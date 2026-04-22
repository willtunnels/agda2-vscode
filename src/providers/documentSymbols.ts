// Document outline, built from the shared def-tree.
//
// Maps atoms to VS Code SymbolKind and attaches type info from
// SessionState.getNameInfo as the detail string. Where-clause locals
// (children of function-like nodes) are pruned -- they clutter the outline
// and Agda's interaction protocol doesn't expose their types anyway.
//
// Note on refresh: VS Code's DocumentSymbolProvider has no onDidChange event
// (longstanding issue microsoft/vscode#71454). To force the outline view to
// re-query after Agda streams new state, the provider owns its registration
// and re-registers (debounced) on state.onDidChange.

import * as vscode from "vscode";
import type { DefId } from "../core/defId.js";
import type { NameInfo, SessionState } from "../core/sessionState.js";
import { buildDefTree, type DefNode } from "./defTree.js";

/** Map atoms from a self-def entry to a VS Code SymbolKind. First match wins. */
function kindFor(atoms: readonly string[]): vscode.SymbolKind {
  if (atoms.includes("module")) return vscode.SymbolKind.Namespace;
  if (atoms.includes("datatype")) return vscode.SymbolKind.Class;
  if (atoms.includes("record")) return vscode.SymbolKind.Struct;
  if (atoms.includes("inductiveconstructor") || atoms.includes("coinductiveconstructor")) {
    return vscode.SymbolKind.Constructor;
  }
  if (atoms.includes("field")) return vscode.SymbolKind.Field;
  if (atoms.includes("function")) return vscode.SymbolKind.Function;
  if (atoms.includes("macro")) return vscode.SymbolKind.Function;
  if (atoms.includes("postulate")) return vscode.SymbolKind.Variable;
  if (atoms.includes("primitive") || atoms.includes("primitivetype"))
    return vscode.SymbolKind.Function;
  if (atoms.includes("generalizable")) return vscode.SymbolKind.Variable;
  return vscode.SymbolKind.Variable;
}

/**
 * True if the entry defines something that can have a `where` clause (and
 * hence local definitions we want to hide from the outline). Only functions
 * and macros qualify in Agda -- data types, records, and modules can contain
 * nested declarations, but those are legitimate outline entries.
 */
function isFunctionLike(atoms: readonly string[]): boolean {
  return atoms.includes("function") || atoms.includes("macro");
}

/**
 * Pure transformation from a def tree to VS Code DocumentSymbols. Skips
 * children of function-like nodes so `where`-clause locals are omitted.
 * Exposed (not just used by the provider) so it can be tested without a
 * SessionState instance.
 */
export function treeToSymbols(
  document: vscode.TextDocument,
  tree: readonly DefNode[],
  getNameInfo: (id: DefId) => NameInfo | undefined,
): vscode.DocumentSymbol[] {
  return tree.map((node) => nodeToSymbol(document, node, getNameInfo));
}

function nodeToSymbol(
  document: vscode.TextDocument,
  node: DefNode,
  getNameInfo: (id: DefId) => NameInfo | undefined,
): vscode.DocumentSymbol {
  const { entry } = node;
  const name = document.getText(entry.range);
  const kind = kindFor(entry.atoms);
  const info = getNameInfo(node.id);
  const detail = info?.type ?? "";

  const symbol = new vscode.DocumentSymbol(name, detail, kind, entry.range, entry.range);

  if (!isFunctionLike(entry.atoms)) {
    for (const child of node.children) {
      symbol.children.push(nodeToSymbol(document, child, getNameInfo));
    }
  }
  return symbol;
}

export class AgdaDocumentSymbolProvider
  implements vscode.DocumentSymbolProvider, vscode.Disposable
{
  private registration?: vscode.Disposable;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly state: SessionState,
    private readonly selector: vscode.DocumentSelector,
  ) {
    this.register();
    this.sub = state.onDidChange(() => this.scheduleRefresh());
  }

  private register(): void {
    this.registration?.dispose();
    this.registration = vscode.languages.registerDocumentSymbolProvider(this.selector, this);
  }

  /**
   * Debounce-schedule a re-registration. Streaming highlighting payloads fire
   * onDidChange many times during a load; collapse them so we only re-register
   * once the burst settles.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.register();
    }, 300);
  }

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const uri = document.uri.toString();
    if (!this.state.hasLoaded(uri)) return [];

    const tree = buildDefTree(this.state.getEntries(uri), document);
    return treeToSymbols(document, tree, (id) => this.state.getNameInfo(uri, id));
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.registration?.dispose();
    this.sub.dispose();
  }
}
