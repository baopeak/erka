// Kelpie logo and mascot artwork (docs/brand.md). Each logo file is drawn for one ground, so
// both variants are rendered and CSS (`.on-dark` / `.on-light`) hides the one the theme does not use.
import markOnDark from "../assets/brand/kelpie-mark-dark.svg";
import markOnLight from "../assets/brand/kelpie-mark.svg";
import wordOnDark from "../assets/brand/kelpie-wordmark-light.svg";
import wordOnLight from "../assets/brand/kelpie-wordmark.svg";
import kipPeek from "../assets/brand/kip-peek.svg";
import kipWorking from "../assets/brand/kip-working.svg";
import kipNeeds from "../assets/brand/kip-needs.svg";
import kipDone from "../assets/brand/kip-done.svg";
import kipSleep from "../assets/brand/kip-sleep.svg";

/** The mark: two kelpie ears behind a `>_` terminal window. Decorative next to the wordmark. */
export function BrandMark() {
  return (
    <>
      <img class="brand-logo on-dark" src={markOnDark} alt="" draggable={false} />
      <img class="brand-logo on-light" src={markOnLight} alt="" draggable={false} />
    </>
  );
}

/** "kelpie" set in the brand typeface (outlined, so it needs no font). */
export function BrandWordmark(props: { height?: number }) {
  const style = () => (props.height ? { height: `${props.height}px` } : undefined);
  return (
    <>
      <img class="brand-word on-dark" src={wordOnDark} alt="Kelpie" style={style()} draggable={false} />
      <img class="brand-word on-light" src={wordOnLight} alt="Kelpie" style={style()} draggable={false} />
    </>
  );
}

export type KipMood = "peek" | "working" | "needs" | "done" | "sleep";

const KIP: Record<KipMood, string> = { peek: kipPeek, working: kipWorking, needs: kipNeeds, done: kipDone, sleep: kipSleep };

/** Kip, the mascot, in one of the agent states. Decorative: the text beside it says what it means. */
export function Kip(props: { mood?: KipMood; size?: number }) {
  return <img class="kip" src={KIP[props.mood ?? "peek"]} alt="" style={{ width: `${props.size ?? 168}px` }} draggable={false} />;
}
