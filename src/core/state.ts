// Per-document and workspace-level state management.

import * as vscode from "vscode";

export class DocumentState {
  /** Interaction point IDs from the last successful load. */
  goalIds: number[] = [];

  /** Whether the document has been modified since last load. */
  dirty = false;

  /** Whether the file has been successfully loaded at least once. */
  loaded = false;

  constructor(public readonly filepath: string) {}

  reset(): void {
    this.goalIds = [];
    this.dirty = false;
    this.loaded = false;
  }
}

export class WorkspaceState implements vscode.Disposable {
  private documents = new Map<string, DocumentState>();
  private disposables: vscode.Disposable[] = [];

  /** The file currently loaded in Agda's process. */
  currentFile: string | null = null;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const state = this.documents.get(e.document.uri.fsPath);
        if (state) {
          state.dirty = true;
        }
      }),
    );
  }

  getOrCreate(filepath: string): DocumentState {
    let state = this.documents.get(filepath);
    if (!state) {
      state = new DocumentState(filepath);
      this.documents.set(filepath, state);
    }
    return state;
  }

  get(filepath: string): DocumentState | undefined {
    return this.documents.get(filepath);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
