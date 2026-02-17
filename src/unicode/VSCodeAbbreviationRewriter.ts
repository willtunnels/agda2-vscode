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
  | { kind: "replaceAll" };

/**
 * VS Code adapter for {@link AbbreviationRewriter}.
 *
 * Handles two concerns:
 *   1. **Re-entrant edit events** — `workspace.applyEdit()` fires a
 *      synchronous `onDidChangeTextDocument` for our own edit, which
 *      must be suppressed.
 *   2. **Serialization** — all event operations (text changes, selection
 *      changes, cycling, replaceAll) must be serialized through a
 *      single queue, lest some internal yield point allow them to
 *      interleave in undesirable ways.
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

  /**
   * Re-entrant edit guard. While true:
   *   - The first `onDidChangeTextDocument` event is our own edit — skip it.
   *   - Subsequent events are real user keystrokes (possible in VS Code
   *     Remote due to IPC latency) — buffer them for replay.
   */
  private isApplyingEdit = false;
  private seenReentrantEvent = false;
  private eventsBufferedDuringEdit: Change[][] = [];

  /** Operation queue (see class doc). */
  private opQueue: QueuedOp[] = [];

  /** Non-null while draining. Reentrancy guard + awaitable by {@link flush}. */
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

        if (this.isApplyingEdit) {
          if (!this.seenReentrantEvent) {
            this.seenReentrantEvent = true;
            return; // Our own edit — skip.
          }
          this.eventsBufferedDuringEdit.push(changes); // Real keystroke — buffer.
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
        // being repositioned by applyEdit -- safe to ignore.
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
   */
  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    try {
      const doc = this.textEditor.document;
      const wsEdit = new WorkspaceEdit();
      for (const c of changes) {
        wsEdit.replace(doc.uri, toVsCodeRange(c.range, doc), c.newText);
      }

      this.isApplyingEdit = true;
      this.seenReentrantEvent = false;
      this.eventsBufferedDuringEdit = [];
      const ok = await workspace.applyEdit(wsEdit);
      this.isApplyingEdit = false;

      // Enqueue any user events that arrived during the edit.
      // They'll be picked up by the current drainQueue loop
      // (if running) or by enqueueOp's drain kick.
      this.replayBufferedEvents();

      return ok;
    } catch (e) {
      this.isApplyingEdit = false;
      this.replayBufferedEvents();
      if (getErrorMessage(e) !== "TextEditor#edit not possible on closed editors") {
        console.error("Error while replacing abbreviation:", e);
      }
    }
    return false;
  }

  /** Move events buffered during isApplyingEdit into the operation queue. */
  private replayBufferedEvents(): void {
    for (const changes of this.eventsBufferedDuringEdit) {
      this.opQueue.push({ kind: "change", changes });
    }
    this.eventsBufferedDuringEdit = [];
    this.drainQueue();
  }

  // --- Unified queue ---

  /**
   * Push an operation onto the queue and start draining.
   */
  private enqueueOp(op: QueuedOp): void {
    this.opQueue.push(op);
    this.drainQueue();
  }

  /**
   * Execute a single queued operation against the engine.
   */
  private async executeOp(op: QueuedOp): Promise<void> {
    switch (op.kind) {
      case "change":
        this.rewriter.changeInput(op.changes);
        await this.rewriter.flushPendingOps();
        await this.rewriter.triggerAbbreviationReplacement();
        this.updateState();
        break;

      case "selection":
        // Use live selections — preceding ops may have changed the document
        // since this event was enqueued, making the captured offsets stale.
        {
          const liveSelections = this.collectSelections();
          await this.rewriter.changeSelections(liveSelections);
        }
        this.updateState();
        break;

      case "cycle":
        await this.rewriter.cycleAbbreviations(op.direction);
        this.updateState();
        break;

      case "replaceAll":
        await this.rewriter.replaceAllTrackedAbbreviations();
        this.updateState();
        break;
    }
  }

  /**
   * Start a drain loop if one isn't already running.
   * The loop processes ops until the queue is empty, including any ops
   * pushed during execution (e.g. buffered events from replaceAbbreviations).
   */
  private drainQueue(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.processDrain();
  }

  private async processDrain(): Promise<void> {
    try {
      while (this.opQueue.length > 0) {
        await this.executeOp(this.opQueue.shift()!);
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
    return `${leader}${abbr.abbreviation}  ${symbolList}`;
  }
  return `${leader}${abbr.abbreviation}`;
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
