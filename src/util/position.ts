import * as vscode from "vscode";
import type { AgdaOffset } from "./offsets.js";
import { agdaCpOffsetToUtf16, utf16OffsetToAgdaCp } from "./offsets.js";

/**
 * Convert a 1-based Agda absolute code-point offset to a VSCode Position.
 * Pass `text` to avoid repeated `document.getText()` calls in loops.
 */
export function agdaOffsetToPosition(
  document: vscode.TextDocument,
  offset: AgdaOffset,
  text?: string,
): vscode.Position {
  const t = text ?? document.getText();
  const utf16 = agdaCpOffsetToUtf16(t, offset);
  return document.positionAt(utf16);
}

/**
 * Convert an Agda highlighting range [from, to] (1-based code-point offsets)
 * to a VSCode Range.
 * Pass `text` to avoid repeated `document.getText()` calls in loops.
 */
export function agdaHighlightRangeToVscode(
  document: vscode.TextDocument,
  range: [AgdaOffset, AgdaOffset],
  text?: string,
): vscode.Range {
  return new vscode.Range(
    agdaOffsetToPosition(document, range[0], text),
    agdaOffsetToPosition(document, range[1], text),
  );
}

/**
 * Convert a VSCode Position to a 1-based Agda absolute code-point offset.
 * Pass `text` to avoid repeated `document.getText()` calls in loops.
 */
export function positionToAgdaOffset(
  document: vscode.TextDocument,
  position: vscode.Position,
  text?: string,
): AgdaOffset {
  const t = text ?? document.getText();
  const utf16Offset = document.offsetAt(position);
  return utf16OffsetToAgdaCp(t, utf16Offset);
}
