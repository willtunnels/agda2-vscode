import { describe, it, expect } from "vitest";
import { Position, Range } from "vscode";
import { makeDefId } from "../src/core/defId.js";
import type { StoredEntry } from "../src/core/sessionState.js";
import { buildDefTree, walkDefTree, type DefNode } from "../src/providers/defTree.js";
import { toAgdaOffset } from "../src/util/offsets.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FILE = "/tmp/test.agda";
const OTHER_FILE = "/tmp/other.agda";

/** Minimal TextDocument mock. */
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

/** Deterministic DefId from a position. */
function idFor(line: number, col: number) {
  return makeDefId(line * 1000 + col);
}

/**
 * Build a self-def entry whose range spans [line, col .. col+length]. The
 * definitionSite's position matches range.start so isSelfDef semantics hold.
 */
function selfDef(line: number, col: number, length: number, atoms: string[]): StoredEntry {
  return {
    range: new Range(line, col, line, col + length),
    atoms,
    isSelfDef: true,
    definitionSite: {
      kind: "sameFile",
      filepath: FILE,
      position: new Position(line, col),
      id: idFor(line, col),
    },
  };
}

/** Build a cross-file entry (not a self-def by our rules since different file). */
function crossFileSelfDef(line: number, col: number, length: number, atoms: string[]): StoredEntry {
  return {
    range: new Range(line, col, line, col + length),
    atoms,
    isSelfDef: false,
    definitionSite: {
      kind: "crossFile",
      filepath: OTHER_FILE,
      offset: toAgdaOffset(1),
      id: idFor(line, col),
    },
  };
}

/** Non-self-def keyword entry (used by effectiveCol lookup). */
function keyword(line: number, col: number, length: number): StoredEntry {
  return {
    range: new Range(line, col, line, col + length),
    atoms: ["keyword"],
    isSelfDef: false,
    definitionSite: null,
  };
}

/** Summary of the tree (name, children) for concise assertions. */
function summarize(tree: readonly DefNode[], doc: any): Array<[string, any[]]> {
  return tree.map((n) => [doc.getText(n.entry.range), summarize(n.children, doc)]);
}

// ---------------------------------------------------------------------------
// buildDefTree tests
// ---------------------------------------------------------------------------

describe("buildDefTree", () => {
  it("places top-level functions as flat roots", () => {
    const source = ["foo : Nat", "bar : Nat", "baz : Nat"].join("\n");
    const doc = mockDocument(source);
    const entries = [
      selfDef(0, 0, 3, ["function"]),
      selfDef(1, 0, 3, ["function"]),
      selfDef(2, 0, 3, ["function"]),
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      ["foo", []],
      ["bar", []],
      ["baz", []],
    ]);
  });

  it("nests data-type constructors under the datatype (keyword-column fixup)", () => {
    // data keyword at col 0; `Nat` identifier at col 5; constructors at col 2.
    // Without the keyword-column fixup, Nat's col would be 5 and the
    // constructors at col 2 would wrongly become siblings.
    const source = ["data Nat where", "  zero : Nat", "  suc : Nat"].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 4), // "data"
      selfDef(0, 5, 3, ["datatype"]),
      selfDef(1, 2, 4, ["inductiveconstructor"]),
      selfDef(2, 2, 3, ["inductiveconstructor"]),
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      [
        "Nat",
        [
          ["zero", []],
          ["suc", []],
        ],
      ],
    ]);
  });

  it("nests record fields and constructor under the record", () => {
    const source = [
      "record Pair : Set where",
      "  constructor _,_",
      "  field",
      "    fst : Set",
      "    snd : Set",
    ].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 6), // "record"
      selfDef(0, 7, 4, ["record"]),
      // `constructor _,_`: only the `_,_` identifier is a self-def.
      selfDef(1, 14, 3, ["inductiveconstructor"]),
      selfDef(3, 4, 3, ["field"]),
      selfDef(4, 4, 3, ["field"]),
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      [
        "Pair",
        [
          ["_,_", []],
          ["fst", []],
          ["snd", []],
        ],
      ],
    ]);
  });

  it("nests named sub-modules under their parent module scope", () => {
    const source = ["module Inner where", "  triple : Nat", "other : Nat"].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 6), // "module"
      selfDef(0, 7, 5, ["module"]),
      selfDef(1, 2, 6, ["function"]),
      selfDef(2, 0, 5, ["function"]),
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      ["Inner", [["triple", []]]],
      ["other", []],
    ]);
  });

  it("nests where-clause definitions under their function", () => {
    const source = [
      "double : Nat",
      "double n = helper n",
      "  where",
      "    helper : Nat",
      "    helper x = x",
    ].join("\n");
    const doc = mockDocument(source);
    const entries = [
      selfDef(0, 0, 6, ["function"]), // double signature
      selfDef(1, 0, 6, ["function"]), // double clause (same DefId)
      selfDef(3, 4, 6, ["function"]), // helper sig
      selfDef(4, 4, 6, ["function"]), // helper clause
    ];
    // double's canonical entry is the earliest (sig at line 0).
    // helper's canonical entry is its sig at line 3, col 4.
    // Multiple occurrences of the same DefId should dedupe to one canonical.
    const tree = buildDefTree(entries, doc);
    // Both double-sig and double-clause share a DefId (via our selfDef helper
    // they have different positions, so different DefIds) -- so we need to
    // verify the dedup logic separately. Here we just check nesting.
    expect(summarize(tree, doc)).toHaveLength(2);
  });

  it("dedupes multiple self-def entries that share a DefId (earliest wins)", () => {
    // Simulate signature + clause LHS for the same function: two entries, same
    // definitionSite.position, same DefId. The canonical entry should be the
    // earliest-range one.
    const doc = mockDocument(["foo : Nat", "foo = 0"].join("\n"));
    const sig = selfDef(0, 0, 3, ["function"]);
    const clause: StoredEntry = {
      ...selfDef(1, 0, 3, ["function"]),
      definitionSite: sig.definitionSite, // share the same DefId
    };
    const tree = buildDefTree([sig, clause], doc);
    expect(tree).toHaveLength(1);
    // Canonical entry is the signature at line 0, not the clause at line 1.
    expect(tree[0].entry.range.start.line).toBe(0);
  });

  it("excludes entries with atom 'bound' (lambda/pattern variables)", () => {
    const doc = mockDocument("f x = x");
    const entries = [
      selfDef(0, 0, 1, ["function"]),
      selfDef(0, 2, 1, ["bound"]), // pattern variable `x`
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([["f", []]]);
  });

  it("excludes cross-file definition sites", () => {
    const doc = mockDocument("Set : Set");
    const entries = [crossFileSelfDef(0, 0, 3, ["primitive"]), selfDef(0, 6, 3, ["function"])];
    const tree = buildDefTree(entries, doc);
    expect(tree).toHaveLength(1);
    // Only the same-file entry remains.
    expect(doc.getText(tree[0].entry.range)).toBe("Set");
  });

  it("flattens anonymous `module _ (params) where` into the surrounding scope", () => {
    const source = ["module _ (s : Set) where", "  foo : Set", "  bar : Set"].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 6), // "module"
      selfDef(0, 7, 1, ["module"]), // the `_` — anonymous
      selfDef(1, 2, 3, ["function"]),
      selfDef(2, 2, 3, ["function"]),
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      ["foo", []],
      ["bar", []],
    ]);
  });

  it("handles nested anonymous modules by hoisting inner entries further up", () => {
    const source = [
      "module _ (s : Set) where",
      "  module _ (n : Set) where",
      "    foo : Set",
      "  bar : Set",
    ].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 6), // outer "module"
      selfDef(0, 7, 1, ["module"]), // outer `_`
      keyword(1, 2, 6), // inner "module"
      selfDef(1, 9, 1, ["module"]), // inner `_`
      selfDef(2, 4, 3, ["function"]),
      selfDef(3, 2, 3, ["function"]),
    ];
    // Both `foo` (inside the inner `_`) and `bar` (inside the outer `_`) hoist
    // to the top level. They become peer roots.
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      ["foo", []],
      ["bar", []],
    ]);
  });

  it("keeps named modules while flattening adjacent anonymous modules", () => {
    const source = ["module Named where", "  foo : Set", "module _ where", "  bar : Set"].join(
      "\n",
    );
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 0, 6), // "module"
      selfDef(0, 7, 5, ["module"]), // Named
      selfDef(1, 2, 3, ["function"]), // foo
      keyword(2, 0, 6), // "module"
      selfDef(2, 7, 1, ["module"]), // `_`
      selfDef(3, 2, 3, ["function"]), // bar
    ];
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([
      ["Named", [["foo", []]]],
      ["bar", []],
    ]);
  });

  it("applies keyword-column fixup for record and module too", () => {
    // Record token deeper than `record` keyword.
    const source = ["  record R : Set where", "    field", "      x : Set"].join("\n");
    const doc = mockDocument(source);
    const entries = [
      keyword(0, 2, 6), // "record" at col 2
      selfDef(0, 9, 1, ["record"]), // R at col 9 -- but effective col should be 2
      selfDef(2, 6, 1, ["field"]),
    ];
    // x's col is 6 > 2, so x nests under R.
    expect(summarize(buildDefTree(entries, doc), doc)).toEqual([["R", [["x", []]]]]);
  });
});

// ---------------------------------------------------------------------------
// walkDefTree tests
// ---------------------------------------------------------------------------

describe("walkDefTree", () => {
  it("yields nothing for an empty tree", () => {
    expect([...walkDefTree([])]).toEqual([]);
  });

  it("visits nodes in depth-first order", () => {
    const doc = mockDocument(["data Nat where", "  zero : Nat", "  suc : Nat"].join("\n"));
    const entries = [
      keyword(0, 0, 4),
      selfDef(0, 5, 3, ["datatype"]),
      selfDef(1, 2, 4, ["inductiveconstructor"]),
      selfDef(2, 2, 3, ["inductiveconstructor"]),
    ];
    const tree = buildDefTree(entries, doc);
    const names = [...walkDefTree(tree)].map((n) => doc.getText(n.entry.range));
    expect(names).toEqual(["Nat", "zero", "suc"]);
  });
});
