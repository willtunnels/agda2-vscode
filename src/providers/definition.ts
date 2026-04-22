import * as vscode from "vscode";
import type { SessionState } from "../core/sessionState.js";
import { agdaOffsetToPosition } from "../util/position.js";

export class AgdaDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly state: SessionState) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location | undefined> {
    const site = this.state.getDefinitionSite(document.uri.toString(), position);
    if (!site) return undefined;

    const targetUri = vscode.Uri.file(site.filepath);

    // Same-file: position is kept live by adjustForEdits -- use it directly.
    if (site.kind === "sameFile") {
      return new vscode.Location(targetUri, site.position);
    }

    // Cross-file: open the target doc lazily and convert the Agda offset.
    try {
      const targetDoc = await vscode.workspace.openTextDocument(targetUri);
      const targetPos = agdaOffsetToPosition(targetDoc, site.offset);
      return new vscode.Location(targetUri, targetPos);
    } catch {
      return new vscode.Location(targetUri, new vscode.Position(0, 0));
    }
  }
}
