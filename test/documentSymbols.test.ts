import { describe, it, expect } from "vitest";
import { Position, Range, SymbolKind } from "vscode";
import { makeDefId, type DefId } from "../src/core/defId.js";
import type { NameInfo, StoredEntry } from "../src/core/sessionState.js";
import type { DefNode } from "../src/providers/defTree.js";
import { treeToSymbols } from "../src/providers/documentSymbols.js";

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

function node(
  line: number,
  col: number,
  length: number,
  atoms: string[],
  children: DefNode[] = [],
): DefNode {
  const id = makeDefId(line * 1000 + col + 1); // +1 avoids DefId=0
  const entry: StoredEntry = {
    range: new Range(line, col, line, col + length),
    atoms,
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

// ---------------------------------------------------------------------------
// treeToSymbols
// ---------------------------------------------------------------------------

describe("treeToSymbols", () => {
  it("maps atoms to the right SymbolKind", () => {
    const doc = mockDocument(
      "foo bar Baz Qux fld Mod ctor pst",
      // 0   4   8   12  16  20  24   29
    );
    const tree = [
      node(0, 0, 3, ["function"]),
      node(0, 4, 3, ["macro"]),
      node(0, 8, 3, ["datatype"]),
      node(0, 12, 3, ["record"]),
      node(0, 16, 3, ["field"]),
      node(0, 20, 3, ["module"]),
      node(0, 24, 4, ["inductiveconstructor"]),
      node(0, 29, 3, ["postulate"]),
    ];
    const symbols = treeToSymbols(doc, tree, () => undefined);
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ["foo", SymbolKind.Function],
      ["bar", SymbolKind.Function],
      ["Baz", SymbolKind.Class],
      ["Qux", SymbolKind.Struct],
      ["fld", SymbolKind.Field],
      ["Mod", SymbolKind.Namespace],
      ["ctor", SymbolKind.Constructor],
      ["pst", SymbolKind.Variable],
    ]);
  });

  it("attaches name-info type as the symbol detail", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3, ["function"])];
    const info: NameInfo = { name: "foo", type: "Nat → Nat" };
    const symbols = treeToSymbols(doc, tree, (id) => (id === tree[0].id ? info : undefined));
    expect(symbols[0].detail).toBe("Nat → Nat");
  });

  it("leaves detail empty when no name-info is present", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3, ["function"])];
    const symbols = treeToSymbols(doc, tree, () => undefined);
    expect(symbols[0].detail).toBe("");
  });

  it("prunes children of function-like nodes (where-clause locals)", () => {
    // `mk-aps` (function) with two where-clause children that should be hidden.
    const doc = mockDocument(
      ["mk-aps = ...", "  where", "    helper1 : ...", "    helper2 : ..."].join("\n"),
    );
    const helper1 = node(2, 4, 7, ["function"]);
    const helper2 = node(3, 4, 7, ["function"]);
    const mkaps = node(0, 0, 6, ["function"], [helper1, helper2]);
    const symbols = treeToSymbols(doc, [mkaps], () => undefined);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("mk-aps");
    expect(symbols[0].children).toEqual([]);
  });

  it("prunes recursively: nested where-clauses under a pruned node are also dropped", () => {
    // outer (function) → inner (function) → deep (function).
    // Pruning at outer means inner and deep never get rendered.
    const doc = mockDocument(["outer", "  inner", "    deep"].join("\n"));
    const deep = node(2, 4, 4, ["function"]);
    const inner = node(1, 2, 5, ["function"], [deep]);
    const outer = node(0, 0, 5, ["function"], [inner]);
    const symbols = treeToSymbols(doc, [outer], () => undefined);
    expect(symbols[0].children).toEqual([]);
  });

  it("keeps children under non-function-like parents", () => {
    // Data type with two constructors: children should be preserved.
    const doc = mockDocument(["data Nat where", "  zero : Nat", "  suc : Nat"].join("\n"));
    const zero = node(1, 2, 4, ["inductiveconstructor"]);
    const suc = node(2, 2, 3, ["inductiveconstructor"]);
    const Nat = node(0, 5, 3, ["datatype"], [zero, suc]);
    const symbols = treeToSymbols(doc, [Nat], () => undefined);
    expect(symbols[0].name).toBe("Nat");
    expect(symbols[0].children.map((s) => s.name)).toEqual(["zero", "suc"]);
  });

  it("keeps record children including private let-bindings (atom=function)", () => {
    // Mirrors the `cs = ...` private in AnchorProxyOracles: a function-atom
    // child of a record should still appear in the outline because the parent
    // isn't function-like.
    const doc = mockDocument(["record R where", "  cs = ...", "  field", "    x : Set"].join("\n"));
    const cs = node(1, 2, 2, ["function"]);
    const x = node(3, 4, 1, ["field"]);
    const R = node(0, 7, 1, ["record"], [cs, x]);
    const symbols = treeToSymbols(doc, [R], () => undefined);
    expect(symbols[0].children.map((s) => s.name)).toEqual(["cs", "x"]);
  });

  it("keeps module children", () => {
    const doc = mockDocument(["module Inner where", "  foo : Set"].join("\n"));
    const foo = node(1, 2, 3, ["function"]);
    const Inner = node(0, 7, 5, ["module"], [foo]);
    const symbols = treeToSymbols(doc, [Inner], () => undefined);
    expect(symbols[0].children.map((s) => s.name)).toEqual(["foo"]);
  });

  it("preserves range and selectionRange from the self-def entry", () => {
    const doc = mockDocument("foo");
    const tree = [node(0, 0, 3, ["function"])];
    const symbols = treeToSymbols(doc, tree, () => undefined);
    const s = symbols[0];
    expect(s.range.isEqual(new Range(0, 0, 0, 3))).toBe(true);
    expect(s.selectionRange.isEqual(new Range(0, 0, 0, 3))).toBe(true);
  });
});
