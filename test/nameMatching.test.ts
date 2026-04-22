import { describe, it, expect } from "vitest";
import { Position, Range } from "vscode";
import { makeDefId, defIdEq, type DefId } from "../src/core/defId.js";
import type { StoredEntry } from "../src/core/sessionState.js";
import type { DefNode } from "../src/providers/defTree.js";
import { buildNameToIdMap, displayType, matchContents } from "../src/providers/nameMatching.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FILE = "/tmp/test.agda";

function mockDocument(text: string) {
  const lines = text.split("\n");
  function offsetAt(pos: Position): number {
    let o = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) o += lines[i].length + 1;
    return o + Math.min(pos.character, (lines[pos.line] ?? "").length);
  }
  return {
    uri: { toString: () => FILE, fsPath: FILE },
    getText(range?: Range) {
      if (!range) return text;
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    lineAt(line: number) {
      return {
        text: lines[line] ?? "",
        range: new Range(line, 0, line, (lines[line] ?? "").length),
      };
    },
    languageId: "agda",
  } as any;
}

/** Construct a DefNode directly (bypasses buildDefTree so tests are focused). */
function node(line: number, col: number, length: number, children: DefNode[] = []): DefNode {
  const id = makeDefId(line * 1000 + col);
  const entry: StoredEntry = {
    range: new Range(line, col, line, col + length),
    atoms: ["function"],
    isSelfDef: true,
    definitionSite: {
      kind: "sameFile",
      filepath: FILE,
      position: new Position(line, col),
      id,
    },
  };
  return { entry, id, children };
}

function containsId(list: [DefId, unknown][], id: DefId): boolean {
  return list.some(([other]) => defIdEq(other, id));
}

// ---------------------------------------------------------------------------
// displayType
// ---------------------------------------------------------------------------

describe("displayType", () => {
  it("collapses newlines to single spaces", () => {
    expect(displayType("{A : Set}\n→ A → A")).toBe("{A : Set} → A → A");
  });

  it("collapses runs of spaces and tabs", () => {
    expect(displayType("a    b\t\tc")).toBe("a b c");
  });

  it("collapses mixed whitespace including CR/LF", () => {
    expect(displayType("a \r\n b\n\n\tc ")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(displayType("   hello   ")).toBe("hello");
  });

  it("leaves single-word terms alone", () => {
    expect(displayType("Nat")).toBe("Nat");
  });
});

// ---------------------------------------------------------------------------
// buildNameToIdMap
// ---------------------------------------------------------------------------

describe("buildNameToIdMap", () => {
  it("returns a map over a flat subtree", () => {
    const doc = mockDocument("foo bar baz");
    const tree = [node(0, 0, 3), node(0, 4, 3), node(0, 8, 3)];
    const map = buildNameToIdMap(doc, tree);
    expect([...map.keys()].sort()).toEqual(["bar", "baz", "foo"]);
  });

  it("walks into children (flat over the whole subtree)", () => {
    const doc = mockDocument("parent\n  child\n  sibling");
    const tree = [node(0, 0, 6, [node(1, 2, 5), node(2, 2, 7)])];
    const map = buildNameToIdMap(doc, tree);
    expect([...map.keys()].sort()).toEqual(["child", "parent", "sibling"]);
  });

  it("keeps the first occurrence when names collide", () => {
    const doc = mockDocument("foo\nfoo");
    const first = node(0, 0, 3);
    const second = node(1, 0, 3);
    const map = buildNameToIdMap(doc, [first, second]);
    expect(defIdEq(map.get("foo")!, first.id)).toBe(true);
    expect(defIdEq(map.get("foo")!, second.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchContents
// ---------------------------------------------------------------------------

describe("matchContents", () => {
  it("matches names against the subtree and returns their types", () => {
    const doc = mockDocument("foo bar");
    const tree = [node(0, 0, 3), node(0, 4, 3)];
    const added = new Set<DefId>();
    const result = matchContents(
      doc,
      tree,
      [
        { name: "foo", term: "Nat" },
        { name: "bar", term: "Nat" },
      ],
      added,
    );
    expect(result).toHaveLength(2);
    expect(result.map(([, info]) => info.name).sort()).toEqual(["bar", "foo"]);
    expect(result.every(([, info]) => info.type === "Nat")).toBe(true);
  });

  it("ignores names that have no matching node", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3)];
    const added = new Set<DefId>();
    const result = matchContents(
      doc,
      tree,
      [
        { name: "foo", term: "Nat" },
        { name: "missing", term: "Set" },
      ],
      added,
    );
    expect(result).toHaveLength(1);
    expect(result[0][1].name).toBe("foo");
  });

  it("adds matched DefIds to the addedIds set", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3)];
    const added = new Set<DefId>();
    matchContents(doc, tree, [{ name: "foo", term: "Nat" }], added);
    expect(added.size).toBe(1);
    expect(added.has(tree[0].id)).toBe(true);
  });

  it("skips names whose DefId is already in addedIds", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3)];
    const added = new Set<DefId>([tree[0].id]);
    const result = matchContents(doc, tree, [{ name: "foo", term: "Should be ignored" }], added);
    expect(result).toHaveLength(0);
  });

  it("applies displayType to the term before storing", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3)];
    const added = new Set<DefId>();
    const result = matchContents(doc, tree, [{ name: "foo", term: "{A : Set}\n→ A\n→ A" }], added);
    expect(result[0][1].type).toBe("{A : Set} → A → A");
  });

  it("scope-limits matching so a name in one subtree doesn't match another", () => {
    // Two separate subtrees each containing a `fst`.
    const doc = mockDocument("record1 fst record2 fst");
    //                           0     8   12      20
    const record1Fst = node(0, 8, 3);
    const record2Fst = node(0, 20, 3);
    const record1: DefNode = { ...node(0, 0, 7), children: [record1Fst] };
    const record2: DefNode = { ...node(0, 12, 7), children: [record2Fst] };

    // Match against record1's subtree only: should pick record1's fst.
    const added = new Set<DefId>();
    const result = matchContents(doc, [record1], [{ name: "fst", term: "A" }], added);
    expect(result).toHaveLength(1);
    expect(defIdEq(result[0][0], record1Fst.id)).toBe(true);
    expect(defIdEq(result[0][0], record2Fst.id)).toBe(false);
  });
});
