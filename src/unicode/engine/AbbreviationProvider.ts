// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/AbbreviationProvider.ts)
// Modified for Agda

import { AbbreviationConfig, SymbolsByAbbreviation } from "./AbbreviationConfig";
import abbreviations from "../abbreviations.json";

export type ExpansionKind = "default" | "alternate";

/**
 * Answers queries to a database of abbreviations.
 *
 * Each abbreviation maps to a list of symbols (string[]).  Single-element
 * lists are ordinary abbreviations; multi-element lists support Tab-cycling.
 */
export class AbbreviationProvider {
  private symbolsByAbbreviation: SymbolsByAbbreviation = {};

  /**
   * Remembers the last-selected cycle index for each abbreviation key.
   * Session-only (not persisted), matching Emacs agda2-mode behavior
   * where `forget-last-selection` is nil.
   */
  private readonly lastSelectedIndex = new Map<string, number>();

  constructor(readonly config: AbbreviationConfig) {
    this.symbolsByAbbreviation = {
      ...(abbreviations as SymbolsByAbbreviation),
      ...config.customTranslations,
    };
  }

  /**
   * Get the remembered cycle index for an abbreviation, or 0 if none.
   */
  getLastSelectedIndex(abbrev: string): number {
    return this.lastSelectedIndex.get(abbrev) ?? 0;
  }

  /**
   * Remember the cycle index the user finalized with for an abbreviation.
   */
  setLastSelectedIndex(abbrev: string, index: number): void {
    this.lastSelectedIndex.set(abbrev, index);
  }

  /**
   * Exact lookup: returns the full cycle list for an abbreviation,
   * or undefined if it's not a known abbreviation.
   */
  getSymbolsForAbbreviation(abbrev: string): string[] | undefined {
    return this.symbolsByAbbreviation[abbrev];
  }

  /**
   * Returns true if any known abbreviation starts with the given prefix.
   * Used to decide whether a typed character extends the abbreviation
   * or finishes it.
   */
  hasAbbreviationsWithPrefix(prefix: string): boolean {
    for (const abbrev of Object.keys(this.symbolsByAbbreviation)) {
      if (abbrev.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reverse lookup: given a symbol, returns all abbreviation strings
   * whose cycle list contains that symbol and whether it is the first element
   * of the list (i.e. whether it is the default expansion or a cycle option).
   */
  collectAllAbbreviations(symbol: string): [string, ExpansionKind][] {
    const result: [string, ExpansionKind][] = [];
    for (const [a, syms] of Object.entries(this.symbolsByAbbreviation)) {
      const index = syms.indexOf(symbol);
      if (index !== -1) {
        result.push([a, index === 0 ? "default" : "alternate"]);
      }
    }
    return result;
  }

  /**
   * Returns the full abbreviation table.
   */
  getSymbolsByAbbreviation(): SymbolsByAbbreviation {
    return this.symbolsByAbbreviation;
  }
}
