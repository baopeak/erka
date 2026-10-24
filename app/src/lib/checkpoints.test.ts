import { describe, expect, it } from "vitest";
import { artifactKind, markdownBlocks, sourceNote, turnStats, visibleTurns, type TurnList, type TurnRecord } from "./checkpoints";

const rec = (n: number, extra: Partial<TurnRecord> = {}): TurnRecord => ({
  n, kind: n === 0 ? "baseline" : "turn", at: n * 10, started: n * 10 - 5, source: "hook", approximate: false,
  files: 0, added: 0, removed: 0, paths: [], truncated: false, undo_of: null, base_n: n ? n - 1 : null, ...extra,
});

describe("visibleTurns", () => {
  it("lists newest first", () => {
    const list: TurnList = { repo: "/r", enabled: true, repo_off: false, why: null, records: [rec(0), rec(1), rec(2)], first_is_base: false };
    expect(visibleTurns(list).map((r) => r.n)).toEqual([2, 1, 0]);
  });
  it("leaves out the base of the oldest turn once the history is full", () => {
    const list: TurnList = { repo: "/r", enabled: true, repo_off: false, why: null, records: [rec(7), rec(8), rec(9)], first_is_base: true };
    expect(visibleTurns(list).map((r) => r.n)).toEqual([9, 8]);
  });
});

describe("artifactKind", () => {
  it("knows what renders", () => {
    expect(artifactKind("docs/Plan.MD")).toBe("markdown");
    expect(artifactKind("a/b/shot.png")).toBe("image");
    expect(artifactKind("flow.mmd")).toBe("mermaid");
    expect(artifactKind("data.tsv")).toBe("csv");
    expect(artifactKind("src/main.rs")).toBeNull();
    expect(artifactKind("Makefile")).toBeNull();
  });
});

describe("markdownBlocks", () => {
  it("gives each block the line of the source it starts on", () => {
    const src = "# Title\n\nFirst paragraph\nspanning two lines.\n\n- one\n- two\n\n```mermaid\ngraph TD\n```\n";
    const blocks = markdownBlocks(src);
    expect(blocks.map((b) => b.line)).toEqual([1, 3, 6, 9]);
    expect(blocks[0].raw.startsWith("# Title")).toBe(true);
    expect(src.split("\n")[blocks[2].line - 1]).toBe("- one");
  });
  it("copes with a document without a trailing newline and with leading blank lines", () => {
    expect(markdownBlocks("\n\nHello").map((b) => b.line)).toEqual([3]);
    expect(markdownBlocks("")).toEqual([]);
  });
});

describe("turn text", () => {
  it("sums up a turn", () => {
    expect(turnStats({ added: 20, removed: 4 }, "3 files")).toBe("3 files +20 −4");
    expect(turnStats({ added: 0, removed: 0 }, "1 file")).toBe("1 file");
  });
  it("explains approximate and codex boundaries, and says nothing for exact ones", () => {
    expect(sourceNote(rec(1, { approximate: true, source: "idle" }), "gemini")).toMatch(/merged/);
    expect(sourceNote(rec(1), "codex")).toMatch(/turn-complete/);
    expect(sourceNote(rec(1), "claude")).toBe("");
    expect(sourceNote(rec(0, { source: "restart" }), "claude")).toMatch(/resumed/);
  });
});
