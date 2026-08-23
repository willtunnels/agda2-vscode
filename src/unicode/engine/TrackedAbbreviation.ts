// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/TrackedAbbreviation.ts)
// Modified for Agda

import { AbbreviationProvider } from "./AbbreviationProvider";
import { Range } from "./Range";

/** Direction for cycling through abbreviation symbols: forward (+1) or backward (-1). */
export type CycleDirection = 1 | -1;

/**
 * Lifecycle status of a tracked abbreviation.
 *
 *   - `active`: the user is still working on it (typing, cycling, extending).
 *   - `finished`: done (non-extending char typed, cursor moved away, or
 *     replace-all). The next flush reconciles the document and drops it.
 *   - `deleted`: removed via the delete command. The next flush deletes its
 *     span from the document and drops it.
 */
export type AbbreviationStatus = "active" | "finished" | "deleted";

/**
 * How to interpret {@link TrackedAbbreviation.shown} when processing edits.
 *
 *   - `typing`: `shown` is `\` + text, exactly what the user typed.
 *   - `symbol`: `shown[0..symbolLen)` is a symbol written by flush; the rest
 *     (the tail) is characters the user typed after it since the last flush.
 */
export type DisplayKind = "typing" | "symbol";

/**
 * One abbreviation tracked by the rewriter, reconciliation-style.
 *
 * The abbreviation always knows two strings:
 *
 *   - {@link shown}: the exact document content of its span
 *     `[start, start + shown.length)`. Kept in sync by the rewriter as it
 *     processes document changes.
 *   - {@link desired}: what the span *should* show, derived from
 *     `text`/`status`/`cycleIndex`. Never stored.
 *
 * The rewriter's flush writes `desired` wherever it differs from `shown`.
 * There are no dirty flags; "needs a write" is always `desired !== shown`.
 *
 * The cycle list is derived from the provider on demand; only the index is
 * stored. {@link setText} re-derives the index from the remembered
 * last-selected one, so every text change keeps it consistent.
 */
export class TrackedAbbreviation {
  status: AbbreviationStatus = "active";
  kind: DisplayKind = "typing";

  /**
   * `kind === "symbol"` only: length of the prefix of {@link shown} written
   * by the last flush. The rest of `shown` is the tail.
   */
  symbolLen = 0;

  /** Index into {@link cycleSymbols}. Maintained by {@link setText}/{@link cycle}. */
  cycleIndex = 0;

  private _text: string;

  constructor(
    private readonly provider: AbbreviationProvider,
    private readonly leader: string,
    /** Document offset where the span starts. */
    public start: number,
    /** Document content of the span. */
    public shown: string,
    text: string,
  ) {
    this._text = text;
  }

  /** The abbreviation text being built (excluding the leader). */
  get text(): string {
    return this._text;
  }

  /**
   * Update the abbreviation text, re-deriving the cycle index from the
   * provider's remembered last selection (clamped in case the table shrank).
   */
  setText(value: string): void {
    this._text = value;
    const symbols = this.cycleSymbols;
    this.cycleIndex =
      symbols.length > 0
        ? Math.min(this.provider.getLastSelectedIndex(value), symbols.length - 1)
        : 0;
  }

  /** Span of {@link shown} in the document (leader included in typing mode). */
  get range(): Range {
    return new Range(this.start, this.shown.length);
  }

  /** Whether the document currently shows a flushed symbol (vs `\text`). */
  get isReplaced(): boolean {
    return this.kind === "symbol";
  }

  /** The cycle list for the current text (derived, never stored). */
  get cycleSymbols(): string[] {
    return this.provider.getSymbolsForAbbreviation(this._text) ?? [];
  }

  get isCycleable(): boolean {
    return this.cycleSymbols.length > 1;
  }

  /** Characters typed after the flushed symbol since the last flush. */
  get tail(): string {
    return this.shown.slice(this.symbolLen);
  }

  /**
   * What the span should show:
   * deleted → nothing; complete abbreviation → the current cycle symbol;
   * otherwise (empty, prefix-only, or impossible text) → `\text`.
   */
  get desired(): string {
    if (this.status === "deleted") {
      return "";
    }
    const symbols = this.cycleSymbols;
    if (symbols.length > 0) {
      return symbols[this.cycleIndex];
    }
    return this.leader + this._text;
  }

  /** Step the cycle index. No-op if the current text has no symbols. */
  cycle(direction: CycleDirection): void {
    const n = this.cycleSymbols.length;
    if (n === 0) {
      return;
    }
    this.cycleIndex = (this.cycleIndex + direction + n) % n;
  }
}
