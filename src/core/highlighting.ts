// Unified Agda highlighting manager.
//
// Stores highlighting entries from Agda (each with a range, atoms, and optional
// definition site) and derives two outputs from them:
//
// 1. Decorations (backgrounds, underlines, font styles) -- pushed to VS Code
//    via setDecorations. These cover visual properties that semantic tokens
//    cannot express.
//
// 2. Semantic tokens (foreground text color) -- pulled by VS Code via the
//    DocumentSemanticTokensProvider API. The user's color theme controls the
//    actual colors based on token types like "function", "variable", "type".
//
// A single entry with atoms ["function", "unsolvedmeta"] produces a "function"
// semantic token (theme-controlled text color) AND an "unsolvedmeta" decoration
// (yellow background).

import * as vscode from "vscode";
import type { DefinitionSite, HighlightingPayload } from "../agda/responses.js";
import { processChanges, adjustRange, expandRange } from "../util/editAdjust.js";
import { agdaHighlightRangeToVscode } from "../util/position.js";

// --- Stored entry ---

export interface StoredEntry {
  range: vscode.Range;
  atoms: string[];
  definitionSite: DefinitionSite | null;
}

// --- Semantic token constants ---

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

// --- Decoration styles (backgrounds, underlines, font styles -- no foreground colors) ---

const DECORATION_STYLES: Record<string, vscode.DecorationRenderOptions> = {
  // "hole" is intentionally omitted -- GoalManager owns hole styling so it
  // persists through edits inside the goal.

  unsolvedmeta: {
    backgroundColor: new vscode.ThemeColor("agda.unsolvedMeta.background"),
  },
  unsolvedconstraint: {
    backgroundColor: new vscode.ThemeColor("agda.unsolvedConstraint.background"),
  },
  terminationproblem: {
    backgroundColor: new vscode.ThemeColor("agda.terminationProblem.background"),
  },
  positivityproblem: {
    backgroundColor: new vscode.ThemeColor("agda.positivityProblem.background"),
  },
  coverageproblem: {
    backgroundColor: new vscode.ThemeColor("agda.coverageProblem.background"),
  },
  confluenceproblem: {
    backgroundColor: new vscode.ThemeColor("agda.confluenceProblem.background"),
  },
  incompletepattern: {
    backgroundColor: new vscode.ThemeColor("agda.incompletePattern.background"),
  },
  typechecks: {
    backgroundColor: new vscode.ThemeColor("agda.typeChecks.background"),
  },
  shadowingintelescope: {
    backgroundColor: new vscode.ThemeColor("agda.shadowingInTelescope.background"),
  },
  catchallclause: {
    backgroundColor: new vscode.ThemeColor("agda.catchallClause.background"),
  },
  instanceproblem: {
    backgroundColor: new vscode.ThemeColor("agda.instanceProblem.background"),
  },
  cosmeticproblem: {
    backgroundColor: new vscode.ThemeColor("agda.cosmeticProblem.background"),
  },
  missingdefinition: {
    backgroundColor: new vscode.ThemeColor("agda.missingDefinition.background"),
  },
  error: {
    color: new vscode.ThemeColor("agda.error.foreground"),
    textDecoration: "underline",
  },
  errorwarning: {
    backgroundColor: new vscode.ThemeColor("agda.errorWarning.background"),
    textDecoration: "underline",
  },
  dottedpattern: {
    fontStyle: "italic",
  },
  deadcode: {
    opacity: "0.5",
  },
};

// --- Semantic token helpers ---

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

// --- Helpers ---

/**
 * Check if an edit range matches a pending expansion. If so, remove it
 * from the pending list and return true.
 */
function consumeMatchingExpansion(pending: vscode.Range[], editRange: vscode.Range): boolean {
  for (let i = 0; i < pending.length; i++) {
    if (pending[i].isEqual(editRange)) {
      pending.splice(i, 1);
      return true;
    }
  }
  return false;
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
 * Group entries by decoration atom. Returns a map from atom name to the
 * ranges that should receive that decoration.
 */
function groupDecorationRanges(
  entries: readonly StoredEntry[],
  knownAtoms: ReadonlySet<string>,
): Map<string, vscode.Range[]> {
  const groups = new Map<string, vscode.Range[]>();
  for (const entry of entries) {
    for (const atom of entry.atoms) {
      if (!knownAtoms.has(atom)) continue;
      let ranges = groups.get(atom);
      if (!ranges) {
        ranges = [];
        groups.set(atom, ranges);
      }
      ranges.push(entry.range);
    }
  }
  return groups;
}

/**
 * The core logic of adjustForEdits: for each change, either expand intersecting entry ranges (if
 * there is a pending expansion) or remove entries with intersecting ranges (for all other edits).
 *
 * Mutates `entries` and `pendingExpansions`.
 */
function adjustEntries(
  entries: StoredEntry[],
  pendingExpansions: vscode.Range[],
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): void {
  for (const edit of processChanges(changes)) {
    const isExpansion =
      pendingExpansions.length > 0
        ? consumeMatchingExpansion(pendingExpansions, edit.editRange)
        : false;

    for (let i = entries.length - 1; i >= 0; i--) {
      if (isExpansion) {
        const expanded = expandRange(entries[i].range, edit);
        if (expanded !== entries[i].range) {
          entries[i] = { ...entries[i], range: expanded };
        }
      } else {
        const adjusted = adjustRange(entries[i].range, edit);
        if (adjusted) {
          entries[i] = { ...entries[i], range: adjusted };
        } else {
          entries.splice(i, 1);
        }
      }
    }
  }
}

// --- Manager ---

export class HighlightingManager
  implements vscode.DocumentSemanticTokensProvider, vscode.Disposable
{
  /** Decoration types shared across files (atom → type). */
  private decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

  /** Highlighting entries per file. */
  private entriesByUri = new Map<string, StoredEntry[]>();

  /**
   * Ranges that are about to be expanded (? → {!  !}).
   * When adjustForEdits sees a content change whose range matches one of
   * these, it grows intersecting highlighting ranges instead of removing them.
   * Entries are consumed on match.
   */
  private pendingExpansions = new Map<string, vscode.Range[]>();

  private readonly _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

  constructor() {
    for (const [atom, style] of Object.entries(DECORATION_STYLES)) {
      this.decorationTypes.set(atom, vscode.window.createTextEditorDecorationType(style));
    }
  }

  // ---------------------------------------------------------------------------
  // Applying highlighting from Agda
  // ---------------------------------------------------------------------------

  /**
   * Apply highlighting from an Agda HighlightingPayload.
   * Stores entries, applies decorations to the editor, and signals a semantic
   * token change so VS Code re-requests foreground colors.
   */
  applyHighlighting(
    editor: vscode.TextEditor,
    payload: HighlightingPayload,
    errorOverrideRange?: vscode.Range,
  ): void {
    if (payload.remove) {
      this.clearTokenBased(editor);
    }

    const uri = editor.document.uri.toString();
    let entries = this.entriesByUri.get(uri);
    if (!entries) {
      entries = [];
      this.entriesByUri.set(uri, entries);
    }

    const text = editor.document.getText();
    for (const entry of payload.payload) {
      const useOverride = errorOverrideRange && entry.atoms.includes("error");
      const range = useOverride
        ? errorOverrideRange
        : agdaHighlightRangeToVscode(editor.document, entry.range, text);
      entries.push({
        range,
        atoms: entry.atoms,
        definitionSite: entry.definitionSite,
      });
    }

    this.applyDecorations(editor);
    this._onDidChangeSemanticTokens.fire();
  }

  // ---------------------------------------------------------------------------
  // Decorations (push-based)
  // ---------------------------------------------------------------------------

  /** Compute and apply decorations from stored entries. */
  private applyDecorations(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    const entries = this.entriesByUri.get(uri) ?? [];
    const knownAtoms = new Set(this.decorationTypes.keys());
    const groups = groupDecorationRanges(entries, knownAtoms);

    // Apply -- set empty ranges for unused types to clear stale decorations
    for (const [atom, decorationType] of this.decorationTypes) {
      editor.setDecorations(decorationType, groups.get(atom) ?? []);
    }
  }

  /** Reapply decorations to an editor (e.g. after editor switch). */
  reapply(editor: vscode.TextEditor): void {
    this.applyDecorations(editor);
  }

  /** Reapply decorations to all visible editors showing a given URI. */
  private reapplyToVisibleEditors(uri: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        this.applyDecorations(editor);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Semantic tokens (pull-based -- VS Code calls this)
  // ---------------------------------------------------------------------------

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const entries = this.entriesByUri.get(document.uri.toString());
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

    if (entries) {
      const tokens = generateSemanticTokens(entries, (line) => document.lineAt(line).text.length);

      // Sort by position (required by the builder). The sort is stable, so
      // tokens from earlier entries come first for equal positions. We skip
      // tokens that overlap with the previously emitted token, giving
      // first-wins precedence (matching Emacs's annotation-merge-faces).
      tokens.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.startChar - b.startChar));
      let prevLine = -1;
      let prevEnd = -1;
      for (const t of tokens) {
        if (t.line === prevLine && t.startChar < prevEnd) continue;
        builder.push(t.line, t.startChar, t.length, t.typeIdx, 0);
        prevLine = t.line;
        prevEnd = t.startChar + t.length;
      }
    }

    return builder.build();
  }

  // ---------------------------------------------------------------------------
  // Go-to-definition
  // ---------------------------------------------------------------------------

  /** Look up the definition site at a position. */
  getDefinitionSite(uri: string, position: vscode.Position): DefinitionSite | undefined {
    const entries = this.entriesByUri.get(uri);
    if (!entries) return undefined;
    for (const entry of entries) {
      if (entry.definitionSite && entry.range.contains(position)) {
        return entry.definitionSite;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Clearing
  // ---------------------------------------------------------------------------

  /** Clear all highlighting for a file (with editor, also clears decorations). */
  clearAll(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    this.entriesByUri.delete(uri);
    for (const decorationType of this.decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
    this._onDidChangeSemanticTokens.fire();
  }

  /** Clear stored entries for a URI (no editor needed). */
  clear(uri: string): void {
    this.entriesByUri.delete(uri);
  }

  /**
   * Clear token-based highlighting only.
   * For now this clears everything -- a more precise implementation would
   * track which entries came from token-based vs non-token-based sources.
   */
  clearTokenBased(editor: vscode.TextEditor): void {
    this.clearAll(editor);
  }

  // ---------------------------------------------------------------------------
  // Edit adjustment
  // ---------------------------------------------------------------------------

  /**
   * Register ranges that are about to be expanded (? → {!  !}).
   * Call this before the applyEdit that performs the expansion.
   * When adjustForEdits later sees a matching content change, it grows
   * intersecting highlighting ranges instead of removing them.
   */
  registerPendingExpansions(uri: string, ranges: vscode.Range[]): void {
    if (ranges.length === 0) return;
    const existing = this.pendingExpansions.get(uri);
    if (existing) {
      existing.push(...ranges);
    } else {
      this.pendingExpansions.set(uri, [...ranges]);
    }
  }

  /**
   * Adjust stored entries after document edits: shift ranges to account for
   * inserted/deleted text.
   *
   * For changes that match a pending expansion (registered via
   * registerPendingExpansions), intersecting ranges are grown rather than
   * removed. All other changes remove intersecting ranges.
   */
  adjustForEdits(uri: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const entries = this.entriesByUri.get(uri);
    if (!entries) return;

    const pending = this.pendingExpansions.get(uri) ?? [];
    adjustEntries(entries, pending, changes);

    // Clean up empty pending sets
    if (pending.length === 0) {
      this.pendingExpansions.delete(uri);
    }

    this._onDidChangeSemanticTokens.fire();
    // Decorations are push-based -- re-apply to keep them in sync with the
    // adjusted entries. (Semantic tokens are re-pulled by VS Code automatically
    // after the event above.)
    this.reapplyToVisibleEditors(uri);
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this._onDidChangeSemanticTokens.dispose();
    this.entriesByUri.clear();
  }
}
