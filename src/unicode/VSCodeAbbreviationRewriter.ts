// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/VSCodeAbbreviationRewriter.ts)
// Modified for Agda

import {
  AbbreviationProvider,
  AbbreviationRewriter,
  AbbreviationTextSource,
  Change,
  CycleDirection,
  Range,
} from "./engine/index";
import { getErrorMessage } from "../util/errorMessage";
import type { TrackedAbbreviation } from "./engine/TrackedAbbreviation";
import {
  Disposable,
  Range as LineColRange,
  StatusBarItem,
  TextDocument,
  TextEditor,
  WorkspaceEdit,
  commands,
  window,
  workspace,
} from "vscode";

type QueuedOp =
  | { kind: "change"; changes: Change[] }
  | { kind: "selection"; selections: Range[] }
  | { kind: "cycle"; direction: CycleDirection }
  | { kind: "replaceAll" }
  | { kind: "delete" };

/**
 * VS Code adapter for {@link AbbreviationRewriter}.
 *
 * Handles two concerns:
 *   1. **Re-entrant edit events** — `workspace.applyEdit()` fires a
 *      synchronous `onDidChangeTextDocument` for our own edit, which
 *      must be identified and suppressed.
 *   2. **Serialization** — all event operations (text changes, selection
 *      changes, cycling, replaceAll) are serialized through a single
 *      queue. The queue is drained synchronously (feeding ops to the
 *      engine), then a single `flushDirty()` applies the accumulated
 *      diff to the document.
 */
export class VSCodeAbbreviationRewriter implements AbbreviationTextSource {
  private readonly disposables = new Array<Disposable>();
  private readonly rewriter;

  /** Solid underline -- abbreviation being typed. */
  private readonly typingDecorationType = window.createTextEditorDecorationType({
    textDecoration: "underline",
  });

  /** Dashed underline -- replaced symbol, cycleable via Tab. */
  private readonly cyclingDecorationType = window.createTextEditorDecorationType({
    textDecoration: "underline dashed",
  });

  /** Set during our own edits to suppress selection events from cursor repositioning. */
  private isApplyingEdit = false;

  /**
   * The changes we are currently applying via `workspace.applyEdit()`.
   * Used to identify the re-entrant edit event.
   */
  private pendingOwnChanges: Change[] | null = null;

  /**
   * Change events that arrived before our own edit event during the await.
   * These are pre-flush user events with pre-flush offsets — they need offset
   * adjustment before being replayed into the queue.
   */
  private preFlushBuffer: Change[][] = [];

  /** Operation queue. */
  private opQueue: QueuedOp[] = [];

  /** Non-null while draining. */
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly leader: string,
    readonly abbreviationProvider: AbbreviationProvider,
    private readonly textEditor: TextEditor,
    private readonly statusBarItem: StatusBarItem,
  ) {
    this.rewriter = new AbbreviationRewriter(leader, abbreviationProvider, this);

    this.disposables.push(this.typingDecorationType);
    this.disposables.push(this.cyclingDecorationType);

    this.disposables.push(
      workspace.onDidChangeTextDocument((e) => {
        if (e.document !== this.textEditor.document) {
          return;
        }

        const changes: Change[] = e.contentChanges.map((c) => ({
          range: new Range(c.rangeOffset, c.rangeLength),
          newText: c.text,
        }));

        if (this.pendingOwnChanges !== null) {
          if (this.matchesOwnEdit(changes)) {
            // Identified our own edit — skip it.
            // Future events during this await are post-flush and go to enqueueOp.
            this.pendingOwnChanges = null;
            return;
          }
          // Pre-flush user event — buffer for offset adjustment.
          this.preFlushBuffer.push(changes);
          return;
        }

        this.enqueueOp({ kind: "change", changes });
      }),
    );
    this.disposables.push(
      window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document !== this.textEditor.document) {
          return;
        }

        // Selection events during our own edits are just the cursor
        // being repositioned by applyEdit — safe to ignore.
        if (this.isApplyingEdit) {
          return;
        }

        const selections = e.selections.map((s) => fromVsCodeRange(s, e.textEditor.document));
        this.enqueueOp({ kind: "selection", selections });
      }),
    );
  }

  collectSelections(): Range[] {
    return this.textEditor.selections.map((s) => fromVsCodeRange(s, this.textEditor.document));
  }

  /**
   * Apply abbreviation replacements to the document.
   * Uses `workspace.applyEdit()` — `textEditor.edit()` has an internal
   * retry loop that can amplify edits in VS Code Remote.
   *
   * During the `await`, incoming change events are handled via edit matching:
   * our own edit is identified and skipped, pre-flush user events are buffered
   * and replayed with adjusted offsets.
   */
  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    try {
      const doc = this.textEditor.document;
      const wsEdit = new WorkspaceEdit();
      for (const c of changes) {
        wsEdit.replace(doc.uri, toVsCodeRange(c.range, doc), c.newText);
      }

      this.pendingOwnChanges = changes;
      this.preFlushBuffer = [];
      this.isApplyingEdit = true;
      const ok = await workspace.applyEdit(wsEdit);
      this.isApplyingEdit = false;
      this.pendingOwnChanges = null;

      // Replay pre-flush events with adjusted offsets (if edit succeeded)
      // and post-flush events (already in opQueue from enqueueOp).
      this.replayPreFlushEvents(ok ? changes : null);

      return ok;
    } catch (e) {
      this.isApplyingEdit = false;
      this.pendingOwnChanges = null;
      this.replayPreFlushEvents(null);
      // VS Code throws a generic Error (no typed subclass) if the editor
      // closes during the await — harmless, so suppress it.
      if (getErrorMessage(e) !== "TextEditor#edit not possible on closed editors") {
        console.error("Error while replacing abbreviation:", e);
      }
    }
    return false;
  }

  /**
   * Replay pre-flush events buffered during the edit await.
   * If `appliedChanges` is provided, adjust offsets through them.
   */
  private replayPreFlushEvents(appliedChanges: Change[] | null): void {
    for (const changes of this.preFlushBuffer) {
      const adjusted = appliedChanges !== null ? adjustOffsets(changes, appliedChanges) : changes;
      this.opQueue.push({ kind: "change", changes: adjusted });
    }
    this.preFlushBuffer = [];
  }

  /**
   * Check whether an incoming change event matches the edit we are currently
   * applying. Compares count, offsets, lengths, and text.
   */
  private matchesOwnEdit(eventChanges: Change[]): boolean {
    const own = this.pendingOwnChanges;
    if (own === null) return false;
    if (eventChanges.length !== own.length) return false;

    // Sort both by start offset for stable comparison.
    const sortedEvent = [...eventChanges].sort((a, b) => a.range.start - b.range.start);
    const sortedOwn = [...own].sort((a, b) => a.range.start - b.range.start);

    for (let i = 0; i < sortedOwn.length; i++) {
      const e = sortedEvent[i];
      const o = sortedOwn[i];
      if (e.range.start !== o.range.start || e.range.length !== o.range.length || e.newText !== o.newText) {
        return false;
      }
    }
    return true;
  }

  /**
   * Push an operation onto the queue and start draining.
   */
  private enqueueOp(op: QueuedOp): void {
    this.opQueue.push(op);
    this.drainQueue();
  }

  /**
   * Start a drain loop if one isn't already running.
   */
  private drainQueue(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.processDrain();
  }

  /**
   * Drain all queued ops synchronously (feeding them to the engine),
   * then flush once to apply the accumulated diff to the document.
   *
   * Events may arrive during the async flush (buffered and replayed).
   * If the queue has new ops after the flush, loop again.
   */
  private async processDrain(): Promise<void> {
    try {
      while (true) {
        while (this.opQueue.length > 0) {
          const op = this.opQueue.shift()!;
          switch (op.kind) {
            case "change":
              this.rewriter.changeInput(op.changes);
              break;
            case "selection":
              this.rewriter.changeSelections(op.selections);
              break;
            case "cycle":
              this.rewriter.cycleAbbreviations(op.direction);
              break;
            case "replaceAll":
              this.rewriter.replaceAllTrackedAbbreviations();
              break;
            case "delete":
              this.rewriter.deleteAbbreviations();
              break;
          }
        }
        await this.rewriter.flushDirty();
        this.updateState();
        if (this.opQueue.length === 0) break;
      }
    } finally {
      this.drainPromise = null;
    }
  }

  /**
   * Wait for all queued operations to complete.
   * Used during disposal to ensure replacements finish before teardown.
   */
  flush(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  /**
   * Replace all tracked abbreviations (e.g. on dispose, or Tab fallback).
   */
  replaceAllTrackedAbbreviations(): void {
    this.enqueueOp({ kind: "replaceAll" });
  }

  /**
   * Cycle abbreviations forward or backward (Tab / Shift+Tab).
   */
  cycleAbbreviations(direction: CycleDirection): void {
    this.enqueueOp({ kind: "cycle", direction });
  }

  /**
   * Delete tracked abbreviations under cursors (Ctrl+Backspace).
   */
  deleteAbbreviations(): void {
    this.enqueueOp({ kind: "delete" });
  }

  private updateState() {
    const trackedAbbreviations = this.rewriter.getTrackedAbbreviations();

    const doc = this.textEditor.document;
    const typingRanges: LineColRange[] = [];
    const cyclingRanges: LineColRange[] = [];
    for (const a of trackedAbbreviations) {
      (a.isReplaced ? cyclingRanges : typingRanges).push(toVsCodeRange(a.range, doc));
    }
    this.textEditor.setDecorations(this.typingDecorationType, typingRanges);
    this.textEditor.setDecorations(this.cyclingDecorationType, cyclingRanges);

    this.updateStatusBar(trackedAbbreviations);
    void this.setInputActive(trackedAbbreviations.size > 0);
  }

  private updateStatusBar(trackedAbbreviations: Set<TrackedAbbreviation>) {
    updateAbbreviationStatusBar(this.leader, trackedAbbreviations, this.statusBarItem);
  }

  private async setInputActive(isActive: boolean) {
    await commands.executeCommand("setContext", "agda.input.isActive", isActive);
  }

  dispose(): void {
    this.statusBarItem.hide();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Update a status bar item to show the current abbreviation and symbol list.
 *
 * Typing mode:   `\alp`
 * Cycling mode:  `\alpha  [ α ]  𝛼  𝛂`   (current symbol in brackets)
 */
export function updateAbbreviationStatusBar(
  leader: string,
  trackedAbbreviations: Set<TrackedAbbreviation>,
  statusBarItem: StatusBarItem,
): void {
  const text = formatAbbreviationStatusBar(leader, trackedAbbreviations);
  if (text === null) {
    statusBarItem.hide();
  } else {
    statusBarItem.text = text;
    statusBarItem.show();
  }
}

/**
 * Compute the status bar text for abbreviation state. Returns null to hide.
 */
export function formatAbbreviationStatusBar(
  leader: string,
  tracked: ReadonlySet<TrackedAbbreviation>,
): string | null {
  if (tracked.size === 0) return null;

  const abbr = [...tracked][0];
  if (abbr.isReplaced) {
    const symbols = abbr.cycleSymbols;
    const idx = abbr.cycleIndex;
    const symbolList = symbols.map((s, i) => (i === idx ? `[ ${s} ]` : s)).join("  ");
    return `${leader}${abbr.text}  ${symbolList}`;
  }

  return `${leader}${abbr.text}`;
}

/**
 * Adjust change offsets through a set of applied changes.
 * Used to transform pre-flush event offsets to post-flush positions.
 */
function adjustOffsets(queuedChanges: Change[], appliedChanges: Change[]): Change[] {
  const sorted = [...appliedChanges].sort((a, b) => a.range.start - b.range.start);
  return queuedChanges.map((c) => {
    let shift = 0;
    for (const applied of sorted) {
      if (c.range.start >= applied.range.start + applied.range.length) {
        shift += applied.newText.length - applied.range.length;
      }
    }
    if (shift === 0) return c;
    return { range: new Range(c.range.start + shift, c.range.length), newText: c.newText };
  });
}

function fromVsCodeRange(range: LineColRange, doc: TextDocument): Range {
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  return new Range(start, end - start);
}

function toVsCodeRange(range: Range, doc: TextDocument): LineColRange {
  const start = doc.positionAt(range.start);
  const end = doc.positionAt(range.endInclusive + 1);
  return new LineColRange(start, end);
}
