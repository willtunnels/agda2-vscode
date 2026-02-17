// Key sequence state machine for Agda keybindings.
//
// Two parallel keybinding styles, each self-consistent:
//
//   Evil-style:  Leader → M → (plain key)
//                Leader → M → X → (plain key)
//                Leader → M → U → (plain key)
//
//   Ctrl+C:      Ctrl+C Ctrl+(key)                [native VS Code chord]
//                Ctrl+C Ctrl+X → Ctrl+(key)       [chord + state machine]
//                Ctrl+C Ctrl+U → Ctrl+(key)       [chord + state machine]
//
// The two styles use separate states (leader-m-x vs cc-x, leader-m-u
// vs cc-u) so they don't bleed into each other.
//
// The "u" prefix emulates Emacs's C-u universal argument:
//   Leader m u t     → goal type (Instantiated)
//   Ctrl+C Ctrl+U t  → goal type (Instantiated)
//   (multiple u's increase normalisation level)
// For non-query commands, u acts as a boolean flag:
//   Leader m u SPC   → give with force
//   Leader m u r     → refine with pattern-matching lambda

import * as vscode from "vscode";

type SequenceState = "" | "leader" | "leader-m" | "leader-m-x" | "leader-m-u" | "cc-x" | "cc-u";

const CONTEXT_KEY = "agda.keySequence";
const TIMEOUT_MS = 2000;

let state: SequenceState = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let universalArgCount = 0;

function setState(newState: SequenceState): void {
  state = newState;
  vscode.commands.executeCommand("setContext", CONTEXT_KEY, newState);

  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }

  if (newState !== "") {
    timer = setTimeout(() => {
      resetSequence();
    }, TIMEOUT_MS);
  }
}

/**
 * Returns the current universal argument count (number of times "u" was pressed).
 * 0 means no universal argument was given.
 */
export function getUniversalArgCount(): number {
  return universalArgCount;
}

export function resetSequence(): void {
  universalArgCount = 0;
  setState("");
}

export function registerKeySequenceCommands(context: vscode.ExtensionContext): void {
  // Leader key pressed (Space). In vim normal mode, our contributes.keybinding
  // intercepts space before VSCodeVim's type override. The leader-m/leader-m-u
  // cases are handled by their own keybindings; this fallback covers any edge
  // case where the command is invoked directly.
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.leader", () => {
      if (state === "leader-m" || state === "leader-m-u") {
        // Leader after Leader M (or Leader M U) → give
        vscode.commands.executeCommand("agda.give");
        return;
      }
      setState("leader");
    }),
  );

  // M pressed after Leader
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.m", () => {
      if (state === "leader") {
        setState("leader-m");
      } else {
        resetSequence();
      }
    }),
  );

  // X pressed after Leader M (for restart/abort sub-prefix)
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.x", () => {
      if (state === "leader-m") {
        setState("leader-m-x");
      } else {
        resetSequence();
      }
    }),
  );

  // U pressed after Leader M or Leader M U (universal argument prefix)
  // Each press increments the count (capped at 3).
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.u", () => {
      if (state === "leader-m") {
        universalArgCount = 1;
        setState("leader-m-u");
      } else if (state === "leader-m-u") {
        universalArgCount = Math.min(universalArgCount + 1, 3);
        // Stay in leader-m-u; re-set to refresh timeout
        setState("leader-m-u");
      } else {
        resetSequence();
      }
    }),
  );

  // Escape cancels
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.escape", () => {
      resetSequence();
    }),
  );

  // Ctrl+C Ctrl+X chord entry -- enters cc-x state (parallel to leader-m-x)
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.cc-x", () => {
      setState("cc-x");
    }),
  );

  // Ctrl+C Ctrl+U chord entry -- enters cc-u state (parallel to leader-m-u)
  // with universalArgCount=1. If already in cc-u, increments the count.
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.cc-u", () => {
      if (state === "cc-u") {
        universalArgCount = Math.min(universalArgCount + 1, 3);
        setState("cc-u");
      } else {
        universalArgCount = 1;
        setState("cc-u");
      }
    }),
  );

  vscode.commands.executeCommand("setContext", CONTEXT_KEY, "");
}
