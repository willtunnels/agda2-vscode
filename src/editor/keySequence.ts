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

type StateKind = "" | "leader" | "leader-m" | "leader-m-x" | "leader-m-u" | "cc-x" | "cc-u";

interface State {
  kind: StateKind;
  u: number;
}

type Key = "leader" | "m" | "x" | "u" | "escape" | "cc-x" | "cc-u";

type KeySequenceResult =
  | { kind: "state"; state: State }
  | { kind: "dispatch"; command: string; state: State };

const RESET: State = { kind: "", u: 0 };

/**
 * Compute the next key sequence state from a key input.
 */
function nextKeySequenceState(
  current: State,
  input: Key,
): KeySequenceResult {
  switch (input) {
    case "leader":
      if (current.kind === "leader-m" || current.kind === "leader-m-u") {
        return { kind: "dispatch", command: "agda.give", state: RESET };
      }
      return { kind: "state", state: { kind: "leader", u: 0 } };

    case "m":
      if (current.kind === "leader") {
        return { kind: "state", state: { kind: "leader-m", u: 0 } };
      }
      return { kind: "state", state: RESET };

    case "x":
      if (current.kind === "leader-m") {
        return { kind: "state", state: { kind: "leader-m-x", u: 0 } };
      }
      return { kind: "state", state: RESET };

    case "u":
      if (current.kind === "leader-m") {
        return { kind: "state", state: { kind: "leader-m-u", u: 1 } };
      }
      if (current.kind === "leader-m-u") {
        return {
          kind: "state",
          state: { kind: "leader-m-u", u: Math.min(current.u + 1, 3) },
        };
      }
      return { kind: "state", state: RESET };

    case "escape":
      return { kind: "state", state: RESET };

    case "cc-x":
      return { kind: "state", state: { kind: "cc-x", u: 0 } };

    case "cc-u":
      if (current.kind === "cc-u") {
        return {
          kind: "state",
          state: { kind: "cc-u", u: Math.min(current.u + 1, 3) },
        };
      }
      return { kind: "state", state: { kind: "cc-u", u: 1 } };
  }
}

// ---------------------------------------------------------------------------
// VSCode integration
// ---------------------------------------------------------------------------

const CONTEXT_KEY = "agda.keySequence";
const TIMEOUT_MS = 2000;

let state: State = RESET;
let timer: ReturnType<typeof setTimeout> | undefined;

function applyState(newState: State): void {
  state = newState;
  vscode.commands.executeCommand("setContext", CONTEXT_KEY, newState.kind);

  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }

  if (newState.kind !== "") {
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
  return state.u;
}

export function resetSequence(): void {
  applyState(RESET);
}

function handleInput(input: Key): void {
  const result = nextKeySequenceState(state, input);
  applyState(result.state);
  if (result.kind === "dispatch") {
    vscode.commands.executeCommand(result.command);
  }
}

export function registerKeySequenceCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agda.keySequence.leader", () => handleInput("leader")),
    vscode.commands.registerCommand("agda.keySequence.m", () => handleInput("m")),
    vscode.commands.registerCommand("agda.keySequence.x", () => handleInput("x")),
    vscode.commands.registerCommand("agda.keySequence.u", () => handleInput("u")),
    vscode.commands.registerCommand("agda.keySequence.escape", () => handleInput("escape")),
    vscode.commands.registerCommand("agda.keySequence.cc-x", () => handleInput("cc-x")),
    vscode.commands.registerCommand("agda.keySequence.cc-u", () => handleInput("cc-u")),
  );

  vscode.commands.executeCommand("setContext", CONTEXT_KEY, "");
}
