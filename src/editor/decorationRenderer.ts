// Push-based decoration rendering for Agda highlighting.
//
// Subscribes to SessionState changes and editor lifecycle events, then pushes
// setDecorations() calls to visible editors. Decoration types are owned here
// (not on SessionState) so state mutation stays free of editor side effects.

import * as vscode from "vscode";
import { groupDecorationRanges, DECORATION_STYLES } from "../core/sessionState.js";
import type { SessionState } from "../core/sessionState.js";

export class DecorationRenderer implements vscode.Disposable {
  /** Decoration types shared across files (atom → type). */
  private decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly state: SessionState) {
    for (const [atom, style] of Object.entries(DECORATION_STYLES)) {
      this.decorationTypes.set(atom, vscode.window.createTextEditorDecorationType(style));
    }

    this.subs.push(
      state.onDidChange(({ uri }) => this.renderVisibleForUri(uri)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.languageId === "agda") {
          this.renderOne(editor);
        }
      }),
    );
  }

  /** Push decorations from current state to a single editor. */
  renderOne(editor: vscode.TextEditor): void {
    const entries = this.state.getEntries(editor.document.uri.toString());
    const knownAtoms = new Set(this.decorationTypes.keys());
    const groups = groupDecorationRanges(entries, knownAtoms);

    // Set empty ranges for unused types to clear stale decorations.
    for (const [atom, decorationType] of this.decorationTypes) {
      editor.setDecorations(decorationType, groups.get(atom) ?? []);
    }
  }

  private renderVisibleForUri(uri: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        this.renderOne(editor);
      }
    }
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();
  }
}
