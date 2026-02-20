// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/AbbreviationProvider.ts)
// Modified for Agda

import abbreviations from "../abbreviations.json";

/**
 * Maps abbreviation strings to their symbol lists.
 * Each abbreviation maps to one or more symbols; multi-symbol entries
 * support Tab-cycling.
 */
export interface SymbolsByAbbreviation {
  [abbrev: string]: string[];
}

export type ExpansionKind = "default" | "alternate";

/**
 * Answers queries to a database of abbreviations.
 *
 * Each abbreviation maps to a list of symbols (string[]). Single-element
 * lists are ordinary abbreviations; multi-element lists support Tab-cycling.
 */
export class AbbreviationProvider {
  private symbolsByAbbreviation: SymbolsByAbbreviation = {};
  private abbreviationsBySymbol = new Map<string, [string, ExpansionKind][]>();

  /** Maximum code-point length of any symbol in the table. */
  maxSymbolCodePoints: number = 0;

  /**
   * Remember the last-selected cycle index for each abbreviation key.
   */
  private readonly lastSelectedIndex = new Map<string, number>();

  constructor(customTranslations: SymbolsByAbbreviation) {
    this.reload(customTranslations);
  }

  /**
   * Re-merge built-in abbreviations with new custom translations.
   */
  reload(customTranslations: SymbolsByAbbreviation): void {
    this.symbolsByAbbreviation = {
      ...(abbreviations as SymbolsByAbbreviation),
      ...customTranslations,
    };

    this.maxSymbolCodePoints = Object.values(this.symbolsByAbbreviation)
      .flat()
      .reduce((max, s) => Math.max(max, [...s].length), 0);

    this.abbreviationsBySymbol.clear();
    for (const [abbrev, syms] of Object.entries(this.symbolsByAbbreviation)) {
      for (let i = 0; i < syms.length; i++) {
        const kind: ExpansionKind = i === 0 ? "default" : "alternate";
        let entry = this.abbreviationsBySymbol.get(syms[i]);
        if (!entry) {
          entry = [];
          this.abbreviationsBySymbol.set(syms[i], entry);
        }
        entry.push([abbrev, kind]);
      }
    }
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
    return this.abbreviationsBySymbol.get(symbol) ?? [];
  }

  /**
   * Returns the full abbreviation table.
   */
  getSymbolsByAbbreviation(): SymbolsByAbbreviation {
    return this.symbolsByAbbreviation;
  }
}
