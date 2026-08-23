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
  /**
   * Reposition selections after a successful {@link replaceAbbreviations}.
   * `selections` are the pre-edit selections mapped through the applied
   * changes (see {@link mapOffsetThroughChanges}). Implementations decide
   * whether to apply them (e.g. skip when they match the editor's own
   * cursor mapping, or when user edits raced with the replacement).
   */
  setSelections(selections: Range[]): void;
}

/**
 * Map a document offset through a batch of disjoint, ascending-sorted
 * replacements.
 *
 * Offsets at or before the start of a replaced range are unchanged (modulo
 * earlier shifts); offsets strictly inside or at the end of a replaced range
 * map to the end of the replacement text; offsets after it shift by the
 * length delta.
 *
 * This encodes the cursor behavior users expect from abbreviation
 * replacement: a cursor sitting at the end of `\ti` must end up after the
 * full replacement text. VS Code's `workspace.applyEdit` does not do this
 * when the replacement is longer than the replaced range (the cursor is
 * left behind, mid-text), so the text source must reposition explicitly.
 */
export function mapOffsetThroughChanges(offset: number, sortedChanges: Change[]): number {
  let shift = 0;
  for (const c of sortedChanges) {
    const start = c.range.start;
    if (offset <= start) break;
    if (offset <= start + c.range.length) {
      return start + shift + c.newText.length;
    }
    shift += c.newText.length - c.range.length;
  }
  return offset + shift;
}

/**
 * State machine for abbreviation tracking and replacement abstracted over
 * the text source (input box, editor, etc.).
 *
 * The engine is reconciliation-based. Every tracked abbreviation maintains
 * `shown` (the exact document content of its span) and derives `desired`
 * (what the span should show). Event handlers only update abbreviation
 * fields; {@link flushDirty} makes the document satisfy `desired` for every
 * tracked abbreviation in one batch edit, then drops the non-active ones.
 *
 * All actual document edits are delegated to an {@link AbbreviationTextSource}.
 */
export class AbbreviationRewriter {
  /** All tracked abbreviations (disjoint spans). */
  private readonly trackedAbbreviations = new Set<TrackedAbbreviation>();

  /** Set during our own edits so the engine doesn't track replacement text as a new `\`. */
  private doNotTrackNewAbbr = false;

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
   * Mark any active abbreviation that no longer contains a cursor as
   * finished. The next {@link flushDirty} reconciles its span (writing any
   * pending symbol/revert) and drops it from tracking.
   */
  changeSelections(selections: Range[]) {
    for (const abbr of this.trackedAbbreviations) {
      if (
        abbr.status === "active" &&
        !selections.some((s) => abbr.range.containsRange(s.withLength(0)))
      ) {
        abbr.status = "finished";
      }
    }
  }

  /**
   * Mark all active abbreviations as finished.
   * Used on dispose, editor switch, input box accept, etc.
   * Call {@link flushDirty} after to apply replacements.
   */
  replaceAllTrackedAbbreviations() {
    for (const abbr of this.trackedAbbreviations) {
      if (abbr.status === "active") {
        abbr.status = "finished";
      }
    }
  }

  /**
   * Cycle all abbreviations with symbols that have a cursor in them.
   * Called by the Tab / Shift+Tab commands.
   *
   * Abbreviations still in typing mode with a complete match are not
   * stepped; the next flush replaces them at the remembered index.
   *
   * Returns true if any cycling/replacement occurred.
   */
  cycleAbbreviations(direction: CycleDirection): boolean {
    const selections = this.textSource.collectSelections();

    const withCursor = [...this.trackedAbbreviations].filter(
      (abbr) =>
        abbr.status === "active" &&
        selections.some((s) => abbr.range.containsRange(s.withLength(0))),
    );

    if (withCursor.length === 0) return false;

    const cyclable = withCursor.filter((abbr) => abbr.cycleSymbols.length > 0);
    if (cyclable.length === 0) {
      // Nothing to cycle and nothing complete -- Tab fallback: finalize all.
      this.replaceAllTrackedAbbreviations();
      return true;
    }

    for (const abbr of cyclable) {
      if (abbr.isReplaced) {
        abbr.cycle(direction);
      }
    }

    return true;
  }

  /**
   * Delete all tracked abbreviations that have a cursor in them.
   * Called by Ctrl+Backspace. The next flush removes their spans from the
   * document entirely.
   */
  deleteAbbreviations(): void {
    const selections = this.textSource.collectSelections();

    for (const abbr of this.trackedAbbreviations) {
      if (selections.some((s) => abbr.range.containsRange(s.withLength(0)))) {
        abbr.status = "deleted";
      }
    }
  }

  /**
   * Reconcile the document with the desired text of every tracked
   * abbreviation in one batch edit, then drop finished/deleted ones.
   *
   * On a failed edit nothing has been mutated in memory, so the same diff
   * is simply retried on the next flush.
   */
  async flushDirty(): Promise<void> {
    const all = [...this.trackedAbbreviations].sort((a, b) => a.start - b.start);
    const writes = all.filter((abbr) => abbr.desired !== abbr.shown);

    if (writes.length > 0) {
      const changes: Change[] = writes.map((abbr) => ({
        range: abbr.range,
        newText: abbr.desired,
      }));

      // Capture selections before the edit so they can be mapped through it.
      const selectionsBefore = this.textSource.collectSelections();

      const ok = await this.replaceAbbreviations(changes);
      if (!ok) return;

      // The document now satisfies every desired text. Commit: update
      // `shown`, and shift every span (written or not) past earlier writes.
      const written = new Set(writes);
      let shift = 0;
      for (const abbr of all) {
        abbr.start += shift;
        if (written.has(abbr)) {
          const newShown = abbr.desired;
          shift += newShown.length - abbr.shown.length;
          abbr.shown = newShown;
          abbr.kind =
            abbr.status !== "deleted" && abbr.cycleSymbols.length > 0 ? "symbol" : "typing";
          abbr.symbolLen = abbr.kind === "symbol" ? abbr.shown.length : 0;
        }
      }

      // Reposition selections. The editor's own cursor mapping leaves the
      // cursor behind when a replacement grows the text (e.g. reverting a
      // symbol to `\text` after an extension makes it incomplete).
      const mappedSelections = selectionsBefore.map((s) => {
        const start = mapOffsetThroughChanges(s.start, changes);
        const end = mapOffsetThroughChanges(s.start + s.length, changes);
        return new Range(start, end - start);
      });
      this.textSource.setSelections(mappedSelections);
    }

    // Drop finalized/deleted abbreviations, remembering the cycle index the
    // user last saw for finalized symbols.
    for (const abbr of [...this.trackedAbbreviations]) {
      if (abbr.status !== "active") {
        if (abbr.kind === "symbol") {
          this.abbreviationProvider.setLastSelectedIndex(abbr.text, abbr.cycleIndex);
        }
        this.trackedAbbreviations.delete(abbr);
      }
    }
  }

  getTrackedAbbreviations(): Set<TrackedAbbreviation> {
    return this.trackedAbbreviations;
  }

  resetTrackedAbbreviations() {
    this.trackedAbbreviations.clear();
  }

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    this.doNotTrackNewAbbr = true;
    const ok = await this.textSource.replaceAbbreviations(changes);
    this.doNotTrackNewAbbr = false;
    return ok;
  }

  /**
   * Process a single document change against all tracked abbreviations.
   * A `\` that doesn't engage any existing abbreviation starts a new one.
   */
  private processChange(c: Change): void {
    let isAnyTrackedAbbrAffected = false;
    for (const abbr of [...this.trackedAbbreviations]) {
      if (this.processChangeForAbbr(abbr, c)) {
        isAnyTrackedAbbrAffected = true;
      }
    }

    if (
      c.newText === this.abbreviationCharacter &&
      !isAnyTrackedAbbrAffected &&
      !this.doNotTrackNewAbbr
    ) {
      this.trackedAbbreviations.add(
        new TrackedAbbreviation(
          this.abbreviationProvider,
          this.abbreviationCharacter,
          c.range.start,
          this.abbreviationCharacter,
          "",
        ),
      );
    }
  }

  /**
   * Process one document change against one abbreviation, updating its
   * span/`shown`/`text`/status. Returns true if the change materially
   * engaged the abbreviation (absorbed append, interior edit, shorten) --
   * used to decide whether a typed leader starts a *new* abbreviation.
   */
  private processChangeForAbbr(abbr: TrackedAbbreviation, c: Change): boolean {
    const spanStart = abbr.start;
    const spanEnd = abbr.start + abbr.shown.length;
    const changeEnd = c.range.start + c.range.length;

    // Entirely after the span.
    if (c.range.start >= spanEnd) {
      if (
        c.range.start === spanEnd &&
        c.range.length === 0 &&
        c.newText.length > 0 &&
        abbr.status !== "deleted"
      ) {
        // Insertion immediately after the span (typed char or paste):
        // absorb if it extends a viable abbreviation prefix; otherwise the
        // abbreviation is done and the insertion stays outside the span.
        if (this.hasAbbreviationsWithPrefix(abbr.text + c.newText)) {
          abbr.shown += c.newText;
          abbr.setText(abbr.text + c.newText);
          return true;
        }
        if (abbr.status === "active") {
          abbr.status = "finished";
        }
      }
      return false;
    }

    // Entirely before the span (including an insertion exactly at its start).
    if (changeEnd <= spanStart) {
      abbr.start += c.newText.length - c.range.length;
      return false;
    }

    // Straddles a span boundary: destructive edit -- drop tracking without
    // writing anything.
    if (c.range.start < spanStart || changeEnd > spanEnd) {
      this.trackedAbbreviations.delete(abbr);
      return false;
    }

    // Interior edit: splice `shown`, then keep `text` in sync per kind.
    const off = c.range.start - spanStart;
    const spliced = abbr.shown.slice(0, off) + c.newText + abbr.shown.slice(off + c.range.length);

    if (abbr.kind === "typing") {
      if (!spliced.startsWith(this.abbreviationCharacter)) {
        // Leader destroyed -- drop tracking.
        this.trackedAbbreviations.delete(abbr);
        return false;
      }
      abbr.shown = spliced;
      abbr.setText(spliced.slice(this.abbreviationCharacter.length));
      this.reviveOrFinalize(abbr);
      return true;
    }

    // Symbol kind.
    if (off >= abbr.symbolLen) {
      // Edit within the tail: splice `text` in parallel.
      const baseLen = abbr.text.length - abbr.tail.length;
      const tailOff = off - abbr.symbolLen;
      const newTail =
        abbr.tail.slice(0, tailOff) + c.newText + abbr.tail.slice(tailOff + c.range.length);
      abbr.shown = spliced;
      abbr.setText(abbr.text.slice(0, baseLen) + newTail);
      this.reviveOrFinalize(abbr);
      return true;
    }

    if (abbr.tail.length > 0) {
      // Edit touches the symbol while tail chars exist: destructive.
      this.trackedAbbreviations.delete(abbr);
      return false;
    }

    if (c.newText.length === 0 && changeEnd === spanEnd && abbr.text.length > 0) {
      // Backspace into the symbol -- deleting any suffix of it (one code
      // point of a multi-code-point symbol, or the whole thing): strip one
      // character from the abbreviation. The flush then writes the shorter
      // abbreviation's symbol (or `\text`) over what's left of the span.
      abbr.shown = spliced;
      abbr.symbolLen = spliced.length;
      abbr.setText(abbr.text.slice(0, -1));
      return true;
    }

    // Any other interior edit of the symbol (e.g. typing into its middle):
    // `desired` is unchanged, so the next flush restores the symbol.
    abbr.shown = spliced;
    abbr.symbolLen = spliced.length;
    return true;
  }

  /**
   * After an interior edit re-synced `text`: an earlier change in the same
   * batch may have marked the abbreviation finished -- reactivate it, unless
   * the new text can never match an abbreviation (then finalize instead of
   * tracking it forever). Deleted abbreviations stay deleted.
   */
  private reviveOrFinalize(abbr: TrackedAbbreviation): void {
    if (abbr.status === "deleted") return;
    abbr.status = this.hasAbbreviationsWithPrefix(abbr.text) ? "active" : "finished";
  }

  private hasAbbreviationsWithPrefix(prefix: string): boolean {
    return this.abbreviationProvider.hasAbbreviationsWithPrefix(prefix);
  }
}
