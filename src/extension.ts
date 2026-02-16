import * as vscode from "vscode";
import { AgdaProcess } from "./agda/process.js";
import { CommandQueue } from "./core/commandQueue.js";
import { GoalManager } from "./core/goals.js";
import { HighlightingManager, SEMANTIC_LEGEND } from "./core/highlighting.js";
import { WorkspaceState } from "./core/state.js";
import { registerCommands } from "./editor/commands.js";
import { InfoPanel } from "./editor/infoPanel.js";
import { registerKeySequenceCommands } from "./editor/keySequence.js";
import { AbbreviationFeature } from "./unicode/AbbreviationFeature.js";
import { agdaOffsetToPosition } from "./util/position.js";
import { computeSingleChange, reconstructPreText } from "./util/editAdjust.js";

const enum TextDocumentChangeReason {
  Undo = 1,
  Redo = 2,
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Agda", { log: true });
  const agdaProcess = new AgdaProcess(outputChannel);
  const commandQueue = new CommandQueue(agdaProcess);
  const goals = new GoalManager();
  const highlighting = new HighlightingManager();
  const workspaceState = new WorkspaceState();
  const infoPanel = new InfoPanel(outputChannel, context.extensionUri);

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "agda" },
      highlighting,
      SEMANTIC_LEGEND,
    ),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(circle-outline) Agda";
  statusBar.tooltip = "Agda — not started (load a file with Ctrl+C Ctrl+L)";
  statusBar.show();

  registerKeySequenceCommands(context);
  registerCommands(context, {
    process: agdaProcess,
    queue: commandQueue,
    goals,
    highlighting,
    workspaceState,
    statusBar,
    infoPanel,
    outputChannel,
    globalStorageUri: context.globalStorageUri,
  });

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "agda" },
      {
        async provideDefinition(
          document: vscode.TextDocument,
          position: vscode.Position,
        ): Promise<vscode.Location | undefined> {
          const site = highlighting.getDefinitionSite(document.uri.toString(), position);
          if (!site) return undefined;

          const targetUri = vscode.Uri.file(site.filepath);
          // Agda's position is a 1-based code-point offset in the target file.
          // We need to open the document to convert offset to line/col.
          try {
            const targetDoc = await vscode.workspace.openTextDocument(targetUri);
            const targetPos = agdaOffsetToPosition(targetDoc, site.position);
            return new vscode.Location(targetUri, targetPos);
          } catch {
            // If we can't open the file, return position 0,0 as fallback
            return new vscode.Location(targetUri, new vscode.Position(0, 0));
          }
        },
      },
    ),
  );

  context.subscriptions.push(
    commandQueue.onBusyChange((busy) => {
      if (!busy && statusBar.text.includes("loading~spin")) {
        statusBar.text = "$(check) Agda";
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === "agda") {
        highlighting.reapply(editor);
        goals.applyDecorations(editor);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agda.goalLabels")) {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.languageId === "agda") {
            goals.applyDecorations(editor);
          }
        }
      }
    }),
  );

  // Adjust stored highlighting and goal ranges when a document is edited.
  //
  // Highlighting: ranges intersecting an edit are removed, except for
  // ? → {!  !} expansions (pre-registered via registerPendingExpansions)
  // which grow intersecting ranges instead.
  //
  // Goals: edits inside a goal's interior grow it; edits crossing a
  // boundary remove it; edits outside shift it.
  //
  // Undo/redo collation:
  // VS Code may decompose an undo into multiple atomic edits (especially
  // with VSCodeVim). Each individual edit looks like an interior-only
  // change, so goals survive incorrectly. We collate undo changes into
  // a single merged edit that crosses goal boundaries.
  //
  // - VSCodeVim: agda.vimUndo/agda.vimRedo snapshots text and sets
  //   collation mode. Individual events skip goal adjustment; a
  //   setTimeout(0) callback processes the merged change.
  // - Native: TextDocumentChangeReason.Undo/Redo detected here. We
  //   reconstruct the pre-change text from the post-text and the content
  //   changes, then compute a single merged change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === "agda" && e.contentChanges.length > 0) {
        const uri = e.document.uri.toString();
        // Highlighting always adjusts per-change (it just shifts/removes)
        highlighting.adjustForEdits(uri, e.contentChanges);

        // Goal adjustment: collate undo/redo changes into a single merged edit
        const reason = (e as any).reason as TextDocumentChangeReason | undefined;
        const isNativeUndoRedo =
          reason === TextDocumentChangeReason.Undo || reason === TextDocumentChangeReason.Redo;

        if (goals.isCollatingUndo(uri)) {
          // VSCodeVim undo — skip goal adjustment; collation handled by
          // agda.vimUndo/agda.vimRedo setTimeout callback.
        } else if (isNativeUndoRedo && e.contentChanges.length > 1) {
          const postText = e.document.getText();
          const preText = reconstructPreText(postText, e.contentChanges);
          const merged = computeSingleChange(preText, postText, true);
          if (merged) {
            goals.adjustForEdits(uri, [merged]);
          }
        } else {
          // Normal edit (or single-change undo) — process directly
          goals.adjustForEdits(uri, e.contentChanges);
        }

        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() === uri) {
            goals.applyDecorations(editor);
          }
        }
      }
    }),
  );

  // Clean up stored highlighting/goal state when a document is closed, so
  // stale entries aren't reapplied if the file changes on disk before being
  // reopened.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "agda") {
        const uri = document.uri.toString();
        highlighting.clear(uri);
        goals.clear(uri);
      }
    }),
  );

  const abbreviationFeature = new AbbreviationFeature();
  context.subscriptions.push(abbreviationFeature);

  context.subscriptions.push(
    agdaProcess,
    commandQueue,
    goals,
    highlighting,
    workspaceState,
    infoPanel,
    statusBar,
    outputChannel,
  );
}

export function deactivate(): void {}
