import * as vscode from "vscode";
import { AgdaProcess } from "./agda/process.js";
import { CommandQueue } from "./core/commandQueue.js";
import { GoalManager } from "./core/goals.js";
import { SessionState } from "./core/sessionState.js";
import { WorkspaceState } from "./core/state.js";
import { registerCommands, ShowInputBox } from "./editor/commands.js";
import { DecorationRenderer } from "./editor/decorationRenderer.js";
import { InfoPanel } from "./editor/infoPanel.js";
import { registerKeySequenceCommands } from "./editor/keySequence.js";
import { AgdaDefinitionProvider } from "./providers/definition.js";
import { AgdaDocumentHighlightProvider } from "./providers/documentHighlights.js";
import { AgdaDocumentSymbolProvider } from "./providers/documentSymbols.js";
import { AgdaHoverProvider, GenericHoverProvider } from "./providers/hover.js";
import { AgdaRenameProvider } from "./providers/rename.js";
import { AgdaSemanticTokensProvider } from "./providers/semanticTokens.js";
import { AbbreviationRewriterFeature } from "./unicode/AbbreviationRewriterFeature.js";
import { AbbreviationProvider } from "./unicode/engine/AbbreviationProvider.js";
import { showUnicodeInputBox } from "./editor/unicodeInputBox.js";
import * as config from "./util/config.js";
import { SEMANTIC_LEGEND } from "./util/semanticTokens.js";
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
  const sessionState = new SessionState();
  const decorationRenderer = new DecorationRenderer(sessionState);
  const workspaceState = new WorkspaceState();
  const infoPanel = new InfoPanel(outputChannel, context.extensionUri);

  const selector: vscode.DocumentSelector = { language: "agda" };
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector,
      new AgdaSemanticTokensProvider(sessionState),
      SEMANTIC_LEGEND,
    ),
    vscode.languages.registerDocumentHighlightProvider(
      selector,
      new AgdaDocumentHighlightProvider(),
    ),
    vscode.languages.registerRenameProvider(selector, new AgdaRenameProvider(sessionState)),
    vscode.languages.registerDefinitionProvider(selector, new AgdaDefinitionProvider(sessionState)),
  );

  // DocumentSymbolProvider has no onDidChange event, so the provider owns
  // its registration and re-registers on state changes to force refresh.
  // Gated by agda.outline.enabled so the post-load name/type fetch can be
  // skipped entirely on large projects.
  let outlineProvider: AgdaDocumentSymbolProvider | undefined = config.getOutlineEnabled()
    ? new AgdaDocumentSymbolProvider(sessionState, selector)
    : undefined;
  context.subscriptions.push(
    config.onOutlineEnabledChanged(() => {
      const enabled = config.getOutlineEnabled();
      if (enabled && !outlineProvider) {
        outlineProvider = new AgdaDocumentSymbolProvider(sessionState, selector);
      } else if (!enabled && outlineProvider) {
        outlineProvider.dispose();
        outlineProvider = undefined;
      }
    }),
    { dispose: () => outlineProvider?.dispose() },
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(circle-outline) Agda";
  statusBar.tooltip = "Agda -- not started (load a file with Ctrl+C Ctrl+L)";
  statusBar.show();

  const abbreviationProvider = new AbbreviationProvider(config.getCustomTranslations());
  const abbreviationStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    200,
  );

  // We share the same AbbreviationProvider across every UI surface that cares
  // about unicode input (hovers, rewriter, input boxes), so that the
  // last-selected cycle index is consistent across them.
  const showInputBox: ShowInputBox = (options) =>
    showUnicodeInputBox(abbreviationProvider, abbreviationStatusBar, options);

  // Hover for unicode abbreviations on non-agda/lagda languages. agda/lagda are
  // served by AgdaHoverProvider, which combines type info and abbreviation info
  // into a single deterministically ordered popup.
  const abbrevHoverSelector = () =>
    config.getInputLanguages().filter((id) => id !== "agda" && id !== "lagda");
  let abbrevHoverRegistration = vscode.languages.registerHoverProvider(
    abbrevHoverSelector(),
    new GenericHoverProvider(abbreviationProvider),
  );
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      selector,
      new AgdaHoverProvider(sessionState, abbreviationProvider),
    ),
    config.onInputLanguagesChanged(() => {
      abbrevHoverRegistration.dispose();
      abbrevHoverRegistration = vscode.languages.registerHoverProvider(
        abbrevHoverSelector(),
        new GenericHoverProvider(abbreviationProvider),
      );
    }),
    { dispose: () => abbrevHoverRegistration.dispose() },
    new AbbreviationRewriterFeature(abbreviationProvider, abbreviationStatusBar),
  );

  registerKeySequenceCommands(context);
  registerCommands(context, {
    process: agdaProcess,
    queue: commandQueue,
    goals,
    sessionState,
    workspaceState,
    statusBar,
    infoPanel,
    outputChannel,
    globalStorageUri: context.globalStorageUri,
    extensionUri: context.extensionUri,
    showInputBox,
  });

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
        goals.applyDecorations(editor);
      }
    }),
  );

  context.subscriptions.push(
    config.init(),

    config.onCustomTranslationsChanged(() => {
      abbreviationProvider.reload(config.getCustomTranslations());
    }),

    config.onGoalLabelsChanged(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === "agda") {
          goals.applyDecorations(editor);
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
  // - VSCodeVim: agda.vimUndo snapshots text and sets collation mode.
  //   Individual events skip goal adjustment; a setTimeout(0) callback
  //   processes the merged change.
  // - Native: TextDocumentChangeReason.Undo/Redo detected here. We
  //   reconstruct the pre-change text from the post-text and the content
  //   changes, then compute a single merged change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === "agda" && e.contentChanges.length > 0) {
        const uri = e.document.uri.toString();
        // Highlighting always adjusts per-change (it just shifts/removes)
        sessionState.adjustForEdits(uri, e.contentChanges);

        // Goal adjustment: collate undo changes into a single merged edit
        const goalChanges = (() => {
          const isCollatingUndo = goals.isCollatingUndo(uri);
          if (isCollatingUndo) return null;

          const reason = (e as any).reason as TextDocumentChangeReason | undefined;
          const isNativeUndo = reason === TextDocumentChangeReason.Undo;

          if (isNativeUndo && e.contentChanges.length > 1) {
            const postText = e.document.getText();
            const preText = reconstructPreText(postText, e.contentChanges);
            const merged = computeSingleChange(preText, postText, true);
            return merged ? [merged] : null;
          }

          return e.contentChanges;
        })();

        if (goalChanges) {
          goals.adjustForEdits(uri, goalChanges);
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
        sessionState.clear(uri);
        goals.clear(uri);
      }
    }),
  );

  context.subscriptions.push(
    abbreviationStatusBar,

    agdaProcess,
    commandQueue,
    goals,
    sessionState,
    decorationRenderer,
    workspaceState,
    infoPanel,
    statusBar,
    outputChannel,
  );
}

export function deactivate(): void {}
