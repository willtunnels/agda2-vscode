/**
 * A `showInputBox` wrapper that runs the abbreviation engine against the
 * InputBox text so that `\to` → `→` etc. work as in the editor.
 */

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

/**
 * Compute a single Change from an old/new string pair using common
 * prefix/suffix matching.
 */
export function computeChanges(oldValue: string, newValue: string): Change[] {
  if (oldValue === newValue) return [];

  const { prefix, suffix } = commonPrefixSuffix(oldValue, newValue);
  const oldMiddleLen = oldValue.length - prefix - suffix;
  const newMiddle = newValue.substring(prefix, newValue.length - suffix);

  return [{ range: new Range(prefix, oldMiddleLen), newText: newMiddle }];
}

/** An AbbreviationTextSource backed by an InputBox value. Edits are synchronous. */
class InputBoxTextSource implements AbbreviationTextSource {
  /* Usually in sync with `this.inputBox.value`, except at the beginning of `onDidChangeValue`
   * handlers, where the InputBox value has already changed but we haven't processed the change yet.
   * There `text` holds the old value as a baseline for computing diffs. */
  text = "";

  /* Reentrancy guard */
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

type QueuedOp =
  | { kind: "change"; changes: Change[] }
  | { kind: "cycle"; direction: 1 | -1 }
  | { kind: "delete" };

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
        while (true) {
          while (opQueue.length > 0) {
            const op = opQueue.shift()!;
            switch (op.kind) {
              case "change":
                rewriter.changeInput(op.changes);
                break;
              case "cycle":
                rewriter.cycleAbbreviations(op.direction);
                break;
              case "delete":
                rewriter.deleteAbbreviations();
                break;
            }
          }
          await rewriter.flushDirty();
          updateStatusBar();
          if (opQueue.length === 0) break;
        }
      } finally {
        drainPromise = null;
      }
    }

    function updateStatusBar(): void {
      updateAbbreviationStatusBar(leader, rewriter.getTrackedAbbreviations(), statusBarItem);
    }

    void vscode.commands.executeCommand("setContext", "agda.inputBox.isActive", true);

    const cycleForwardDisposable = vscode.commands.registerCommand(
      "agda.inputBox.cycleForward",
      () => enqueueOp({ kind: "cycle", direction: 1 }),
    );

    const cycleBackwardDisposable = vscode.commands.registerCommand(
      "agda.inputBox.cycleBackward",
      () => enqueueOp({ kind: "cycle", direction: -1 }),
    );

    const deleteAbbrDisposable = vscode.commands.registerCommand(
      "agda.inputBox.deleteAbbreviation",
      () => enqueueOp({ kind: "delete" }),
    );

    function doResolve(value: string | undefined): void {
      if (resolved) return;
      resolved = true;

      statusBarItem.hide();
      void vscode.commands.executeCommand("setContext", "agda.inputBox.isActive", false);

      cycleForwardDisposable.dispose();
      cycleBackwardDisposable.dispose();
      deleteAbbrDisposable.dispose();

      resolve(value);
      inputBox.dispose();
    }

    inputBox.onDidChangeValue((newValue) => {
      // Skip change events caused by our own replaceAbbreviations calls.
      if (textSource.isApplyingEdit) {
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

      rewriter.replaceAllTrackedAbbreviations();
      await rewriter.flushDirty();

      doResolve(textSource.text);
    });

    inputBox.onDidHide(() => {
      doResolve(undefined);
    });

    inputBox.show();
  });
}
