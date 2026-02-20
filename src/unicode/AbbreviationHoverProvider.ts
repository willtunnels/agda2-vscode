// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationHoverProvider.ts)
// Modified for Agda

import { AbbreviationProvider, ExpansionKind } from "./engine/index";
import * as config from "../util/config";
import { Hover, HoverProvider, Position, Range, TextDocument } from "vscode";

/**
 * Adds hover behaviour for getting translations of unicode characters.
 * E.g. "Type ⊓ using \glb or \sqcap"
 */
export class AbbreviationHoverProvider implements HoverProvider {
  constructor(private readonly abbreviations: AbbreviationProvider) {}

  provideHover(document: TextDocument, pos: Position): Hover | undefined {
    const restOfLine = document.lineAt(pos.line).text.slice(pos.character);
    const codePoints = [...restOfLine].slice(0, this.abbreviations.maxSymbolCodePoints);

    // Longest match wins
    type Match = { symbol: string; abbrevs: [string, ExpansionKind][] };
    let match: Match | undefined;
    for (let n = codePoints.length; n >= 1; n--) {
      const symbol = codePoints.slice(0, n).join("");
      const abbrevs = this.abbreviations.collectAllAbbreviations(symbol);
      if (abbrevs.length > 0) {
        match = { symbol, abbrevs };
        break;
      }
    }

    if (!match) return undefined;

    const leader = config.getInputLeader();
    const parts = match.abbrevs.map(([a, kind]) => {
      const suffix = kind === "alternate" ? " (tab to cycle)" : "";
      return `\`${leader}${a}\`${suffix}`;
    });

    const hoverMarkdown = `Type \`${match.symbol}\` using ${parts.join(" or ")}`;
    const hoverRange = new Range(pos, pos.translate(0, match.symbol.length));
    return new Hover(hoverMarkdown, hoverRange);
  }
}
