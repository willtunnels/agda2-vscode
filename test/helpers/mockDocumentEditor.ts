/**
 * Mock DocumentEditor for testing.
 *
 * Wraps a jest-mock-vscode MockTextDocument and implements the DocumentEditor
 * interface from src/core/documentEditor.ts. When applyEdit is called, it
 * parses the WorkspaceEdit and mutates the MockTextDocument accordingly.
 *
 * This allows tests to call the REAL processBatchedResponses from
 * responseProcessor.ts with a mock editor instead of reimplementing the logic.
 */

import {
  Position,
  Range,
  Selection,
  Uri,
  MockTextDocument,
  TextEdit,
} from "../__mocks__/vscode.js";
import type { DocumentEditor } from "../../src/core/documentEditor.js";
import type * as vscode from "vscode";

/** Captured decoration entry for test assertions. */
export interface CapturedDecoration {
  decorationType: unknown;
  decorations: readonly (vscode.DecorationOptions | vscode.Range)[];
}

export class MockDocumentEditor implements DocumentEditor {
  readonly document: MockTextDocument;

  /** Current primary selection (cursor). */
  selection: vscode.Selection;

  /** All selections (multi-cursor). */
  selections: vscode.Selection[];

  /** Captured decorations for test assertions. */
  private _decorations = new Map<unknown, readonly (vscode.DecorationOptions | vscode.Range)[]>();

  constructor(content: string, uri?: vscode.Uri) {
    const docUri = uri ?? Uri.file("/test/Mock.agda");
    this.document = MockTextDocument.create(docUri, content, "agda");

    const origin = new Position(0, 0) as vscode.Position;
    this.selection = new Selection(origin, origin) as vscode.Selection;
    this.selections = [this.selection];
  }

  /**
   * Apply a WorkspaceEdit by parsing its text edits and mutating the document.
   *
   * Edits are applied in reverse document order (matching VS Code behavior)
   * so that earlier edits don't invalidate later offsets.
   */
  async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    // Get edits for our document's URI
    const textEdits: vscode.TextEdit[] = (edit as any).get(this.document.uri);
    if (!textEdits || textEdits.length === 0) return true;

    // Sort in reverse document order (later edits first)
    const sorted = [...textEdits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
      return b.range.start.character - a.range.start.character;
    });

    // Apply each edit by splicing the document content
    let content = this.document.getText();
    for (const te of sorted) {
      const startOff = this.document.offsetAt(te.range.start);
      const endOff = this.document.offsetAt(te.range.end);
      content = content.slice(0, startOff) + te.newText + content.slice(endOff);
      // Update the document after each edit so subsequent offsetAt calls are correct
      MockTextDocument.setContents(this.document, content);
    }

    return true;
  }

  /** Save is a no-op in tests. */
  async save(): Promise<void> {}

  /** Capture decorations for test assertions. */
  setDecorations(
    type: vscode.TextEditorDecorationType,
    decorations: readonly (vscode.DecorationOptions | vscode.Range)[],
  ): void {
    this._decorations.set(type, [...decorations]);
  }

  /** Get captured decorations for a decoration type. */
  getDecorations(decorationType: unknown): readonly (vscode.DecorationOptions | vscode.Range)[] {
    return this._decorations.get(decorationType) ?? [];
  }

  /** Get all captured decorations across all types. */
  getAllDecorations(): CapturedDecoration[] {
    const result: CapturedDecoration[] = [];
    for (const [decorationType, decorations] of this._decorations) {
      result.push({ decorationType, decorations });
    }
    return result;
  }
}
