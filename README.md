<p align="center">
  <img src="./icon.png" width="128" />
</p>

Interactive development for Agda >= 2.6.1. This extension communicates directly with Agda via `--interaction-json` for a responsive feel, similar to `agda2-mode` for Emacs.

This extension can download recent versions of Agda for all major platforms, so you do not need a preexisting Agda install.

## Features

- **All Agda commands**: we support load, give, refine, auto, case split, solve, compile, etc.
- **Unicode input**: type `\` followed by an abbreviation to insert Unicode characters
- **Semantic highlighting**: foreground colors from your theme via semantic tokens; background decorations for unsolved metas, termination problems, coverage issues, etc.
- **Go-to-definition**: Ctrl+Click or F12 to jump to the definition site of any highlighted name
- **Info panel**: persistent side panel showing goal types, context, errors, and other Agda output
- **VSCodeVim integration**: interacts correctly with VSCodeVim, e.g., accounts for VSCodeVim's bespoke undo/redo mechanism when adjusting goal spans

## Keybindings

Two keybinding styles are supported.

| Style     | Prefix     | Example (load)  |
| --------- | ---------- | --------------- |
| **Emacs** | `Ctrl+C`   | `Ctrl+C Ctrl+L` |
| **Evil**  | `Leader M` | `Leader M L`    |

The **Ctrl+C** bindings work out of the box. The **Evil-style** bindings work given [VSCodeVim](https://marketplace.visualstudio.com/items?itemName=vscodevim.vim) -- see [below](#vscodevim).

### Basic commands

| Command                               | Key                   | Key (Evil-style)      |
| ------------------------------------- | --------------------- | --------------------- |
| Load file                             | `Ctrl+C Ctrl+L`       | `Leader M L`          |
| Give (fill goal)                      | `Ctrl+C Ctrl+SPC`     | `Leader M SPC`        |
| Refine                                | `Ctrl+C Ctrl+R`       | `Leader M R`          |
| Auto                                  | `Ctrl+C Ctrl+A`       | `Leader M A`          |
| Case split                            | `Ctrl+C Ctrl+C`       | `Leader M C`          |
| Goal type                             | `Ctrl+C Ctrl+T`       | `Leader M T`          |
| Goal type and context                 | `Ctrl+C Ctrl+,`       | `Leader M ,`          |
| Goal type, context, and inferred type | `Ctrl+C Ctrl+.`       | `Leader M .`          |
| Goal type, context, and checked type  | `Ctrl+C Ctrl+;`       | `Leader M ;`          |
| Context (environment)                 | `Ctrl+C Ctrl+E`       | `Leader M E`          |
| Helper function type                  | `Ctrl+C Ctrl+H`       | `Leader M H`          |
| Infer type (deduce)                   | `Ctrl+C Ctrl+D`       | `Leader M D`          |
| Compute normal form                   | `Ctrl+C Ctrl+N`       | `Leader M N`          |
| Why in scope                          | `Ctrl+C Ctrl+W`       | `Leader M W`          |
| Search about                          | `Ctrl+C Ctrl+Z`       | `Leader M Z`          |
| Module contents                       | `Ctrl+C Ctrl+O`       | `Leader M P`          |
| Show constraints                      | `Ctrl+C Ctrl+=`       | `Leader M =`          |
| Show goals/metas                      | `Ctrl+C Ctrl+?`       | `Leader M ?`          |
| Solve                                 | `Ctrl+C Ctrl+S`       | `Leader M S`          |
| Next goal (forward)                   | `Ctrl+C Ctrl+F`       | `Leader M F`          |
| Previous goal (back)                  | `Ctrl+C Ctrl+B`       | `Leader M B`          |
| Toggle info panel                     | `Ctrl+C Ctrl+I`       | `Leader M I`          |
| Download Agda binary                  | (use command palette) | (use command palette) |
| Switch active Agda binary             | (use command palette) | (use command palette) |

### Extended commands

| Command                     | Key                    | Key (Evil-style) |
| --------------------------- | ---------------------- | ---------------- |
| Restart Agda                | `Ctrl+C Ctrl+X Ctrl+R` | `Leader M X R`   |
| Abort                       | `Ctrl+C Ctrl+X Ctrl+A` | `Leader M X A`   |
| Toggle implicit arguments   | `Ctrl+C Ctrl+X Ctrl+H` | `Leader M X H`   |
| Toggle irrelevant arguments | `Ctrl+C Ctrl+X Ctrl+I` | `Leader M X I`   |
| Remove annotations          | `Ctrl+C Ctrl+X Ctrl+D` | `Leader M X D`   |
| Compile                     | (use command palette)  | `Leader M X C`   |

### Universal argument

A universal argument prefix before a command changes its behaviour. For query commands, it controls the normalisation level:

| Prefix                                           | Normalisation |
| ------------------------------------------------ | ------------- |
| `Ctrl+C` / `Leader M`                            | Simplified    |
| `Ctrl+C Ctrl+U` / `Leader M U`                   | Instantiated  |
| `Ctrl+C Ctrl+U Ctrl+U` / `Leader M U U`          | Normalised    |
| `Ctrl+C Ctrl+U Ctrl+U Ctrl+U` / `Leader M U U U` | HeadNormal    |

For action commands, it acts as a boolean flag:

| Effect                              | Key                      | Key (Evil-style) |
| ----------------------------------- | ------------------------ | ---------------- |
| Give with force                     | `Ctrl+C Ctrl+U Ctrl+SPC` | `Leader M U SPC` |
| Elaborate and give                  | `Ctrl+C Ctrl+U Ctrl+M`   | `Leader M U M`   |
| Refine with pattern-matching lambda | `Ctrl+C Ctrl+U Ctrl+R`   | `Leader M U R`   |

### Maybe-toplevel commands

These commands adapt to cursor position. In a goal, they operate on that goal. Outside a goal, they might, e.g., prompt for input or operate on all goals:

- **Infer type**: goal-level `Cmd_infer` or toplevel `Cmd_infer_toplevel`
- **Compute normal form**: goal-level `Cmd_compute` or toplevel `Cmd_compute_toplevel`
- **Auto**: goal-level `Cmd_autoOne` or `Cmd_autoAll`
- **Solve**: goal-level `Cmd_solveOne` or `Cmd_solveAll`
- **Why in scope**: goal-level `Cmd_why_in_scope` or toplevel `Cmd_why_in_scope_toplevel`
- **Module contents**: goal-level `Cmd_show_module_contents` or toplevel `Cmd_show_module_contents_toplevel`

### Other

| Key      | Action              |
| -------- | ------------------- |
| `Escape` | Cancel key sequence |

All commands are also available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`, search "Agda").

Key sequences time out after 2 seconds of inactivity.

## Tips

Here are some tips for interacting with Agda (these are also applicable to the Emacs `agda2-mode`):

- Goals relocate as you type, but this is only best-effort because rechecking the file with Agda can be expensive. If the type of a goal seems off, try reloading (`Ctrl+C Ctrl+L` / `Leader M L`).
- If you run "auto" (`Ctrl+C Ctrl+A` / `Leader M A`) and your cursor is not inside a goal, Agda will try to find a solution to every goal in the file, quickly dispatching anything trivial.

## VSCodeVim

If you have [VSCodeVim](https://marketplace.visualstudio.com/items?itemName=vscodevim.vim) installed, the Evil-style keybindings should work automatically. This extension intercepts `Space` to run `agda.keySequence.leader` and `u` to run `agda.vimUndo`, which wraps VSCodeVim's undo action in some custom logic to ensure goals are shifted correctly. In insert mode and in non-Agda files, keys fall through to VSCodeVim.

To use a different leader key (e.g., `,` instead of the default `Space`), add this to your `keybindings.json`:

```json
{
  "key": "space",
  "command": "-agda.keySequence.leader",
  "when": "editorTextFocus && vim.active && vim.mode == 'Normal' && editorLangId == agda && agda.keySequence == ''"
},
{
  "key": ",",
  "command": "agda.keySequence.leader",
  "when": "editorTextFocus && vim.active && vim.mode == 'Normal' && editorLangId == agda && agda.keySequence == ''"
}
```

## Unicode Input

Type `\` followed by an abbreviation to insert Unicode characters. The abbreviation table includes all entries from Agda's Emacs mode.

### How it works

1. When you type `\`, a solid underline appears indicating an active abbreviation
2. As you continue typing the abbreviation (e.g., `\lambda`, `\to`, `\bN`), a symbol replaces the text as soon as a complete match exists
3. You can keep typing to extend the abbreviation (`→` becomes `⊤` when you type `p` to complete `\top`) or backspace to shorten the abbreviation (`⊤` back to `→`)
4. If the abbreviation corresponds to multiple symbols, the underline changes to a dashed underline and you can press **Tab** / **Shift+Tab** to cycle through alternatives
5. The status bar shows the current symbol and all alternatives while cycling

The extension remembers the last symbol you chose for each abbreviation during the session. Next time you type the same abbreviation, it starts at your last selection (matching Emacs `agda2-mode`'s default behavior).

Type `\` followed by a space to insert a literal backslash.

### Common abbreviations

| Input  | Result | Description            |
| ------ | ------ | ---------------------- |
| `\==`  | ≡      | Propositional equality |
| `\to`  | →      | Arrow                  |
| `\all` | ∀      | Universal quantifier   |
| `\ex`  | ∃      | Existential quantifier |
| `\Gl`  | λ      | Lambda                 |
| `\Ga`  | α      | Alpha                  |
| `\Gb`  | β      | Beta                   |
| `\x`   | ×      | Times                  |
| `\u+`  | ⊎      | Union                  |
| `\bN`  | ℕ      | Natural numbers        |

### Discovering abbreviations

Hover over any Unicode character in an Agda file to see which abbreviations produce it. For example, hovering over `⊓` shows "Type ⊓ using `\glb` or `\sqcap`". Abbreviations where the symbol is not the default expansion are marked with "(tab to cycle)".

## Configuration

| Setting                         | Default    | Description                                                                                          |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `agda.path`                     | `"agda"`   | Active Agda binary                                                                                   |
| `agda.additionalPaths`          | `[]`       | Additional Agda binaries to show as "Agda: Switch Agda Version" options                              |
| `agda.extraArgs`                | `[]`       | Extra command-line arguments passed to Agda                                                          |
| `agda.backend`                  | `""`       | Default backend for compilation (`GHC`, `GHCNoMain`, `JS`, `LaTeX`, `QuickLaTeX`, `HTML`)            |
| `agda.input.enabled`            | `true`     | Enable the Unicode input method                                                                      |
| `agda.input.leader`             | `"\\"`     | The leader character that triggers Unicode input                                                     |
| `agda.input.languages`          | `["agda"]` | Languages in which Unicode input is enabled                                                          |
| `agda.input.customTranslations` | `{}`       | Custom abbreviation overrides (key: abbreviation, value: symbol or array of symbols for Tab-cycling) |
| `agda.goalLabels`               | `true`     | Show goal ID labels (`?0`, `?1`, ...) next to interaction points                                     |

## Comparison with `banacorn/agda2-mode-vscode`

This extension is not a fork of the VSCode extension for Agda by banacorn. Its implementation is spiritually closer to Emacs `agda2-mode`. At the time of writing, `banacorn/agda2-mode-vscode` has bugs in a number of cases where we do not, e.g., certain well-typed files fail to highlight and the case split command sometimes inserts ill-formed text (of course, we do not promise our extension is bug-free). Other differences include our VSCodeVim integration, our approach to unicode input, and the look-and-feel of our info panel.

We made an effort to get the small details right, like not highlighting parentheses in comments and putting your cursor in the right place after a give or an automatic case split (even Emacs `agda2-mode` will sometimes put your cursor one past the final character of the line when the line shrinks during a give; we will not).

## On the use of AI

The code in this repository was developed with the assistance of agents. Of course, AI tools are not yet sufficient to produce quality code in the absence of intervention by a knowledgeable developer. Care was taken with this project (it was not "vibe coded").

Contributors are welcome to use AI, but the contributions must be of quality and not so large as to be unreviewable.
