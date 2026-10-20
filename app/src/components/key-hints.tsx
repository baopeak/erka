import { For } from "solid-js";

/** Footer row explaining the keys an overlay understands: [["Enter", "Open"], ["Esc", "Close"]]. */
export function KeyHints(props: { items: [string, string][] }) {
  return (
    <div class="key-hints">
      <For each={props.items}>
        {([key, label]) => (
          <span class="hint">
            <span class="kbd">{key}</span>
            {label}
          </span>
        )}
      </For>
    </div>
  );
}
