// Semantic token computation: pure functions over highlighting entries.
//
// The DocumentSemanticTokensProvider maps Agda highlighting atoms to standard
// VS Code semantic token types so the user's color theme controls foreground
// colors. This file holds the mapping tables plus the derivation functions.

import * as vscode from "vscode";
import type { StoredEntry } from "../core/sessionState.js";

// --- Token legend ---

const TOKEN_TYPES = [
  "comment", // 0
  "keyword", // 1
  "string", // 2
  "number", // 3
  "type", // 4
  "function", // 5
  "variable", // 6
  "parameter", // 7
  "property", // 8
  "enumMember", // 9
  "namespace", // 10
  "struct", // 11
  "operator", // 12
  "macro", // 13
] as const;

const TOKEN_MODIFIERS = [
  "declaration", // 0
  "readonly", // 1
] as const;

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
  [...TOKEN_TYPES],
  [...TOKEN_MODIFIERS],
);

/** Token type indices that represent identifiers (renameable). */
export const RENAMEABLE_TYPE_INDICES: ReadonlySet<number> = new Set(
  (
    [
      "type",
      "function",
      "variable",
      "parameter",
      "property",
      "enumMember",
      "namespace",
      "struct",
      "macro",
    ] as const
  ).map((t) => TOKEN_TYPES.indexOf(t)),
);

/** Map from Agda atom names to semantic token types. */
const ATOM_TO_TOKEN_TYPE: Partial<Record<string, (typeof TOKEN_TYPES)[number]>> = {
  keyword: "keyword",
  comment: "comment",
  string: "string",
  number: "number",
  symbol: "operator",
  primitivetype: "type",
  bound: "variable",
  generalizable: "variable",
  inductiveconstructor: "enumMember",
  coinductiveconstructor: "enumMember",
  datatype: "type",
  field: "property",
  function: "function",
  module: "namespace",
  postulate: "function",
  primitive: "type",
  record: "struct",
  argument: "parameter",
  macro: "macro",
  operator: "operator",
  markup: "comment",
};

// --- Derivation ---

export interface SemanticToken {
  line: number;
  startChar: number;
  length: number;
  typeIdx: number;
}

function getTokenTypeIndex(atoms: string[]): number {
  for (const atom of atoms) {
    const tokenType = ATOM_TO_TOKEN_TYPE[atom];
    if (tokenType !== undefined) {
      const idx = TOKEN_TYPES.indexOf(tokenType);
      if (idx >= 0) return idx;
    }
  }
  return -1;
}

/**
 * Generate semantic tokens from stored entries, splitting multi-line ranges.
 */
function generateSemanticTokens(
  entries: readonly StoredEntry[],
  lineLength: (line: number) => number,
): SemanticToken[] {
  const tokens: SemanticToken[] = [];

  for (const entry of entries) {
    const typeIdx = getTokenTypeIndex(entry.atoms);
    if (typeIdx < 0) continue;

    const { start, end } = entry.range;
    if (start.line === end.line) {
      const length = end.character - start.character;
      if (length > 0) {
        tokens.push({ line: start.line, startChar: start.character, length, typeIdx });
      }
    } else {
      const firstLineLen = lineLength(start.line) - start.character;
      if (firstLineLen > 0) {
        tokens.push({
          line: start.line,
          startChar: start.character,
          length: firstLineLen,
          typeIdx,
        });
      }
      for (let line = start.line + 1; line < end.line; line++) {
        const len = lineLength(line);
        if (len > 0) {
          tokens.push({ line, startChar: 0, length: len, typeIdx });
        }
      }
      if (end.character > 0) {
        tokens.push({ line: end.line, startChar: 0, length: end.character, typeIdx });
      }
    }
  }

  return tokens;
}

/**
 * Sort by position and remove overlapping tokens (first-wins precedence,
 * matching Emacs's annotation-merge-faces). The sort is stable, so tokens
 * from earlier entries win for equal positions.
 */
export function resolveSemanticTokens(
  entries: readonly StoredEntry[],
  lineLength: (line: number) => number,
): SemanticToken[] {
  const tokens = generateSemanticTokens(entries, lineLength);
  tokens.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.startChar - b.startChar));

  const result: SemanticToken[] = [];
  let prevLine = -1;
  let prevEnd = -1;

  for (const t of tokens) {
    if (t.line === prevLine && t.startChar < prevEnd) continue;
    result.push(t);
    prevLine = t.line;
    prevEnd = t.startChar + t.length;
  }

  return result;
}
