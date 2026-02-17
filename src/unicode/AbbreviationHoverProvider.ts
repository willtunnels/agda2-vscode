// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationHoverProvider.ts)
// Modified for Agda

import { AbbreviationProvider } from "./engine/index";
import * as config from "../util/config";
import { Hover, HoverProvider, Position, Range, TextDocument } from "vscode";

/**
 * Adds hover behaviour for getting translations of unicode characters.
 * E.g. "Type ⊓ using \glb or \sqcap"
 */
export class AbbreviationHoverProvider implements HoverProvider {
  constructor(private readonly abbreviations: AbbreviationProvider) {}

  provideHover(document: TextDocument, pos: Position): Hover | undefined {
    const symbol = document.lineAt(pos.line).text.slice(pos.character);
    const allAbbrevs = this.abbreviations.collectAllAbbreviations(symbol);

    if (allAbbrevs.length === 0) {
      return undefined;
    }

    const parts: string[] = [];
    const leader = config.getInputLeader();
    for (const [a, kind] of allAbbrevs) {
      const suffix = kind === "alternate" ? " (tab to cycle)" : "";
      parts.push(`\`${leader}${a}\`${suffix}`);
    }

    const hoverMarkdown = `Type \`${symbol}\` using ${parts.join(" or ")}`;
    const hoverRange = new Range(pos, pos.translate(0, symbol.length));
    return new Hover(hoverMarkdown, hoverRange);
  }
}
