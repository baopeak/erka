import type { ITheme } from "@xterm/xterm";

/**
 * Terminal palette. Keep in sync with `default_color` in crates/erkad/src/vt.rs — the daemon
 * answers colour queries (OSC 10/11/4) with these values while no view is attached.
 */
export const terminalTheme: ITheme = {
  background: "#0e1117",
  foreground: "#d7dce6",
  cursor: "#6cb6ff",
  cursorAccent: "#0e1117",
  selectionBackground: "rgba(108, 182, 255, 0.30)",
  selectionInactiveBackground: "rgba(108, 182, 255, 0.16)",
  black: "#1d202a",
  red: "#ff6b7a",
  green: "#8bd58b",
  yellow: "#f2c96d",
  blue: "#6cb6ff",
  magenta: "#c592ff",
  cyan: "#5fd7d7",
  white: "#c9d1d9",
  brightBlack: "#5c6370",
  brightRed: "#ff8f9c",
  brightGreen: "#a8e6a1",
  brightYellow: "#ffdd8a",
  brightBlue: "#8fc8ff",
  brightMagenta: "#d7b0ff",
  brightCyan: "#87e8e8",
  brightWhite: "#f4f6fa",
  scrollbarSliderBackground: "rgba(255,255,255,0.08)",
  scrollbarSliderHoverBackground: "rgba(255,255,255,0.16)",
  scrollbarSliderActiveBackground: "rgba(255,255,255,0.22)",
};

/** Light terminal palette (Settings → Appearance → Light). */
export const terminalThemeLight: ITheme = {
  background: "#ffffff",
  foreground: "#1d2330",
  cursor: "#2f6fde",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(47, 111, 222, 0.22)",
  selectionInactiveBackground: "rgba(47, 111, 222, 0.12)",
  black: "#1d2330",
  red: "#c4303f",
  green: "#2b8a4b",
  yellow: "#9a6a00",
  blue: "#2f6fde",
  magenta: "#8a4fd8",
  cyan: "#0f7f8a",
  white: "#c8cdd6",
  brightBlack: "#6b7383",
  brightRed: "#d64553",
  brightGreen: "#2f9e57",
  brightYellow: "#b7791f",
  brightBlue: "#4a86e8",
  brightMagenta: "#9b67e0",
  brightCyan: "#1597a3",
  brightWhite: "#eef0f4",
  scrollbarSliderBackground: "rgba(0,0,0,0.10)",
  scrollbarSliderHoverBackground: "rgba(0,0,0,0.18)",
  scrollbarSliderActiveBackground: "rgba(0,0,0,0.25)",
};

export const terminalThemeFor = (theme: "dark" | "light" | undefined) => (theme === "light" ? terminalThemeLight : terminalTheme);

export const projectColors = ["#6cb6ff", "#c592ff", "#8bd58b", "#f2c96d", "#ff8f9c", "#5fd7d7", "#ffb86c", "#a8b3ff"];

export const statusColor: Record<string, string> = {
  working: "var(--working)",
  waiting: "var(--waiting)",
  idle: "var(--idle)",
  exited: "var(--exited)",
};
