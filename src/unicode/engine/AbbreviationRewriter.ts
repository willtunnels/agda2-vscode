// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/AbbreviationRewriter.ts)
// Modified for Agda

import { AbbreviationConfig } from "./AbbreviationConfig";
import { AbbreviationProvider } from "./AbbreviationProvider";
import { Range } from "./Range";
import { TrackedAbbreviation } from "./TrackedAbbreviation";
import type { CycleDirection } from "./TrackedAbbreviation";

export interface Change {
  range: Range;
  newText: string;
}

export interface AbbreviationTextSource {
  replaceAbbreviations(changes: Change[]): Promise<boolean>;
  collectSelections(): Range[];
}

/** Info gathered for each abbreviation during first replacement (typing -> cycling). */
interface ReplaceInfo {
  abbr: TrackedAbbreviation;
  symbols: string[];
  newText: string;
  initialIndex: number;
}

/** Info gathered for each abbreviation during cycle replacement. */
interface CycleInfo {
  abbr: TrackedAbbreviation;
  newText: string;
}

export class AbbreviationRewriter {
  /**
   * All tracked abbreviations are disjoint.
   */
  private readonly trackedAbbreviations = new Set<TrackedAbbreviation>();

  private doNotTrackNewAbbr = false;

  /**
   * Abbreviations that received a non-matching character in typing mode.
   * Populated by changeInput(), consumed by triggerAbbreviationReplacement().
   */
  private readonly _finishedAbbreviations = new Set<TrackedAbbreviation>();

  /**
   * Deferred extend/shorten operations queued during processChange.
   * These are NOT started immediately — they are executed sequentially
   * by flushPendingOps().  This is critical for multi-cursor: when
   * changeInput processes multiple changes in one batch, earlier
   * processChange calls may shift abbreviation ranges that later
   * doShorten/doExtend calls need to read.  By deferring execution,
   * each operation reads the range AFTER all batch adjustments.
   */
  private _pendingOps: (() => Promise<void>)[] = [];

  constructor(
    private readonly config: AbbreviationConfig,
    private readonly abbreviationProvider: AbbreviationProvider,
    private readonly textSource: AbbreviationTextSource,
  ) {}

  changeInput(changes: Change[]) {
    // Process changes from bottom to top so offsets stay valid.
    changes.sort((c1, c2) => c2.range.start - c1.range.start);

    for (const c of changes) {
      this.processChange(c);
    }
  }

  /**
   * After input changes, check if any abbreviations should be replaced.
   *
   * - Finished abbreviations (non-matching char typed) are always replaced.
   * - In eager mode, abbreviations whose text is a complete abbreviation
   *   are replaced (even if longer abbreviations exist).
   */
  async triggerAbbreviationReplacement() {
    // Finished abbreviations (non-matching char typed) — always finalize
    const finished = [...this._finishedAbbreviations];
    this._finishedAbbreviations.clear();
    if (finished.length > 0) {
      await this.forceReplace(finished);
    }

    // Eager replacement: complete abbreviations that are still in typing mode
    // → replace with first symbol and enter cycling mode (stay tracked)
    const complete = [...this.trackedAbbreviations].filter(
      (abbr) =>
        !abbr.isReplaced &&
        this.abbreviationProvider.getSymbolsForAbbreviation(abbr.abbreviation) !== undefined,
    );
    if (complete.length > 0) {
      await this.replaceAndEnterCycling(complete);
    }
  }

  async changeSelections(selections: Range[]) {
    await this.forceReplace(
      [...this.trackedAbbreviations].filter(
        (abbr) => !selections.some((s) => abbr.range.containsRange(s.withLength(0))),
      ),
    );
  }

  async replaceAllTrackedAbbreviations() {
    await this.forceReplace([...this.trackedAbbreviations]);
  }

  /**
   * Cycle all replaced abbreviations that have a cursor in them.
   * Called by the Tab / Shift+Tab commands.
   *
   * For abbreviations still in typing mode that have a complete match,
   * does the first replacement and enters cycling mode.
   *
   * Returns true if any cycling/replacement occurred.
   */
  async cycleAbbreviations(direction: CycleDirection): Promise<boolean> {
    const selections = this.textSource.collectSelections();

    const withCursor = [...this.trackedAbbreviations].filter((abbr) =>
      selections.some((s) => abbr.range.containsRange(s.withLength(0))),
    );

    if (withCursor.length === 0) return false;

    const toCycle = withCursor.filter((a) => a.isReplaced);
    const toFirstReplace = withCursor.filter(
      (a) =>
        !a.isReplaced &&
        this.abbreviationProvider.getSymbolsForAbbreviation(a.abbreviation) !== undefined,
    );

    if (toCycle.length === 0 && toFirstReplace.length === 0) {
      // Nothing to cycle and nothing complete — do a normal replaceAll (Tab = convert)
      await this.replaceAllTrackedAbbreviations();
      return true;
    }

    if (toFirstReplace.length > 0) {
      await this.replaceAndEnterCycling(toFirstReplace);
    }

    if (toCycle.length > 0) {
      await this.doCycleReplace(toCycle, direction);
    }

    return true;
  }

  /**
   * Await any pending doExtend/doShorten operations.
   * Must be called after changeInput() and before triggerAbbreviationReplacement()
   * to ensure state is consistent before deciding on replacements.
   */
  async flushPendingOps(): Promise<void> {
    const ops = this._pendingOps.splice(0);
    for (const op of ops) {
      await op();
    }
  }

  getTrackedAbbreviations(): Set<TrackedAbbreviation> {
    return this.trackedAbbreviations;
  }

  resetTrackedAbbreviations() {
    this.trackedAbbreviations.clear();
    this._finishedAbbreviations.clear();
  }

  private removeFromTracking(abbr: TrackedAbbreviation): void {
    if (abbr.isReplaced) {
      this.abbreviationProvider.setLastSelectedIndex(abbr.abbreviation, abbr.cycleIndex);
    }
    this.trackedAbbreviations.delete(abbr);
    this._finishedAbbreviations.delete(abbr);
  }

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    this.doNotTrackNewAbbr = true;
    const ok = await this.textSource.replaceAbbreviations(changes);
    this.doNotTrackNewAbbr = false;
    return ok;
  }

  // --- Internal: batch range shifting ---

  /**
   * Sort items by abbreviation offset and invoke a callback with shifted ranges.
   * Used after a batch edit to update each abbreviation's range accounting for
   * the cumulative length changes of preceding items.
   */
  private applyShiftsToSorted<T extends CycleInfo>(
    items: T[],
    apply: (item: T, newRange: Range) => void,
  ): void {
    let totalShift = 0;
    const sorted = [...items].sort((a, b) => a.abbr.range.start - b.abbr.range.start);
    for (const item of sorted) {
      const oldRange = item.abbr.range;
      const newRange = new Range(oldRange.start + totalShift, item.newText.length);
      apply(item, newRange);
      totalShift += item.newText.length - oldRange.length;
    }
  }

  // --- Internal: first replacement (typing → cycling) ---

  /**
   * Replace abbreviation text with the first symbol and enter cycling mode.
   * The abbreviation stays tracked (not finalized).
   */
  private async replaceAndEnterCycling(abbreviations: TrackedAbbreviation[]): Promise<void> {
    const changes: Change[] = [];
    const abbrInfo: ReplaceInfo[] = [];

    for (const abbr of abbreviations) {
      const symbols = this.abbreviationProvider.getSymbolsForAbbreviation(abbr.abbreviation);
      if (!symbols || symbols.length === 0) continue;

      // Start from the remembered index (Emacs-style last selection)
      const initialIndex = this.abbreviationProvider.getLastSelectedIndex(abbr.abbreviation);
      const newText = symbols[initialIndex];
      changes.push({ range: abbr.range, newText });
      abbrInfo.push({ abbr, symbols, newText, initialIndex });
    }

    if (changes.length === 0) return;

    const ok = await this.replaceAbbreviations(changes);

    if (ok) {
      this.applyShiftsToSorted(abbrInfo, ({ abbr, symbols, initialIndex }, newRange) => {
        abbr.enterReplacedState(symbols, newRange, initialIndex);
      });
    }
  }

  // --- Internal: cycle replacement ---

  /**
   * Replace the current symbol with the next/previous in the cycle list.
   */
  private async doCycleReplace(
    abbreviations: TrackedAbbreviation[],
    direction: CycleDirection,
  ): Promise<void> {
    const changes: Change[] = [];
    const cycleInfo: CycleInfo[] = [];

    for (const abbr of abbreviations) {
      const newSymbol = abbr.cycle(direction);
      changes.push({ range: abbr.range, newText: newSymbol });
      cycleInfo.push({ abbr, newText: newSymbol });
    }

    if (changes.length === 0) return;

    const ok = await this.replaceAbbreviations(changes);

    if (ok) {
      this.applyShiftsToSorted(cycleInfo, ({ abbr }, newRange) => {
        abbr.updateRangeAfterCycleEdit(newRange);
      });
    }
  }

  /**
   * Apply a single-change edit and shift all OTHER tracked abbreviation
   * ranges by the document delta.  This is necessary because the
   * re-entrant onDidChangeTextDocument from the edit is suppressed by
   * the VS Code layer, so the engine never sees the shift.
   *
   * Without this, sequential doExtend/doShorten calls in multi-cursor
   * scenarios would use stale offsets for the second abbreviation.
   */
  private async applyEditAndShiftOthers(
    editedAbbr: TrackedAbbreviation,
    change: Change,
  ): Promise<boolean> {
    const ok = await this.replaceAbbreviations([change]);

    if (ok) {
      const delta = change.newText.length - change.range.length;
      if (delta !== 0) {
        for (const abbr of this.trackedAbbreviations) {
          if (abbr === editedAbbr) continue;
          if (abbr.abbreviationRange.start > change.range.start) {
            abbr.shiftRange(delta);
          }
        }
      }
    }

    return ok;
  }

  // --- Internal: extend/shorten replaced abbreviation ---

  /**
   * Shared logic for extending (user types after symbol) and shortening
   * (user backspaces symbol) a replaced abbreviation.
   *
   * @param abbr The tracked abbreviation to update.
   * @param newAbbrevText The new abbreviation text after extend/shorten.
   * @param replaceRange The document range to replace with the new content.
   */
  private async doUpdateReplaced(
    abbr: TrackedAbbreviation,
    newAbbrevText: string,
    replaceRange: Range,
  ): Promise<void> {
    const newSymbols =
      newAbbrevText.length > 0
        ? (this.abbreviationProvider.getSymbolsForAbbreviation(newAbbrevText) ?? [])
        : [];
    const initialIndex =
      newSymbols.length > 0 ? this.abbreviationProvider.getLastSelectedIndex(newAbbrevText) : 0;
    const newDisplay = abbr.updateAbbreviation(newAbbrevText, newSymbols, initialIndex);

    if (newDisplay !== undefined) {
      const change: Change = { range: replaceRange, newText: newDisplay };
      const ok = await this.applyEditAndShiftOthers(abbr, change);
      if (ok) {
        abbr.updateRangeAfterCycleEdit(new Range(replaceRange.start, newDisplay.length));
      }
    } else {
      const leaderAndText = this.config.abbreviationCharacter + newAbbrevText;
      const change: Change = { range: replaceRange, newText: leaderAndText };
      const ok = await this.applyEditAndShiftOthers(abbr, change);
      if (ok) {
        abbr.updateRangeAfterCycleEdit(new Range(replaceRange.start + 1, newAbbrevText.length));
      }
    }
  }

  private async doExtend(abbr: TrackedAbbreviation, extendChar: string): Promise<void> {
    // Capture symbol range BEFORE updateAbbreviation may flip _isReplaced
    const replaceRange = new Range(abbr.range.start, abbr.range.length + extendChar.length);
    await this.doUpdateReplaced(abbr, abbr.abbreviation + extendChar, replaceRange);
  }

  private async doShorten(abbr: TrackedAbbreviation): Promise<void> {
    await this.doUpdateReplaced(abbr, abbr.abbreviation.slice(0, -1), abbr.abbreviationRange);
  }

  // --- Finalize ---

  /**
   * Replace abbreviations with their matching symbols and remove from tracking.
   * For already-replaced abbreviations, just remove tracking (symbol is already in doc).
   */
  private async forceReplace(abbreviations: TrackedAbbreviation[]): Promise<void> {
    if (abbreviations.length === 0) return;

    const alreadyReplaced = abbreviations.filter((a) => a.isReplaced);
    const needsReplace = abbreviations.filter((a) => !a.isReplaced);

    for (const a of alreadyReplaced) {
      this.removeFromTracking(a);
    }

    if (needsReplace.length > 0) {
      for (const a of needsReplace) {
        this.trackedAbbreviations.delete(a);
      }

      const changes = this.computeReplacementChanges(needsReplace);

      // If no abbreviation produced a replacement (e.g. empty text after
      // bare `\`), just remove from tracking.  Calling replaceAbbreviations
      // with an empty change list would trigger the isApplyingEdit guard
      // with no reentrant event to absorb, causing the next real keystroke
      // to be silently skipped.
      if (changes.length === 0) return;

      const ok = await this.replaceAbbreviations(changes);

      if (!ok) {
        for (const a of needsReplace) {
          this.trackedAbbreviations.add(a);
        }
      }
    }
  }

  private computeReplacementChanges(abbreviations: TrackedAbbreviation[]): Change[] {
    const changes: Change[] = [];
    for (const abbr of abbreviations) {
      const symbols = this.abbreviationProvider.getSymbolsForAbbreviation(abbr.abbreviation);
      if (symbols && symbols.length > 0) {
        changes.push({ range: abbr.range, newText: symbols[0] });
      }
    }
    changes.sort((a, b) => a.range.start - b.range.start);
    return changes;
  }

  private processChange(c: Change): void {
    let isAnyTrackedAbbrAffected = false;
    for (const abbr of [...this.trackedAbbreviations]) {
      const result = abbr.processChange(c.range, c.newText);
      switch (result.kind) {
        case "none":
          break;
        case "stop":
          this.removeFromTracking(abbr);
          break;
        case "updated":
          isAnyTrackedAbbrAffected = true;
          // If this abbreviation was previously marked finished by an
          // earlier change in the same batch, a subsequent edit inside
          // its range overrides that.
          this._finishedAbbreviations.delete(abbr);
          break;
        case "appended":
          if (
            this.abbreviationProvider.hasAbbreviationsWithPrefix(abbr.abbreviation + result.text)
          ) {
            isAnyTrackedAbbrAffected = true;
            if (abbr.isReplaced) {
              this._pendingOps.push(() => this.doExtend(abbr, result.text));
            } else {
              abbr.acceptAppend(result.text);
            }
          } else if (abbr.isReplaced) {
            this.removeFromTracking(abbr);
          } else {
            this._finishedAbbreviations.add(abbr);
          }
          break;
        case "shorten":
          isAnyTrackedAbbrAffected = true;
          this._pendingOps.push(() => this.doShorten(abbr));
          break;
      }
    }

    if (
      c.newText === this.config.abbreviationCharacter &&
      !isAnyTrackedAbbrAffected &&
      !this.doNotTrackNewAbbr
    ) {
      const abbr = new TrackedAbbreviation(new Range(c.range.start + 1, 0), "");
      this.trackedAbbreviations.add(abbr);
    }
  }
}
