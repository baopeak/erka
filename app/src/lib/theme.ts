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

export const projectColors = ["#6cb6ff", "#c592ff", "#8bd58b", "#f2c96d", "#ff8f9c", "#5fd7d7", "#ffb86c", "#a8b3ff"];

export const statusColor: Record<string, string> = {
  working: "var(--working)",
  waiting: "var(--waiting)",
  idle: "var(--idle)",
  exited: "var(--exited)",
};
