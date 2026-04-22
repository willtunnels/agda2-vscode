// Shared tree-building logic for document symbols and name-info scoping.
//
// Walks self-def highlighting entries in source order, applies a column-stack
// indent heuristic (with keyword-column fixup for module / data / record /
// postulate / primitive), and returns a tree of DefNodes. Both
// AgdaDocumentSymbolProvider and the post-load name-info fetch consume this
// tree: the outline to render a DocumentSymbol hierarchy, the fetch to scope
// ModuleContents name-matching to each namespace's actual children.

import * as vscode from "vscode";
import type { DefId } from "../core/defId.js";
import type { StoredEntry } from "../core/sessionState.js";

export interface DefNode {
  entry: StoredEntry;
  id: DefId;
  children: DefNode[];
}

/**
 * Atoms whose effective indent should come from a preceding keyword rather
 * than the identifier column. e.g. `data Bool` — the `Bool` token is at the
 * column after `data `, but for nesting purposes we want the `data` column.
 */
const KEYWORD_FOR_ATOM: Record<string, string> = {
  module: "module",
  datatype: "data",
  record: "record",
  postulate: "postulate",
  primitive: "primitive",
};

/** Text values we bother to index — union of KEYWORD_FOR_ATOM's values. */
const KEYWORDS = new Set(Object.values(KEYWORD_FOR_ATOM));

export function buildDefTree(
  entries: readonly StoredEntry[],
  document: vscode.TextDocument,
): DefNode[] {
  const keywordIndex = buildKeywordIndex(entries, document);

  // Collect canonical self-def per DefId (earliest range wins).
  const canonical = new Map<DefId, StoredEntry>();
  for (const e of entries) {
    if (!e.isSelfDef || !e.definitionSite || e.definitionSite.kind !== "sameFile") continue;
    if (e.atoms.includes("bound")) continue;
    const id = e.definitionSite.id;
    const existing = canonical.get(id);
    if (!existing || e.range.start.isBefore(existing.range.start)) {
      canonical.set(id, e);
    }
  }

  // Sort by source position.
  const defs = [...canonical.values()].sort(byStart);

  const effectiveCol = (entry: StoredEntry): number => {
    for (const atom of entry.atoms) {
      const kw = KEYWORD_FOR_ATOM[atom];
      if (!kw) continue;
      const kwCol = findPrecedingKeywordCol(keywordIndex, entry, kw);
      if (kwCol !== undefined) return kwCol;
    }
    return entry.range.start.character;
  };

  // Indent-column stack.
  const roots: DefNode[] = [];
  const stack: { node: DefNode; col: number }[] = [];

  for (const e of defs) {
    const col = effectiveCol(e);
    while (stack.length > 0 && stack[stack.length - 1].col >= col) stack.pop();

    // Anonymous `module _ (params) where` is a parameter-sharing construct,
    // not a structural container -- Agda semantically merges its contents
    // into the surrounding scope (appending the module's params to each
    // member's type). Pop happened above so sibling defs at the same column
    // are handled correctly; skip the push so the inner entries hoist up to
    // whatever scope `_` was living in.
    if (isAnonymousModule(e, document)) continue;

    const node: DefNode = {
      entry: e,
      id: e.definitionSite!.id, // guarded by filter above
      children: [],
    };

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, col });
  }

  return roots;
}

function isAnonymousModule(entry: StoredEntry, document: vscode.TextDocument): boolean {
  return entry.atoms.includes("module") && document.getText(entry.range) === "_";
}

/**
 * Walk a tree depth-first, yielding every node.
 */
export function* walkDefTree(tree: readonly DefNode[]): Iterable<DefNode> {
  for (const node of tree) {
    yield node;
    yield* walkDefTree(node.children);
  }
}

function byStart(a: StoredEntry, b: StoredEntry): number {
  if (a.range.start.line !== b.range.start.line) {
    return a.range.start.line - b.range.start.line;
  }
  return a.range.start.character - b.range.start.character;
}

/**
 * Bucket keyword entries by text (for keywords in KEYWORDS) so
 * findPrecedingKeywordCol can do a binary-search predecessor lookup instead
 * of a full linear scan per query.
 */
function buildKeywordIndex(
  entries: readonly StoredEntry[],
  document: vscode.TextDocument,
): Map<string, StoredEntry[]> {
  const index = new Map<string, StoredEntry[]>();
  for (const e of entries) {
    if (!e.atoms.includes("keyword")) continue;
    const text = document.getText(e.range);
    if (!KEYWORDS.has(text)) continue;
    let arr = index.get(text);
    if (!arr) {
      arr = [];
      index.set(text, arr);
    }
    arr.push(e);
  }
  // Agda emits in source order so buckets are already sorted, but sort
  // defensively so the binary search stays correct if that ever changes.
  for (const arr of index.values()) arr.sort(byStart);
  return index;
}

/**
 * Column of the nearest `keyword`-atom entry with text `kw` whose start is
 * not after `target.range.start`. Used to derive the effective indent of
 * `data X` / `record X` / `module X where` / `postulate\n  X` declarations.
 */
function findPrecedingKeywordCol(
  index: Map<string, StoredEntry[]>,
  target: StoredEntry,
  kw: string,
): number | undefined {
  const arr = index.get(kw);
  if (!arr) return undefined;
  const targetStart = target.range.start;
  // Rightmost i such that arr[i].range.start is not after targetStart.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].range.start.isAfter(targetStart)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo === 0 ? undefined : arr[lo - 1].range.start.character;
}
