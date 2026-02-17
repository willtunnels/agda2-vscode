import * as vscode from "vscode";
import {
  AbbreviationRewriter,
  type AbbreviationTextSource,
  type Change,
  Range,
} from "../unicode/engine/index.js";
import type { AbbreviationProvider } from "../unicode/engine/AbbreviationProvider.js";
import * as config from "../util/config.js";
import { updateAbbreviationStatusBar } from "../unicode/VSCodeAbbreviationRewriter.js";
import { commonPrefixSuffix } from "../util/editAdjust.js";

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Compute a single Change from an old/new string pair using common
 * prefix/suffix matching. Handles insertions, deletions, replacements,
 * and pastes uniformly.
 */
export function computeChanges(oldValue: string, newValue: string): Change[] {
  if (oldValue === newValue) return [];

  const { prefix, suffix } = commonPrefixSuffix(oldValue, newValue);
  const oldMiddleLen = oldValue.length - prefix - suffix;
  const newMiddle = newValue.substring(prefix, newValue.length - suffix);

  return [{ range: new Range(prefix, oldMiddleLen), newText: newMiddle }];
}

// ---------------------------------------------------------------------------
// InputBox text source
// ---------------------------------------------------------------------------

class InputBoxTextSource implements AbbreviationTextSource {
  text = "";
  isApplyingEdit = false;

  constructor(private readonly inputBox: vscode.InputBox) {}

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    const sorted = [...changes].sort((a, b) => b.range.start - a.range.start);
    let value = this.text;
    for (const c of sorted) {
      const before = value.slice(0, c.range.start);
      const after = value.slice(c.range.start + c.range.length);
      value = before + c.newText + after;
    }

    // Cursor at the end of the last (bottom-most) change
    const last = sorted[0]; // sorted descending, so [0] is bottom-most
    const cursorPos = last.range.start + last.newText.length;

    this.isApplyingEdit = true;
    this.text = value;
    this.inputBox.value = value;
    this.inputBox.valueSelection = [cursorPos, cursorPos];
    this.isApplyingEdit = false;
    return true;
  }

  collectSelections(): Range[] {
    const pos = this.inputBox.valueSelection?.[0] ?? this.text.length;
    return [new Range(pos, 0)];
  }
}

// ---------------------------------------------------------------------------
// Operation queue
// ---------------------------------------------------------------------------

type QueuedOp = { kind: "change"; changes: Change[] } | { kind: "cycle"; direction: 1 | -1 };

// ---------------------------------------------------------------------------
// showUnicodeInputBox
// ---------------------------------------------------------------------------

export function showUnicodeInputBox(
  provider: AbbreviationProvider,
  statusBarItem: vscode.StatusBarItem,
  options: { prompt: string },
): Promise<string | undefined> {
  if (!config.getInputEnabled()) {
    return vscode.window.showInputBox(options) as Promise<string | undefined>;
  }

  const leader = config.getInputLeader();

  return new Promise<string | undefined>((resolve) => {
    const inputBox = vscode.window.createInputBox();
    inputBox.prompt = options.prompt;

    const textSource = new InputBoxTextSource(inputBox);
    const rewriter = new AbbreviationRewriter(leader, provider, textSource);

    const opQueue: QueuedOp[] = [];
    let drainPromise: Promise<void> | null = null;
    let resolved = false;

    function enqueueOp(op: QueuedOp): void {
      opQueue.push(op);
      if (!drainPromise) {
        drainPromise = processDrain();
      }
    }

    async function processDrain(): Promise<void> {
      try {
        while (opQueue.length > 0) {
          const op = opQueue.shift()!;
          if (op.kind === "change") {
            rewriter.changeInput(op.changes);
            // Only flush pending ops and trigger replacement when no
            // more change ops follow. When multiple keystrokes fire
            // synchronously (fast typing), their changes are all queued
            // before the drain starts. Triggering replacement after an
            // intermediate character (e.g. `\t` in `\to`) would modify
            // textSource.text out from under the remaining queued changes
            // whose offsets were computed against the original text.
            const nextIsChange = opQueue.length > 0 && opQueue[0].kind === "change";
            if (!nextIsChange) {
              await rewriter.flushPendingOps();
              await rewriter.triggerAbbreviationReplacement();
            }
          } else {
            await rewriter.cycleAbbreviations(op.direction);
          }
          updateStatusBar();
        }
      } finally {
        drainPromise = null;
      }
    }

    function updateStatusBar(): void {
      updateAbbreviationStatusBar(leader, rewriter.getTrackedAbbreviations(), statusBarItem);
    }

    // --- Context variable + cycle commands ---

    void vscode.commands.executeCommand("setContext", "agda.inputBox.isActive", true);

    const cycleForwardDisposable = vscode.commands.registerCommand(
      "agda.inputBox.cycleForward",
      () => enqueueOp({ kind: "cycle", direction: 1 }),
    );
    const cycleBackwardDisposable = vscode.commands.registerCommand(
      "agda.inputBox.cycleBackward",
      () => enqueueOp({ kind: "cycle", direction: -1 }),
    );

    // --- Event handlers ---

    function doResolve(value: string | undefined): void {
      if (resolved) return;
      resolved = true;
      statusBarItem.hide();
      void vscode.commands.executeCommand("setContext", "agda.inputBox.isActive", false);
      cycleForwardDisposable.dispose();
      cycleBackwardDisposable.dispose();
      resolve(value);
      inputBox.dispose();
    }

    inputBox.onDidChangeValue((newValue) => {
      if (textSource.isApplyingEdit) {
        textSource.text = newValue;
        return;
      }

      const changes = computeChanges(textSource.text, newValue);
      textSource.text = newValue;

      if (changes.length > 0) {
        enqueueOp({ kind: "change", changes });
      }
    });

    inputBox.onDidAccept(async () => {
      // Drain any pending ops, then finalize all tracked abbreviations
      if (drainPromise) await drainPromise;
      await rewriter.replaceAllTrackedAbbreviations();
      doResolve(textSource.text);
    });

    inputBox.onDidHide(() => {
      doResolve(undefined);
    });

    inputBox.show();
  });
}
