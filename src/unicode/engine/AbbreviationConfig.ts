// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/AbbreviationConfig.ts)
// Modified for Agda

/**
 * Maps abbreviation strings to their symbol lists.
 * Each abbreviation maps to one or more symbols; multi-symbol entries
 * support Tab-cycling.
 */
export interface SymbolsByAbbreviation {
  [abbrev: string]: string[];
}

export interface AbbreviationConfig {
  abbreviationCharacter: string;
  customTranslations: SymbolsByAbbreviation;
}
