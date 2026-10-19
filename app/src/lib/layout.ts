// Pure split-tree operations. Every function returns a new tree (immutable), so the store
// can swap a tab's root in one write and Solid only re-renders the changed subtree.
import type { LayoutNode, LeafNode, Pane, SplitNode } from "./types";
import { uid } from "./platform";

export const leaf = (pane: Pane): LeafNode => ({ type: "leaf", id: uid(), pane });

export function allPanes(node: LayoutNode): Pane[] {
  return node.type === "leaf" ? [node.pane] : [...allPanes(node.a), ...allPanes(node.b)];
}

export function findPane(node: LayoutNode, paneId: string): Pane | undefined {
  return allPanes(node).find((p) => p.id === paneId);
}

/** Splits the leaf holding `paneId`; the new pane goes after (right / below) it. */
export function splitPane(node: LayoutNode, paneId: string, pane: Pane, dir: "row" | "col"): LayoutNode {
  if (node.type === "leaf") {
    if (node.pane.id !== paneId) return node;
    const split: SplitNode = { type: "split", id: uid(), dir, ratio: 0.5, a: node, b: leaf(pane) };
    return split;
  }
  const a = splitPane(node.a, paneId, pane, dir);
  const b = a === node.a ? splitPane(node.b, paneId, pane, dir) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Removes a pane; its sibling takes the parent's place. Returns null when the tree empties. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "leaf") return node.pane.id === paneId ? null : node;
  const a = removePane(node.a, paneId);
  const b = removePane(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function replacePane(node: LayoutNode, paneId: string, pane: Pane): LayoutNode {
  if (node.type === "leaf") return node.pane.id === paneId ? { ...node, pane } : node;
  const a = replacePane(node.a, paneId, pane);
  const b = replacePane(node.b, paneId, pane);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  const a = setRatio(node.a, splitId, ratio);
  const b = setRatio(node.b, splitId, ratio);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Next/previous pane in reading order (wraps). */
export function cyclePane(node: LayoutNode, paneId: string, delta: 1 | -1): string {
  const panes = allPanes(node);
  const i = panes.findIndex((p) => p.id === paneId);
  return panes[(i + delta + panes.length) % panes.length]?.id ?? paneId;
}
