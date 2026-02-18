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
   *  validity and call `acceptAppend` if valid. */
  | { kind: "appended"; text: string }
  /** Replaced mode: symbol fully deleted (backspace). Caller should shorten
   *  the abbreviation text and update cycle state. */
  | { kind: "shorten" };

/**
 * Represents an abbreviation tracked by the rewriter.
 *
 * Lifecycle states:
 *   1. **Typing** -- the user is building the abbreviation character by character.
 *      `isReplaced === false`. The range covers `\` + abbreviation text.
 *   2. **Replaced / cycling** -- the abbreviation text has been replaced with a
 *      symbol from the cycle list. `isReplaced === true`. The range covers the
 *      flushed symbol plus any extension chars typed after it.
 *
 * In replaced mode, `_flushedSymbolLength` records the display length of the
 * symbol last written by flush. Extension chars (typed by the user after the
 * symbol) occupy the rest of the range. The rewriter owns dirty tracking.
 *
 * This class is a pure position/state tracker with no dependencies on the
 * abbreviation database. The rewriter is responsible for all provider queries.
 */
export class TrackedAbbreviation {
  /**
   * In typing mode: range of the abbreviation text (excluding the leader `\`).
   * In replaced mode: range of the flushed symbol plus any extension chars.
   */
  private _abbreviationRange: Range;

  /** The abbreviation text (excluding leader). Includes extensions in replaced mode. */
  private _text: string;

  // --- Cycling state ---

  /** Whether the document currently shows a symbol (true) or `\text` (false). */
  private _isReplaced = false;

  /** The cycle list for the current abbreviation text. */
  private _cycleSymbols: string[] = [];

  /** Current index into _cycleSymbols. */
  private _cycleIndex = 0;

  /**
   * Replaced mode only: display length of the symbol last written by flush.
   * Extension chars start at `_abbreviationRange.start + _flushedSymbolLength`.
   */
  private _flushedSymbolLength = 0;

  // --- Public getters ---

  get abbreviationRange(): Range {
    return this._abbreviationRange;
  }

  /**
   * Full range in the document.
   * Typing mode: includes the leader character.
   * Replaced mode: includes flushed symbol + extension chars.
   */
  get range(): Range {
    if (this._isReplaced) {
      return this._abbreviationRange;
    }
    return this._abbreviationRange.moveStart(-1);
  }

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    this._text = value;
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

  get flushedSymbolLength(): number {
    return this._flushedSymbolLength;
  }

  constructor(abbreviationRange: Range, text: string) {
    this._abbreviationRange = abbreviationRange;
    this._text = text;
  }

  // --- State update methods ---

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
    this._flushedSymbolLength = symbolRange.length;
  }

  /**
   * Advance the cycle index. Returns the new symbol.
   */
  cycle(direction: CycleDirection): string {
    if (this._cycleSymbols.length === 0) {
      throw new Error("Cannot cycle: no symbols");
    }
    const n = this._cycleSymbols.length;
    this._cycleIndex = (this._cycleIndex + direction + n) % n;
    return this._cycleSymbols[this._cycleIndex];
  }

  /**
   * Set the cycle list and index directly.
   * Used by the rewriter after extend, shorten, or updated events.
   */
  setCycleState(symbols: string[], index: number): void {
    this._cycleSymbols = symbols;
    this._cycleIndex = index;
  }

  /**
   * Update range and flushedSymbolLength after a successful flush
   * that wrote a new symbol to the document.
   */
  updateAfterFlush(symbolRange: Range): void {
    this._abbreviationRange = symbolRange;
    this._flushedSymbolLength = symbolRange.length;
  }

  /**
   * Revert from replaced mode to typing mode after a flush
   * (e.g. the shortened abbreviation has no symbols, so we display `\text`).
   */
  revertToTyping(textRange: Range): void {
    this._isReplaced = false;
    this._cycleSymbols = [];
    this._cycleIndex = 0;
    this._flushedSymbolLength = 0;
    this._abbreviationRange = textRange;
  }

  /**
   * Accept text appended at the end of the abbreviation.
   * Grows both the range and text. Works for both typing and replaced mode.
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
      if (range.length === 0 && range.start === this.abbreviationRange.endInclusive + 1) {
        // Zero-length insertion at end -- caller checks prefix validity.
        return { kind: "appended", text: newText };
      }

      this._abbreviationRange = this.abbreviationRange.moveEnd(newText.length - range.length);
      const startStr = this.text.slice(0, range.start - this.abbreviationRange.start);
      const endStr = this.text.slice(range.endInclusive + 1 - this.abbreviationRange.start);
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
    // After range: check adjacency for append
    if (range.isAfter(this._abbreviationRange)) {
      if (range.start === this._abbreviationRange.endInclusive + 1 && newText.length === 1) {
        return { kind: "appended", text: newText };
      }
      // Not immediately adjacent (e.g. multi-cursor edit elsewhere).
      return { kind: "none" };
    }

    // Before range: shift
    if (range.isBefore(this._abbreviationRange)) {
      this._abbreviationRange = this._abbreviationRange.move(newText.length - range.length);
      return { kind: "none" };
    }

    // Contained in range
    if (this._abbreviationRange.containsRange(range)) {
      const extensionLen = this._abbreviationRange.length - this._flushedSymbolLength;
      const symbolEnd = this._abbreviationRange.start + this._flushedSymbolLength;

      if (extensionLen > 0 && range.start >= symbolEnd) {
        // Edit in extension region: splice text and adjust range
        const baseTextLen = this._text.length - extensionLen;
        const extOffset = range.start - symbolEnd;
        const extText = this._text.slice(baseTextLen);

        const newExt =
          extText.slice(0, extOffset) + newText + extText.slice(extOffset + range.length);

        this._text = this._text.slice(0, baseTextLen) + newExt;
        this._abbreviationRange = this._abbreviationRange.moveEnd(newText.length - range.length);
        return { kind: "updated" };
      } else if (extensionLen > 0) {
        // Edit touches symbol while extensions exist: stop
        return { kind: "stop" };
      } else {
        // No extensions
        this._abbreviationRange = this._abbreviationRange.moveEnd(newText.length - range.length);

        if (this._abbreviationRange.length === 0 && newText.length === 0 && this._text.length > 0) {
          return { kind: "shorten" };
        }

        return { kind: "updated" };
      }
    }

    // Overlaps boundary: stop
    return { kind: "stop" };
  }
}
