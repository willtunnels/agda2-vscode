// Hover providers for Agda and for unicode-input-enabled languages.
//
// AgdaHoverProvider (agda/lagda) combines type information from
// SessionState.getNameInfo with unicode input abbreviations. Keeping the two
// sources in one provider means the order is deterministic (VS Code merges
// results from multiple providers without a stable order).
//
// GenericHoverProvider (other languages with unicode input enabled) shows the
// abbreviation section only.
//
// Originally adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationHoverProvider.ts):
// Copyright 2021 Microsoft Corporation and the Lean community contributors,
// SPDX-License-Identifier: Apache-2.0.

import * as vscode from "vscode";
import type { SessionState } from "../core/sessionState.js";
import type {
  AbbreviationProvider,
  ExpansionKind,
} from "../unicode/engine/AbbreviationProvider.js";
import * as config from "../util/config.js";
import { rangeContains } from "../util/position.js";

interface HoverSection {
  markdown: vscode.MarkdownString;
  range: vscode.Range;
}

function buildAbbreviationHover(
  abbreviations: AbbreviationProvider,
  document: vscode.TextDocument,
  pos: vscode.Position,
): HoverSection | undefined {
  const restOfLine = document.lineAt(pos.line).text.slice(pos.character);
  const codePoints = [...restOfLine].slice(0, abbreviations.maxSymbolCodePoints);

  // Longest match wins
  let match: { symbol: string; abbrevs: [string, ExpansionKind][] } | undefined;
  for (let n = codePoints.length; n >= 1; n--) {
    const symbol = codePoints.slice(0, n).join("");
    const abbrevs = abbreviations.collectAllAbbreviations(symbol);
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

  const markdown = new vscode.MarkdownString(
    `Type \`${match.symbol}\` using ${parts.join(" or ")}`,
  );
  const range = new vscode.Range(pos, pos.translate(0, match.symbol.length));
  return { markdown, range };
}

export class GenericHoverProvider implements vscode.HoverProvider {
  constructor(private readonly abbreviations: AbbreviationProvider) {}

  provideHover(document: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const hover = buildAbbreviationHover(this.abbreviations, document, pos);
    if (!hover) return undefined;
    return new vscode.Hover(hover.markdown, hover.range);
  }
}

export class AgdaHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly state: SessionState,
    private readonly abbreviations: AbbreviationProvider,
  ) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const sections: HoverSection[] = [];

    const typeSection = this.resolveTypeInfo(document, position);
    if (typeSection) sections.push(typeSection);

    const abbrevSection = buildAbbreviationHover(this.abbreviations, document, position);
    if (abbrevSection) sections.push(abbrevSection);

    if (sections.length === 0) return undefined;

    return new vscode.Hover(
      sections.map((s) => s.markdown),
      sections[0].range,
    );
  }

  /**
   * Type info for the entry at the cursor. Returns a "run Agda load" hint when
   * the file hasn't been loaded yet but the cursor is on a word-like token.
   */
  private resolveTypeInfo(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): HoverSection | undefined {
    const uri = document.uri.toString();

    if (!this.state.hasLoaded(uri)) {
      const wordRange = document.getWordRangeAtPosition(position);
      if (!wordRange) return undefined;
      const md = new vscode.MarkdownString(
        "*Run Agda load (Ctrl+C Ctrl+L / Leader M L) for type information.*",
      );
      return { markdown: md, range: wordRange };
    }

    for (const e of this.state.getEntries(uri)) {
      if (!rangeContains(e.range, position)) continue;
      if (!e.definitionSite || e.definitionSite.kind !== "sameFile") continue;
      const info = this.state.getNameInfo(uri, e.definitionSite.id);
      if (!info?.type) continue;

      const md = new vscode.MarkdownString();
      md.appendCodeblock(`${info.name} : ${info.type}`, "agda");
      return { markdown: md, range: e.range };
    }
    return undefined;
  }
}
