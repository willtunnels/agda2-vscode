import * as vscode from "vscode";
import type { SessionState } from "../core/sessionState.js";
import { SEMANTIC_LEGEND, resolveSemanticTokens } from "../util/semanticTokens.js";

export class AgdaSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider, vscode.Disposable
{
  private readonly _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

  private readonly sub: vscode.Disposable;

  constructor(private readonly state: SessionState) {
    this.sub = state.onDidChange(() => this._onDidChangeSemanticTokens.fire());
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const entries = this.state.getEntries(document.uri.toString());
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

    const lineLength = (line: number) => document.lineAt(line).text.length;
    for (const t of resolveSemanticTokens(entries, lineLength)) {
      builder.push(t.line, t.startChar, t.length, t.typeIdx, 0);
    }

    return builder.build();
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeSemanticTokens.dispose();
  }
}
