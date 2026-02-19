# Change Log

## [v1.1.1](https://github.com/willtunnels/agda2-vscode/tree/v1.1.1) (2026-02-18)

- Fix highlighting for options in pragmas (e.g., "--postfix-projections")
- Adjust highlight colors to match Emacs agda2-mode more closely
- Classify "{"/"}" as "brackets" and "surroundingPairs" in our VSCode language configuration

## [v1.1.0](https://github.com/willtunnels/agda2-vscode/tree/v1.1.0) (2026-02-18)

- Added Unicode support to all input boxes (e.g., to the popup for case splitting with an empty hole)
- Ctrl+Backspace now interacts correctly with Unicode input
- Improved handling of new input events that arrive in the middle of Unicode input processsing
- Added `agda-mode` 2.8.0 abbreviations
- Fixed "\\\\" abbreviation (previously filtered out during abbreviation set generation)
- Improved cursor positioning after jumping to the next/previous goal
- Updated README

## [v1.0.1](https://github.com/willtunnels/agda2-vscode/tree/v1.0.1) (2026-02-16)

- Updated README
