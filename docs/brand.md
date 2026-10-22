# Kelpie brand

Kelpie is named after the Australian herding dog that rounds up a whole flock, and the Scottish water spirit (a "daemon"): one app that keeps every coding agent together and running in the background.

Assets live in [app/src/assets/brand/](../app/src/assets/brand/); the design canvas is https://claude.ai/artifact/F3idpWC6i9kent9G1Gu7dt.

## Logo

| File | Use |
|---|---|
| `kelpie-mark.svg` / `kelpie-mark-dark.svg` | The mark: two ears behind a `>_` window. Light / dark grounds. |
| `kelpie-wordmark.svg` / `-light.svg` | "kelpie" in Bricolage Grotesque ExtraBold, outlined. |
| `kelpie-lockup.svg` / `-light.svg` | Mark + wordmark, horizontal. |
| `kelpie-app-icon.svg` | App icon: Kip peeking over a terminal band on Night. Source of `app/src-tauri/icons/`. |

- Clear space around the logo: at least the width of the cursor bar.
- Minimum size: 16 px for the mark, 96 px wide for the lockup.
- Do not rotate, stretch, recolor outside the palette or add effects.

## Color

| Token | Hex | Use |
|---|---|---|
| Kelpie Rust | `#E8743B` | Primary accent, the dog. Text on light: `#B4501F`. |
| Night | `#141823` | Main text, dark grounds, terminal. |
| Spirit Teal | `#18A999` | Cursor, secondary accent. Text on light: `#0F7C70`. |
| Tan | `#F6A971` | Details, paws. |
| Cream | `#FFF1E2` | Text on dark, muzzle. |
| Paper | `#F6F6F3` | Light grounds. |

Agent status: working `#18A999`, needs you `#F5B53F`, done `#3FAE6A`, idle `#8A91A3`.

## Type

- **Bricolage Grotesque** 800: wordmark and display headings.
- **Inter** 400–600: interface and body.
- **JetBrains Mono** 700: terminal and code.

## Mascot: Kip

A kelpie peeking out of a terminal window. One file per agent state:

| File | State |
|---|---|
| `kip-peek.svg` | Default, welcome, empty states |
| `kip-working.svg` | Agent working |
| `kip-needs.svg` | Agent needs you |
| `kip-done.svg` | Agent done |
| `kip-sleep.svg` | Idle / hibernated |

## Voice

Clear, short and warm, like a teammate: say what happened and what to do next.
