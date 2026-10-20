// Searchable index of settings: drives the settings page navigation and "/" search results.
export type SettingsSection = "agents" | "terminal" | "appearance" | "notifications" | "usage" | "commands" | "shortcuts" | "daemon" | "about";

export const settingsSections: { id: SettingsSection; label: string; group: string }[] = [
  { id: "agents", label: "Agents", group: "Workflow" },
  { id: "commands", label: "Quick Commands", group: "Workflow" },
  { id: "terminal", label: "Terminal", group: "Interface" },
  { id: "appearance", label: "Appearance", group: "Interface" },
  { id: "shortcuts", label: "Shortcuts", group: "Interface" },
  { id: "notifications", label: "Notifications", group: "Interface" },
  { id: "usage", label: "Usage & Resources", group: "System" },
  { id: "daemon", label: "Session Daemon", group: "System" },
  { id: "about", label: "About", group: "System" },
];

export const settingsCatalog: { section: SettingsSection; label: string; keywords: string }[] = [
  { section: "agents", label: "Agent arguments (Claude, Codex, OMP)", keywords: "model args flags profile" },
  { section: "agents", label: "Default shell command", keywords: "pwsh bash zsh shell" },
  { section: "commands", label: "Quick commands", keywords: "snippet saved command run" },
  { section: "terminal", label: "Terminal font", keywords: "font family nerd jetbrains" },
  { section: "terminal", label: "Font size and line height", keywords: "zoom size spacing" },
  { section: "terminal", label: "Scrollback lines", keywords: "history buffer" },
  { section: "terminal", label: "Renderer (WebGL / DOM)", keywords: "gpu webgl canvas" },
  { section: "terminal", label: "Cursor blink", keywords: "caret" },
  { section: "appearance", label: "Density (compact / comfortable)", keywords: "spacing compact" },
  { section: "appearance", label: "Interface font size", keywords: "ui zoom text" },
  { section: "shortcuts", label: "Keyboard shortcuts", keywords: "keybinding hotkey chord" },
  { section: "notifications", label: "Desktop notifications", keywords: "alert toast done" },
  { section: "notifications", label: "Explain shortcuts kept from the terminal", keywords: "hint toast intercept" },
  { section: "usage", label: "Claude / Codex usage meters", keywords: "rate limit quota tokens" },
  { section: "usage", label: "Memory meter", keywords: "ram resources" },
  { section: "daemon", label: "Stop daemon and all sessions", keywords: "kill quit erkad" },
  { section: "daemon", label: "Data directory and logs", keywords: "path folder log" },
  { section: "about", label: "Version", keywords: "about build" },
];
