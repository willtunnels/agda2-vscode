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
import { commonPrefixSuffix } from "../util/editAdjust";
import type { TrackedAbbreviation } from "./engine/TrackedAbbreviation";
import {
  Disposable,
  Range as LineColRange,
  Selection,
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
   * The full document text expected after {@link pendingOwnChanges} apply.
   * Fallback for own-edit recognition: VS Code's bulk-edit pipeline runs
   * `computeMoreMinimalEdits` over edits targeting the active editor, which
   * may merge adjacent edits or split one edit into several diff hunks —
   * defeating the exact list comparison. Comparing the resulting document
   * text identifies our edit regardless of how it was decomposed.
   */
  private pendingExpectedText: string | null = null;

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

  /**
   * Set when user change events raced with our last applyEdit. In that case
   * the engine's selection mapping is based on a stale document state, so
   * setSelections must not fight the user's cursor; the raced events re-flow
   * through the queue and trigger another flush that repositions correctly.
   */
  private userEditsRacedWithLastEdit = false;

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
          if (
            this.matchesOwnEdit(changes) ||
            this.textEditor.document.getText() === this.pendingExpectedText
          ) {
            // Identified our own edit (exactly, or by its effect when VS Code
            // merged/split it) — skip it. Future events during this await are
            // post-flush and go to enqueueOp.
            this.pendingOwnChanges = null;
            this.pendingExpectedText = null;
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
   * Apply the engine's post-replacement selection mapping.
   *
   * VS Code's own cursor mapping through `workspace.applyEdit` is correct
   * except when a replacement is longer than the replaced range (the cursor
   * stays inside the new text, e.g. between `t` and `i` after `◂i` → `\ti`).
   * Only write selections when they differ from the live ones so the common
   * correctly-mapped case doesn't produce extra selection events.
   */
  setSelections(selections: Range[]): void {
    if (this.userEditsRacedWithLastEdit) return;

    const doc = this.textEditor.document;
    const target = selections.map((s) => {
      const vr = toVsCodeRange(s, doc);
      return new Selection(vr.start, vr.end);
    });
    const current = this.textEditor.selections;
    const same = current.length === target.length && current.every((c, i) => c.isEqual(target[i]));
    if (!same) {
      this.textEditor.selections = target;
    }
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

      // Submit MINIMIZED edits. When a workspace edit targets the active
      // editor's document, VS Code's bulk-edit pipeline rewrites it via
      // `computeMoreMinimalEdits` before applying (bulkEditService defaults
      // the editor to the active one; bulkTextEdits sets `makeMinimal`), and
      // the content-change events mirror the applied — minimized — edits:
      // replacing `◂i` with `\ti` is reported as replacing `◂` with `\t`.
      // Submitting pre-minimized edits keeps matchesOwnEdit's comparison
      // exact for the common case, and makes VS Code's native cursor mapping
      // correct for the revert case (the cursor sits after the minimized
      // edit and shifts by the delta).
      const minimized: Change[] = [];
      for (const c of changes) {
        const oldText = doc.getText(toVsCodeRange(c.range, doc));
        const m = minimizeChange(oldText, c);
        if (m !== null) minimized.push(m);
      }
      if (minimized.length === 0) return true;

      const wsEdit = new WorkspaceEdit();
      for (const c of minimized) {
        wsEdit.replace(doc.uri, toVsCodeRange(c.range, doc), c.newText);
      }

      this.pendingOwnChanges = minimized;
      this.pendingExpectedText = applyChangesToText(doc.getText(), minimized);
      this.preFlushBuffer = [];
      this.isApplyingEdit = true;
      const ok = await workspace.applyEdit(wsEdit);
      this.isApplyingEdit = false;
      this.pendingOwnChanges = null;
      this.pendingExpectedText = null;

      // User keystrokes that arrived during the await make the engine's
      // selection mapping stale (see setSelections).
      this.userEditsRacedWithLastEdit =
        this.preFlushBuffer.length > 0 || this.opQueue.some((op) => op.kind === "change");

      // Replay pre-flush events with adjusted offsets (if edit succeeded)
      // and post-flush events (already in opQueue from enqueueOp).
      this.replayPreFlushEvents(ok ? minimized : null);

      return ok;
    } catch (e) {
      this.isApplyingEdit = false;
      this.pendingOwnChanges = null;
      this.pendingExpectedText = null;
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
   *
   * The replayed events are put at the FRONT of the queue: they were applied
   * to the document before anything enqueued during the await (which is
   * post-own-edit by definition), and change events must be processed in
   * application order or their offsets are interpreted against the wrong
   * document state — orphaning keystrokes outside the abbreviation.
   */
  private replayPreFlushEvents(appliedChanges: Change[] | null): void {
    if (this.preFlushBuffer.length === 0) return;
    const replayed: QueuedOp[] = this.preFlushBuffer.map((changes) => ({
      kind: "change",
      changes: appliedChanges !== null ? adjustOffsets(changes, appliedChanges) : changes,
    }));
    this.preFlushBuffer = [];
    this.opQueue.unshift(...replayed);
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
      if (
        e.range.start !== o.range.start ||
        e.range.length !== o.range.length ||
        e.newText !== o.newText
      ) {
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
        this.rewriter.pruneDesynced(this.textEditor.document.getText());
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

/** Apply offset-based changes (disjoint) to a string. */
export function applyChangesToText(text: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.range.start - a.range.start);
  for (const c of sorted) {
    text = text.slice(0, c.range.start) + c.newText + text.slice(c.range.start + c.range.length);
  }
  return text;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Minimize a change against the text it replaces: trim the common prefix
 * and suffix so the edit touches only what actually differs. This is the
 * form VS Code reports applied edits in, so it is the form we must submit
 * for own-edit recognition to work (see replaceAbbreviations).
 *
 * Trims never split a surrogate pair. Returns null for a no-op change.
 */
export function minimizeChange(oldText: string, c: Change): Change | null {
  let { prefix, suffix } = commonPrefixSuffix(oldText, c.newText);
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--;
  const oldLen = oldText.length - prefix - suffix;
  const newText = c.newText.slice(prefix, c.newText.length - suffix);
  if (oldLen === 0 && newText.length === 0) return null;
  return { range: new Range(c.range.start + prefix, oldLen), newText };
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
