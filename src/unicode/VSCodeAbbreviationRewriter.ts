// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/VSCodeAbbreviationRewriter.ts)
// Modified for Agda

import {
  AbbreviationConfig,
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

// --- Operation queue types ---

/**
 * All operations the rewriter can perform.
 */
type QueuedOp =
  | { kind: "change"; changes: Change[] }
  | { kind: "selection"; selections: Range[] }
  | { kind: "cycle"; direction: CycleDirection }
  | { kind: "replaceAll" };

/**
 * Tracks abbreviations in a given text editor and replaces them dynamically.
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
   * True while we are inside a workspace.applyEdit() call.
   *
   * During applyEdit, VS Code fires a re-entrant onDidChangeTextDocument
   * for our own edit.  That event must be skipped -- if the engine saw it,
   * processChange would see an overlapping edit and kill the tracked
   * abbreviation before enterReplacedState/updateRangeAfterCycleEdit runs.
   *
   * In VS Code Remote, applyEdit involves IPC and takes multiple event-loop
   * turns. The first event during isApplyingEdit is assumed to be the
   * re-entrant event and is skipped.  Any additional events are buffered
   * in `eventsBufferedDuringEdit` and replayed after the edit completes.
   */
  private isApplyingEdit = false;

  /** Whether we've already seen (and skipped) the re-entrant event. */
  private seenReentrantEvent = false;

  /** Events that arrived during isApplyingEdit after the re-entrant one. */
  private eventsBufferedDuringEdit: Change[][] = [];

  /**
   * Unified operation queue.  ALL interactions with the engine
   * (text changes, selection changes, Tab/Shift+Tab cycling, replaceAll)
   * are serialized through this queue so that at most one async engine
   * operation is in-flight at any time.
   */
  private opQueue: QueuedOp[] = [];

  /**
   * Non-null while a drain loop is running.  Serves two purposes:
   *   1. Reentrancy guard -- drainQueue() is a no-op if already set.
   *   2. Awaitable by flush() to wait for the queue to empty.
   */
  private drainPromise: Promise<void> | null = null;

  constructor(
    readonly config: AbbreviationConfig,
    readonly abbreviationProvider: AbbreviationProvider,
    private readonly textEditor: TextEditor,
    private readonly statusBarItem: StatusBarItem,
  ) {
    this.rewriter = new AbbreviationRewriter(config, abbreviationProvider, this);

    this.disposables.push(this.typingDecorationType);
    this.disposables.push(this.cyclingDecorationType);

    this.disposables.push(
      workspace.onDidChangeTextDocument((e) => {
        if (e.document !== this.textEditor.document) {
          return;
        }

        const changes: Change[] = e.contentChanges.map((changeEvent) => ({
          range: new Range(changeEvent.rangeOffset, changeEvent.rangeLength),
          newText: changeEvent.text,
        }));

        if (this.isApplyingEdit) {
          if (!this.seenReentrantEvent) {
            // First event during our applyEdit -- this is the
            // re-entrant notification for our own edit.  Skip it.
            this.seenReentrantEvent = true;
            return;
          }
          // Additional events during applyEdit are real user
          // keystrokes that arrived while the edit was in flight
          // (common in VS Code Remote due to IPC latency).
          this.eventsBufferedDuringEdit.push(changes);
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
   *
   * Uses workspace.applyEdit() instead of textEditor.edit() deliberately:
   * textEditor.edit() has an internal retry loop ($tryApplyEdits →
   * acceptModelChanged → retry) that can amplify edits in VS Code Remote.
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

  /**
   * Move events buffered during isApplyingEdit into the operation queue.
   */
  private replayBufferedEvents(): void {
    for (const changes of this.eventsBufferedDuringEdit) {
      this.opQueue.push({ kind: "change", changes });
    }
    this.eventsBufferedDuringEdit = [];
    // Kick a drain in case nobody else will (e.g. replaceAbbreviations
    // was called from cycleAbbreviations or changeSelections, not from
    // the drain loop).
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
        // Read CURRENT live selections rather than the potentially-stale
        // offsets captured when the event was enqueued.  The document may
        // have changed between enqueue time and processing time -- e.g.,
        // an eager replacement in a preceding change op shrinks `\t` to
        // `◂`, but the selection event still carries the pre-replacement
        // cursor offset.  Using live positions avoids killing the
        // abbreviation with a stale offset.
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

    const typingRanges: LineColRange[] = [];
    const cyclingRanges: LineColRange[] = [];

    for (const a of trackedAbbreviations) {
      if (a.isReplaced) {
        cyclingRanges.push(toVsCodeRange(a.range, this.textEditor.document));
      } else {
        typingRanges.push(toVsCodeRange(a.range, this.textEditor.document));
      }
    }

    this.textEditor.setDecorations(this.typingDecorationType, typingRanges);
    this.textEditor.setDecorations(this.cyclingDecorationType, cyclingRanges);

    this.updateStatusBar(trackedAbbreviations);
    void this.setInputActive(trackedAbbreviations.size > 0);
  }

  /**
   * Update the status bar to show the current abbreviation and symbol list.
   *
   * Typing mode:   `\alp`
   * Cycling mode:  `\alpha  [ α ]  𝛼  𝛂`   (current symbol in guillemets)
   */
  private updateStatusBar(trackedAbbreviations: Set<TrackedAbbreviation>) {
    if (trackedAbbreviations.size === 0) {
      this.statusBarItem.hide();
      return;
    }

    // Use the first tracked abbreviation (multi-cursor: all share the same text)
    const abbr = [...trackedAbbreviations][0];
    const leader = this.config.abbreviationCharacter;

    if (abbr.isReplaced) {
      const symbols = abbr.cycleSymbols;
      const idx = abbr.cycleIndex;
      const symbolList = symbols.map((s, i) => (i === idx ? `[ ${s} ]` : s)).join("  ");
      this.statusBarItem.text = `${leader}${abbr.abbreviation}  ${symbolList}`;
    } else {
      this.statusBarItem.text = `${leader}${abbr.abbreviation}`;
    }

    this.statusBarItem.show();
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
