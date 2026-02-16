// Shared edit-adjustment utilities for keeping stored highlighting state
// (decoration ranges, definition sites, semantic tokens) in sync with
// document edits.
//
// Two modes:
// - adjust*: for arbitrary user edits — intersecting items are removed.
// - expand*: for known ? → {!  !} goal marker expansion — intersecting items
//   are preserved and grown.

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Edit parameters
// ---------------------------------------------------------------------------

/** Pre-computed parameters for a single content change. */
export interface EditParams {
  /** The range that was replaced in the old document. */
  editRange: vscode.Range;
  /** Net change in line count (positive = lines added). */
  lineDelta: number;
  /** Column where the replacement text ends (post-edit coordinates). */
  newEndChar: number;
}

/**
 * Sort content changes in reverse document order and compute edit parameters.
 * Processing in reverse order ensures that adjustments from earlier (lower)
 * edits don't interfere with later ones.
 */
export function processChanges(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): EditParams[] {
  return [...changes]
    .sort((a, b) =>
      b.range.start.line !== a.range.start.line
        ? b.range.start.line - a.range.start.line
        : b.range.start.character - a.range.start.character,
    )
    .map((change) => {
      const newLines = change.text.split("\n");
      const newLineCount = newLines.length - 1;
      const oldLineSpan = change.range.end.line - change.range.start.line;
      return {
        editRange: change.range,
        lineDelta: newLineCount - oldLineSpan,
        newEndChar:
          newLineCount === 0
            ? change.range.start.character + newLines[0].length
            : newLines[newLines.length - 1].length,
      };
    });
}

// ---------------------------------------------------------------------------
// Position shifting
// ---------------------------------------------------------------------------

/**
 * Shift a position that is known to be at or after the edit end.
 * Adjusts line by lineDelta; adjusts character if on the same line as
 * the edit end.
 */
function shiftPosition(
  pos: vscode.Position,
  editEnd: vscode.Position,
  lineDelta: number,
  newEndChar: number,
): vscode.Position {
  if (pos.line === editEnd.line) {
    return new vscode.Position(
      pos.line + lineDelta,
      pos.character - editEnd.character + newEndChar,
    );
  }
  return new vscode.Position(pos.line + lineDelta, pos.character);
}

// ---------------------------------------------------------------------------
// Range adjustment (for arbitrary edits — removes intersecting ranges)
// ---------------------------------------------------------------------------

/**
 * Adjust a range for a single edit. Returns the shifted range, or null if the
 * range intersects the edit and should be removed.
 */
export function adjustRange(range: vscode.Range, edit: EditParams): vscode.Range | null {
  // Entirely before edit — unchanged
  if (range.end.isBeforeOrEqual(edit.editRange.start)) {
    return range;
  }

  // Entirely after edit — shift
  if (range.start.isAfterOrEqual(edit.editRange.end)) {
    return new vscode.Range(
      shiftPosition(range.start, edit.editRange.end, edit.lineDelta, edit.newEndChar),
      shiftPosition(range.end, edit.editRange.end, edit.lineDelta, edit.newEndChar),
    );
  }

  // Intersects — remove
  return null;
}

// ---------------------------------------------------------------------------
// Range adjustment for containers (goals) — grows when edit is inside
// ---------------------------------------------------------------------------

/**
 * Adjust a container range (e.g. a goal `{! !}`) for a single edit.
 *
 * Unlike adjustRange (which removes any intersecting range), this function
 * **grows** the range when the edit is entirely within the interior — the
 * expected behavior when the user types inside a {! !} goal.
 *
 * @param delimiterWidth The number of characters at each end of the range
 *   that form the delimiters (e.g. 2 for `{!` and `!}`).  Edits touching
 *   the delimiter characters are treated as boundary overlaps.
 *
 * Returns the adjusted range, or null if the edit overlaps a boundary
 * (the container is structurally broken and should be removed).
 */
export function adjustRangeContaining(
  range: vscode.Range,
  edit: EditParams,
  delimiterWidth = 0,
): vscode.Range | null {
  // Entirely before edit — unchanged
  if (range.end.isBeforeOrEqual(edit.editRange.start)) {
    return range;
  }

  // Entirely after edit — shift
  if (range.start.isAfterOrEqual(edit.editRange.end)) {
    return new vscode.Range(
      shiftPosition(range.start, edit.editRange.end, edit.lineDelta, edit.newEndChar),
      shiftPosition(range.end, edit.editRange.end, edit.lineDelta, edit.newEndChar),
    );
  }

  // Edit strictly inside the interior (between delimiters) — grow the range.
  // The interior starts `delimiterWidth` characters after range.start
  // and ends `delimiterWidth` characters before range.end.
  const interiorStart = delimiterWidth > 0 ? range.start.translate(0, delimiterWidth) : range.start;
  const interiorEnd = delimiterWidth > 0 ? range.end.translate(0, -delimiterWidth) : range.end;
  if (
    edit.editRange.start.isAfterOrEqual(interiorStart) &&
    edit.editRange.end.isBeforeOrEqual(interiorEnd)
  ) {
    return new vscode.Range(
      range.start,
      shiftPosition(range.end, edit.editRange.end, edit.lineDelta, edit.newEndChar),
    );
  }

  // Partial overlap (edit crosses a boundary or touches a delimiter) — remove
  return null;
}

// ---------------------------------------------------------------------------
// Range expansion (for ? → {!  !} — preserves and grows intersecting ranges)
// ---------------------------------------------------------------------------

/**
 * Expand a range for a known goal marker expansion (? → {!  !}).
 * Any position ≥ the insertion point (old end of ?) shifts by the delta.
 * Ranges covering ? grow; ranges after shift; ranges before are unchanged.
 */
export function expandRange(range: vscode.Range, edit: EditParams): vscode.Range {
  const insertionPoint = edit.editRange.end;
  const newStart = range.start.isBefore(insertionPoint)
    ? range.start
    : shiftPosition(range.start, insertionPoint, edit.lineDelta, edit.newEndChar);
  const newEnd = range.end.isBefore(insertionPoint)
    ? range.end
    : shiftPosition(range.end, insertionPoint, edit.lineDelta, edit.newEndChar);
  if (newStart === range.start && newEnd === range.end) return range;
  return new vscode.Range(newStart, newEnd);
}

// ---------------------------------------------------------------------------
// Undo collation: compute a single merged change from before/after text
// ---------------------------------------------------------------------------

/**
 * Given the full document text before and after an undo/redo operation,
 * compute a single TextDocumentContentChangeEvent that represents the
 * net effect. This collapses multiple atomic undo steps into one change
 * that correctly crosses goal boundaries (causing adjustRangeContaining
 * to remove the goal).
 *
 * When `holeAware` is true, the common prefix is shrunk to avoid hiding
 * `{!`/`!}` delimiter crossings. Without this, an undo that restores
 * `{! id ? !}` from `{!  !}` produces a minimal diff that looks like an
 * interior insertion ("id ?" between the matching `{!` and `!}`), so
 * adjustRangeContaining grows the goal instead of removing it. Shrinking
 * the prefix to before the unmatched `{!` makes the diff cross the
 * delimiter boundary.
 *
 * Returns null if the texts are identical (no change).
 */
export function computeSingleChange(
  beforeText: string,
  afterText: string,
  holeAware = false,
): vscode.TextDocumentContentChangeEvent | null {
  if (beforeText === afterText) return null;

  // Find common prefix length
  const minLen = Math.min(beforeText.length, afterText.length);
  let prefixLen = 0;
  while (prefixLen < minLen && beforeText[prefixLen] === afterText[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix length (not overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    beforeText[beforeText.length - 1 - suffixLen] === afterText[afterText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // When hole-aware, check if the minimal diff is "hidden" inside a
  // {! !} pair: unmatched {! in the prefix and unmatched !} in the suffix.
  // If so, shrink the prefix to before the outermost unmatched {! so the
  // diff crosses the delimiter boundary.
  if (holeAware) {
    prefixLen = shrinkPrefixForHoles(beforeText, prefixLen, suffixLen);
  }

  // The changed region in the before-text: [prefixLen, beforeText.length - suffixLen)
  const rangeStartOffset = prefixLen;
  const rangeEndOffset = beforeText.length - suffixLen;

  // The replacement text from after-text
  const newText = afterText.slice(prefixLen, afterText.length - suffixLen);

  // Convert offsets to positions using the document (which is in the after-state).
  // We need positions in the before-state, so we compute them from the before-text.
  const rangeStart = offsetToPosition(beforeText, rangeStartOffset);
  const rangeEnd = offsetToPosition(beforeText, rangeEndOffset);

  return {
    range: new vscode.Range(rangeStart, rangeEnd),
    rangeOffset: rangeStartOffset,
    rangeLength: rangeEndOffset - rangeStartOffset,
    text: newText,
  };
}

/**
 * Check for unmatched `{!` in the common prefix and `!}` in the common
 * suffix. If both exist, the minimal diff is inside a hole — shrink the
 * prefix to before the outermost unmatched `{!`.
 *
 * Uses the before-text (but the prefix/suffix are identical in both texts).
 */
function shrinkPrefixForHoles(text: string, prefixLen: number, suffixLen: number): number {
  // Scan prefix for unmatched {! openers
  let depth = 0;
  let firstUnmatchedOpen = -1;
  for (let i = 0; i < prefixLen - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "!") {
      if (depth === 0) firstUnmatchedOpen = i;
      depth++;
      i++; // skip past '!'
    } else if (text[i] === "!" && text[i + 1] === "}") {
      depth--;
      if (depth === 0) firstUnmatchedOpen = -1;
      i++; // skip past '}'
    }
  }

  if (depth <= 0 || firstUnmatchedOpen < 0) return prefixLen;

  // Scan suffix for unmatched !} closers
  const suffixStart = text.length - suffixLen;
  let closeDepth = 0;
  for (let i = suffixStart; i < text.length - 1; i++) {
    if (text[i] === "!" && text[i + 1] === "}") {
      closeDepth++;
      i++;
    } else if (text[i] === "{" && text[i + 1] === "!") {
      closeDepth--;
      i++;
    }
  }

  if (closeDepth <= 0) return prefixLen;

  // Both sides have unmatched delimiters — shrink prefix to before the {!
  return firstUnmatchedOpen;
}

/**
 * Convert a character offset in a string to a line/character Position.
 * This is a pure computation (no document needed).
 */
function offsetToPosition(text: string, offset: number): vscode.Position {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return new vscode.Position(line, offset - lastNewline - 1);
}

// ---------------------------------------------------------------------------
// Pre-change text reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct the document text from before a set of content changes were
 * applied. The document is in the post-change state; we reverse the changes
 * to recover the pre-change text.
 *
 * Deleted content is unrecoverable from the post-text alone, so we fill
 * deleted regions with null-byte placeholders of the correct length. This
 * is sufficient because the result is only used by computeSingleChange,
 * which finds the common prefix/suffix between pre and post — unchanged
 * regions outside the edits match correctly, and the placeholder content
 * falls within the "changed middle" where exact content doesn't matter.
 */
export function reconstructPreText(
  postText: string,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): string {
  // Sort by rangeOffset ascending (pre-doc coordinates)
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);

  // Build pre-text by walking through post-text and reversing each change.
  // For each change: the gap before it is the same in pre and post.
  // At the change: post-text has `text` (text.length chars), pre-text had
  // `rangeLength` chars of unknown content.
  let result = "";
  let preCursor = 0; // position in pre-doc
  let postCursor = 0; // position in post-doc

  for (const c of sorted) {
    // Unchanged gap before this change
    const gapLength = c.rangeOffset - preCursor;
    result += postText.slice(postCursor, postCursor + gapLength);
    postCursor += gapLength;
    preCursor += gapLength;

    // The change: in pre-doc, rangeLength chars; in post-doc, text.length chars.
    // Fill with null bytes as placeholder — these won't match post-text,
    // so computeSingleChange will include this region in the "changed middle".
    result += "\0".repeat(c.rangeLength);
    preCursor += c.rangeLength;
    postCursor += c.text.length;
  }

  // Remaining unchanged text after the last change
  result += postText.slice(postCursor);

  return result;
}

// ---------------------------------------------------------------------------
// Generic item adjustment
// ---------------------------------------------------------------------------

/**
 * Adjust an array of items in place after document edits.
 * Items whose ranges become null (intersected an edit) are spliced out.
 * Items whose ranges survive are updated via setRange.
 */
export function adjustItems<T>(
  items: T[],
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  getRange: (item: T) => vscode.Range,
  setRange: (item: T, range: vscode.Range) => T,
  adjustFn: (range: vscode.Range, edit: EditParams) => vscode.Range | null,
): void {
  for (const edit of processChanges(changes)) {
    for (let i = items.length - 1; i >= 0; i--) {
      const adjusted = adjustFn(getRange(items[i]), edit);
      if (adjusted) {
        items[i] = setRange(items[i], adjusted);
      } else {
        items.splice(i, 1);
      }
    }
  }
}
