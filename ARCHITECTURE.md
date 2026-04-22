# Architecture

The purpose of this file is to bootstrap human and agent context with respect to this project.

## Overview

This is a VSCode extension for interactive Agda development, targeting Agda >= 2.6.1. It communicates directly with a single long-lived `agda --interaction-json` process via stdin/stdout pipes -- this is similar to `agda2-mode.el`, the Emacs agda2-mode, which communicates with `agda --interaction` (an S-expression based protocol).

The Emacs agda2-mode and this extension are structurally parallel, except:

- We use a modified version of the Lean 4 abbreviation engine (see [Unicode input](#unicode-input) below) for Unicode input.
- The Emacs mode has some Haskell integration that we do not.
- In Emacs, highlighting is stored as buffer text properties that are lost when switching buffers. The Emacs mode uses `Cmd_load_highlighting_info` to ask Agda to re-send all highlighting for the file. We don't need this because `SessionState` keeps all highlighting data in memory and `DecorationRenderer` re-pushes decorations whenever the active editor changes.

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
├── core/               # Domain state (pure data, no VS Code providers)
│   ├── commandQueue.ts      # Serial command queue with streaming
│   ├── defId.ts             # Opaque branded DefId type for definition identity
│   ├── documentEditor.ts    # TextEditor abstraction for testable response processing
│   ├── goals.ts             # Goal tracking, navigation, decorations
│   ├── responseProcessor.ts # Handles document-mutating responses (give, make-case, goal expansion)
│   ├── sessionState.ts      # Per-file Agda state: highlighting entries + name/type info
│   └── state.ts             # Per-document and workspace state
├── providers/          # Thin VS Code provider adapters over core state
│   ├── defTree.ts           # Pure def-tree builder shared by outline + name-info fetch
│   ├── definition.ts        # Go-to-definition (uses LiveDefinitionSite)
│   ├── documentHighlights.ts # Regex-based word occurrence highlighting
│   ├── documentSymbols.ts   # Outline from def tree (owns re-registration, prunes where-locals)
│   ├── hover.ts             # AgdaHoverProvider (type info + abbreviations, agda/lagda) and GenericHoverProvider (abbreviations only, other languages)
│   ├── nameMatching.ts      # Pure helpers for joining ModuleContents responses to DefIds
│   ├── rename.ts            # F2 rename via semantic tokens
│   └── semanticTokens.ts    # Foreground color tokens (pull-based)
├── editor/             # VS Code integration layer (side effects on editors)
│   ├── commands.ts     # Command handlers (load, give, refine, etc.)
│   ├── decorationRenderer.ts # Pushes setDecorations from SessionState state events
│   ├── infoPanel.ts    # Agda Info Panel (WebviewPanel for goals, context, errors)
│   ├── keySequence.ts  # Leader M key sequence state machine
│   └── unicodeInputBox.ts # InputBox with abbreviation support (used for goal prompts)
├── unicode/            # Unicode input (backslash abbreviations)
│   ├── engine/         # Lean 4 abbreviation engine (Apache-2.0, mostly unmodified)
│   ├── AbbreviationRewriterFeature.ts  # Manages per-editor rewriter lifecycle
│   └── VSCodeAbbreviationRewriter.ts   # VS Code adapter (isApplyingEdit guard)
├── util/               # Shared utilities
│   ├── agdaLocation.ts # Parse Agda source locations in error messages
│   ├── config.ts       # Typed helpers for reading agda.* configuration
│   ├── editAdjust.ts   # Edit-adjustment math (range/position shifts)
│   ├── errorMessage.ts # Extract message from Error objects or unknown values
│   ├── iotcm.ts        # IOTCM envelope + Haskell string quoting
│   ├── offsets.ts      # Pure offset conversion (Agda code points ↔ UTF-16)
│   ├── position.ts     # VS Code position/range conversion wrappers
│   └── semanticTokens.ts # Pure derivation of semantic tokens from entries
└── extension.ts        # Entry point: activate/deactivate, wires state ↔ providers
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

#### SessionState: pure data, no providers

`SessionState` (`src/core/sessionState.ts`) is the single source of truth for per-file Agda-derived state. Two kinds of state:

1. **Highlighting entries** (`StoredEntry[]` per URI) -- each with a `Range`, atoms (e.g. `["function"]`, `["keyword"]`), an `isSelfDef` flag, and an optional `LiveDefinitionSite`.
2. **Name/type info** (`Map<DefId, NameInfo>` per URI) -- populated post-load by `Cmd_show_module_contents_toplevel` and joined to self-def entries by name. Consumed by the outline and hover.

`SessionState` has no VS Code provider methods and no editor side effects. It just ingests (`applyHighlighting`, `setNameInfo`), exposes accessors (`getEntries`, `getDefinitionSite`, `getNameInfo`, `hasLoaded`), adjusts for edits (`adjustForEdits`, `registerPendingExpansions`), and fires `onDidChange({uri})` on every mutation. The providers and `DecorationRenderer` subscribe.

#### Providers: thin adapters over state

`src/providers/` holds seven small classes, one per VS Code provider interface. Each takes `SessionState` (and any other state sources it needs) as constructor args and implements `provide*`:

- `AgdaSemanticTokensProvider` -- maps entries' atoms to standard semantic token types so **all foreground text colors come from the user's theme**. Pull-based; re-fires VS Code's `onDidChangeSemanticTokens` when `state.onDidChange` fires.
- `AgdaDocumentHighlightProvider` -- regex-based word-occurrence highlighting; takes no state (works even before load).
- `AgdaRenameProvider` -- semantic-token-based rename (F2).
- `AgdaDefinitionProvider` -- go-to-definition. For same-file sites uses `LiveDefinitionSite.position` (shifted on edits); for cross-file sites opens the target file and converts the raw offset.
- `AgdaDocumentSymbolProvider` -- the outline. Delegates to `buildDefTree` and `treeToSymbols` (see [Outline and name-info](#outline-and-name-info) below). `DocumentSymbolProvider` has no `onDidChange` API ([microsoft/vscode#71454](https://github.com/microsoft/vscode/issues/71454)), so the provider owns its own registration and re-registers (debounced) on `state.onDidChange` to force VS Code to re-query.
- `AgdaHoverProvider` (agda/lagda) -- combines type info (from `getNameInfo`) and unicode abbreviations (from `AbbreviationProvider`) into a single deterministically ordered popup.
- `GenericHoverProvider` (non-agda/lagda) -- abbreviation info only.

#### DecorationRenderer: push-based rendering

Decorations (backgrounds, underlines, font styles via `ThemeColor`) can't be expressed as semantic tokens, so they go through `TextEditor.setDecorations`. `DecorationRenderer` (`src/editor/decorationRenderer.ts`) owns the decoration types, subscribes to `state.onDidChange` and `vscode.window.onDidChangeActiveTextEditor`, and pushes to visible editors. Keeping this out of `SessionState` means state ingestion has no editor dependency.

#### Definition sites: DefId (opaque identity) + LiveDefinitionSite (live position)

Each entry with a `definitionSite` carries two things:

- **`id: DefId`** -- opaque branded identity (from `src/core/defId.ts`). Minted at ingestion from Agda's reported offset. Never shifted. Used as the key for `nameInfoByUri` and for grouping entries that point to the same definition. The brand prevents all numeric operations at compile time; only `defIdEq` and `Map<DefId, _>` lookups are legal.
- **`position`** -- for same-file definitions, a live `vscode.Position` shifted by `adjustForEdits` so go-to-definition lands on the correct character after arbitrary edits. For cross-file definitions, the raw `AgdaOffset` is kept instead and converted lazily by `AgdaDefinitionProvider` when it opens the target document.

`isSelfDef` is computed at ingestion (the entry's range start matches its own definition position) and stays stable under edits.

#### Edit adjustment

When the user edits the document, stored highlighting ranges must be adjusted to stay in sync. Two modes are supported (implemented in `src/util/editAdjust.ts`):

- **`adjustForEdits`** -- for arbitrary user edits: ranges that intersect the edited region are removed; ranges after the edit are shifted by the line/character delta. Same-file `LiveDefinitionSite.position` fields are shifted via `adjustPosition` using the same math. Name-info entries whose self-def was removed are evicted in the same pass.
- **Pending expansions** -- for the known `?` → `{!!}` expansion during load: intersecting ranges are preserved and grown rather than removed. `SessionState` maintains a per-URI `pendingExpansions` map; `registerPendingExpansions(uri, ranges)` is called before the expansion edit, and `adjustForEdits` consumes matching entries to decide whether to grow or remove intersecting ranges.

### Outline and name-info

The document outline and hover type info are both driven from a shared tree over self-def entries, plus a cache of name/type pairs fetched from Agda after load.

#### `buildDefTree` (`src/providers/defTree.ts`)

Pure function `(entries, document) → DefNode[]`. Produces a forest keyed by `DefId`. Consumed by both the outline provider and `fetchNameInfo` so they agree on structure. Algorithm:

1. Collect one canonical self-def per `DefId` (earliest range wins); drop entries with the `bound` atom and cross-file definition sites.
2. Sort by source position.
3. Walk with an indent-column stack. Each entry's effective column is its identifier's column, except for atoms whose containing keyword sits to the left (`module` → `module` keyword, `datatype` → `data`, `record` → `record`, `postulate` → `postulate`, `primitive` → `primitive`) -- for these the effective column is the preceding keyword's column, so e.g. `data Bool` nests children by the `data` column rather than the `Bool` column.
4. Anonymous `module _ (params) where` entries (atom `module`, name `_`) are skipped but still pop the stack, hoisting their children into the surrounding scope. This matches Agda's semantic merging: anonymous modules are a parameter-sharing tool, not a structural container -- their contents appear at the outer module's scope (with the params prepended to each member's type).

`walkDefTree(tree)` is a depth-first iterator used by the name-info matcher to flatten a subtree when building a name → DefId lookup.

#### `fetchNameInfo` (`src/editor/commands.ts`)

Runs after a successful `Cmd_load`. Its responsibility is to populate `sessionState.nameInfoByUri` so the outline and hover can attach types to their entries. It bypasses `processBatchedResponses` (so the `ModuleContents` response doesn't surface in the info panel) and goes through the command queue directly.

1. Issue `Cmd_show_module_contents_toplevel ""` to get the file's top-level contents (everything visible at module scope -- including constructors re-exported from data types and anonymous-module-merged definitions).
2. Build the def tree from the current entries.
3. Flat-walk the whole tree to build a name → DefId map, then match the response's `contents` array against it. Matched entries go into `nameInfoByUri` via `sessionState.setNameInfo`; matched IDs are added to a local `addedIds` set for dedup.
4. For each name in the response's `names` list (sub-namespaces -- records, data types as namespaces, nested modules), look up the corresponding tree node via a flat-walk lookup (not just roots -- the namespace may live inside an anonymous module). Fetch its contents via another `Cmd_show_module_contents_toplevel <name>` and match against _that_ node's subtree. Scope-limited matching prevents two records that share a field name (e.g. both have `fst`) from clobbering each other. Recursion stops at one level deep.

The name-matching logic lives in `src/providers/nameMatching.ts` (`displayType`, `buildNameToIdMap`, `matchContents`) so it can be unit-tested without a live Agda process.

**What Agda won't surface**: where-clause locals (defined inside a function's `where`). Agda's interaction protocol has no command that exposes them: `Cmd_show_module_contents_toplevel <funcName>` fails with `ShouldBeRecordType`; qualified infers (`funcName.localName`) return `NotInScope`. The outline prunes them for the same reason (see below); hover silently returns no type for them.

**What Agda won't surface for modules**: module telescopes are always empty in the `ModuleContents` response (Agda 2.8).

#### `treeToSymbols` (`src/providers/documentSymbols.ts`)

Pure function `(document, tree, getNameInfo) → DocumentSymbol[]`. Maps atoms to `SymbolKind` (function → Function, datatype → Class, record → Struct, constructor → Constructor, field → Field, module → Namespace, postulate → Variable). Attaches `NameInfo.type` as the symbol detail. **Prunes children of function-like nodes** (`function`, `macro` atoms) so where-clause locals don't clutter the outline -- they're purely local and Agda can't give us types for them anyway. Non-function parents (records, data types, modules) keep their children, so private let-bindings inside records (atom `function`, but parent `record`) still appear.

### Goals

After `Cmd_load`, Agda responds with `InteractionPoints` -- a list of `{id, range}` objects identifying each hole. `GoalManager` converts these Agda ranges to VSCode ranges and applies decorations (blue background + `?N` label). As a fallback for empty ranges, it scans the document for `{! !}` delimiters.

### Undo/redo collation

When the user does give then undo, the goal decoration should disappear (matching Emacs, where the overlay is destroyed by give and not restored by undo). The problem: VS Code decomposes the undo into multiple atomic edits, and each individual edit looks like an interior-only change to `adjustRangeContaining`, so the goal survives.

The fix is **undo collation** -- collapse the multiple atomic edits into a single merged change, which crosses goal boundaries and causes `adjustRangeContaining` to remove the goal.

**Computing the merged change:** `computeSingleChange(beforeText, afterText, holeAware)` in `editAdjust.ts` diffs the full document text before and after the undo using common prefix/suffix matching. It produces one `TextDocumentContentChangeEvent` spanning the entire changed region. Both undo paths pass `holeAware=true`, which prevents the minimal diff from hiding `{!`/`!}` delimiter crossings: if the common prefix contains an unmatched `{!` and the common suffix contains an unmatched `!}`, the prefix is shrunk to before the `{!` so the change region crosses the delimiter boundary. This is needed because a give that simplifies to `?` (expanded to `{!  !}`) produces identical delimiters in the post-give text, and the undo diff would otherwise be interior-only.

#### VSCodeVim undo

VSCodeVim implements its own undo (`historyTracker.goBackHistoryStep()`) by applying each reversed change via `TextEditor.edit()`. VS Code fires a **separate `onDidChangeTextDocument` event** for each atomic change.

The extension intercepts `u` via a `contributes.keybinding` with `"when": "vim.active && vim.mode == 'Normal' && editorLangId == agda"`. This binding sits above VSCodeVim's `type` command override in VS Code's keybinding resolution order, so the keystroke never reaches VSCodeVim directly. No user configuration is needed.

Redo (`Ctrl+R`) does **not** need interception: before we can redo edit X we must have undone X, so the undo collation already removed any goals whose boundaries X crosses. VSCodeVim handles redo through its own `Ctrl+R` keybinding (which is an explicit `contributes.keybinding` registered by VSCodeVim, not routed through the `type` override).

The `agda.vimUndo` handler dispatches the `u` key back through VS Code's `type` command (`executeCommand("type", {text: "u"})`), which VSCodeVim overrides. This is exactly the path a normal `u` keypress takes (minus keybinding resolution), so VSCodeVim's undo pipeline runs through its normal task queue and state management -- preserving redo history. `executeCommand` does not go through keybinding resolution, so our keybinding does not re-fire.

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
3. `computeSingleChange(preText, postText)` diffs to get the merged change. Placeholders land inside the "changed middle" since they won't match the post-text -- the boundaries are determined by the unchanged regions, which are correct.
4. `goals.adjustForEdits` runs with the single merged change.

### Command queue

Only one IOTCM command can be in-flight at a time (Agda processes them serially, signaling completion with a `JSON> ` prompt). `CommandQueue` ensures serial execution and tracks busy state via `setContext('agda.busy', ...)`.

The queue uses a hybrid streaming/batched model:

- An `onStream` callback fires for each response as it arrives (used for highlighting and progress)
- The returned `Promise<CommandResult>` resolves after the prompt with all accumulated responses

## Info Panel

The Info Panel (`src/editor/infoPanel.ts`) is a `WebviewPanel` that replaces notification toasts as the primary information display -- equivalent to Emacs's `*Agda Information*` buffer.

### Design

Unlike Lean 4's infoview (a React app communicating over bidirectional RPC), the Agda Info Panel uses plain HTML/CSS generated on the extension side and sent to the webview via `postMessage`. The webview sends messages back only for user interactions (clicking a file location link → `openFile`). This simple design is appropriate because Agda's protocol sends complete `DisplayInfo` JSON blobs -- there are no server-side object references or interactive widgets.

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

- **`AbbreviationProvider`**: Loads the abbreviation table, supports prefix matching and multi-result lookup. Takes custom translations directly (a `SymbolsByAbbreviation` map) and supports `reload()` for live config changes. Also a convenient place to store the last-selected cycle index for each abbreviation with multiple mappings.
- **`AbbreviationRewriter`**: Core state machine tracking active abbreviations, deciding when to replace. Takes a leader character string and an `AbbreviationTextSource` abstraction.
- **`TrackedAbbreviation`**: Represents one in-progress abbreviation (its range, current text, matched symbols)

The VS Code integration layer adapts the engine to VS Code's APIs -- listening to document changes and selection changes, applying edits, managing per-editor lifecycle:

- `VSCodeAbbreviationRewriter` and `AbbreviationRewriterFeature` (in `src/unicode/`) manage the in-editor rewriter lifecycle.
- `GenericHoverProvider` (in `src/providers/hover.ts`) shows abbreviation info on hover for non-agda/lagda languages. For agda/lagda, `AgdaHoverProvider` (same file) covers the same source alongside type info.

The `AbbreviationProvider` and status bar item are created once in `extension.ts` and shared across the editor rewriter, both hover providers, and the InputBox.

### InputBox abbreviation support

When Agda commands prompt the user for input (e.g. `agda.give` with an empty goal, `agda.searchAbout`), the extension uses `showUnicodeInputBox` (`src/editor/unicodeInputBox.ts`) instead of plain `vscode.window.showInputBox`. This wraps the same `AbbreviationRewriter` engine so users can type abbreviations like `\to` → `→` inside the input box. Tab/Shift+Tab cycling is supported via dedicated keybindings gated on the `agda.inputBox.isActive` context variable.

The InputBox and editor rewriter both need to format the status bar identically (showing the current abbreviation and cycle list). This logic is shared via the `updateAbbreviationStatusBar` free function exported from `VSCodeAbbreviationRewriter.ts`. Both consumers also use the same operation-queue pattern (enqueue/drain/flush) to serialize async engine calls, though the implementations differ enough (4 op kinds vs 2 because of the limited callback API of `InputBox`) that the queue itself is not shared.

### Re-entrant edit events and the `isApplyingEdit` guard

When `workspace.applyEdit()` modifies the document, VS Code fires `onDidChangeTextDocument` **re-entrantly** -- during the `await`, before the promise resolves. Without a guard, this re-entrant event feeds our own edit into `changeInput` → `processChange`, which kills tracked abbreviations before `enterReplacedState` / `updateRangeAfterCycleEdit` can run.

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

Both styles share the same `universalArgCount`, `resetSequence()`, timeout (2 seconds), and Escape cancel. The states are kept separate (`leader-m-x` vs `cc-x`, `leader-m-u` vs `cc-u`) so the two styles don't bleed into each other -- each style uses its own key modifiers (plain keys for Evil, `ctrl+key` for Ctrl+C) in sub-states.

## Version handling

`AgdaVersion` (`src/agda/version.ts`) is an opaque branded type -- like `AgdaOffset`, it prevents accidental misuse by making it non-assignable to/from `number[]`. Well-known constants `V2_7` and `V2_8` are used throughout the codebase for version-gated behavior:

- **Command builders** (`commands.ts`): `cmdAutoOne`/`cmdAutoAll` take different arguments for Agda < 2.7 vs >= 2.7. `cmdLoadNoMetas` (>= 2.8) takes the filepath in the inner command; `cmdNoMetas` (< 2.8) does not. `cmdBackendTop`/`cmdBackendHole` are >= 2.8 only.
- **Location parsing** (`agdaLocation.ts`): Agda < 2.8 uses comma-separated positions (`file:10,5-15`); >= 2.8 uses dots (`file:10.5-15`).
- **Process startup** (`process.ts`): Runs `agda --version` before spawning, validates >= 2.6.1.

## Agda binary management

The extension can discover and manage Agda installations (`src/agda/installations.ts`), exposed through two commands:

- **Download Agda** (`agda.downloadAgda`): Downloads pre-built Agda binaries from a hardcoded table of known GitHub release URLs for the current platform (linux/x64, macOS-arm64/x64, win64). Archives are cached in `globalStorage/archives/` and extracted to `globalStorage/bin/{tag}/`. Handles two archive layouts: v2.8.0+ (bare `agda` at root) and v2.7.0.1 (`Agda-*/bin/agda`). On macOS, removes the quarantine extended attribute.
- **Switch Agda** (`agda.switchAgda`): Shows a QuickPick listing Agda installations from four sources (discovered in parallel) and updates the `agda.path` configuration:
  1. **Extension-managed** downloads in `globalStorage/bin/`
  2. **User-configured** `agda.additionalPaths` -- broken entries are shown with a warning icon and reason
  3. **System PATH** -- scans `$PATH` directories
  4. **Well-known locations** -- `~/.cabal/bin`, `~/.local/bin`, `~/.ghcup/bin`, `~/.nix-profile/bin`, Nix system profile, plus Homebrew paths on macOS and `%APPDATA%\cabal\bin` on Windows

All discovery functions return normalized paths (symlinks resolved) to ensure correct deduplication across sources. The shared `probeAgda()` helper checks executability and runs `agda --version` to detect the version, returning a structured `ProbeResult` (success with version, or failure with reason).

`AgdaProcess` auto-detects `Agda_datadir` for v2.7.0.1 bundled installs so the data directory is found correctly when using a downloaded binary.

## Location parsing

Agda error messages contain source locations like `file:10,5-15` or `file:10,5-12,3`. The `agdaLocation.ts` module parses these into structured `LinkedText` -- an array of plain-text and location segments. This enables clickable file locations in the Info Panel.

Column numbers require conversion because Agda reports code-point offsets while VS Code uses UTF-16. The parser reads the referenced file's text to perform this conversion accurately. Goal-relative ranges (no filepath) are left as plain text since they refer to the current document's already-known goal ranges.

## Offsets and positions

Agda uses 1-based absolute code-point offsets for all positions. Two layers handle conversion:

1. **`offsets.ts`** -- pure functions with zero VS Code dependencies. `AgdaOffset` is a branded opaque type that prevents passing raw numbers to `document.positionAt()`. Handles supplementary-plane characters (U+10000+), where each code point maps to two UTF-16 code units.

2. **`position.ts`** -- thin wrappers that accept a `TextDocument` and delegate to `offsets.ts`. Functions take an optional `text?: string` parameter to avoid repeated `document.getText()` calls in loops.

## Configuration

`src/util/config.ts` provides typed helpers for reading `agda.*` settings: `getAgdaPath()`, `getExtraArgs()`, `getBackend()`, `getAdditionalPaths()`, `getGoalLabels()`, `getInputEnabled()`, `getInputLeader()`, `getInputLanguages()`, `getCustomTranslations()`. The generic `agdaConfig()` helper wraps `vscode.workspace.getConfiguration("agda")`.

Available settings: `agda.path` (binary), `agda.additionalPaths` (for Switch Agda), `agda.extraArgs`, `agda.backend` (GHC/JS/LaTeX/HTML), `agda.goalLabels` (show `?N` decorations), plus `agda.input.*` settings for the abbreviation engine.

## TextMate grammar

`syntaxes/agda.tmLanguage.json` provides a minimal TextMate grammar that scopes comments, block comments, and string literals. Its only purpose is to tell VS Code's bracket matcher to skip brackets inside these regions -- without it, parentheses in `-- comment (with parens)` would be bracket-matched. All actual syntax coloring comes from Agda's semantic tokens.

The line comment rule uses a negative lookbehind to avoid matching `--` inside identifiers: `(?<![^\s(){}";@.])--.*$`. This is a double-negative ("not preceded by a non-delimiter") derived from Agda's lexer, where the delimiter characters that cannot appear in identifiers are whitespace, `(){}`, `"`, `;`, `@`, and `.`. Since Agda allows almost any Unicode character in identifiers (the `alexGetByte` function in the compiler maps non-ASCII printable characters to identifier-compatible bytes), enumerating delimiters is simpler than enumerating identifier characters.

## Build and test

Begin by running `npm install`.

The extension is bundled with **esbuild** (`esbuild.js`): `src/extension.ts` → `dist/extension.js` as CommonJS (required by VS Code), with `vscode` as an external. `--watch` mode is available for development.

Tests use **vitest** (`vitest.config.mts`) with a mock VS Code API (`test/__mocks__/vscode.ts`). Run with `npx vitest run` (361 tests across 18 files). Tests cover offsets, positions, edit adjustment, goals, highlighting, def tree construction, name matching, outline symbol derivation, cursor positioning, info panel rendering, abbreviation engine, InputBox abbreviation support, version comparison, and location parsing.

`scripts/generate-abbreviations.py` regenerates `src/unicode/abbreviations.json` from Agda's Emacs input method by driving Emacs in batch mode to dump the `agda-input` translation table.
