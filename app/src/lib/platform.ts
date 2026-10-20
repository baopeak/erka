export const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac OS");

/** Human label for a chord like "mod+shift+p". */
export function chordLabel(chord: string): string {
  return chord
    .split("+")
    .map((k) => {
      switch (k) {
        case "mod": return isMac ? "⌘" : "Ctrl";
        case "ctrl": return isMac ? "⌃" : "Ctrl";
        case "shift": return isMac ? "⇧" : "Shift";
        case "alt": return isMac ? "⌥" : "Alt";
        case "arrowleft": return "←";
        case "arrowright": return "→";
        case "arrowup": return "↑";
        case "arrowdown": return "↓";
        case "enter": return isMac ? "↩" : "Enter";
        default: return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
      }
    })
    .join(isMac ? "" : "+");
}

export function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return rel ? root.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep) : root;
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** Compact age: "now", "5m", "3h", "2d", "4w". */
export function relTimeShort(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return `${Math.floor(d / (7 * 86_400_000))}w`;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
