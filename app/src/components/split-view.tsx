import { Show, createMemo, createSignal } from "solid-js";
import { store } from "../lib/store";
import { allPanes } from "../lib/layout";
import type { LayoutNode, LeafNode, Project, SplitNode, Tab } from "../lib/types";
import { PaneView } from "./pane-view";

/** Renders a tab's split tree. Nodes are keyed by id so splitting one pane keeps the others. */
export function SplitView(props: { project: Project; tab: Tab }) {
  const multi = createMemo(() => allPanes(props.tab.root).length > 1);
  return (
    <div class={multi() ? "multi" : ""} style={{ position: "absolute", inset: 0 }}>
      <NodeView node={props.tab.root} project={props.project} tab={props.tab} />
    </div>
  );
}

// Keyed by node id (not object identity): resizing produces new node objects but must not
// remount the terminals inside. A given id never changes type.
function NodeView(props: { node: LayoutNode; project: Project; tab: Tab }) {
  return (
    <Show when={props.node.id} keyed>
      {(_id) =>
        props.node.type === "leaf" ? (
          <PaneView pane={(props.node as LeafNode).pane} project={props.project} tab={props.tab} />
        ) : (
          <SplitNodeView node={props.node as SplitNode} project={props.project} tab={props.tab} />
        )
      }
    </Show>
  );
}

function SplitNodeView(props: { node: SplitNode; project: Project; tab: Tab }) {
  let container!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio = props.node.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      store.resizeSplit(props.project.id, props.tab.id, props.node.id, ratio);
    };
    const up = () => {
      setDragging(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const basis = (r: number) => `calc(${r * 100}% - 0.5px)`;
  return (
    <div ref={container} class={`split ${props.node.dir}`}>
      <div class="child" style={{ "flex-basis": basis(props.node.ratio), "flex-grow": 0, "flex-shrink": 0 }}>
        <NodeView node={props.node.a} project={props.project} tab={props.tab} />
      </div>
      <div class={`gutter${dragging() ? " dragging" : ""}`} onPointerDown={startDrag} />
      <div class="child" style={{ flex: 1 }}>
        <NodeView node={props.node.b} project={props.project} tab={props.tab} />
      </div>
    </div>
  );
}
