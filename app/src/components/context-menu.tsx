// App-wide context menu: one instance rendered by <App>, opened from anywhere.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

export type MenuItem = { label: string; run: () => void; danger?: boolean; hint?: string } | null;

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openContextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuHost() {
  onMount(() => {
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    });
  });
  return (
    <Show when={menu()}>
      {(m) => (
        <div
          class="ctx-menu"
          style={{ left: `${Math.min(m().x, window.innerWidth - 220)}px`, top: `${Math.min(m().y, window.innerHeight - 30 * m().items.length - 12)}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={m().items}>
            {(item) =>
              item ? (
                <div class={`ctx-item${item.danger ? " danger" : ""}`} onClick={() => { setMenu(null); item.run(); }}>
                  <span>{item.label}</span>
                  <Show when={item.hint}><span class="kbd">{item.hint}</span></Show>
                </div>
              ) : (
                <div class="ctx-sep" />
              )
            }
          </For>
        </div>
      )}
    </Show>
  );
}
