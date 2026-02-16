// Abstraction over vscode.TextEditor + vscode.workspace.applyEdit that
// allows the response processor to work with both real VS Code editors
// (production) and mock editors (tests).
//
// The interface mirrors the vscode.TextEditor subset that
// processBatchedResponses and handleGiveAction actually use, plus an
// applyEdit method that replaces vscode.workspace.applyEdit.

import type * as vscode from "vscode";

/**
 * Minimal editor abstraction used by the response processor.
 *
 * In production, wraps a real vscode.TextEditor.
 * In tests, wraps a MockTextDocument + captured state.
 */
export interface DocumentEditor {
  /** The underlying document. */
  readonly document: vscode.TextDocument;

  /** Apply a workspace edit. Returns true on success. */
  applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;

  /** Current primary selection (cursor). */
  selection: vscode.Selection;

  /** All selections (multi-cursor). */
  selections: vscode.Selection[];

  /** Save the document to disk. */
  save(): Promise<void>;

  /** Apply decorations. */
  setDecorations(
    type: vscode.TextEditorDecorationType,
    decorations: readonly (vscode.DecorationOptions | vscode.Range)[],
  ): void;
}
