# Architecture

## Overview

This is a VSCode extension for interactive Agda development, targeting Agda >= 2.6.1. It communicates directly with a single long-lived `agda --interaction-json` process via stdin/stdout pipes — this is similar to `agda2-mode.el`, the Emacs agda2-mode, which communicates with `agda --interaction` (an S-expression based protocol).

The Emacs agda2-mode and this extension are structurally parallel, except:

- We use a modified version of the Lean 4 abbreviation engine (see [Unicode input](#unicode-input) below) for Unicode input.
- The Emacs mode has some Haskell integration that we do not.
- In Emacs, highlighting is stored as buffer text properties that are lost when switching buffers. The Emacs mode uses `Cmd_load_highlighting_info` to ask Agda to re-send all highlighting for the file. We don't need this because `HighlightingManager` keeps all decoration data in memory and `reapply(editor)` restores decorations when an editor regains focus.

## `--interaction` vs. `--interaction-json`

`--interaction` responses are serialized as S-expressions that invoke Emacs Lisp functions directly:

```
(agda2-goals-action '(0 1 2))
(agda2-status-action "Checked")
(agda2-info-action "*All Goals*" "?0 : Nat\n?1 : Bool" nil)
(agda2-give-action 0 "term")
((last . 2) agda2-make-case-action '("clause1" "clause2"))
```

Some responses are wrapped with ((last . N) ...) for sequencing.

`--interaction-json` responses are JSON objects (one per line)

```
{"kind":"InteractionPoints","interactionPoints":[{"id":0,"range":[...]}]}
{"kind":"Status","status":{"showImplicitArguments":false,"checked":true}}
{"kind":"DisplayInfo","info":{"kind":"AllGoalsWarnings","visibleGoals":[{"kind":"OfType","constraintObj":{"id":0},"typ
e":"Nat"}],"invisibleGoals":[],"warnings":[],"errors":[]}}
{"kind":"GiveAction","interactionPoint":0,"giveResult":{"str":"term"}}
{"kind":"MakeCase","interactionPoint":0,"variant":"Function","clauses":["clause1","clause2"]}
```

Every object has a top-level "kind" discriminator field. Built using EncodeTCM class from Interaction/JSON.hs.

## Module structure

```
src/
├── agda/               # Agda process communication
│   ├── commands.ts     # IOTCM command string builders
│   ├── installations.ts # Discover, probe, download, and manage Agda binaries
│   ├── process.ts      # Child process lifecycle (spawn, send, kill)
│   ├── protocol.ts     # Line-buffered stdout parser, prompt detection
│   ├── responses.ts    # TypeScript types for all JSON responses
│   └── version.ts      # Opaque branded AgdaVersion type + comparison
├── core/               # Domain state management
│   ├── commandQueue.ts      # Serial command queue with streaming
│   ├── documentEditor.ts    # TextEditor abstraction for testable response processing
│   ├── goals.ts             # Goal tracking, navigation, decorations
│   ├── highlighting.ts      # Unified highlighting (decorations + semantic tokens + definition sites)
│   ├── responseProcessor.ts # Handles document-mutating responses (give, make-case, goal expansion)
│   └── state.ts             # Per-document and workspace state
├── editor/             # VSCode integration
│   ├── commands.ts     # Command handlers (load, give, refine, etc.)
│   ├── infoPanel.ts    # Agda Info Panel (WebviewPanel for goals, context, errors)
│   └── keySequence.ts  # Leader M key sequence state machine
├── unicode/            # Unicode input (backslash abbreviations)
│   ├── engine/         # Lean 4 abbreviation engine (Apache-2.0, mostly unmodified)
│   ├── AbbreviationFeature.ts          # Entry point: wires everything together
│   ├── AbbreviationRewriterFeature.ts  # Manages per-editor rewriter lifecycle
│   ├── AbbreviationHoverProvider.ts    # Hover tooltips for abbreviation symbols
│   ├── VSCodeAbbreviationRewriter.ts   # VS Code adapter (isApplyingEdit guard)
│   └── VSCodeAbbreviationConfig.ts     # Configuration adapter
├── util/               # Shared utilities
│   ├── agdaLocation.ts # Parse Agda source locations in error messages
│   ├── config.ts       # Typed helpers for reading agda.* configuration
│   ├── editAdjust.ts   # Edit-adjustment math for keeping state in sync with edits
│   ├── errorMessage.ts # Extract message from Error objects or unknown values
│   ├── iotcm.ts        # IOTCM envelope + Haskell string quoting
│   ├── offsets.ts      # Pure offset conversion (Agda code points ↔ UTF-16)
│   └── position.ts     # VS Code position/range conversion wrappers
└── extension.ts        # Entry point: activate/deactivate
```

## Data flow

### Command execution

```
User keypress (Leader M L)
  → keySequence state machine advances to "leader-m", then fires agda.load
  → commands.ts: save document, build IOTCM string, enqueue
  → commandQueue.ts: send IOTCM to stdin, start collecting responses
  → protocol.ts: parse JSON lines from stdout, fire events
  → Two response paths:
      Streaming: HighlightingInfo, RunningInfo → applied immediately
      Batched: InteractionPoints, DisplayInfo, etc. → collected until "JSON> " prompt
  → commands.ts: processBatchedResponses() updates goals, shows info
```

### Highlighting

The IOTCM envelope specifies `Direct` highlighting delivery, so Agda embeds highlighting payloads inline in JSON responses (`{kind: "HighlightingInfo", direct: true, info: {...}}`). This is simpler and more reliable than the `Indirect` mode (which writes to temp files) used by the Emacs mode.

Highlighting is handled in the streaming callback so it appears progressively as Agda type-checks.

Each highlighting entry has a `[from, to]` range (1-based absolute character offsets) and a list of aspect atom names (e.g. `["keyword"]`, `["inductiveconstructor"]`), plus an optional `definitionSite` for go-to-definition.

#### Unified HighlightingManager

`HighlightingManager` (`src/core/highlighting.ts`) is the single source of truth for all highlighting state. It stores `StoredEntry` objects per file URI — each with a `Range`, atoms, and optional `definitionSite` — and derives two outputs:

1. **Semantic tokens (foreground colors)** — `HighlightingManager` implements `DocumentSemanticTokensProvider`. VS Code pulls tokens on demand; the manager maps Agda atoms to standard semantic token types so **all foreground text colors come from the user's theme**.

2. **Decorations (backgrounds, underlines, font styles)** — pushed to VS Code via `setDecorations`. These cover visual properties that semantic tokens cannot express, using `ThemeColor` references to custom color IDs defined in `contributes.colors`.

This unified design means each highlighting entry is stored once and adjusted once when the document is edited, rather than maintaining two parallel data structures.

#### Edit adjustment

When the user edits the document, stored highlighting ranges must be adjusted to stay in sync. Two modes are supported (implemented in `src/util/editAdjust.ts`):

- **`adjustForEdits`** — for arbitrary user edits: ranges that intersect the edited region are removed; ranges after the edit are shifted by the line/character delta.
- **`expandForGoalMarkers`** — for the known `?` → `{!!}` expansion during load: intersecting ranges are preserved and grown rather than removed. `HighlightingManager` maintains a per-URI `pendingExpansions` map; `registerPendingExpansions(uri, ranges)` is called before the expansion edit, and `adjustForEdits` consumes matching entries to decide whether to grow or remove intersecting ranges.

### Goals

After `Cmd_load`, Agda responds with `InteractionPoints` — a list of `{id, range}` objects identifying each hole. `GoalManager` converts these Agda ranges to VSCode ranges and applies decorations (blue background + `?N` label). As a fallback for empty ranges, it scans the document for `{! !}` delimiters.

### Undo/redo collation

When the user does give then undo, the goal decoration should disappear (matching Emacs, where the overlay is destroyed by give and not restored by undo). The problem: VS Code decomposes the undo into multiple atomic edits, and each individual edit looks like an interior-only change to `adjustRangeContaining`, so the goal survives.

The fix is **undo collation** — collapse the multiple atomic edits into a single merged change, which crosses goal boundaries and causes `adjustRangeContaining` to remove the goal.

**Computing the merged change:** `computeSingleChange(beforeText, afterText, holeAware)` in `editAdjust.ts` diffs the full document text before and after the undo using common prefix/suffix matching. It produces one `TextDocumentContentChangeEvent` spanning the entire changed region. Both undo paths pass `holeAware=true`, which prevents the minimal diff from hiding `{!`/`!}` delimiter crossings: if the common prefix contains an unmatched `{!` and the common suffix contains an unmatched `!}`, the prefix is shrunk to before the `{!` so the change region crosses the delimiter boundary. This is needed because a give that simplifies to `?` (expanded to `{!  !}`) produces identical delimiters in the post-give text, and the undo diff would otherwise be interior-only.

#### VSCodeVim undo

VSCodeVim implements its own undo (`historyTracker.goBackHistoryStep()`) by applying each reversed change via `TextEditor.edit()`. VS Code fires a **separate `onDidChangeTextDocument` event** for each atomic change.

The extension intercepts `u` via a `contributes.keybinding` with `"when": "vim.active && vim.mode == 'Normal' && editorLangId == agda"`. This binding sits above VSCodeVim's `type` command override in VS Code's keybinding resolution order, so the keystroke never reaches VSCodeVim directly. No user configuration is needed.

Redo (`Ctrl+R`) does **not** need interception: before we can redo edit X we must have undone X, so the undo collation already removed any goals whose boundaries X crosses. VSCodeVim handles redo through its own `Ctrl+R` keybinding (which is an explicit `contributes.keybinding` registered by VSCodeVim, not routed through the `type` override).

The `agda.vimUndo` handler dispatches the `u` key back through VS Code's `type` command (`executeCommand("type", {text: "u"})`), which VSCodeVim overrides. This is exactly the path a normal `u` keypress takes (minus keybinding resolution), so VSCodeVim's undo pipeline runs through its normal task queue and state management — preserving redo history. `executeCommand` does not go through keybinding resolution, so our keybinding does not re-fire.

The handler wraps this dispatch with collation:

1. Snapshots the document text and sets collation mode on `GoalManager`.
2. Dispatches `u` via `executeCommand("type")` so VSCodeVim runs its undo.
3. As `onDidChangeTextDocument` events fire, the handler sees the collation flag and skips `goals.adjustForEdits` (highlighting still adjusts per-change as normal).
4. `setTimeout(0)` defers final processing until straggling events drain.
5. The callback diffs the snapshot against the current text, runs `goals.adjustForEdits` with the single merged change.

The `setTimeout(0)` relies on: (a) VSCodeVim applying all mutations synchronously (no awaits between `TextEditor.edit()` calls), so all events are queued before `setTimeout` is scheduled; (b) FIFO task queue ordering.

#### Native VS Code undo

Native undo fires **one `onDidChangeTextDocument` event** with multiple `contentChanges` and `reason === TextDocumentChangeReason.Undo`. No multi-event coordination is needed.

1. The handler detects `reason === 1` (Undo) or `reason === 2` (Redo) with multiple changes.
2. `reconstructPreText(postText, contentChanges)` rebuilds the pre-change text. Content changes have ranges in pre-document coordinates; unchanged regions are copied from the post-text, and deleted content (which we don't have) is filled with null-byte placeholders.
3. `computeSingleChange(preText, postText)` diffs to get the merged change. Placeholders land inside the "changed middle" since they won't match the post-text — the boundaries are determined by the unchanged regions, which are correct.
4. `goals.adjustForEdits` runs with the single merged change.

### Command queue

Only one IOTCM command can be in-flight at a time (Agda processes them serially, signaling completion with a `JSON> ` prompt). `CommandQueue` ensures serial execution and tracks busy state via `setContext('agda.busy', ...)`.

The queue uses a hybrid streaming/batched model:

- An `onStream` callback fires for each response as it arrives (used for highlighting and progress)
- The returned `Promise<CommandResult>` resolves after the prompt with all accumulated responses

## Info Panel

The Info Panel (`src/editor/infoPanel.ts`) is a `WebviewPanel` that replaces notification toasts as the primary information display — equivalent to Emacs's `*Agda Information*` buffer.

### Design

Unlike Lean 4's infoview (a React app communicating over bidirectional RPC), the Agda Info Panel uses plain HTML/CSS generated on the extension side and sent to the webview via `postMessage`. The webview sends messages back only for user interactions (clicking a file location link → `openFile`). This simple design is appropriate because Agda's protocol sends complete `DisplayInfo` JSON blobs — there are no server-side object references or interactive widgets.

### What it displays

All `DisplayInfo` response variants are routed to the panel:

- **AllGoalsWarnings**: Visible goals (`?N : Type`), invisible goals, warnings, errors
- **GoalSpecific**: Goal type with full context (`ResponseContextEntry[]`), `GoalTypeAux` (Have/Elaboration), boundary, output forms, helper functions
- **Error**: Full error messages (no truncation), with warnings
- **InferredType**, **NormalForm**, **Version**
- **CompilationOk**: Success message with optional backend name, warnings, errors
- **Constraints**, **Context**, **WhyInScope**, **ModuleContents**, **SearchAbout**, **Auto**, **Time**, **IntroNotFound**, **IntroConstructorUnknown**

### Lifecycle

- Auto-opens on first `agda.load` (in `ViewColumn.Beside`, `preserveFocus: true`)
- If the user closes it, it stays closed (not auto-reopened)
- Toggle with `agda.toggleInfoPanel` (`Leader M I`)
- Panel uses `retainContextWhenHidden: true` to preserve scroll position

## Unicode input

### Overview

Agda code uses extensive Unicode (→, ∀, ℕ, λ, etc.). The extension provides inline replacement: type `\to` and it becomes `→`, type `\all` and it becomes `∀`, etc. The abbreviation is underlined while active and replaced eagerly when the user moves the cursor away or types a non-matching character.

### Engine: Lean 4 abbreviation system

Rather than writing a custom Unicode input system, we adapted the abbreviation engine from [vscode-lean4](https://github.com/leanprover/vscode-lean4) (Apache-2.0). The engine lives in `src/unicode/engine/` and is mostly unmodified from upstream. It provides:

- **`AbbreviationProvider`**: Loads the abbreviation table, supports prefix matching and multi-result lookup
- **`AbbreviationRewriter`**: Core state machine tracking active abbreviations, deciding when to replace
- **`TrackedAbbreviation`**: Represents one in-progress abbreviation (its range, current text, matched symbols)

The VS Code integration layer (`VSCodeAbbreviationRewriter`, `AbbreviationRewriterFeature`, `AbbreviationFeature`) adapts the engine to VS Code's APIs — listening to document changes and selection changes, applying edits, managing per-editor lifecycle.

### Re-entrant edit events and the `isApplyingEdit` guard

When `workspace.applyEdit()` modifies the document, VS Code fires `onDidChangeTextDocument` **re-entrantly** — during the `await`, before the promise resolves. Without a guard, this re-entrant event feeds our own edit into `changeInput` → `processChange`, which kills tracked abbreviations before `enterReplacedState` / `updateRangeAfterCycleEdit` can run.

**The fix**: `VSCodeAbbreviationRewriter` sets `isApplyingEdit = true` before `await workspace.applyEdit()` and `false` after. The first `onDidChangeTextDocument` event during the flag is assumed to be the re-entrant notification for our own edit and is skipped. In VS Code Remote, `applyEdit` involves IPC and takes multiple event-loop turns, so any additional events that arrive during the flag (real user keystrokes) are buffered in `eventsBufferedDuringEdit` and replayed through the operation queue after the edit completes.

#### Why `workspace.applyEdit` instead of `textEditor.edit`

The Lean 4 upstream uses `textEditor.edit()`. We use `workspace.applyEdit()` because:

1. `textEditor.edit()` has an internal retry loop (`$tryApplyEdits` → `acceptModelChanged` → retry) that can re-apply edits unexpectedly
2. `workspace.applyEdit()` is the recommended API for programmatic edits and goes through a cleaner code path

## Keybinding architecture

Two parallel keybinding styles are supported, each self-consistent:

### Ctrl+C style (Emacs-like)

Basic commands use native VS Code 2-key chords: `ctrl+c ctrl+l` → `agda.load`, etc. No state machine needed.

For 3-key sequences (`C-c C-x C-...` and `C-c C-u ...`), the chord enters a state machine state, then a `ctrl+key` binding fires the final command:

- `ctrl+c ctrl+x` → state `"cc-x"` → `ctrl+r` fires `agda.restart`
- `ctrl+c ctrl+u` → state `"cc-u"` → `ctrl+t` fires `agda.goalType` (with universalArgCount=1)

### Evil style (Doom Emacs)

VSCode only supports 2-key chords natively, and VSCodeVim captures all Normal mode keypresses. To support `Leader M L` style sequences:

1. A `contributes.keybinding` intercepts `Space` in vim normal mode for Agda files (fires before VSCodeVim's `type` override) → `agda.keySequence.leader` command
2. The key sequence state machine (`keySequence.ts`) tracks prefix state via `setContext("agda.keySequence", state)`
3. Package.json keybindings use `when` clauses: `"agda.keySequence == 'leader-m'"` gates single-key bindings like `l` → `agda.load`
4. Each Agda command handler calls `resetSequence()` to clear the prefix state

State transitions: `""` → `"leader"` → `"leader-m"` → (final key fires command) or `"leader-m"` → `"leader-m-x"` → (final key fires command).

### Shared infrastructure

Both styles share the same `universalArgCount`, `resetSequence()`, timeout (2 seconds), and Escape cancel. The states are kept separate (`leader-m-x` vs `cc-x`, `leader-m-u` vs `cc-u`) so the two styles don't bleed into each other — each style uses its own key modifiers (plain keys for Evil, `ctrl+key` for Ctrl+C) in sub-states.

## Version handling

`AgdaVersion` (`src/agda/version.ts`) is an opaque branded type — like `AgdaOffset`, it prevents accidental misuse by making it non-assignable to/from `number[]`. Well-known constants `V2_7` and `V2_8` are used throughout the codebase for version-gated behavior:

- **Command builders** (`commands.ts`): `cmdAutoOne`/`cmdAutoAll` take different arguments for Agda < 2.7 vs >= 2.7. `cmdLoadNoMetas` (>= 2.8) takes the filepath in the inner command; `cmdNoMetas` (< 2.8) does not. `cmdBackendTop`/`cmdBackendHole` are >= 2.8 only.
- **Location parsing** (`agdaLocation.ts`): Agda < 2.8 uses comma-separated positions (`file:10,5-15`); >= 2.8 uses dots (`file:10.5-15`).
- **Process startup** (`process.ts`): Runs `agda --version` before spawning, validates >= 2.6.1.

## Agda binary management

The extension can discover and manage Agda installations (`src/agda/installations.ts`), exposed through two commands:

- **Download Agda** (`agda.downloadAgda`): Downloads pre-built Agda binaries from a hardcoded table of known GitHub release URLs for the current platform (linux/x64, macOS-arm64/x64, win64). Archives are cached in `globalStorage/archives/` and extracted to `globalStorage/bin/{tag}/`. Handles two archive layouts: v2.8.0+ (bare `agda` at root) and v2.7.0.1 (`Agda-*/bin/agda`). On macOS, removes the quarantine extended attribute.
- **Switch Agda** (`agda.switchAgda`): Shows a QuickPick listing Agda installations from four sources (discovered in parallel) and updates the `agda.path` configuration:
  1. **Extension-managed** downloads in `globalStorage/bin/`
  2. **User-configured** `agda.additionalPaths` — broken entries are shown with a warning icon and reason
  3. **System PATH** — scans `$PATH` directories
  4. **Well-known locations** — `~/.cabal/bin`, `~/.local/bin`, `~/.ghcup/bin`, `~/.nix-profile/bin`, Nix system profile, plus Homebrew paths on macOS and `%APPDATA%\cabal\bin` on Windows

All discovery functions return normalized paths (symlinks resolved) to ensure correct deduplication across sources. The shared `probeAgda()` helper checks executability and runs `agda --version` to detect the version, returning a structured `ProbeResult` (success with version, or failure with reason).

`AgdaProcess` auto-detects `Agda_datadir` for v2.7.0.1 bundled installs so the data directory is found correctly when using a downloaded binary.

## Location parsing

Agda error messages contain source locations like `file:10,5-15` or `file:10,5-12,3`. The `agdaLocation.ts` module parses these into structured `LinkedText` — an array of plain-text and location segments. This enables clickable file locations in the Info Panel.

Column numbers require conversion because Agda reports code-point offsets while VS Code uses UTF-16. The parser reads the referenced file's text to perform this conversion accurately. Goal-relative ranges (no filepath) are left as plain text since they refer to the current document's already-known goal ranges.

## Offsets and positions

Agda uses 1-based absolute code-point offsets for all positions. Two layers handle conversion:

1. **`offsets.ts`** — pure functions with zero VS Code dependencies. `AgdaOffset` is a branded opaque type that prevents passing raw numbers to `document.positionAt()`. Handles supplementary-plane characters (U+10000+), where each code point maps to two UTF-16 code units.

2. **`position.ts`** — thin wrappers that accept a `TextDocument` and delegate to `offsets.ts`. Functions take an optional `text?: string` parameter to avoid repeated `document.getText()` calls in loops.

## Configuration

`src/util/config.ts` provides typed helpers for reading `agda.*` settings: `getAgdaPath()`, `getExtraArgs()`, `getBackend()`, `getAdditionalPaths()`, `getGoalLabels()`. The generic `agdaConfig()` helper wraps `vscode.workspace.getConfiguration("agda")`.

Available settings: `agda.path` (binary), `agda.additionalPaths` (for Switch Agda), `agda.extraArgs`, `agda.backend` (GHC/JS/LaTeX/HTML), `agda.goalLabels` (show `?N` decorations), plus `agda.input.*` settings for the abbreviation engine.

## TextMate grammar

`syntaxes/agda.tmLanguage.json` provides a minimal TextMate grammar that scopes comments, block comments, and string literals. Its only purpose is to tell VS Code's bracket matcher to skip brackets inside these regions — without it, parentheses in `-- comment (with parens)` would be bracket-matched. All actual syntax coloring comes from Agda's semantic tokens.

The line comment rule uses a negative lookbehind to avoid matching `--` inside identifiers: `(?<![^\s(){}";@.])--.*$`. This is a double-negative ("not preceded by a non-delimiter") derived from Agda's lexer, where the delimiter characters that cannot appear in identifiers are whitespace, `(){}`, `"`, `;`, `@`, and `.`. Since Agda allows almost any Unicode character in identifiers (the `alexGetByte` function in the compiler maps non-ASCII printable characters to identifier-compatible bytes), enumerating delimiters is simpler than enumerating identifier characters.

## Build and test

Begin by running `npm install`.

The extension is bundled with **esbuild** (`esbuild.js`): `src/extension.ts` → `dist/extension.js` as CommonJS (required by VS Code), with `vscode` as an external. `--watch` mode is available for development.

Tests use **vitest** (`vitest.config.mts`) with a mock VS Code API (`test/__mocks__/vscode.ts`). Run with `npx vitest run` (262 tests across 14 files). Tests cover offsets, positions, edit adjustment, goals, highlighting, cursor positioning, info panel rendering, abbreviation engine, version comparison, and location parsing.

`scripts/generate-abbreviations.py` regenerates `src/unicode/abbreviations.json` from Agda's Emacs input method by driving Emacs in batch mode to dump the `agda-input` translation table.
