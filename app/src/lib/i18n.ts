// Interface language (Settings → Appearance → Language): English, or Vietnamese from the
// dictionaries in src/locales/vi/*.json. The English text is the key — `t("Close pane")` — so
// code reads naturally and a missing translation shows English, never a key name.
//
// Rules (checked by scripts/i18n-check.mjs):
// - `t()` and `msg()` take a plain string literal; values go in `{name}` placeholders:
//   t("Delete {name}?", { name }). Never build keys from template literals.
// - Plurals are separate keys: n === 1 ? t("{n} session", { n }) : t("{n} sessions", { n }).
// - Tables declared at module load (command labels, settings rows) mark their text with `msg()`
//   and are translated where they are shown: t(command.label).
// - Not translated: what is typed into terminals or sent to agents, ids, paths, brand names.
import { createSignal } from "solid-js";

export type Locale = "en" | "vi";
export type LocaleSetting = "system" | Locale;

const fragments = import.meta.glob<Record<string, string>>("../locales/vi/*.json", { eager: true, import: "default" });
const VI: Record<string, string> = Object.assign({}, ...Object.values(fragments));

const [locale, setLocaleSignal] = createSignal<Locale>("en");
export { locale };

export function systemLocale(): Locale {
  return (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function applyLocale(setting: LocaleSetting | undefined) {
  const l = !setting || setting === "system" ? systemLocale() : setting;
  setLocaleSignal(l);
  document.documentElement.lang = l;
}

/** BCP 47 tag for Intl. */
export const intlLocale = () => (locale() === "vi" ? "vi-VN" : "en-US");

function fill(text: string, vars?: Record<string, string | number>) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** The text in the interface language. Reactive: re-runs when the language changes. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(locale() === "vi" ? VI[text] ?? text : text, vars);
}

/** Marks text in a table built at load time; translate it with `t()` where it is shown. */
export const msg = (text: string) => text;

/** Fixed messages from the Rust side (locales/vi/backend.json), longest first. */
const BACKEND = Object.keys((fragments["../locales/vi/backend.json"] as Record<string, string> | undefined) ?? {}).sort((a, b) => b.length - a.length);

/** An error for display: without the "Error: " prefix, with known backend messages translated. */
export function errorText(e: unknown): string {
  let s = String(e ?? "").replace(/^(Error|RuntimeError):\s*/, "");
  if (locale() !== "vi") return s;
  for (const k of BACKEND) if (s.includes(k)) s = s.split(k).join(VI[k]);
  return s;
}

/** Whether `text` has a Vietnamese translation (settings search matches both languages). */
export const translated = (text: string) => VI[text];

// ---------- dates and times ----------

export const formatDate = (ms: number | Date, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }) =>
  new Date(ms).toLocaleDateString(intlLocale(), opts);

export const formatDateTime = (ms: number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
  new Date(ms).toLocaleString(intlLocale(), opts);

export const formatTime = (ms: number | Date, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }) =>
  new Date(ms).toLocaleTimeString(intlLocale(), opts);

export const formatNumber = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(intlLocale(), opts);

/** "5 minutes ago" / "5 phút trước". */
export function formatRelative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const abs = Math.abs(d);
  if (abs < 60_000) return t("just now");
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (abs < 3_600_000) return rtf.format(Math.round(d / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(d / 3_600_000), "hour");
  return rtf.format(Math.round(d / 86_400_000), "day");
}

/** Time until `ms`, coarse: "3 h 20 min" / "3 giờ 20 phút". */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return t("{n} min", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t("{h} h {m} min", { h, m: m % 60 }) : t("{n} h", { n: h });
  return t("{n} days", { n: Math.round(h / 24) });
}
