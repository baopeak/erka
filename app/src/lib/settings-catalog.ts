// Searchable index of settings: one entry per row of the settings page. Drives the page's
// navigation, its search box, and "/" results in the global search.
import { msg, translated } from "./i18n";

export type SettingsSection = "agents" | "accounts" | "integrations" | "automations" | "terminal" | "layouts" | "remote" | "mobile" | "appearance" | "notifications" | "usage" | "commands" | "shortcuts" | "daemon" | "plugins" | "voice" | "about";

export const settingsSections: { id: SettingsSection; label: string; group: string }[] = [
  { id: "agents", label: msg("Agents"), group: msg("Workflow") },
  { id: "accounts", label: msg("Accounts"), group: msg("Workflow") },
  { id: "integrations", label: msg("Integrations"), group: msg("Workflow") },
  { id: "remote", label: msg("Remote (SSH)"), group: msg("Workflow") },
  { id: "mobile", label: msg("Mobile"), group: msg("Workflow") },
  { id: "commands", label: msg("Quick Commands"), group: msg("Workflow") },
  { id: "automations", label: msg("Automations"), group: msg("Workflow") },
  { id: "voice", label: msg("Voice"), group: msg("Workflow") },
  { id: "terminal", label: msg("Terminal"), group: msg("Interface") },
  { id: "layouts", label: msg("Layouts"), group: msg("Interface") },
  { id: "appearance", label: msg("Appearance"), group: msg("Interface") },
  { id: "shortcuts", label: msg("Shortcuts"), group: msg("Interface") },
  { id: "notifications", label: msg("Notifications"), group: msg("Interface") },
  { id: "plugins", label: msg("Plugins"), group: msg("System") },
  { id: "usage", label: msg("Usage & Resources"), group: msg("System") },
  { id: "daemon", label: msg("Session Daemon"), group: msg("System") },
  { id: "about", label: msg("About"), group: msg("System") },
];

export interface SettingEntry {
  id: string;
  section: SettingsSection;
  label: string;
  description: string;
  keywords: string;
}

export const settingsCatalog: SettingEntry[] = [
  { id: "agent-permissions", section: "agents", label: msg("Permissions"), description: msg("Manual: agents ask before acting, as they normally do. Yolo: start them with their skip-permission flags (agents with their own permission choice below keep it)."), keywords: "yolo dangerously skip bypass approval permission auto" },
  { id: "agent-list", section: "agents", label: msg("Agent CLIs"), description: msg("Agents found on this computer. Shown ones appear in launchers and the new-session menu."), keywords: "gemini cursor opencode copilot aider grok amp qwen droid kimi crush cline kiro devin goose installed enable hide" },
  { id: "ai-agent", section: "agents", label: msg("Agent for AI actions"), description: msg("Writes commit messages and pull request descriptions (runs once, without a terminal)."), keywords: "generate commit message pull request ai" },
  { id: "hibernate", section: "agents", label: msg("Hibernate idle agents"), description: msg("Stop agents that finished and sat unseen in a background project; they resume their conversation when you open it again."), keywords: "sleep memory idle pause resume hibernation" },
  { id: "resume-sessions", section: "agents", label: msg("Resume after a restart"), description: msg("When the session daemon stops while sessions run (computer restart, update, crash), bring them back: when you open them, all at once, or only with their Resume button. Agents continue the same conversation."), keywords: "restore reopen reboot continue session resume startup" },
  { id: "accounts", section: "accounts", label: msg("Claude Code and Codex accounts"), description: msg("Sign in with several accounts. New sessions use the active account; running ones keep theirs. Each account has its own sign-in, settings and history."), keywords: "account login sign in profile switch subscription team personal work CLAUDE_CONFIG_DIR CODEX_HOME" },
  { id: "integration-linear", section: "integrations", label: msg("Linear"), description: msg("A personal API key: your assigned issues in the Issues panel, start agents or worktrees from them, move them between states."), keywords: "linear issues tracker api key ticket" },
  { id: "integration-jira", section: "integrations", label: msg("Jira"), description: msg("Jira Cloud (site, e-mail and API token) or Server / Data Center (personal access token): your open issues, transitions."), keywords: "jira atlassian issues tracker ticket jql" },
  { id: "integration-gitlab", section: "integrations", label: msg("GitLab"), description: msg("Merge requests and pipelines for projects on GitLab (public ones work without a token), creating merge requests and your issues. Add self-hosted hosts here."), keywords: "gitlab merge request mr pipeline ci self-hosted token" },
  { id: "ssh-config", section: "remote", label: msg("SSH config file"), description: msg("Remote projects use your OpenSSH client with this config file (empty: ssh's default, ~/.ssh/config). Hosts, users, ports, keys and jump hosts come from it."), keywords: "ssh remote server host config identity key proxyjump" },
  { id: "remote-projects", section: "remote", label: msg("Remote projects"), description: msg("Projects on other machines: terminals and agents run there over SSH (kept alive in tmux when it is installed); files, search and git work through ssh too."), keywords: "ssh remote server cloud vm tmux host" },
  { id: "mobile-access", section: "mobile", label: msg("Mobile access"), description: msg("A web app on your network for your phone: every session, what needs you, a session's screen and (if allowed) replies. Off until you turn it on; each phone is paired and approved here."), keywords: "phone mobile companion remote lan wifi pwa tablet" },
  { id: "mobile-network", section: "mobile", label: msg("Network address"), description: msg("The address and port phones connect to (a private or Tailscale address; never every interface)."), keywords: "ip port interface lan tailscale" },
  { id: "mobile-tls", section: "mobile", label: msg("HTTPS certificate"), description: msg("Serve HTTPS with your certificate and key (PEM), e.g. from `tailscale cert`: encrypted, and the phone can install the app."), keywords: "https tls ssl certificate tailscale secure" },
  { id: "mobile-pair", section: "mobile", label: msg("Pair a phone"), description: msg("Shows a one-time QR code (2 minutes). After scanning, approve the phone here."), keywords: "qr pair connect device phone" },
  { id: "mobile-devices", section: "mobile", label: msg("Paired devices"), description: msg("Phones that may connect. Typing is allowed per device; unpairing disconnects it at once."), keywords: "device revoke unpair permission" },
  { id: "saved-layouts", section: "layouts", label: msg("Saved layouts"), description: msg("Pane arrangements saved from a tab (Layout menu → Save this layout), with what each pane runs. Open one from the Layout menu or a project's start page."), keywords: "grid rows columns split arrangement template workspace" },
  { id: "plugins", section: "plugins", label: msg("Installed plugins"), description: msg("Plugins add agents, palette commands, quick commands, terminal themes, layouts and status-bar items. A plugin does nothing until you review what it runs and enable it; editing it turns it off until you review it again."), keywords: "plugin extension addon extend manifest kelpie-plugin.json" },
  { id: "plugin-install-git", section: "plugins", label: msg("Install from a Git repository"), description: msg("Clones the repository (https, ssh or git@) into the plugins folder; it stays off until you enable it."), keywords: "git clone url github install plugin" },
  { id: "plugin-create", section: "plugins", label: msg("Create a plugin"), description: msg("A starter kelpie-plugin.json with a command, a quick command and a status item to edit."), keywords: "new scaffold author develop plugin template" },
  { id: "voice-models", section: "voice", label: msg("Speech models"), description: msg("Dictation runs on this computer: download a model once, then speak into any text field or terminal. Vietnamese has its own fast model; Whisper models understand many languages."), keywords: "voice dictation speech to text microphone stt whisper vietnamese offline transcribe" },
  { id: "voice-language", section: "voice", label: msg("Language"), description: msg("What you speak, for Whisper models (Detect automatically works but is slower and can guess wrong on short phrases)."), keywords: "language english vietnamese dictation" },
  { id: "voice-mic", section: "voice", label: msg("Microphone"), description: msg("Input device for dictation."), keywords: "microphone input device audio headset" },
  { id: "voice-try", section: "voice", label: msg("Try it"), description: msg("Click the microphone (or press the Dictate shortcut), speak, then click it again: the words appear at the cursor. Esc cancels."), keywords: "test dictation shortcut" },
  { id: "keep-awake", section: "agents", label: msg("Keep computer awake"), description: msg("Prevent idle sleep while an agent is working, or always (the display may still turn off)."), keywords: "caffeinate sleep power awake" },
  { id: "automations", section: "automations", label: msg("Scheduled automations"), description: msg("Start an agent with a prompt on a schedule. They run from the session daemon, also while this window is closed."), keywords: "schedule cron daily hourly weekly recurring automation" },
  { id: "terminal-theme", section: "terminal", label: msg("Colour theme"), description: msg("Terminal colours; Default follows the app theme."), keywords: "dracula nord solarized gruvbox one dark tokyo catppuccin github palette colors" },
  { id: "localhost-browser", section: "terminal", label: msg("Open localhost links in a browser pane"), description: msg("Ctrl/Cmd+click on a local dev-server address (localhost, 127.0.0.1) in a terminal opens it in a browser pane next to the terminal instead of your browser."), keywords: "link url dev server preview browser pane localhost" },
  { id: "floating-terminal", section: "terminal", label: msg("Floating terminal"), description: msg("A global terminal in your home folder, one shortcut away from any project."), keywords: "quake dropdown global scratch float" },
  { id: "language", section: "appearance", label: msg("Language"), description: msg("Language of Kelpie's interface. System follows your computer."), keywords: "language english vietnamese tiếng việt ngôn ngữ locale translation" },
  { id: "word-wrap", section: "appearance", label: msg("Editor word wrap"), description: msg("Wrap long lines in the file editor (Alt+Z toggles it)."), keywords: "soft wrap lines editor" },
  { id: "notification-sound", section: "notifications", label: msg("Notification sound"), description: msg("Play a short chime with desktop notifications."), keywords: "sound chime audio beep" },
  { id: "agent-claude", section: "agents", label: msg("Claude Code"), description: msg("Arguments, permission mode and environment for new Claude Code sessions."), keywords: "model args flags profile permission env claude" },
  { id: "agent-codex", section: "agents", label: msg("Codex"), description: msg("Arguments, approval policy and environment for new Codex sessions."), keywords: "model args flags profile approval env codex" },
  { id: "agent-omp", section: "agents", label: msg("OMP"), description: msg("Arguments and environment for new OMP sessions."), keywords: "model args flags profile env omp pi" },
  { id: "quick-commands", section: "commands", label: msg("Quick commands"), description: msg("Saved commands and prompts, run from search or the new session menu."), keywords: "snippet saved command run prompt" },
  { id: "font-family", section: "terminal", label: msg("Terminal font"), description: msg("Font family for terminals; include a Nerd Font for agent icons."), keywords: "font family nerd jetbrains" },
  { id: "font-size", section: "terminal", label: msg("Font size and line height"), description: msg("Terminal text size and line spacing."), keywords: "zoom size spacing" },
  { id: "scrollback", section: "terminal", label: msg("Scrollback lines"), description: msg("Lines each terminal keeps above the screen."), keywords: "history buffer" },
  { id: "renderer", section: "terminal", label: msg("Renderer"), description: msg("GPU (WebGL) is fastest; DOM is a fallback for unusual GPUs."), keywords: "gpu webgl canvas dom" },
  { id: "cursor-blink", section: "terminal", label: msg("Cursor blink"), description: msg("Blink the terminal cursor."), keywords: "caret" },
  { id: "shell", section: "terminal", label: msg("Default shell"), description: msg("Command for new terminals; empty uses the system shell."), keywords: "pwsh bash zsh shell" },
  { id: "theme", section: "appearance", label: msg("Theme"), description: msg("Dark or light interface, terminals and editors."), keywords: "dark light color colour" },
  { id: "density", section: "appearance", label: msg("Density"), description: msg("Compact fits more sessions in the sidebar."), keywords: "spacing compact comfortable" },
  { id: "ui-scale", section: "appearance", label: msg("Interface text size"), description: msg("Size of sidebar, panels and menus (terminals have their own size)."), keywords: "ui zoom text scale" },
  { id: "shortcuts", section: "shortcuts", label: msg("Keyboard shortcuts"), description: msg("Change or remove the key for any command."), keywords: "keybinding hotkey chord key" },
  { id: "notifications", section: "notifications", label: msg("Desktop notifications"), description: msg("Notify when an agent finishes or needs you while Kelpie is in the background."), keywords: "alert toast done" },
  { id: "shortcut-hints", section: "notifications", label: msg("Explain shortcuts kept from the terminal"), description: msg("Show a one-time note when Kelpie takes a key the terminal would have received."), keywords: "hint toast intercept" },
  { id: "tips", section: "notifications", label: msg("Tips"), description: msg("Occasional tips about Kelpie's features, one at a time."), keywords: "onboarding help popover" },
  { id: "usage-meters", section: "usage", label: msg("Claude / Codex usage meters"), description: msg("Plan usage (5 h and weekly windows) in the status bar, read with the agents' own sign-in."), keywords: "rate limit quota tokens subscription" },
  { id: "memory-meter", section: "usage", label: msg("Memory meter"), description: msg("Memory used by Kelpie, its session daemon and the sessions."), keywords: "ram resources" },
  { id: "daemon-info", section: "daemon", label: msg("Daemon status"), description: msg("The process that keeps sessions running when the window closes."), keywords: "kelpied pid endpoint version" },
  { id: "daemon-data", section: "daemon", label: msg("Data directory and logs"), description: msg("Where sessions, snapshots and logs are stored."), keywords: "path folder log" },
  { id: "daemon-stop", section: "daemon", label: msg("Stop daemon and all sessions"), description: msg("Ends every running session."), keywords: "kill quit kelpied shutdown" },
  { id: "version", section: "about", label: msg("Version"), description: msg("Kelpie build and platform."), keywords: "about build" },
];

export const catalogEntry = (id: string) => settingsCatalog.find((e) => e.id === id);

/** Every word of `query` appears in the entry's label, description or keywords. */
export function entryMatches(e: SettingEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${e.label} ${e.description} ${e.keywords} ${translated(e.label) ?? ""} ${translated(e.description) ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
