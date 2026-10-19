//! Headless terminal state for one session, built on `alacritty_terminal`.
//!
//! The daemon parses every PTY byte exactly once, here. Views that attach later get either
//! a raw replay (cheap, exact) or an ANSI snapshot produced by [`Vt::snapshot`].

use std::fmt::Write as _;
use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb, StdSyncHandler};
use parking_lot::Mutex;

/// Side effects the parser asks for. Collected during `feed` and drained by the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VtEvent {
    /// Bytes the terminal must answer with (DA, DSR, colour queries…).
    Reply(String),
    Title(Option<String>),
    Bell,
    /// OSC 52 clipboard store request.
    Clipboard(String),
}

#[derive(Clone, Default)]
struct Collector(Arc<Mutex<Vec<VtEvent>>>);

impl EventListener for Collector {
    fn send_event(&self, event: Event) {
        let ev = match event {
            Event::PtyWrite(s) => VtEvent::Reply(s),
            Event::Title(t) => VtEvent::Title(Some(t)),
            Event::ResetTitle => VtEvent::Title(None),
            Event::Bell => VtEvent::Bell,
            Event::ClipboardStore(_, s) => VtEvent::Clipboard(s),
            // Colour queries (OSC 10/11/4) — agents such as Claude Code probe the background
            // to pick a theme; answer with the palette the Erka UI renders.
            Event::ColorRequest(index, fmt) => VtEvent::Reply(fmt(default_color(index))),
            _ => return,
        };
        self.0.lock().push(ev);
    }
}

/// Matches the default dark theme in `app/src/lib/theme.ts`.
fn default_color(index: usize) -> Rgb {
    const ANSI: [(u8, u8, u8); 16] = [
        (0x1d, 0x20, 0x2a), (0xff, 0x6b, 0x7a), (0x8b, 0xd5, 0x8b), (0xf2, 0xc9, 0x6d),
        (0x6c, 0xb6, 0xff), (0xc5, 0x92, 0xff), (0x5f, 0xd7, 0xd7), (0xc9, 0xd1, 0xd9),
        (0x5c, 0x63, 0x70), (0xff, 0x8f, 0x9c), (0xa8, 0xe6, 0xa1), (0xff, 0xdd, 0x8a),
        (0x8f, 0xc8, 0xff), (0xd7, 0xb0, 0xff), (0x87, 0xe8, 0xe8), (0xf4, 0xf6, 0xfa),
    ];
    let (r, g, b) = match index {
        i if i < 16 => ANSI[i],
        // NamedColor::Foreground / Background / Cursor
        256 => (0xd7, 0xdc, 0xe6),
        257 => (0x0e, 0x11, 0x17),
        258 => (0x6c, 0xb6, 0xff),
        i if i < 232 => {
            let i = i - 16;
            let level = |v: usize| if v == 0 { 0 } else { (v * 40 + 55) as u8 };
            (level(i / 36), level((i / 6) % 6), level(i % 6))
        }
        i if i < 256 => {
            let v = (8 + (i - 232) * 10) as u8;
            (v, v, v)
        }
        _ => (0xd7, 0xdc, 0xe6),
    };
    Rgb { r, g, b }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct Vt {
    term: Term<Collector>,
    parser: Processor<StdSyncHandler>,
    events: Collector,
    title: Option<String>,
}

impl Vt {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Vt {
        let events = Collector::default();
        let config = Config { scrolling_history: scrollback, ..Config::default() };
        let size = Size { cols: cols.max(2) as usize, rows: rows.max(1) as usize };
        Vt { term: Term::new(config, &size, events.clone()), parser: Processor::new(), events, title: None }
    }

    /// Feeds bytes in order and returns the side effects they triggered.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<VtEvent> {
        self.parser.advance(&mut self.term, bytes);
        let events = std::mem::take(&mut *self.events.0.lock());
        for ev in &events {
            if let VtEvent::Title(t) = ev {
                self.title = t.clone();
            }
        }
        events
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size { cols: cols.max(2) as usize, rows: rows.max(1) as usize });
    }

    pub fn size(&self) -> (u16, u16) {
        (self.term.columns() as u16, self.term.screen_lines() as u16)
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    /// Plain text of the visible screen (used for status heuristics and `session.read`).
    pub fn screen_text(&self) -> String {
        let grid = self.term.grid();
        let mut out = String::new();
        for line in 0..grid.screen_lines() as i32 {
            let row = &grid[Line(line)];
            let mut text = String::new();
            for col in 0..grid.columns() {
                let cell = &row[Column(col)];
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
            }
            out.push_str(text.trim_end());
            out.push('\n');
        }
        out
    }

    /// Serializes scrollback (up to `max_history` lines) + screen + cursor + modes into an ANSI
    /// stream that recreates this state when written into a freshly reset terminal of the same
    /// size.
    pub fn snapshot(&self, max_history: usize) -> Vec<u8> {
        let term = &self.term;
        let grid = term.grid();
        let mode = *term.mode();
        let mut out = String::with_capacity(64 * 1024);
        let mut pen = Pen::default();

        if mode.contains(TermMode::ALT_SCREEN) {
            out.push_str("\x1b[?1049h\x1b[H\x1b[2J");
        }

        let history = grid.history_size().min(max_history) as i32;
        let screen = grid.screen_lines() as i32;
        let cols = grid.columns();
        for line in -history..screen {
            let row = &grid[Line(line)];
            let wraps = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
            let end = if wraps { cols } else { visible_len(row, cols) };
            for col in 0..end {
                let cell = &row[Column(col)];
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                    continue;
                }
                pen.apply(&mut out, cell);
                out.push(if cell.c == '\0' { ' ' } else { cell.c });
                if let Some(zw) = cell.zerowidth() {
                    out.extend(zw.iter());
                }
            }
            if line + 1 < screen && !wraps {
                // Reset before the line break so background colour does not bleed (BCE).
                if pen.is_styled() {
                    out.push_str("\x1b[0m");
                    pen = Pen::default();
                }
                out.push_str("\r\n");
            }
        }
        out.push_str("\x1b[0m");
        if pen.link.is_some() {
            out.push_str("\x1b]8;;\x1b\\");
        }

        let cursor = grid.cursor.point;
        let _ = write!(out, "\x1b[{};{}H", cursor.line.0 + 1, cursor.column.0 + 1);
        let template = &grid.cursor.template;
        if template.fg != Color::Named(NamedColor::Foreground)
            || template.bg != Color::Named(NamedColor::Background)
            || !template.flags.is_empty()
        {
            Pen::default().apply(&mut out, template);
        }

        let style = term.cursor_style();
        let shape = match style.shape {
            CursorShape::Underline => 4,
            CursorShape::Beam => 6,
            _ => 2,
        } - style.blinking as u8;
        let _ = write!(out, "\x1b[{shape} q");

        let decset = |out: &mut String, flag: TermMode, code: u16| {
            if mode.contains(flag) {
                let _ = write!(out, "\x1b[?{code}h");
            }
        };
        decset(&mut out, TermMode::APP_CURSOR, 1);
        decset(&mut out, TermMode::MOUSE_REPORT_CLICK, 1000);
        decset(&mut out, TermMode::MOUSE_DRAG, 1002);
        decset(&mut out, TermMode::MOUSE_MOTION, 1003);
        decset(&mut out, TermMode::FOCUS_IN_OUT, 1004);
        decset(&mut out, TermMode::SGR_MOUSE, 1006);
        decset(&mut out, TermMode::ALTERNATE_SCROLL, 1007);
        decset(&mut out, TermMode::BRACKETED_PASTE, 2004);
        if mode.contains(TermMode::APP_KEYPAD) {
            out.push_str("\x1b=");
        }
        if !mode.contains(TermMode::LINE_WRAP) {
            out.push_str("\x1b[?7l");
        }
        let kitty = (mode & TermMode::KITTY_KEYBOARD_PROTOCOL).bits() >> 18;
        if kitty != 0 {
            let _ = write!(out, "\x1b[={kitty};1u");
        }
        if !mode.contains(TermMode::SHOW_CURSOR) {
            out.push_str("\x1b[?25l");
        }
        if let Some(title) = &self.title {
            let _ = write!(out, "\x1b]2;{}\x07", title.replace(['\x07', '\x1b'], ""));
        }
        out.into_bytes()
    }
}

/// Number of leading cells worth emitting: trailing blank, unstyled cells are dropped.
fn visible_len(row: &alacritty_terminal::grid::Row<Cell>, cols: usize) -> usize {
    let mut end = cols;
    while end > 0 {
        let cell = &row[Column(end - 1)];
        let blank = (cell.c == ' ' || cell.c == '\0')
            && cell.bg == Color::Named(NamedColor::Background)
            && !cell.flags.intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
            && cell.extra.is_none();
        if !blank {
            break;
        }
        end -= 1;
    }
    end
}

/// Tracks the SGR state already emitted so we only write escape codes on change.
#[derive(Default)]
struct Pen {
    styled: Option<(Color, Color, Flags, Option<Color>)>,
    link: Option<String>,
}

const SGR_FLAGS: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

impl Pen {
    fn is_styled(&self) -> bool {
        self.styled.is_some()
    }

    fn apply(&mut self, out: &mut String, cell: &Cell) {
        let flags = cell.flags & SGR_FLAGS;
        let ul = cell.underline_color();
        let default = cell.fg == Color::Named(NamedColor::Foreground)
            && cell.bg == Color::Named(NamedColor::Background)
            && flags.is_empty()
            && ul.is_none();
        let want = if default { None } else { Some((cell.fg, cell.bg, flags, ul)) };
        if want != self.styled {
            out.push_str("\x1b[0");
            if let Some((fg, bg, flags, ul)) = want {
                if flags.contains(Flags::BOLD) { out.push_str(";1"); }
                if flags.contains(Flags::DIM) { out.push_str(";2"); }
                if flags.contains(Flags::ITALIC) { out.push_str(";3"); }
                if flags.contains(Flags::UNDERLINE) { out.push_str(";4"); }
                if flags.contains(Flags::DOUBLE_UNDERLINE) { out.push_str(";4:2"); }
                if flags.contains(Flags::UNDERCURL) { out.push_str(";4:3"); }
                if flags.contains(Flags::DOTTED_UNDERLINE) { out.push_str(";4:4"); }
                if flags.contains(Flags::DASHED_UNDERLINE) { out.push_str(";4:5"); }
                if flags.contains(Flags::INVERSE) { out.push_str(";7"); }
                if flags.contains(Flags::HIDDEN) { out.push_str(";8"); }
                if flags.contains(Flags::STRIKEOUT) { out.push_str(";9"); }
                push_color(out, fg, 30);
                push_color(out, bg, 40);
                if let Some(ul) = ul {
                    push_color(out, ul, 50);
                }
            }
            out.push('m');
            self.styled = want;
        }
        let link = cell.hyperlink().map(|h| h.uri().to_string());
        if link != self.link {
            match &link {
                Some(uri) => {
                    let _ = write!(out, "\x1b]8;;{uri}\x1b\\");
                }
                None => out.push_str("\x1b]8;;\x1b\\"),
            }
            self.link = link;
        }
    }
}

/// `base` is 30 (fg), 40 (bg) or 50 (underline colour, SGR 58).
fn push_color(out: &mut String, color: Color, base: u16) {
    let extended = base + 8;
    match color {
        Color::Spec(Rgb { r, g, b }) => {
            let _ = write!(out, ";{extended};2;{r};{g};{b}");
        }
        Color::Indexed(i) => {
            let _ = write!(out, ";{extended};5;{i}");
        }
        Color::Named(named) => {
            let idx = named as usize;
            match idx {
                0..=7 if base != 50 => {
                    let _ = write!(out, ";{}", base as usize + idx);
                }
                8..=15 if base != 50 => {
                    let _ = write!(out, ";{}", base as usize + 60 + idx - 8);
                }
                0..=15 => {
                    let _ = write!(out, ";{extended};5;{idx}");
                }
                // Dim variants (DimBlack..DimWhite) map back onto the normal colour.
                259..=266 if base != 50 => {
                    let _ = write!(out, ";{}", base as usize + idx - 259);
                }
                _ => {} // default fg/bg: already reset by the leading `0`
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_dump(vt: &Vt) -> Vec<String> {
        let grid = vt.term.grid();
        let hist = grid.history_size() as i32;
        let mut lines = Vec::new();
        for line in -hist..grid.screen_lines() as i32 {
            let row = &grid[Line(line)];
            let mut s = String::new();
            for col in 0..grid.columns() {
                let c = &row[Column(col)];
                let _ = write!(s, "{}{:?}{:?}{:?}|", c.c, c.fg, c.bg, c.flags & SGR_FLAGS);
            }
            lines.push(s);
        }
        lines
    }

    fn assert_roundtrip(input: &[u8], cols: u16, rows: u16) {
        let mut a = Vt::new(cols, rows, 1000);
        a.feed(input);
        let snap = a.snapshot(1000);
        let mut b = Vt::new(cols, rows, 1000);
        b.feed(&snap);
        assert_eq!(grid_dump(&a), grid_dump(&b), "snapshot: {:?}", String::from_utf8_lossy(&snap));
        assert_eq!(a.term.grid().cursor.point, b.term.grid().cursor.point);
        assert_eq!(*a.term.mode(), *b.term.mode());
    }

    #[test]
    fn roundtrip_colors_and_attrs() {
        assert_roundtrip(
            b"plain \x1b[1;31mbold red\x1b[0m \x1b[38;2;10;20;30;48;5;200mrgb\x1b[0m\r\n\x1b[4;3;7mul it inv\x1b[0m end",
            40,
            6,
        );
    }

    #[test]
    fn roundtrip_wide_chars_and_wrap() {
        assert_roundtrip("日本語テキスト🙂 abc 0123456789012345678901234567890 wrap".as_bytes(), 12, 5);
    }

    #[test]
    fn roundtrip_scrollback() {
        let mut input = Vec::new();
        for i in 0..50 {
            input.extend_from_slice(format!("line {i}\r\n").as_bytes());
        }
        assert_roundtrip(&input, 20, 5);
    }

    #[test]
    fn roundtrip_alt_screen_and_modes() {
        assert_roundtrip(
            b"main\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1h\x1b[3;5Halt \x1b[42mgreen\x1b[0m\x1b[?25l",
            30,
            8,
        );
    }

    #[test]
    fn answers_device_attributes() {
        let mut vt = Vt::new(80, 24, 100);
        let events = vt.feed(b"\x1b[c\x1b[6n");
        assert!(events.iter().any(|e| matches!(e, VtEvent::Reply(r) if r.contains("?6c"))));
        assert!(events.iter().any(|e| matches!(e, VtEvent::Reply(r) if r == "\x1b[1;1R")));
    }

    #[test]
    fn tracks_title() {
        let mut vt = Vt::new(80, 24, 100);
        vt.feed(b"\x1b]2;hello\x07");
        assert_eq!(vt.title(), Some("hello"));
    }
}
