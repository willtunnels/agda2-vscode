// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/AbbreviationRewriter.ts)
// Modified for Agda

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

/**
 * State machine for abbreviation tracking and replacement abstracted over
 * the text source (input box, editor, etc.).
 *
 * Each abbreviation goes through two phases:
 *   1. **Typing** — the user is building `\text` character by character.
 *   2. **Replaced / cycling** — `\text` has been eagerly replaced with a
 *      symbol; Tab/Shift+Tab cycles through alternatives.
 *
 * All state changes (extend, shorten, cycle) update abbreviation state
 * synchronously. A single {@link flushDirty} method computes the diff
 * and applies one batch document edit.
 *
 * All actual document edits are delegated to an {@link AbbreviationTextSource}.
 */
export class AbbreviationRewriter {
  /** All tracked abbreviations (disjoint ranges). */
  private readonly trackedAbbreviations = new Set<TrackedAbbreviation>();

  /** Set during our own edits so the engine doesn't track replacement text as a new `\`. */
  private doNotTrackNewAbbr = false;

  /**
   * Typing-mode abbreviations that are done (cursor moved away, or a
   * non-extending character was typed). The document still shows `\text`;
   * flushDirty() replaces it with the symbol and removes them from tracking.
   */
  private readonly _finishedAbbreviations = new Set<TrackedAbbreviation>();

  /**
   * Replaced abbreviations that were both dirty and finalized in the same
   * change batch. For example, the user extends an abbreviation (marking it
   * dirty) then types a non-extending character (finalizing it).
   * removeFromTracking() clears dirtyAbbreviations, so without this set the
   * pending document update would be lost.
   */
  private readonly _finalizedDirty = new Set<TrackedAbbreviation>();

  /**
   * Replaced-mode abbreviations whose in-memory state (cycle index,
   * extension text) differs from what's in the document. flushDirty()
   * writes the current symbol to the document and clears the flag.
   */
  private readonly dirtyAbbreviations = new Set<TrackedAbbreviation>();

  /**
   * Abbreviations to delete entirely (Ctrl+Backspace). flushDirty()
   * replaces their range with empty text and removes them from tracking.
   */
  private readonly _deletedAbbreviations = new Set<TrackedAbbreviation>();

  constructor(
    private readonly abbreviationCharacter: string,
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
   * Mark any tracked abbreviation that no longer contains a cursor for finalization.
   * Replaced abbreviations are removed from tracking immediately (symbol is already
   * in the document). Typing-mode abbreviations are added to `_finishedAbbreviations`
   * for replacement by {@link flushDirty}.
   */
  changeSelections(selections: Range[]) {
    const toFinalize = [...this.trackedAbbreviations].filter(
      (abbr) => !selections.some((s) => abbr.range.containsRange(s.withLength(0))),
    );
    for (const abbr of toFinalize) {
      if (abbr.isReplaced) {
        this.removeFromTracking(abbr);
      } else {
        this._finishedAbbreviations.add(abbr);
      }
    }
  }

  /**
   * Mark all tracked abbreviations for finalization.
   * Used on dispose, editor switch, input box accept, etc.
   * Call {@link flushDirty} after to apply replacements.
   */
  replaceAllTrackedAbbreviations() {
    for (const abbr of [...this.trackedAbbreviations]) {
      if (abbr.isReplaced) {
        this.removeFromTracking(abbr);
      } else {
        this._finishedAbbreviations.add(abbr);
      }
    }
  }

  /**
   * Cycle all replaced abbreviations that have a cursor in them.
   * Called by the Tab / Shift+Tab commands.
   *
   * For abbreviations still in typing mode that have a complete match,
   * marks them so {@link flushDirty} will enter cycling mode.
   *
   * Returns true if any cycling/replacement occurred.
   */
  cycleAbbreviations(direction: CycleDirection): boolean {
    const selections = this.textSource.collectSelections();

    const withCursor = [...this.trackedAbbreviations].filter((abbr) =>
      selections.some((s) => abbr.range.containsRange(s.withLength(0))),
    );

    if (withCursor.length === 0) return false;

    const toCycle = withCursor.filter((a) => a.isReplaced);
    const toFirstReplace = withCursor.filter(
      (a) =>
        !a.isReplaced &&
        this.abbreviationProvider.getSymbolsForAbbreviation(a.text) !== undefined,
    );

    if (toCycle.length === 0 && toFirstReplace.length === 0) {
      // Nothing to cycle and nothing complete -- Tab fallback: finalize all.
      this.replaceAllTrackedAbbreviations();
      return true;
    }

    for (const abbr of toCycle) {
      abbr.cycle(direction);
      this.dirtyAbbreviations.add(abbr);
    }

    for (const abbr of toFirstReplace) {
      this.dirtyAbbreviations.add(abbr);
    }

    return true;
  }

  /**
   * Delete all tracked abbreviations that have a cursor in them.
   * Called by Ctrl+Backspace. Removes the abbreviation text/symbol from
   * the document entirely.
   */
  deleteAbbreviations(): void {
    const selections = this.textSource.collectSelections();

    const withCursor = [...this.trackedAbbreviations].filter((abbr) =>
      selections.some((s) => abbr.range.containsRange(s.withLength(0))),
    );

    for (const abbr of withCursor) {
      this._deletedAbbreviations.add(abbr);
      this.removeFromTracking(abbr);
    }
  }

  /**
   * Compute diffs between current state and document, apply one batch edit.
   */
  async flushDirty(): Promise<void> {
    type FlushItem = {
      abbr: TrackedAbbreviation;
      newText: string;
      rangeAtCreation: Range;
      apply: (newRange: Range) => void;
    };

    const changes: Change[] = [];
    const items: FlushItem[] = [];

    // Deleted abbreviations (Ctrl+Backspace)
    for (const abbr of this._deletedAbbreviations) {
      const rangeAtCreation = abbr.range;
      changes.push({ range: rangeAtCreation, newText: "" });
      items.push({ abbr, newText: "", rangeAtCreation, apply: () => {} });
    }
    this._deletedAbbreviations.clear();

    // Finished abbreviations (non-matching char typed in typing mode)
    const finished = [...this._finishedAbbreviations];
    this._finishedAbbreviations.clear();
    const finishedForRollback: TrackedAbbreviation[] = [];

    for (const abbr of finished) {
      if (!this.trackedAbbreviations.has(abbr)) continue;

      const symbols = this.abbreviationProvider.getSymbolsForAbbreviation(abbr.text);
      if (symbols && symbols.length > 0) {
        const initialIndex = this.abbreviationProvider.getLastSelectedIndex(abbr.text);
        const newText = symbols[initialIndex];
        const rangeAtCreation = abbr.range;

        changes.push({ range: rangeAtCreation, newText });
        items.push({ abbr, newText, rangeAtCreation, apply: () => {} });
      }

      this.trackedAbbreviations.delete(abbr);
      finishedForRollback.push(abbr);
    }

    // Complete typing abbreviations → eager replace
    const complete = [...this.trackedAbbreviations].filter(
      (abbr) =>
        !abbr.isReplaced &&
        this.abbreviationProvider.getSymbolsForAbbreviation(abbr.text) !== undefined,
    );

    for (const abbr of complete) {
      const symbols = this.abbreviationProvider.getSymbolsForAbbreviation(abbr.text)!;
      const initialIndex = this.abbreviationProvider.getLastSelectedIndex(abbr.text);
      const newText = symbols[initialIndex];
      const rangeAtCreation = abbr.range;

      changes.push({ range: rangeAtCreation, newText });
      items.push({
        abbr,
        newText,
        rangeAtCreation,
        apply: (newRange) => abbr.enterReplacedState(symbols, newRange, initialIndex),
      });
    }

    // Finalized-but-dirty replaced abbreviations.
    // These were removed from tracking (non-extending char typed) but had
    // pending extends that should still be applied to the document.
    for (const abbr of this._finalizedDirty) {
      if (abbr.cycleSymbols.length > 0) {
        const newText = abbr.cycleSymbols[abbr.cycleIndex];
        const rangeAtCreation = abbr.range;

        changes.push({ range: rangeAtCreation, newText });
        items.push({ abbr, newText, rangeAtCreation, apply: () => {} });
      }
    }

    this._finalizedDirty.clear();

    // Dirty replaced abbreviations → update display
    const dirty = [...this.trackedAbbreviations].filter(
      (abbr) => abbr.isReplaced && this.dirtyAbbreviations.has(abbr),
    );

    for (const abbr of dirty) {
      if (abbr.cycleSymbols.length > 0) {
        // Has symbols → display the current cycle symbol
        const newText = abbr.cycleSymbols[abbr.cycleIndex];
        const rangeAtCreation = abbr.range;

        changes.push({ range: rangeAtCreation, newText });
        items.push({
          abbr,
          newText,
          rangeAtCreation,
          apply: (newRange) => {
            abbr.updateAfterFlush(newRange);
            this.dirtyAbbreviations.delete(abbr);
          },
        });
      } else {
        // No symbols → revert to typing mode: display \text
        const abbrevText = abbr.text;
        const newText = this.abbreviationCharacter + abbrevText;
        const rangeAtCreation = abbr.range;

        changes.push({ range: rangeAtCreation, newText });
        items.push({
          abbr,
          newText,
          rangeAtCreation,
          apply: (newRange) => {
            abbr.revertToTyping(new Range(newRange.start + 1, abbrevText.length));
            this.dirtyAbbreviations.delete(abbr);
          },
        });
      }
    }

    if (changes.length === 0) return;

    // Batch apply all changes
    const ok = await this.replaceAbbreviations(changes);
    if (ok) {
      // Apply range shifts: process items left-to-right, accumulating shift
      let totalShift = 0;
      const sorted = [...items].sort((a, b) => a.rangeAtCreation.start - b.rangeAtCreation.start);
      for (const item of sorted) {
        const newRange = new Range(
          item.rangeAtCreation.start + totalShift,
          item.newText.length,
        );
        item.apply(newRange);
        totalShift += item.newText.length - item.rangeAtCreation.length;
      }
    } else {
      // Edit failed — re-add finished abbreviations to tracking
      for (const abbr of finishedForRollback) {
        this.trackedAbbreviations.add(abbr);
      }
    }
  }

  getTrackedAbbreviations(): Set<TrackedAbbreviation> {
    return this.trackedAbbreviations;
  }

  resetTrackedAbbreviations() {
    this.trackedAbbreviations.clear();
    this._finishedAbbreviations.clear();
    this._finalizedDirty.clear();
    this.dirtyAbbreviations.clear();
    this._deletedAbbreviations.clear();
  }

  private removeFromTracking(abbr: TrackedAbbreviation): void {
    if (abbr.isReplaced) {
      this.abbreviationProvider.setLastSelectedIndex(abbr.text, abbr.cycleIndex);
    }
    this.trackedAbbreviations.delete(abbr);
    this._finishedAbbreviations.delete(abbr);
    this.dirtyAbbreviations.delete(abbr);
  }

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    this.doNotTrackNewAbbr = true;
    const ok = await this.textSource.replaceAbbreviations(changes);
    this.doNotTrackNewAbbr = false;
    return ok;
  }

  /**
   * Process a single document change against all tracked abbreviations.
   * A `\` that doesn't overlap any existing abbreviation starts a new one.
   */
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
          // Earlier change in same batch may have marked this finished; override.
          this._finishedAbbreviations.delete(abbr);
          if (abbr.isReplaced) {
            // Extension chars may have been trimmed by processChange internally;
            // re-lookup symbols for the current abbreviation.
            const symbols =
              this.abbreviationProvider.getSymbolsForAbbreviation(abbr.text) ?? [];
            const initialIndex =
              symbols.length > 0
                ? this.abbreviationProvider.getLastSelectedIndex(abbr.text)
                : 0;
            abbr.setCycleState(symbols, initialIndex);
            this.dirtyAbbreviations.add(abbr);
          }
          break;
        case "appended":
          if (abbr.isReplaced) {
            // Replaced mode: extend or finalize
            const extended = abbr.text + result.text;
            if (this.abbreviationProvider.hasAbbreviationsWithPrefix(extended)) {
              isAnyTrackedAbbrAffected = true;
              abbr.acceptAppend(result.text);
              const symbols =
                this.abbreviationProvider.getSymbolsForAbbreviation(abbr.text) ?? [];
              const initialIndex =
                symbols.length > 0
                  ? this.abbreviationProvider.getLastSelectedIndex(abbr.text)
                  : 0;
              abbr.setCycleState(symbols, initialIndex);
              this.dirtyAbbreviations.add(abbr);
            } else {
              // Non-extending char after a symbol — done.
              // If the abbreviation is dirty, preserve it so flushDirty can
              // still apply the pending extend before finalizing.
              if (this.dirtyAbbreviations.has(abbr)) {
                this._finalizedDirty.add(abbr);
              }
              this.removeFromTracking(abbr);
            }
          } else {
            // Typing mode: extend or finish
            if (
              this.abbreviationProvider.hasAbbreviationsWithPrefix(abbr.text + result.text)
            ) {
              // Extends a known prefix — keep tracking.
              isAnyTrackedAbbrAffected = true;
              abbr.acceptAppend(result.text);
            } else {
              // Non-extending char in typing mode — mark for finalization.
              this._finishedAbbreviations.add(abbr);
            }
          }
          break;
        case "shorten":
          isAnyTrackedAbbrAffected = true;
          {
            const newText = abbr.text.slice(0, -1);
            abbr.text = newText;
            const newSymbols =
              newText.length > 0
                ? (this.abbreviationProvider.getSymbolsForAbbreviation(newText) ?? [])
                : [];
            const initialIndex =
              newSymbols.length > 0
                ? this.abbreviationProvider.getLastSelectedIndex(newText)
                : 0;
            abbr.setCycleState(newSymbols, initialIndex);
            this.dirtyAbbreviations.add(abbr);
          }
          break;
      }
    }

    if (
      c.newText === this.abbreviationCharacter &&
      !isAnyTrackedAbbrAffected &&
      !this.doNotTrackNewAbbr
    ) {
      const abbr = new TrackedAbbreviation(new Range(c.range.start + 1, 0), "");
      this.trackedAbbreviations.add(abbr);
    }
  }
}
