// Searchable index of settings: one entry per row of the settings page. Drives the page's
// navigation, its search box, and "/" results in the global search.
export type SettingsSection = "agents" | "automations" | "terminal" | "appearance" | "notifications" | "usage" | "commands" | "shortcuts" | "daemon" | "about";

export const settingsSections: { id: SettingsSection; label: string; group: string }[] = [
  { id: "agents", label: "Agents", group: "Workflow" },
  { id: "commands", label: "Quick Commands", group: "Workflow" },
  { id: "automations", label: "Automations", group: "Workflow" },
  { id: "terminal", label: "Terminal", group: "Interface" },
  { id: "appearance", label: "Appearance", group: "Interface" },
  { id: "shortcuts", label: "Shortcuts", group: "Interface" },
  { id: "notifications", label: "Notifications", group: "Interface" },
  { id: "usage", label: "Usage & Resources", group: "System" },
  { id: "daemon", label: "Session Daemon", group: "System" },
  { id: "about", label: "About", group: "System" },
];

export interface SettingEntry {
  id: string;
  section: SettingsSection;
  label: string;
  description: string;
  keywords: string;
}

export const settingsCatalog: SettingEntry[] = [
  { id: "agent-permissions", section: "agents", label: "Permissions", description: "Manual: agents ask before acting, as they normally do. Yolo: start them with their skip-permission flags (agents with their own permission choice below keep it).", keywords: "yolo dangerously skip bypass approval permission auto" },
  { id: "agent-list", section: "agents", label: "Agent CLIs", description: "Agents found on this computer. Shown ones appear in launchers and the new-session menu.", keywords: "gemini cursor opencode copilot aider grok amp qwen droid kimi crush cline kiro devin goose installed enable hide" },
  { id: "ai-agent", section: "agents", label: "Agent for AI actions", description: "Writes commit messages and pull request descriptions (runs once, without a terminal).", keywords: "generate commit message pull request ai" },
  { id: "hibernate", section: "agents", label: "Hibernate idle agents", description: "Stop agents that finished and sat unseen in a background project; they resume their conversation when you open it again.", keywords: "sleep memory idle pause resume hibernation" },
  { id: "keep-awake", section: "agents", label: "Keep computer awake", description: "Prevent idle sleep while an agent is working, or always (the display may still turn off).", keywords: "caffeinate sleep power awake" },
  { id: "automations", section: "automations", label: "Scheduled automations", description: "Start an agent with a prompt on a schedule. They run from the session daemon, also while this window is closed.", keywords: "schedule cron daily hourly weekly recurring automation" },
  { id: "terminal-theme", section: "terminal", label: "Colour theme", description: "Terminal colours; Default follows the app theme.", keywords: "dracula nord solarized gruvbox one dark tokyo catppuccin github palette colors" },
  { id: "floating-terminal", section: "terminal", label: "Floating terminal", description: "A global terminal in your home folder, one shortcut away from any project.", keywords: "quake dropdown global scratch float" },
  { id: "word-wrap", section: "appearance", label: "Editor word wrap", description: "Wrap long lines in the file editor (Alt+Z toggles it).", keywords: "soft wrap lines editor" },
  { id: "notification-sound", section: "notifications", label: "Notification sound", description: "Play a short chime with desktop notifications.", keywords: "sound chime audio beep" },
  { id: "agent-claude", section: "agents", label: "Claude Code", description: "Arguments, permission mode and environment for new Claude Code sessions.", keywords: "model args flags profile permission env claude" },
  { id: "agent-codex", section: "agents", label: "Codex", description: "Arguments, approval policy and environment for new Codex sessions.", keywords: "model args flags profile approval env codex" },
  { id: "agent-omp", section: "agents", label: "OMP", description: "Arguments and environment for new OMP sessions.", keywords: "model args flags profile env omp pi" },
  { id: "quick-commands", section: "commands", label: "Quick commands", description: "Saved commands and prompts, run from search or the new session menu.", keywords: "snippet saved command run prompt" },
  { id: "font-family", section: "terminal", label: "Terminal font", description: "Font family for terminals; include a Nerd Font for agent icons.", keywords: "font family nerd jetbrains" },
  { id: "font-size", section: "terminal", label: "Font size and line height", description: "Terminal text size and line spacing.", keywords: "zoom size spacing" },
  { id: "scrollback", section: "terminal", label: "Scrollback lines", description: "Lines each terminal keeps above the screen.", keywords: "history buffer" },
  { id: "renderer", section: "terminal", label: "Renderer", description: "GPU (WebGL) is fastest; DOM is a fallback for unusual GPUs.", keywords: "gpu webgl canvas dom" },
  { id: "cursor-blink", section: "terminal", label: "Cursor blink", description: "Blink the terminal cursor.", keywords: "caret" },
  { id: "shell", section: "terminal", label: "Default shell", description: "Command for new terminals; empty uses the system shell.", keywords: "pwsh bash zsh shell" },
  { id: "theme", section: "appearance", label: "Theme", description: "Dark or light interface, terminals and editors.", keywords: "dark light color colour" },
  { id: "density", section: "appearance", label: "Density", description: "Compact fits more sessions in the sidebar.", keywords: "spacing compact comfortable" },
  { id: "ui-scale", section: "appearance", label: "Interface text size", description: "Size of sidebar, panels and menus (terminals have their own size).", keywords: "ui zoom text scale" },
  { id: "shortcuts", section: "shortcuts", label: "Keyboard shortcuts", description: "Change or remove the key for any command.", keywords: "keybinding hotkey chord key" },
  { id: "notifications", section: "notifications", label: "Desktop notifications", description: "Notify when an agent finishes or needs you while Erka is in the background.", keywords: "alert toast done" },
  { id: "shortcut-hints", section: "notifications", label: "Explain shortcuts kept from the terminal", description: "Show a one-time note when Erka takes a key the terminal would have received.", keywords: "hint toast intercept" },
  { id: "tips", section: "notifications", label: "Tips", description: "Occasional tips about Erka's features, one at a time.", keywords: "onboarding help popover" },
  { id: "usage-meters", section: "usage", label: "Claude / Codex usage meters", description: "Plan usage (5 h and weekly windows) in the status bar, read with the agents' own sign-in.", keywords: "rate limit quota tokens subscription" },
  { id: "memory-meter", section: "usage", label: "Memory meter", description: "Memory used by Erka, its session daemon and the sessions.", keywords: "ram resources" },
  { id: "daemon-info", section: "daemon", label: "Daemon status", description: "The process that keeps sessions running when the window closes.", keywords: "erkad pid endpoint version" },
  { id: "daemon-data", section: "daemon", label: "Data directory and logs", description: "Where sessions, snapshots and logs are stored.", keywords: "path folder log" },
  { id: "daemon-stop", section: "daemon", label: "Stop daemon and all sessions", description: "Ends every running session.", keywords: "kill quit erkad shutdown" },
  { id: "version", section: "about", label: "Version", description: "Erka build and platform.", keywords: "about build" },
];

export const catalogEntry = (id: string) => settingsCatalog.find((e) => e.id === id);

/** Every word of `query` appears in the entry's label, description or keywords. */
export function entryMatches(e: SettingEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${e.label} ${e.description} ${e.keywords}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
