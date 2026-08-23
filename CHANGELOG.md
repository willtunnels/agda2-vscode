# Change Log

## [v1.2.3](https://github.com/willtunnels/agda2-vscode/tree/v1.2.3) (2026-08-23)

- Fix Unicode input for abbreviations reached through a shorter complete abbreviation (e.g. `\times` through `\t`)
- Fix cursor position in input boxes when a batched extend + finalize replacement shortened text before the cursor
- Stop tracking an abbreviation when an edit inside it makes it unable to ever match (previously it stayed underlined forever)
- Fix backspace on symbols made of several code points (e.g. with combining marks)
- Pasting multiple characters right after a replaced symbol now extends the abbreviation, matching typed characters
- Fix a pending extension being lost (leaving e.g. `→p` in the document) when the cursor jumped away before the replacement was applied
- Fix stale abbreviation positions in multi-cursor sessions when one abbreviation was replaced while another was still being typed
- Fix fast typing occasionally garbling abbreviations (e.g. `\times` -> `⁀ms` or left as literal text)
- Fix cursor position after backspacing a symbol
- Fix abbreviations dying in the real editor on the revert step (e.g. `\times`: typing `i` after `\t` -> `◂` untracked the abbreviation and left `\ti` as literal text)

## [v1.2.2](https://github.com/willtunnels/agda2-vscode/tree/v1.2.2) (2026-04-22)

- Fix stylesheet for info panel so that text is monospace

## [v1.2.1](https://github.com/willtunnels/agda2-vscode/tree/v1.2.1) (2026-04-07)

- Fix highlight ranges on Windows (account for the fact that Agda uses Haskell text-mode IO which converts CRLF to LF)

## [v1.2.0](https://github.com/willtunnels/agda2-vscode/tree/v1.2.0) (2026-02-25)

- Add rename feature
- Fix abbreviation hover feature
- Fix Agda binary download on Windows (missing DLL)
- Improve word selection (by default VSCode splits on "-", which is valid in Agda identifiers)

## [v1.1.1](https://github.com/willtunnels/agda2-vscode/tree/v1.1.1) (2026-02-18)

- Fix highlighting for options in pragmas (e.g., "--postfix-projections")
- Adjust highlight colors to match Emacs agda2-mode more closely
- Classify "{"/"}" as "brackets" and "surroundingPairs" in our VSCode language configuration

## [v1.1.0](https://github.com/willtunnels/agda2-vscode/tree/v1.1.0) (2026-02-18)

- Add Unicode support to all input boxes (e.g., to the popup for case splitting with an empty hole)
- Ctrl+Backspace now interacts correctly with Unicode input
- Improve handling of new input events that arrive in the middle of Unicode input processsing
- Add `agda-mode` 2.8.0 abbreviations
- Fix "\\\\" abbreviation (previously filtered out during abbreviation set generation)
- Improve cursor positioning after jumping to the next/previous goal
- Update README

## [v1.0.1](https://github.com/willtunnels/agda2-vscode/tree/v1.0.1) (2026-02-16)

- Update README
