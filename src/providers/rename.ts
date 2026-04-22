import * as vscode from "vscode";
import type { SessionState } from "../core/sessionState.js";
import { rangeContains } from "../util/position.js";
import {
  RENAMEABLE_TYPE_INDICES,
  resolveSemanticTokens,
  type SemanticToken,
} from "../util/semanticTokens.js";

export class AgdaRenameProvider implements vscode.RenameProvider {
  constructor(private readonly state: SessionState) {}

  /**
   * Find the ranges of semantic tokens with the same text and token type as the
   * token at the given position.
   */
  private getTokenMatches(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Range[] | undefined {
    const uri = document.uri.toString();
    if (!this.state.hasLoaded(uri)) return undefined;
    const entries = this.state.getEntries(uri);

    const lineLength = (line: number) => document.lineAt(line).text.length;
    const toRange = (t: SemanticToken) =>
      new vscode.Range(t.line, t.startChar, t.line, t.startChar + t.length);

    const tokens = resolveSemanticTokens(entries, lineLength);
    const hit = tokens.find((t) => rangeContains(toRange(t), position));
    if (!hit || !RENAMEABLE_TYPE_INDICES.has(hit.typeIdx)) return undefined;

    const hitText = document.getText(toRange(hit));
    return tokens
      .filter((t) => t.typeIdx === hit.typeIdx && document.getText(toRange(t)) === hitText)
      .map(toRange);
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): vscode.WorkspaceEdit | undefined {
    const matches = this.getTokenMatches(document, position);
    if (!matches) return undefined;

    const edit = new vscode.WorkspaceEdit();
    for (const range of matches) {
      edit.replace(document.uri, range, newName);
    }

    return edit;
  }

  // Errors thrown by this function are shown in a message box in the editor.
  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    if (!this.state.hasLoaded(document.uri.toString())) {
      throw new Error("Load the file first (Ctrl+C Ctrl+L / Leader M L)");
    }

    const matches = this.getTokenMatches(document, position);
    if (!matches) {
      throw new Error("No renameable token here");
    }

    return matches[0];
  }
}
