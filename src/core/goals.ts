// Goal (interaction point / hole) management.
// Tracks goal positions, provides navigation, handles give/make-case edits.

import * as vscode from "vscode";
import type { InteractionPointWithRange } from "../agda/responses.js";
import { agdaOffsetToPosition } from "../util/position.js";
import { adjustRangeContaining, adjustItems, computeSingleChange } from "../util/editAdjust.js";
import { getGoalLabels } from "../util/config.js";

/** The marker text that replaces lone `?` goals during load. */
export const GOAL_MARKER = "{!  !}";

/** Number of characters to move the cursor into the fresh goal after inserting a make-case snippet. */
export const MAKE_CASE_CURSOR_OFFSET = 3;

// ---------------------------------------------------------------------------
// Shared Agda source scanner
// ---------------------------------------------------------------------------

/**
 * Visitor called at each "code" position (outside comments and string literals).
 * Return the number of characters consumed, or undefined to advance by 1.
 */
type CodeVisitor = (i: number, text: string, holeDepth: number) => number | undefined;

/**
 * Walk Agda source text, skipping line comments, block comments, and string
 * literals. At each code position, call `onCode` with the current index,
 * full text, and hole nesting depth. The visitor may consume multi-character
 * tokens by returning the number of characters consumed.
 */
function scanAgdaSource(text: string, onCode: CodeVisitor): void {
  let i = 0;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let holeDepth = 0;

  while (i < text.length) {
    // Line comment: -- (only at top level, outside holes)
    if (
      !inLineComment &&
      blockCommentDepth === 0 &&
      holeDepth === 0 &&
      text[i] === "-" &&
      i + 1 < text.length &&
      text[i + 1] === "-"
    ) {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (text[i] === "\n") inLineComment = false;
      i++;
      continue;
    }

    // Block comment: {- ... -} (only at top level, outside holes)
    if (
      holeDepth === 0 &&
      text[i] === "{" &&
      i + 1 < text.length &&
      text[i + 1] === "-" &&
      !(i + 2 < text.length && text[i + 2] === "!")
    ) {
      blockCommentDepth++;
      i += 2;
      continue;
    }
    if (blockCommentDepth > 0 && text[i] === "-" && i + 1 < text.length && text[i + 1] === "}") {
      blockCommentDepth--;
      i += 2;
      continue;
    }
    if (blockCommentDepth > 0) {
      i++;
      continue;
    }

    // String literal (only at top level, outside holes)
    if (holeDepth === 0 && text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i < text.length) i++;
      continue;
    }

    // Hole nesting: {! increments, !} decrements
    if (text[i] === "{" && i + 1 < text.length && text[i + 1] === "!") {
      const consumed = onCode(i, text, holeDepth);
      holeDepth++;
      i += consumed ?? 2;
      continue;
    }
    if (holeDepth > 0 && text[i] === "!" && i + 1 < text.length && text[i + 1] === "}") {
      holeDepth--;
      const consumed = onCode(i, text, holeDepth);
      i += consumed ?? 2;
      continue;
    }

    // Regular code character
    const consumed = onCode(i, text, holeDepth);
    i += consumed ?? 1;
  }
}

// ---------------------------------------------------------------------------
// Question mark expansion
// ---------------------------------------------------------------------------

/**
 * True if `ch` could be part of an Agda identifier -- i.e. it is NOT a
 * character that always terminates a name. Whitespace, parentheses, braces,
 * and string boundaries all delimit identifiers in Agda's lexer.
 */
function isNameChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  // Parentheses and braces are special syntax in Agda -- they can never
  // appear inside identifiers or operators.
  if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return false;
  return !/\s/.test(ch);
}

/**
 * Replace lone `?` characters in Agda-generated text with `{!  !}`.
 * Skips `?` inside comments, string literals, and existing holes.
 * A `?` is "lone" when it is not adjacent to identifier characters --
 * whitespace, parens, braces, and string boundaries all count as delimiters.
 */
export function expandQuestionMarks(text: string): string {
  const positions: number[] = [];
  scanAgdaSource(text, (i, text, holeDepth) => {
    if (
      holeDepth === 0 &&
      text[i] === "?" &&
      !isNameChar(text[i - 1]) &&
      !isNameChar(text[i + 1])
    ) {
      positions.push(i);
    }
    return undefined;
  });
  if (positions.length === 0) return text;

  let result = "";
  let prev = 0;
  for (const pos of positions) {
    result += text.slice(prev, pos) + GOAL_MARKER;
    prev = pos + 1;
  }
  result += text.slice(prev);
  return result;
}

export interface Goal {
  id: number;
  range: vscode.Range;
}

/**
 * The inner range of a goal, excluding the `{!` and `!}` delimiters.
 * Returns undefined if the goal is null/undefined, or if the goal text
 * does not actually start with `{!` and end with `!}`.
 */
export function goalInnerRange(
  goal: Goal | null | undefined,
  document: vscode.TextDocument,
): vscode.Range | undefined {
  if (!goal) return undefined;

  const text = document.getText(goal.range);
  if (!text.startsWith("{!") || !text.endsWith("!}")) return undefined;

  const start = goal.range.start.translate(0, 2); // skip `{!`
  const end = goal.range.end.translate(0, -2); // skip `!}`
  return new vscode.Range(start, end);
}

/**
 * Cursor position for goal navigation: the first non-whitespace character inside the `{!` / `!}`
 * delimiters, or the character after `{!` if the goal is empty or whitespace-only.
 */
export function goalCursorPosition(goal: Goal, document: vscode.TextDocument): vscode.Position {
  const inner = goalInnerRange(goal, document);
  if (!inner) return goal.range.start;

  const match = /\S/.exec(document.getText(inner));
  if (match) return document.positionAt(document.offsetAt(inner.start) + match.index);

  return goal.range.start.translate(0, 2); // position cursor after `{!`
}

/** State for undo/redo collation. While active, individual
 *  onDidChangeTextDocument events skip goal adjustment; a single
 *  merged change is processed when collation ends. */
interface UndoCollationState {
  uri: string;
  preText: string;
}

export class GoalManager implements vscode.Disposable {
  /** Per-file goals: uri → goals. */
  private goalsByUri = new Map<string, Goal[]>();

  /** Active undo/redo collation, if any. */
  private undoCollation: UndoCollationState | null = null;

  private readonly goalDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("agda.hole.background"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("agda.hole.border"),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  /**
   * Update goals after Cmd_load.
   *
   * When forceScan is false (the default), uses range info from Agda's
   * InteractionPoints response, falling back to scanning for {! !}
   * delimiters when ranges are missing.
   *
   * When forceScan is true (after ? → {!  !} expansion), Agda's ranges are
   * stale so we scan the document for {! !} patterns and match goals to
   * interaction points by document order.
   */
  updateGoals(
    document: vscode.TextDocument,
    interactionPoints: InteractionPointWithRange[],
    forceScan = false,
  ): void {
    const uri = document.uri.toString();
    const goals: Goal[] = [];

    if (forceScan) {
      // Agda's ranges are stale after ? expansion -- scan for {! !} patterns
      const text = document.getText();
      const holeRanges = this.findHoleRanges(text, document);
      for (let i = 0; i < interactionPoints.length && i < holeRanges.length; i++) {
        goals.push({ id: interactionPoints[i].id, range: holeRanges[i] });
      }
    } else {
      const text = document.getText();
      let cachedHoleRanges: vscode.Range[] | undefined;
      const getHoleRanges = () => (cachedHoleRanges ??= this.findHoleRanges(text, document));

      for (const ip of interactionPoints) {
        let range: vscode.Range;
        if (ip.range.length > 0) {
          // Use the range from Agda (1-based code-point offsets)
          const interval = ip.range[0];
          range = new vscode.Range(
            agdaOffsetToPosition(document, interval.start.pos, text),
            agdaOffsetToPosition(document, interval.end.pos, text),
          );
        } else {
          // Fallback: scan document for holes and match by order
          const holeRanges = getHoleRanges();
          const idx = interactionPoints.indexOf(ip);
          if (idx < holeRanges.length) {
            range = holeRanges[idx];
          } else {
            continue; // Can't find this goal
          }
        }
        goals.push({ id: ip.id, range });
      }
    }

    this.goalsByUri.set(uri, goals);
  }

  /** Find all {! !} hole ranges, handling nesting and skipping comments. */
  private findHoleRanges(text: string, document: vscode.TextDocument): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    let holeStart = -1;

    scanAgdaSource(text, (i, text, holeDepth) => {
      // Hole start: {!
      if (text[i] === "{" && i + 1 < text.length && text[i + 1] === "!") {
        if (holeDepth === 0) holeStart = i;
        return 2;
      }
      // Hole end: !}
      if (text[i] === "!" && i + 1 < text.length && text[i + 1] === "}") {
        // holeDepth here is already decremented by scanAgdaSource
        if (holeDepth === 0 && holeStart >= 0) {
          ranges.push(new vscode.Range(document.positionAt(holeStart), document.positionAt(i + 2)));
          holeStart = -1;
        }
        return 2;
      }
      return undefined;
    });

    return ranges;
  }

  /** Apply goal decorations to an editor. */
  applyDecorations(editor: vscode.TextEditor): void {
    const goals = this.getAll(editor.document.uri.toString());
    const showLabels = getGoalLabels();
    const decorations: vscode.DecorationOptions[] = goals.map((g) => ({
      range: g.range,
      ...(showLabels && {
        renderOptions: {
          after: {
            contentText: `?${g.id}`,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
            margin: "0 0 0 1em",
          },
        },
      }),
    }));
    editor.setDecorations(this.goalDecorationType, decorations);
  }

  /** Clear all goal decorations for a single editor. */
  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.goalDecorationType, []);
  }

  /** Clear goal decorations on all visible editors showing a URI. */
  clearDecorationsForUri(uri: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        editor.setDecorations(this.goalDecorationType, []);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Undo/redo collation
  // -------------------------------------------------------------------------

  /**
   * Begin undo collation for a URI. While active, `adjustForEdits` is
   * skipped for that URI. Call `endUndoCollation` to process the merged
   * change.
   */
  beginUndoCollation(uri: string, preText: string): void {
    this.undoCollation = { uri, preText };
  }

  /** Whether undo collation is active for the given URI. */
  isCollatingUndo(uri: string): boolean {
    return this.undoCollation !== null && this.undoCollation.uri === uri;
  }

  /**
   * End undo collation: compute a single merged change from the pre-undo
   * text vs the current document text, and process it through the normal
   * goal adjustment logic. This correctly removes goals whose boundaries
   * were crossed by the undo.
   */
  endUndoCollation(uri: string, postText: string): void {
    if (!this.undoCollation || this.undoCollation.uri !== uri) return;

    const preText = this.undoCollation.preText;
    this.undoCollation = null;

    const mergedChange = computeSingleChange(preText, postText, true);
    if (mergedChange) {
      this.adjustForEdits(uri, [mergedChange]);
    }
  }

  /**
   * Adjust goal ranges after a document edit.
   * Intersecting goals are removed; goals after the edit are shifted.
   */
  adjustForEdits(uri: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    if (this.getAll(uri).length === 0) return;
    const goals = this.goalsByUri.get(uri)!;

    adjustItems(
      goals,
      changes,
      (g) => g.range,
      (g, range) => ({ ...g, range }),
      (range, edit) => adjustRangeContaining(range, edit, 2),
    );

    // If all goals were removed, clean up the map entry
    if (goals.length === 0) {
      this.goalsByUri.delete(uri);
      this.clearDecorationsForUri(uri);
    }
  }

  /** Get the goal at the cursor position, if any. */
  getGoalAt(uri: string, position: vscode.Position): Goal | undefined {
    return this.getAll(uri).find((g) => g.range.contains(position));
  }

  /** Get all current goals for a file. */
  getAll(uri: string): readonly Goal[] {
    return this.goalsByUri.get(uri) ?? [];
  }

  /** Get the text content of a goal (between {! and !}). */
  getGoalContent(goal: Goal, document: vscode.TextDocument): string {
    const text = document.getText(goal.range);
    if (text.startsWith("{!") && text.endsWith("!}")) {
      return text.slice(2, -2).trim();
    }
    return text.trim();
  }

  /** Navigate to the next goal after the given position. */
  nextGoal(uri: string, from: vscode.Position): Goal | undefined {
    const goals = this.getAll(uri);
    for (const goal of goals) {
      if (goal.range.start.isAfter(from)) {
        return goal;
      }
    }
    return goals.length > 0 ? goals[0] : undefined;
  }

  /** Navigate to the previous goal before the given position. */
  previousGoal(uri: string, from: vscode.Position): Goal | undefined {
    const goals = this.getAll(uri);
    for (let i = goals.length - 1; i >= 0; i--) {
      if (goals[i].range.end.isBefore(from)) {
        return goals[i];
      }
    }
    return goals.length > 0 ? goals[goals.length - 1] : undefined;
  }

  /** Clear goals for a specific file, or all files if no URI given. */
  clear(uri?: string): void {
    if (uri) {
      this.goalsByUri.delete(uri);
    } else {
      this.goalsByUri.clear();
    }
  }

  dispose(): void {
    this.goalDecorationType.dispose();
  }
}
