// Core logic for handling Agda responses that mutate the document
// (GiveAction, InteractionPoints with ? expansion, MakeCase) and update
// goal state. It operates on a DocumentEditor abstraction so it can be
// tested with mock editors.

import * as vscode from "vscode";
import type { AgdaResponse, DisplayInfo, GiveResult, Solution } from "../agda/responses.js";
import type { AgdaOffset } from "../util/offsets.js";
import { agdaOffsetToPosition } from "../util/position.js";
import { GoalManager, GOAL_MARKER, expandQuestionMarks } from "./goals.js";
import type { DocumentEditor } from "./documentEditor.js";

// Re-export for convenience
export type { DocumentEditor };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Info needed to re-highlight after a give action. */
export interface GiveHighlightInfo {
  goalId: number;
  replacement: string;
  /** The start position of the replaced range (before edit). */
  rangeStart: vscode.Position;
}

/** Callbacks for side effects that the response processor doesn't own. */
export interface ResponseProcessorCallbacks {
  /** Called when Agda reports Status { checked: true }. */
  onStatus(checked: boolean): void;

  /** Called with accumulated DisplayInfo responses. */
  onDisplayInfo(infos: DisplayInfo[]): void | Promise<void>;

  /** Called to re-highlight after a give. */
  sendHighlightCommand(info: GiveHighlightInfo): Promise<void>;

  /** Called to handle MakeCase (replaces lines, reloads). */
  handleMakeCase(goalId: number, clauses: string[]): Promise<void>;

  /** Called to handle SolveAll (gives each solution). */
  handleSolveAll(solutions: Solution[]): Promise<void>;

  /** Called to handle JumpToError. */
  handleJumpToError(filepath: string, position: AgdaOffset): void;

  /** Called to store goal IDs in workspace state. */
  setGoalIds(ids: number[]): void;

  /** Whether to reload after give (config setting). */
  reloadOnGive: boolean;

  /** Called to trigger a full reload after give (when reloadOnGive is set). */
  reload(): Promise<void>;

  /**
   * Register ranges that are about to be expanded (? → {!  !}).
   * Called before the edit so the highlighting manager can grow
   * intersecting ranges instead of removing them.
   */
  registerPendingExpansions(ranges: vscode.Range[]): void;
}

/** A no-op implementation of ResponseProcessorCallbacks. */
export const noopCallbacks: ResponseProcessorCallbacks = {
  onStatus() {},
  onDisplayInfo() {},
  async sendHighlightCommand() {},
  async handleMakeCase() {},
  async handleSolveAll() {},
  handleJumpToError() {},
  setGoalIds() {},
  reloadOnGive: false,
  async reload() {},
  registerPendingExpansions() {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Adjust a position to account for ? → {!  !} expansions.
 * For each expansion that occurred before (or at) the position on the same
 * line, shift the character forward by `charDelta`.
 */
function adjustPositionForExpansions(
  pos: vscode.Position,
  expansions: vscode.Range[],
  charDelta: number,
): vscode.Position {
  let shift = 0;
  for (const range of expansions) {
    if (range.start.line > pos.line) break;
    if (range.start.line === pos.line && range.start.character < pos.character) {
      shift += charDelta;
    }
  }
  return shift > 0 ? new vscode.Position(pos.line, pos.character + shift) : pos;
}

// ---------------------------------------------------------------------------
// Core response processing
// ---------------------------------------------------------------------------

/**
 * Process batched Agda responses after a command completes.
 *
 * Handles GiveAction (document edit + ? expansion), InteractionPoints
 * (? → {!  !} expansion, goal update), Status, DisplayInfo, MakeCase,
 * SolveAll, and JumpToError.
 */
export async function processBatchedResponses(
  editor: DocumentEditor,
  responses: AgdaResponse[],
  goals: GoalManager,
  callbacks: ResponseProcessorCallbacks,
): Promise<void> {
  const pendingHighlights: GiveHighlightInfo[] = [];
  const displayInfos: DisplayInfo[] = [];

  // MakeCase and (when reloadOnGive is set) GiveAction trigger a full reload
  // after editing. The InteractionPoints in this batch have stale positions
  // referring to the pre-edit document — skip them since the reload will
  // provide fresh ones.
  const willReload =
    responses.some((r) => r.kind === "MakeCase") ||
    (callbacks.reloadOnGive && responses.some((r) => r.kind === "GiveAction"));

  // GiveAction edits the document (expanding any ? in the result to {!  !}
  // first), making InteractionPoints offsets in this batch stale.
  // Process all GiveActions before InteractionPoints, then use forceScan.
  let gaveGoal = false;
  if (!willReload) {
    for (const response of responses) {
      if (response.kind === "GiveAction") {
        const info = await handleGiveAction(
          editor,
          goals,
          response.interactionPoint.id,
          response.giveResult,
          callbacks,
        );
        if (info) pendingHighlights.push(info);
        gaveGoal = true;
      }
    }
  }

  for (const response of responses) {
    switch (response.kind) {
      case "InteractionPoints": {
        if (willReload) break;
        // Expand lone ? to {!  !}, matching Emacs agda2-goals-action.
        // When a give was applied earlier in this batch, Agda's offsets
        // refer to the pre-give document and are stale — skip the offset-
        // based ? detection and fall through to forceScan.
        let expanded = false;
        if (!gaveGoal) {
          const questionMarks: vscode.Range[] = [];
          for (const ip of response.interactionPoints) {
            if (ip.range.length > 0) {
              const interval = ip.range[0];
              const start = agdaOffsetToPosition(editor.document, interval.start.pos);
              const end = agdaOffsetToPosition(editor.document, interval.end.pos);
              const range = new vscode.Range(start, end);
              if (editor.document.getText(range) === "?") {
                questionMarks.push(range);
              }
            }
          }
          if (questionMarks.length > 0) {
            const edit = new vscode.WorkspaceEdit();
            for (const range of questionMarks) {
              edit.replace(editor.document.uri, range, GOAL_MARKER);
            }
            const savedSelections = editor.selections;
            callbacks.registerPendingExpansions(questionMarks);
            await editor.applyEdit(edit);
            const charDelta = GOAL_MARKER.length - 1;
            editor.selections = savedSelections.map((sel) => {
              const newAnchor = adjustPositionForExpansions(sel.anchor, questionMarks, charDelta);
              const newActive = adjustPositionForExpansions(sel.active, questionMarks, charDelta);
              return new vscode.Selection(newAnchor, newActive);
            });
            await editor.save();
            expanded = true;
          }
        }

        goals.updateGoals(editor.document, response.interactionPoints, expanded || gaveGoal);
        goals.applyDecorations(editor as unknown as vscode.TextEditor);
        callbacks.setGoalIds(response.interactionPoints.map((ip) => ip.id));
        break;
      }
      case "Status":
        if (response.status.checked) {
          callbacks.onStatus(true);
        }
        break;
      case "DisplayInfo":
        displayInfos.push(response.info);
        break;
      case "GiveAction":
        // Already processed above.
        break;
      case "MakeCase":
        await callbacks.handleMakeCase(response.interactionPoint.id, response.clauses);
        break;
      case "SolveAll":
        await callbacks.handleSolveAll(response.solutions);
        break;
      case "JumpToError":
        callbacks.handleJumpToError(response.filepath, response.position);
        break;
    }
  }

  if (displayInfos.length > 0) {
    await callbacks.onDisplayInfo(displayInfos);
  }

  for (const gh of pendingHighlights) {
    await callbacks.sendHighlightCommand(gh);
  }
}

// ---------------------------------------------------------------------------
// Give handling
// ---------------------------------------------------------------------------

/**
 * Handle a GiveAction response: replace the goal range with the give result.
 *
 * When the give result contains a string, lone `?` marks are expanded to
 * `{!  !}` before substitution.
 *
 * Returns GiveHighlightInfo for re-highlighting, or undefined.
 */
async function handleGiveAction(
  editor: DocumentEditor,
  goals: GoalManager,
  goalId: number,
  giveResult: GiveResult,
  callbacks: ResponseProcessorCallbacks,
): Promise<GiveHighlightInfo | undefined> {
  const uri = editor.document.uri.toString();
  const goal = goals.getAll(uri).find((g) => g.id === goalId);
  if (!goal) return undefined;

  let replacement: string;
  const isStringResult = "str" in giveResult;
  if (isStringResult) {
    replacement = expandQuestionMarks(giveResult.str);
  } else {
    const content = goals.getGoalContent(goal, editor.document);
    replacement = expandQuestionMarks(giveResult.paren ? `(${content})` : content);
  }

  const cursorPos = editor.selection.active;
  const goalText = editor.document.getText(goal.range);
  const goalStartOffset = editor.document.offsetAt(goal.range.start);
  const cursorOffsetInGoal = editor.document.offsetAt(cursorPos) - goalStartOffset;

  const rangeStart = goal.range.start;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, goal.range, replacement);
  const applied = await editor.applyEdit(edit);

  if (applied) {
    const newOffset = mapCursorThroughEdit(goalText, replacement, cursorOffsetInGoal);
    const restorePos = editor.document.positionAt(goalStartOffset + newOffset);
    editor.selection = new vscode.Selection(restorePos, restorePos);
  }

  if (callbacks.reloadOnGive) {
    await callbacks.reload();
    return undefined;
  }

  if (isStringResult && applied) {
    return { goalId, replacement, rangeStart };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Cursor mapping
// ---------------------------------------------------------------------------

/**
 * Map a cursor offset through a text replacement by finding the common
 * prefix and suffix. Positions in the shared prefix/suffix keep their
 * offset; positions in the changed middle clamp to the boundary.
 */
export function mapCursorThroughEdit(
  oldText: string,
  newText: string,
  cursorOffset: number,
): number {
  const minLen = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  )
    suffix++;

  if (cursorOffset <= prefix) return cursorOffset;
  if (cursorOffset >= oldText.length - suffix)
    return newText.length - (oldText.length - cursorOffset);
  // Clamp to last character of the new middle, not one past it.
  // When the new middle is empty, fall back to the prefix boundary.
  return Math.min(cursorOffset, Math.max(prefix, newText.length - suffix - 1));
}
