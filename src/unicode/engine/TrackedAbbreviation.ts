// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/TrackedAbbreviation.ts)
// Modified for Agda

import { Range } from "./Range";

/** Direction for cycling through abbreviation symbols: forward (+1) or backward (-1). */
export type CycleDirection = 1 | -1;

/** Result of processing a document change against a tracked abbreviation. */
export type ProcessChangeResult =
  /** Change was elsewhere -- no impact (range may have been shifted internally). */
  | { kind: "none" }
  /** Abbreviation should be removed from tracking (disruptive edit). */
  | { kind: "stop" }
  /** Edit inside the abbreviation range updated its text/range. */
  | { kind: "updated" }
  /** Text appended at end of the abbreviation. Caller should check prefix
   *  validity and take the appropriate action for the current mode
   *  (typing: `acceptAppend`; replaced: queue extend). */
  | { kind: "appended"; text: string }
  /** Replaced mode: symbol fully deleted (backspace). Caller should queue
   *  a shorten operation. */
  | { kind: "shorten" };

/**
 * Represents an abbreviation tracked by the rewriter.
 *
 * Lifecycle states:
 *   1. **Typing** -- the user is building the abbreviation character by character.
 *      `isReplaced === false`. The range covers `\` + abbreviation text.
 *   2. **Replaced / cycling** -- the abbreviation text has been replaced with a
 *      symbol from the cycle list. `isReplaced === true`. The range covers the
 *      symbol in the document. Tab advances `cycleIndex`.
 *
 * This class is a pure position/state tracker with no dependencies on the
 * abbreviation database. The rewriter is responsible for all provider queries.
 */
export class TrackedAbbreviation {
  /** Range of the abbreviation text (excluding the leader `\`). */
  private _abbreviationRange: Range;

  /** The abbreviation text typed so far (excluding leader). */
  private _text: string;

  // --- Cycling state ---

  /** Whether the document currently shows a symbol (true) or `\text` (false). */
  private _isReplaced = false;

  /** The cycle list for the current abbreviation text. */
  private _cycleSymbols: string[] = [];

  /** Current index into _cycleSymbols. */
  private _cycleIndex = 0;

  // --- Public getters ---

  get abbreviationRange(): Range {
    return this._abbreviationRange;
  }

  /** Full range including the leader character. */
  get range(): Range {
    if (this._isReplaced) {
      // When replaced, the leader is gone; range IS the symbol
      return this._abbreviationRange;
    }
    return this.abbreviationRange.moveStart(-1);
  }

  get abbreviation(): string {
    return this._text;
  }

  get isReplaced(): boolean {
    return this._isReplaced;
  }

  get cycleSymbols(): string[] {
    return this._cycleSymbols;
  }

  get cycleIndex(): number {
    return this._cycleIndex;
  }

  get isCycleable(): boolean {
    return this._cycleSymbols.length > 1;
  }

  /** The symbol currently shown (or that would be shown) for this abbreviation. */
  get currentSymbol(): string | undefined {
    if (this._cycleSymbols.length === 0) return undefined;
    return this._cycleSymbols[this._cycleIndex];
  }

  constructor(abbreviationRange: Range, text: string) {
    this._abbreviationRange = abbreviationRange;
    this._text = text;
  }

  // --- Cycling methods ---

  /**
   * Enter replaced/cycling mode. Called by the rewriter after it replaces
   * `\text` with a symbol in the document.
   *
   * @param symbols The cycle list for the current abbreviation.
   * @param symbolRange The range of the replaced symbol in the document.
   * @param initialIndex Starting index into the cycle list (from remembered
   *   last selection). Defaults to 0.
   */
  enterReplacedState(symbols: string[], symbolRange: Range, initialIndex = 0): void {
    this._cycleSymbols = symbols;
    this._cycleIndex = initialIndex;
    this._isReplaced = true;
    this._abbreviationRange = symbolRange;
  }

  /**
   * Advance the cycle index. Returns the new symbol.
   */
  cycle(direction: CycleDirection): string {
    if (this._cycleSymbols.length === 0) {
      throw new Error("Cannot cycle: no symbols");
    }
    const n = this._cycleSymbols.length;
    this._cycleIndex = (((this._cycleIndex + direction) % n) + n) % n;
    return this._cycleSymbols[this._cycleIndex];
  }

  /**
   * Update the range after a cycle replacement edited the document.
   * The symbol at _abbreviationRange was replaced with a new symbol.
   */
  updateRangeAfterCycleEdit(newRange: Range): void {
    this._abbreviationRange = newRange;
  }

  /**
   * Shift the abbreviation range by a delta.
   * Used to adjust for edits to OTHER abbreviations in multi-cursor scenarios
   * where the re-entrant event from the edit is suppressed.
   */
  shiftRange(delta: number): void {
    this._abbreviationRange = this._abbreviationRange.move(delta);
  }

  /**
   * Update the abbreviation text and cycle list while in replaced mode.
   * Used for both extending (user types a character after the symbol) and
   * shortening (user backspaces the symbol).
   *
   * @param newText The new abbreviation text.
   * @param newSymbols The cycle list for the new abbreviation, or empty
   *   if the new text is not yet a complete abbreviation.
   * @param initialIndex Starting index into the cycle list.
   * @returns The symbol to display, or undefined if back to typing mode.
   */
  updateAbbreviation(newText: string, newSymbols: string[], initialIndex = 0): string | undefined {
    this._text = newText;
    this._cycleSymbols = newSymbols;
    this._cycleIndex = initialIndex;
    if (newSymbols.length > 0) {
      return newSymbols[initialIndex];
    }
    this._isReplaced = false;
    return undefined;
  }

  /**
   * Accept text appended at the end of the abbreviation in typing mode.
   * Called by the rewriter after confirming the extended text is a valid prefix.
   */
  acceptAppend(text: string): void {
    this._abbreviationRange = this._abbreviationRange.moveEnd(text.length);
    this._text = this._text + text;
  }

  // --- Change processing ---

  processChange(range: Range, newText: string): ProcessChangeResult {
    if (this._isReplaced) {
      return this._processChangeReplaced(range, newText);
    } else {
      return this._processChangeTyping(range, newText);
    }
  }

  /** Process a document change while in typing mode. */
  private _processChangeTyping(range: Range, newText: string): ProcessChangeResult {
    if (this.abbreviationRange.containsRange(range)) {
      if (this.abbreviationRange.isBefore(range)) {
        // Text appended at end -- caller checks prefix validity.
        return { kind: "appended", text: newText };
      }

      this._abbreviationRange = this.abbreviationRange.moveEnd(newText.length - range.length);
      const startStr = this.abbreviation.slice(0, range.start - this.abbreviationRange.start);
      const endStr = this.abbreviation.slice(range.endInclusive + 1 - this.abbreviationRange.start);
      this._text = startStr + newText + endStr;

      return { kind: "updated" };
    } else if (range.isBefore(this.range)) {
      this._abbreviationRange = this._abbreviationRange.move(newText.length - range.length);
      return { kind: "none" };
    } else if (range.isAfter(this.range)) {
      return { kind: "none" };
    } else {
      return { kind: "stop" };
    }
  }

  /** Process a document change while in replaced mode. */
  private _processChangeReplaced(range: Range, newText: string): ProcessChangeResult {
    if (range.isAfter(this._abbreviationRange)) {
      if (range.start === this._abbreviationRange.endInclusive + 1 && newText.length === 1) {
        return { kind: "appended", text: newText };
      }
      // Not immediately adjacent (e.g. multi-cursor edit elsewhere).
      return { kind: "none" };
    }

    if (range.isBefore(this._abbreviationRange)) {
      this._abbreviationRange = this._abbreviationRange.move(newText.length - range.length);
      return { kind: "none" };
    }

    if (this._abbreviationRange.containsRange(range)) {
      this._abbreviationRange = this._abbreviationRange.moveEnd(newText.length - range.length);

      if (this._abbreviationRange.length === 0 && newText.length === 0 && this._text.length > 0) {
        return { kind: "shorten" };
      }

      return { kind: "updated" };
    }

    return { kind: "stop" };
  }
}
