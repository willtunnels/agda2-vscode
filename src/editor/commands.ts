import * as fs from "fs";
import * as vscode from "vscode";
import type { TextEditor } from "vscode";
import type { AgdaProcess } from "../agda/process.js";
import type { AgdaResponse, HighlightingPayload, Solution } from "../agda/responses.js";
import { convertDisplayInfo } from "../util/agdaLocation.js";
import {
  cmdLoad,
  cmdGive,
  cmdRefine,
  cmdMakeCase,
  cmdGoalType,
  cmdGoalTypeContext,
  cmdGoalTypeContextInfer,
  cmdGoalTypeContextCheck,
  cmdContext,
  cmdInfer,
  cmdInferToplevel,
  cmdCompute,
  cmdComputeToplevel,
  cmdAutoOne,
  cmdAutoAll,
  cmdSolveOne,
  cmdSolveAll,
  cmdConstraints,
  cmdMetas,
  cmdWhyInScope,
  cmdWhyInScopeToplevel,
  cmdSearchAboutToplevel,
  cmdShowModuleContents,
  cmdShowModuleContentsToplevel,
  cmdToggleImplicitArgs,
  cmdToggleIrrelevantArgs,
  cmdShowVersion,
  cmdElaborateGive,
  cmdHelperFunctionType,
  cmdHighlight,
  cmdCompile,
  cmdAbort,
} from "../agda/commands.js";
import { agdaOffsetToPosition, positionToAgdaOffset } from "../util/position.js";
import type { AgdaOffset } from "../util/offsets.js";
import { resetSequence, getUniversalArgCount } from "./keySequence.js";
import type { Rewrite } from "../agda/commands.js";
import { InfoPanel } from "./infoPanel.js";
import { CommandQueue } from "../core/commandQueue.js";
import {
  GoalManager,
  expandQuestionMarks,
  type Goal,
  goalInnerRange,
  MAKE_CASE_CURSOR_OFFSET,
} from "../core/goals.js";
import { HighlightingManager } from "../core/highlighting.js";
import { WorkspaceState } from "../core/state.js";
import {
  processBatchedResponses,
  type ResponseProcessorCallbacks,
} from "../core/responseProcessor.js";
import type { DocumentEditor } from "../core/documentEditor.js";
import {
  detectPlatform,
  getAvailableReleases,
  downloadAndInstall,
  getDownloadedVersions,
  findSystemAgda,
  findWellKnownAgda,
  probeAdditionalPaths,
  AGDA_INSTALL_GUIDE,
} from "../agda/installations.js";
import { formatVersion } from "../agda/version.js";
import {
  agdaConfig,
  getAgdaPath,
  getExtraArgs,
  getBackend,
  getAdditionalPaths,
  getReloadOnGive,
} from "../util/config.js";
import { getErrorMessage } from "../util/errorMessage.js";

/** Wraps a real vscode.TextEditor to implement DocumentEditor. */
class VscodeDocumentEditor implements DocumentEditor {
  constructor(private readonly editor: TextEditor) {}

  get document() {
    return this.editor.document;
  }

  async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    return vscode.workspace.applyEdit(edit);
  }

  get selection() {
    return this.editor.selection;
  }
  set selection(sel: vscode.Selection) {
    this.editor.selection = sel;
  }

  get selections() {
    return [...this.editor.selections];
  }
  set selections(sels: vscode.Selection[]) {
    this.editor.selections = sels;
  }

  async save(): Promise<void> {
    await this.editor.document.save();
  }

  setDecorations(
    type: vscode.TextEditorDecorationType,
    decorations: readonly (vscode.DecorationOptions | vscode.Range)[],
  ): void {
    this.editor.setDecorations(type, decorations as vscode.DecorationOptions[]);
  }
}

interface Services {
  process: AgdaProcess;
  queue: CommandQueue;
  goals: GoalManager;
  highlighting: HighlightingManager;
  workspaceState: WorkspaceState;
  statusBar: vscode.StatusBarItem;
  infoPanel: InfoPanel;
  outputChannel: vscode.OutputChannel;
  globalStorageUri: vscode.Uri;
}

/**
 * Map universal argument count to Rewrite mode.
 * Matches Emacs agda2-maybe-normalised: no prefix → Simplified.
 */
function rewriteFromUArg(n: number): Rewrite {
  const map: Record<number, Rewrite> = { 1: "Instantiated", 2: "Normalised", 3: "HeadNormal" };
  return map[n] ?? "Simplified";
}

/**
 * Map universal argument count to Rewrite mode (AsIs variant).
 * Matches Emacs agda2-maybe-normalised-asis: no prefix → AsIs.
 * Used by auto, solve, show-goals.
 */
function rewriteFromUArgAsIs(n: number): Rewrite {
  const map: Record<number, Rewrite> = { 1: "Simplified", 2: "Normalised", 3: "HeadNormal" };
  return map[n] ?? "AsIs";
}

export function registerCommands(context: vscode.ExtensionContext, services: Services): void {
  const {
    process: agda,
    queue,
    goals,
    highlighting,
    workspaceState,
    statusBar,
    infoPanel,
    outputChannel,
    globalStorageUri,
  } = services;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Update agda.path in the most specific config scope that currently has a value. */
  async function setAgdaPath(newPath: string): Promise<void> {
    const config = agdaConfig();
    const inspected = config.inspect<string>("path");
    const target =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await config.update("path", newPath, target);
  }

  async function ensureAgdaAndFile(): Promise<
    { editor: TextEditor; filepath: string } | undefined
  > {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "agda") {
      vscode.window.showWarningMessage("No active Agda file");
      return undefined;
    }

    const filepath = editor.document.uri.fsPath;

    if (!agda.running) {
      try {
        statusBar.text = "$(loading~spin) Agda: Starting...";
        await agda.spawn(getAgdaPath(), getExtraArgs());
        statusBar.text = "$(check) Agda";
      } catch (e) {
        const msg = getErrorMessage(e);
        statusBar.text = "$(error) Agda";
        if (getAvailableReleases(detectPlatform()).length > 0) {
          const choice = await vscode.window.showErrorMessage(
            `Failed to start Agda: ${msg}`,
            "Download Agda",
          );
          if (choice === "Download Agda") {
            await vscode.commands.executeCommand("agda.downloadAgda");
          }
        } else {
          const choice = await vscode.window.showErrorMessage(
            `Failed to start Agda: ${msg}`,
            "Install Guide",
          );
          if (choice === "Install Guide") {
            vscode.env.openExternal(vscode.Uri.parse(AGDA_INSTALL_GUIDE));
          }
        }
        return undefined;
      }
    }

    return { editor, filepath };
  }

  /** Send a command and process batched responses. */
  async function runCommand(
    cmd: string,
    editor: TextEditor,
    filepath: string,
    opts?: { errorGoal?: Goal },
  ): Promise<void> {
    const result = await queue.enqueue(cmd, makeStreamHandler(editor, opts));
    await processResponses(result.responses, editor, filepath);
  }

  /** Clear stale state, save, and send Cmd_load. */
  async function reload(editor: TextEditor, filepath: string): Promise<void> {
    goals.clear(editor.document.uri.toString());
    goals.clearDecorations(editor);
    highlighting.clearAll(editor);
    await editor.document.save();
    statusBar.text = "$(loading~spin) Agda: Loading...";
    await runCommand(cmdLoad(filepath, getExtraArgs()), editor, filepath);
    const state = workspaceState.getOrCreate(filepath);
    state.loaded = true;
    state.dirty = false;
  }

  /** Get the goal at the cursor, or show "No goal at cursor". */
  function requireGoal(editor: TextEditor): Goal | undefined {
    const uri = editor.document.uri.toString();
    const pos = editor.selection.active;
    const goal = goals.getGoalAt(uri, pos);
    if (!goal) {
      infoPanel.showMessage("No goal at cursor");
    }
    return goal;
  }

  /** Get the goal content, or prompt the user for an expression. */
  async function getExprOrPrompt(
    goal: Goal,
    editor: TextEditor,
    prompt: string,
  ): Promise<string | undefined> {
    const expr = goals.getGoalContent(goal, editor.document);
    if (expr) return expr;
    return vscode.window.showInputBox({ prompt });
  }

  /** Optional goal lookup (for maybe-toplevel commands). */
  function tryGoalAt(editor: TextEditor): Goal | null {
    return goals.getGoalAt(editor.document.uri.toString(), editor.selection.active) ?? null;
  }

  // When errorGoal is provided, error-atom highlighting is pinned to the goal
  // range instead of using Agda's (potentially stale) offsets.
  function makeStreamHandler(editor: TextEditor, opts?: { errorGoal?: Goal }) {
    const errorOverride = goalInnerRange(opts?.errorGoal);
    return (response: AgdaResponse) => {
      switch (response.kind) {
        case "HighlightingInfo":
          if (response.direct) {
            highlighting.applyHighlighting(editor, response.info, errorOverride);
          } else {
            try {
              const content = fs.readFileSync(response.filepath, "utf-8");
              const payload = JSON.parse(content) as HighlightingPayload;
              highlighting.applyHighlighting(editor, payload, errorOverride);
              // Delete the temp file as Agda expects
              fs.unlinkSync(response.filepath);
            } catch (e) {
              const msg = getErrorMessage(e);
              outputChannel.appendLine(
                `[warn] Failed to read highlighting file ${response.filepath}: ${msg}`,
              );
            }
          }
          break;
        case "RunningInfo":
          statusBar.text = `$(loading~spin) Agda: ${response.message}`;
          infoPanel.showMessage(response.message);
          break;
        case "ClearRunningInfo":
          statusBar.text = "$(loading~spin) Agda";
          break;
        case "ClearHighlighting":
          if (response.tokenBased === "TokenBased") {
            highlighting.clearTokenBased(editor);
          } else {
            highlighting.clearAll(editor);
          }
          break;
      }
    };
  }

  /** Process responses by delegating to the extracted response processor. */
  async function processResponses(
    responses: AgdaResponse[],
    editor: TextEditor,
    filepath: string,
  ): Promise<void> {
    const docEditor = new VscodeDocumentEditor(editor);
    const callbacks: ResponseProcessorCallbacks = {
      reloadOnGive: getReloadOnGive(),
      registerPendingExpansions(ranges) {
        highlighting.registerPendingExpansions(editor.document.uri.toString(), ranges);
      },
      onStatus(checked) {
        if (checked) statusBar.text = "$(check) Agda: Checked";
      },
      async onDisplayInfo(infos) {
        const converted = await Promise.all(
          infos.map((info) => convertDisplayInfo(info, editor.document, filepath, agda.version)),
        );
        infoPanel.showDisplayInfo(converted, agda.version);
      },
      async sendHighlightCommand(gh) {
        try {
          const startPos = gh.rangeStart;
          const endPos = editor.document.positionAt(
            editor.document.offsetAt(startPos) + gh.replacement.length,
          );
          const fromOffset = positionToAgdaOffset(editor.document, startPos);
          const toOffset = positionToAgdaOffset(editor.document, endPos);

          const result = await queue.enqueue(
            cmdHighlight(
              filepath,
              gh.goalId,
              fromOffset,
              startPos.line + 1,
              startPos.character + 1,
              toOffset,
              endPos.line + 1,
              endPos.character + 1,
              gh.replacement,
              agda.version,
            ),
            makeStreamHandler(editor),
          );
          for (const resp of result.responses) {
            if (resp.kind === "DisplayInfo") {
              const conv = await convertDisplayInfo(
                resp.info,
                editor.document,
                filepath,
                agda.version,
              );
              infoPanel.showDisplayInfo([conv], agda.version);
            }
          }
        } catch {
          // Non-fatal: re-highlighting is best-effort
        }
      },
      async handleMakeCase(goalId, clauses) {
        await handleMakeCaseImpl(editor, goalId, clauses, filepath);
      },
      async handleSolveAll(solutions) {
        await handleSolveAllImpl(editor, filepath, solutions);
      },
      handleJumpToError(fp, position) {
        handleJumpToErrorImpl(editor, fp, position);
      },
      setGoalIds(ids) {
        workspaceState.getOrCreate(filepath).goalIds = ids;
      },
      async reload() {
        await reload(editor, filepath);
      },
    };

    await processBatchedResponses(docEditor, responses, goals, callbacks);
  }

  async function handleMakeCaseImpl(
    editor: TextEditor,
    _goalId: number,
    clauses: string[],
    filepath: string,
  ): Promise<void> {
    // Replace the entire line(s) containing the goal with the new clauses,
    // then reload -- matching Emacs agda2-make-case-action.
    const cursor = editor.selection.active;
    const caseLine = cursor.line;
    const line = editor.document.lineAt(caseLine);
    const uri = editor.document.uri.toString();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, line.range, clauses.map(expandQuestionMarks).join("\n"));
    await vscode.workspace.applyEdit(edit);

    await reload(editor, filepath);

    const firstNewGoal = goals
      .getAll(uri)
      .find(
        (g) => g.range.start.line >= caseLine && g.range.start.line < caseLine + clauses.length,
      );
    if (firstNewGoal) {
      const pos = firstNewGoal.range.start.translate(0, MAKE_CASE_CURSOR_OFFSET);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  async function handleSolveAllImpl(
    editor: TextEditor,
    filepath: string,
    solutions: Solution[],
  ): Promise<void> {
    // For each solution, replace the goal content and give.
    // Emacs does: replace goal text → goto goal → give.
    for (const solution of solutions) {
      const goal = goals
        .getAll(editor.document.uri.toString())
        .find((g) => g.id === solution.interactionPoint);
      if (!goal) continue;

      try {
        await runCommand(cmdGive(filepath, goal.id, solution.expression), editor, filepath);
      } catch {
        // If one solution fails, continue with the rest
      }
    }
  }

  function handleJumpToErrorImpl(editor: TextEditor, filepath: string, position: AgdaOffset): void {
    // position is a 1-based Agda code-point offset
    if (editor.document.uri.fsPath === filepath) {
      const pos = agdaOffsetToPosition(editor.document, position);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }

  // ---------------------------------------------------------------------------
  // Registration helpers
  // ---------------------------------------------------------------------------

  function register(id: string, handler: () => void | Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  /** Register a command that takes no goal, no input, no universal argument. */
  function registerSimple(id: string, buildCmd: (filepath: string) => string): void {
    register(id, async () => {
      resetSequence();
      const ctx = await ensureAgdaAndFile();
      if (!ctx) return;
      await runCommand(buildCmd(ctx.filepath), ctx.editor, ctx.filepath);
    });
  }

  /** Register a command that requires a goal at the cursor. */
  function registerGoal(
    id: string,
    handler: (
      editor: TextEditor,
      filepath: string,
      goal: Goal,
      uArg: number,
    ) => Promise<void> | void,
  ): void {
    register(id, async () => {
      const uArg = getUniversalArgCount();
      resetSequence();
      const ctx = await ensureAgdaAndFile();
      if (!ctx) return;
      const goal = requireGoal(ctx.editor);
      if (!goal) return;
      await handler(ctx.editor, ctx.filepath, goal, uArg);
    });
  }

  /** Register a command that optionally uses a goal at the cursor. */
  function registerOptionalGoal(
    id: string,
    handler: (
      editor: TextEditor,
      filepath: string,
      goal: Goal | null,
      uArg: number,
    ) => Promise<void> | void,
  ): void {
    register(id, async () => {
      const uArg = getUniversalArgCount();
      resetSequence();
      const ctx = await ensureAgdaAndFile();
      if (!ctx) return;
      await handler(ctx.editor, ctx.filepath, tryGoalAt(ctx.editor), uArg);
    });
  }

  // ---------------------------------------------------------------------------
  // Simple commands
  // ---------------------------------------------------------------------------

  registerSimple("agda.toggleImplicitArgs", cmdToggleImplicitArgs);
  registerSimple("agda.toggleIrrelevantArgs", cmdToggleIrrelevantArgs);
  registerSimple("agda.showVersion", cmdShowVersion);
  registerSimple("agda.showConstraints", cmdConstraints);

  // ---------------------------------------------------------------------------
  // Command: Load
  // ---------------------------------------------------------------------------

  register("agda.load", async () => {
    resetSequence();
    const ctx = await ensureAgdaAndFile();
    if (!ctx) return;
    const { editor, filepath } = ctx;

    infoPanel.showMessage("Loading…");
    workspaceState.currentFile = filepath;

    try {
      await reload(editor, filepath);
    } catch (e) {
      const msg = getErrorMessage(e);
      vscode.window.showErrorMessage(`Agda load failed: ${msg}`);
      statusBar.text = "$(error) Agda";
    }
  });

  // ---------------------------------------------------------------------------
  // Goal commands
  // ---------------------------------------------------------------------------

  registerGoal("agda.give", async (editor, fp, goal, uArg) => {
    const force = uArg > 0;
    const prompt = force
      ? `Expression for goal ?${goal.id} (force)`
      : `Expression for goal ?${goal.id}`;
    const expr = await getExprOrPrompt(goal, editor, prompt);
    if (expr === undefined) return;
    await runCommand(cmdGive(fp, goal.id, expr, force), editor, fp, { errorGoal: goal });
  });

  registerGoal("agda.refine", (editor, fp, goal, uArg) => {
    const expr = goals.getGoalContent(goal, editor.document);
    return runCommand(cmdRefine(fp, goal.id, expr, uArg > 0), editor, fp);
  });

  registerGoal("agda.makeCase", async (editor, fp, goal) => {
    const variable = await getExprOrPrompt(
      goal,
      editor,
      `Variable to case split on (goal ?${goal.id})`,
    );
    if (variable === undefined) return;
    await runCommand(cmdMakeCase(fp, goal.id, variable), editor, fp);
  });

  registerGoal("agda.goalType", (editor, fp, goal, uArg) =>
    runCommand(cmdGoalType(fp, goal.id, rewriteFromUArg(uArg)), editor, fp),
  );

  registerGoal("agda.goalTypeAndContext", (editor, fp, goal, uArg) =>
    runCommand(cmdGoalTypeContext(fp, goal.id, rewriteFromUArg(uArg)), editor, fp),
  );

  registerGoal("agda.goalTypeContextInfer", (editor, fp, goal, uArg) => {
    const expr = goals.getGoalContent(goal, editor.document);
    return runCommand(
      cmdGoalTypeContextInfer(fp, goal.id, expr, rewriteFromUArg(uArg)),
      editor,
      fp,
    );
  });

  registerGoal("agda.context", (editor, fp, goal, uArg) =>
    runCommand(cmdContext(fp, goal.id, rewriteFromUArg(uArg)), editor, fp),
  );

  registerGoal("agda.goalTypeContextCheck", (editor, fp, goal, uArg) => {
    const expr = goals.getGoalContent(goal, editor.document);
    return runCommand(
      cmdGoalTypeContextCheck(fp, goal.id, expr, rewriteFromUArg(uArg)),
      editor,
      fp,
    );
  });

  registerGoal("agda.elaborateGive", async (editor, fp, goal, uArg) => {
    const expr = await getExprOrPrompt(
      goal,
      editor,
      `Expression to elaborate and give (goal ?${goal.id})`,
    );
    if (expr === undefined) return;
    await runCommand(cmdElaborateGive(fp, goal.id, expr, rewriteFromUArg(uArg)), editor, fp);
  });

  registerGoal("agda.helperFunctionType", async (editor, fp, goal, uArg) => {
    const expr = await getExprOrPrompt(goal, editor, "Expression for helper function");
    if (expr === undefined) return;
    await runCommand(
      cmdHelperFunctionType(fp, goal.id, expr, rewriteFromUArgAsIs(uArg)),
      editor,
      fp,
    );
  });

  // ---------------------------------------------------------------------------
  // Optional-goal commands (maybe-toplevel / maybe-all)
  // ---------------------------------------------------------------------------

  registerOptionalGoal("agda.auto", (editor, fp, goal, uArg) => {
    const rewrite = rewriteFromUArgAsIs(uArg);
    const cmd = goal
      ? cmdAutoOne(fp, goal.id, agda.version, rewrite)
      : cmdAutoAll(fp, agda.version, rewrite);
    return runCommand(cmd, editor, fp);
  });

  registerOptionalGoal("agda.solve", (editor, fp, goal, uArg) => {
    const rewrite = rewriteFromUArgAsIs(uArg);
    const cmd = goal ? cmdSolveOne(fp, goal.id, rewrite) : cmdSolveAll(fp, rewrite);
    return runCommand(cmd, editor, fp);
  });

  /** Helper for commands that operate on a goal or fall back to toplevel input. */
  async function runGoalOrToplevel(
    goal: Goal | null,
    editor: TextEditor,
    fp: string,
    prompt: string,
    goalCmd: (id: number, expr: string) => string,
    toplevelCmd: (expr: string) => string,
    toplevelPrompt?: string,
  ): Promise<void> {
    if (goal) {
      const expr = await getExprOrPrompt(goal, editor, prompt);
      if (expr === undefined) return;
      await runCommand(goalCmd(goal.id, expr), editor, fp);
    } else {
      const input = await vscode.window.showInputBox({ prompt: toplevelPrompt ?? prompt });
      if (input === undefined) return;
      await runCommand(toplevelCmd(input), editor, fp);
    }
  }

  registerOptionalGoal("agda.inferType", (editor, fp, goal, uArg) => {
    const rewrite = rewriteFromUArg(uArg);
    return runGoalOrToplevel(
      goal,
      editor,
      fp,
      "Expression to infer type of",
      (id, expr) => cmdInfer(fp, id, expr, rewrite),
      (expr) => cmdInferToplevel(fp, expr, rewrite),
    );
  });

  registerOptionalGoal("agda.computeNormalForm", (editor, fp, goal) =>
    runGoalOrToplevel(
      goal,
      editor,
      fp,
      "Expression to normalize",
      (id, expr) => cmdCompute(fp, id, expr),
      (expr) => cmdComputeToplevel(fp, expr),
    ),
  );

  registerOptionalGoal("agda.whyInScope", (editor, fp, goal) =>
    runGoalOrToplevel(
      goal,
      editor,
      fp,
      "Name to explain",
      (id, name) => cmdWhyInScope(fp, id, name),
      (name) => cmdWhyInScopeToplevel(fp, name),
    ),
  );

  registerOptionalGoal("agda.moduleContents", (editor, fp, goal, uArg) => {
    const rewrite = rewriteFromUArg(uArg);
    return runGoalOrToplevel(
      goal,
      editor,
      fp,
      "Module name (empty for current module)",
      (id, moduleName) => cmdShowModuleContents(fp, id, moduleName, rewrite),
      (moduleName) => cmdShowModuleContentsToplevel(fp, moduleName, rewrite),
      "Module name (empty for top-level module)",
    );
  });

  // ---------------------------------------------------------------------------
  // Standalone commands
  // ---------------------------------------------------------------------------

  register("agda.showGoals", async () => {
    const uArg = getUniversalArgCount();
    resetSequence();
    const ctx = await ensureAgdaAndFile();
    if (!ctx) return;
    await runCommand(
      cmdMetas(ctx.filepath, agda.version, rewriteFromUArgAsIs(uArg)),
      ctx.editor,
      ctx.filepath,
    );
  });

  register("agda.searchAbout", async () => {
    const uArg = getUniversalArgCount();
    resetSequence();
    const ctx = await ensureAgdaAndFile();
    if (!ctx) return;
    const input = await vscode.window.showInputBox({ prompt: "Search about" });
    if (input === undefined) return;
    await runCommand(
      cmdSearchAboutToplevel(ctx.filepath, input, rewriteFromUArg(uArg)),
      ctx.editor,
      ctx.filepath,
    );
  });

  register("agda.compile", async () => {
    resetSequence();
    const ctx = await ensureAgdaAndFile();
    if (!ctx) return;
    const { editor, filepath } = ctx;

    const BACKENDS = ["GHC", "GHCNoMain", "JS", "LaTeX", "QuickLaTeX", "HTML"] as const;
    let backend = getBackend();
    if (!backend) {
      const picked = await vscode.window.showQuickPick([...BACKENDS], {
        placeHolder: "Select compilation backend",
      });
      if (!picked) return;
      backend = picked;
    }

    await editor.document.save();
    statusBar.text = `$(loading~spin) Agda: Compiling (${backend})...`;

    await runCommand(cmdCompile(filepath, backend, getExtraArgs()), editor, filepath);
  });

  register("agda.removeAnnotations", () => {
    resetSequence();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "agda") return;
    highlighting.clearAll(editor);
    goals.clear(editor.document.uri.toString());
    goals.clearDecorations(editor);
    infoPanel.clear();
    statusBar.text = "$(check) Agda";
  });

  register("agda.nextGoal", () => {
    resetSequence();
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const goal = goals.nextGoal(editor.document.uri.toString(), editor.selection.active);
    if (goal) {
      const pos = goal.range.start;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(goal.range);
    }
  });

  register("agda.previousGoal", () => {
    resetSequence();
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const goal = goals.previousGoal(editor.document.uri.toString(), editor.selection.active);
    if (goal) {
      const pos = goal.range.start;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(goal.range);
    }
  });

  register("agda.toggleInfoPanel", () => {
    resetSequence();
    infoPanel.toggle();
  });

  register("agda.restart", async () => {
    resetSequence();
    try {
      statusBar.text = "$(loading~spin) Agda: Restarting...";
      queue.abort();
      await agda.restart(getAgdaPath(), getExtraArgs());
      statusBar.text = "$(check) Agda";
      vscode.window.showInformationMessage("Agda restarted");
    } catch (e) {
      const msg = getErrorMessage(e);
      vscode.window.showErrorMessage(`Failed to restart Agda: ${msg}`);
      statusBar.text = "$(error) Agda";
    }
  });

  register("agda.abort", async () => {
    resetSequence();
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const filepath = editor.document.uri.fsPath;
    if (agda.running) {
      agda.send(cmdAbort(filepath));
    }
    queue.abort();
    statusBar.text = "$(check) Agda";
  });

  register("agda.downloadAgda", async () => {
    const platform = detectPlatform();
    const releases = getAvailableReleases(platform);
    if (releases.length === 0) {
      const choice = await vscode.window.showErrorMessage(
        "No pre-built Agda binaries are available for this platform.",
        "Install Guide",
      );
      if (choice === "Install Guide") {
        vscode.env.openExternal(vscode.Uri.parse(AGDA_INSTALL_GUIDE));
      }
      return;
    }
    const items = releases.map((r, i) => ({
      label: `v${formatVersion(r.version)}`,
      description: i === 0 ? "(latest)" : undefined,
      release: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select Agda version to download",
    });
    if (!picked) return;

    const storageDir = globalStorageUri.fsPath;
    let binaryPath: string;

    try {
      binaryPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading Agda v${formatVersion(picked.release.version)}`,
          cancellable: true,
        },
        async (progress, token) => {
          return downloadAndInstall(
            picked.release,
            platform,
            storageDir,
            (message, _increment) => progress.report({ message }),
            token,
          );
        },
      );
    } catch (e) {
      if (e instanceof Error && e.message === "Cancelled") {
        vscode.window.showInformationMessage("Agda download cancelled.");
        return;
      }
      const msg = getErrorMessage(e);
      vscode.window.showErrorMessage(`Failed to download Agda: ${msg}`);
      return;
    }

    await setAgdaPath(binaryPath);

    // Kill existing process so next command uses the new binary
    if (agda.running) {
      queue.abort();
      await agda.kill();
    }

    statusBar.text = "$(check) Agda";
    vscode.window.showInformationMessage(
      `Agda v${formatVersion(picked.release.version)} installed. Path set to: ${binaryPath}`,
    );
  });

  register("agda.switchAgda", async () => {
    const storageDir = globalStorageUri.fsPath;
    const additionalPaths = getAdditionalPaths();

    // Discover system, downloaded, additional, and well-known installs in parallel
    const [systemVersions, downloadedVersions, additionalResults, wellKnownVersions] =
      await Promise.all([
        findSystemAgda(),
        getDownloadedVersions(storageDir),
        probeAdditionalPaths(additionalPaths),
        findWellKnownAgda(),
      ]);

    // All paths from discovery functions are already normalized (symlinks
    // resolved), so the seen set deduplicates correctly across sources.
    type PickItem = vscode.QuickPickItem & { agdaPath?: string; broken?: boolean };
    const items: PickItem[] = [];
    const seen = new Set<string>();

    for (const d of downloadedVersions) {
      seen.add(d.path);
      items.push({
        label: `v${formatVersion(d.version)}`,
        description: "(extension managed)",
        detail: d.path,
        agdaPath: d.path,
      });
    }

    // Additional paths first so broken entries are visible even if the same
    // binary is found working via PATH or well-known locations
    for (const a of additionalResults) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      if (a.kind === "ok") {
        items.push({
          label: `v${formatVersion(a.version)}`,
          description: "(from additionalPaths)",
          detail: a.path,
          agdaPath: a.path,
        });
      } else {
        items.push({
          label: `$(warning) ${a.path}`,
          description: `(from additionalPaths -- ${a.reason})`,
          broken: true,
        });
      }
    }

    for (const s of systemVersions) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      items.push({
        label: `v${formatVersion(s.version)}`,
        description: s.path,
        agdaPath: s.path,
      });
    }

    for (const w of wellKnownVersions) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      items.push({
        label: `v${formatVersion(w.version)}`,
        description: "(discovered)",
        detail: w.path,
        agdaPath: w.path,
      });
    }

    items.push({
      label: "$(cloud-download) Download a new version...",
      agdaPath: undefined,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select Agda installation to use",
    });
    if (!picked) return;

    if (picked.broken) {
      vscode.window.showWarningMessage(`This Agda path is not working: ${picked.description}`);
      return;
    }

    if (picked.agdaPath === undefined) {
      await vscode.commands.executeCommand("agda.downloadAgda");
      return;
    }

    await setAgdaPath(picked.agdaPath);

    if (agda.running) {
      queue.abort();
      await agda.kill();
    }

    statusBar.text = "$(check) Agda";
    vscode.window.showInformationMessage(`Agda path set to: ${picked.agdaPath}`);
  });

  // ---------------------------------------------------------------------------
  // VSCodeVim undo interception
  // ---------------------------------------------------------------------------
  //
  // VSCodeVim implements its own undo (historyTracker.goBackHistoryStep())
  // by applying each reversed change via editor.edit(). VS Code fires a
  // separate onDidChangeTextDocument event for each atomic change. Each
  // individual event looks like an interior-only edit, so goal adjustment
  // never removes goals whose boundaries were actually crossed.
  //
  // Fix: intercept `u` via contributes.keybindings (which fires before
  // VSCodeVim's `type` command override), snapshot the document text,
  // dispatch `u` back through the `type` command so VSCodeVim processes
  // it through its normal pipeline (task queue, state management, etc.),
  // then collate all changes into one.
  //
  // We dispatch via executeCommand("type") rather than calling
  // handleKeyEvent directly -- this preserves VSCodeVim's full internal
  // state management (including redo history). executeCommand does not
  // go through keybinding resolution, so our keybinding does not re-fire.
  //
  // Redo does NOT need interception: before we can redo edit X we must
  // have undone X, so the undo collation already removed any goals whose
  // boundaries X crosses. VSCodeVim handles redo through its own ctrl+r
  // keybinding (an explicit contributes.keybinding, not the type override).

  register("agda.vimUndo", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const uri = editor.document.uri.toString();
    goals.beginUndoCollation(uri, editor.document.getText());

    // Dispatch `u` back through the `type` command, which VSCodeVim
    // overrides. This is exactly the path a normal `u` keypress takes
    // (minus keybinding resolution), so VSCodeVim's undo pipeline runs
    // normally and redo state is preserved.
    await vscode.commands.executeCommand("type", { text: "u" });

    // onDidChangeTextDocument events may still be in the event queue.
    // Defer collation until they drain.
    setTimeout(() => {
      goals.endUndoCollation(uri, editor.document.getText());
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === uri) {
          goals.applyDecorations(ed);
        }
      }
    }, 0);
  });
}
