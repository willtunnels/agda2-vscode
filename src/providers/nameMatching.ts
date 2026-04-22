// Name-to-DefId matching for ModuleContents responses.
//
// The post-load fetch (src/editor/commands.ts fetchNameInfo) asks Agda for
// type info via Cmd_show_module_contents_toplevel and joins the response's
// name-term pairs to StoredEntry DefIds. These helpers are the join logic,
// extracted so they can be tested against a mock document without booting a
// full Agda process.

import * as vscode from "vscode";
import type { NameTypePair } from "../agda/responses.js";
import type { DefId } from "../core/defId.js";
import type { NameInfo } from "../core/sessionState.js";
import { walkDefTree, type DefNode } from "./defTree.js";

/** Collapse any runs of whitespace to a single space for one-line display. */
export function displayType(term: string): string {
  return term.replace(/\s+/g, " ").trim();
}

/**
 * Flat walk of a subtree, yielding a name → DefId map. Names are the text at
 * each node's entry range; the first occurrence wins if duplicated.
 */
export function buildNameToIdMap(
  document: vscode.TextDocument,
  scope: readonly DefNode[],
): Map<string, DefId> {
  const m = new Map<string, DefId>();
  for (const node of walkDefTree(scope)) {
    const name = document.getText(node.entry.range);
    if (!m.has(name)) m.set(name, node.id);
  }
  return m;
}

/**
 * Match a ModuleContents response's `contents` list against tree nodes in a
 * subtree, returning `[DefId, NameInfo][]` pairs. Names already in
 * `addedIds` are skipped (so a later sub-namespace pass doesn't overwrite
 * a top-level match). Successfully matched DefIds are added to `addedIds`.
 */
export function matchContents(
  document: vscode.TextDocument,
  scope: readonly DefNode[],
  contents: readonly { name: string; term: string }[],
  addedIds: Set<DefId>,
): [DefId, NameInfo][] {
  const map = buildNameToIdMap(document, scope);
  const out: [DefId, NameInfo][] = [];
  for (const { name, term } of contents) {
    const id = map.get(name);
    // `undefined` means no match. DefId's runtime representation is a number
    // that may legitimately be 0 (or any other falsy number), so use an
    // explicit undefined check instead of truthiness.
    if (id !== undefined && !addedIds.has(id)) {
      out.push([id, { name, type: displayType(term) }]);
      addedIds.add(id);
    }
  }
  return out;
}

/** Minimal ModuleContents shape needed by collectNameInfo. */
export interface ModuleContentsResponse {
  contents: readonly NameTypePair[];
  names: readonly string[];
}

export type FetchModuleContents = (qname: string) => Promise<ModuleContentsResponse | undefined>;

/**
 * Recursively walk the def tree, fetching show_module_contents at each
 * module/record scope and joining responses to DefIds.
 *
 * Skip heuristics (to avoid wasted round-trips):
 *   - Container def-node has no children -- nothing in its subtree to match.
 *   - Container's atom is `datatype` -- its constructors are already surfaced
 *     in the enclosing scope's contents, so recursion only duplicates work
 *     that `addedIds` would dedupe.
 *
 * Anonymous `module _` needs no special handling: buildDefTree already hoists
 * their children into the outer scope, and Agda's `names` / qualified paths
 * elide `_` (so plain "parent.child" concatenation produces the right path).
 */
export async function collectNameInfo(
  document: vscode.TextDocument,
  tree: readonly DefNode[],
  fetch: FetchModuleContents,
): Promise<Array<[DefId, NameInfo]>> {
  const nameInfo: Array<[DefId, NameInfo]> = [];
  const addedIds = new Set<DefId>();
  await walk("", tree);
  return nameInfo;

  async function walk(qname: string, scope: readonly DefNode[]): Promise<void> {
    const mc = await fetch(qname);
    if (!mc) return;
    nameInfo.push(...matchContents(document, scope, mc.contents, addedIds));

    // Candidates for sub-namespace recursion. Agda's `names` lists the direct
    // sub-namespaces of the queried module. In our def tree:
    //   - At top-level (qname === ""), the queried "module" is the file
    //     module itself, whose same-column siblings (the top-level decls)
    //     are peer roots in the tree rather than its children -- so the
    //     tree roots ARE the candidates.
    //   - At nested levels, scope is a single parent node and its direct
    //     children are the candidates.
    const candidates: readonly DefNode[] = qname === "" ? scope : (scope[0]?.children ?? []);

    const childrenByName = new Map<string, DefNode>();
    for (const c of candidates) {
      const name = document.getText(c.entry.range);
      if (!childrenByName.has(name)) childrenByName.set(name, c);
    }

    for (const subName of mc.names) {
      const child = childrenByName.get(subName);
      if (!child) continue;
      if (child.children.length === 0) continue;
      if (!isNamespace(child.entry.atoms)) continue;
      const sub = qname === "" ? subName : `${qname}.${subName}`;
      await walk(sub, [child]);
    }
  }
}

/**
 * True if this node's atoms mark it as a module or record -- something whose
 * nested contents live in its own namespace and aren't already surfaced by
 * the enclosing scope's `contents`.
 */
function isNamespace(atoms: readonly string[]): boolean {
  return atoms.includes("module") || atoms.includes("record");
}
