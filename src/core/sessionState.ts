// Session state for a loaded Agda file.
//
// Stores highlighting entries from Agda (each with a range, atoms, and optional
// definition site) keyed by document URI. Providers read via getEntries;
// DecorationRenderer subscribes to onDidChange and pushes setDecorations.

import * as vscode from "vscode";
import type { HighlightingPayload } from "../agda/responses.js";
import { makeDefId, type DefId } from "./defId.js";
import { processChanges, adjustRange, adjustPosition, expandRange } from "../util/editAdjust.js";
import type { AgdaOffset } from "../util/offsets.js";
import {
  agdaHighlightRangeToVscode,
  agdaOffsetToPosition,
  rangeContains,
} from "../util/position.js";

// --- Stored entry + definition site ---

/**
 * Where a symbol is defined.
 *  - sameFile: live Position, shifted on edits. `position` is always up-to-date.
 *  - crossFile: defined in another file; we have only the original Agda offset.
 *    Callers resolve to a Position by opening the target document lazily.
 *
 * `id` is a stable, opaque identifier shared across all entries that point to
 * the same definition -- use it as a key for name-info maps and comparisons.
 */
export type LiveDefinitionSite =
  | { kind: "sameFile"; filepath: string; position: vscode.Position; id: DefId }
  | { kind: "crossFile"; filepath: string; offset: AgdaOffset; id: DefId };

export interface StoredEntry {
  range: vscode.Range;
  atoms: string[];
  definitionSite: LiveDefinitionSite | null;
  /** True if this entry is the defining occurrence of the symbol (signature or clause LHS). */
  isSelfDef: boolean;
}

/**
 * Type info for a named definition. Fetched post-load via
 * Cmd_show_module_contents_toplevel and keyed by DefId so it stays linked to
 * the highlighting entry regardless of edits.
 */
export interface NameInfo {
  name: string;
  type?: string;
}

// --- Decoration styles (read by DecorationRenderer) ---

export const DECORATION_STYLES: Record<string, vscode.DecorationRenderOptions> = {
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
 * Group entries by decoration atom. Returns a map from atom name to the
 * ranges that should receive that decoration.
 */
export function groupDecorationRanges(
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
      const entry = entries[i];
      if (isExpansion) {
        const expanded = expandRange(entry.range, edit);
        const newSite =
          entry.definitionSite && entry.definitionSite.kind === "sameFile"
            ? {
                ...entry.definitionSite,
                position: adjustPosition(entry.definitionSite.position, edit),
              }
            : entry.definitionSite;
        if (expanded !== entry.range || newSite !== entry.definitionSite) {
          entries[i] = { ...entry, range: expanded, definitionSite: newSite };
        }
      } else {
        const adjusted = adjustRange(entry.range, edit);
        if (adjusted) {
          const newSite =
            entry.definitionSite && entry.definitionSite.kind === "sameFile"
              ? {
                  ...entry.definitionSite,
                  position: adjustPosition(entry.definitionSite.position, edit),
                }
              : entry.definitionSite;
          entries[i] = { ...entry, range: adjusted, definitionSite: newSite };
        } else {
          entries.splice(i, 1);
        }
      }
    }
  }
}

// --- Session state ---

export class SessionState implements vscode.Disposable {
  /** Highlighting entries per file. */
  private entriesByUri = new Map<string, StoredEntry[]>();

  /** Name/type info per file, keyed by definition identity. */
  private nameInfoByUri = new Map<string, Map<DefId, NameInfo>>();

  /**
   * Ranges that are about to be expanded (? → {!  !}).
   * When adjustForEdits sees a content change whose range matches one of
   * these, it grows intersecting highlighting ranges instead of removing them.
   * Entries are consumed on match.
   */
  private pendingExpansions = new Map<string, vscode.Range[]>();

  private readonly _onDidChange = new vscode.EventEmitter<{ uri: string }>();
  /** Fires whenever stored entries for a URI change (ingest / clear / edit). */
  readonly onDidChange = this._onDidChange.event;

  // ---------------------------------------------------------------------------
  // Applying highlighting from Agda
  // ---------------------------------------------------------------------------

  /**
   * Apply highlighting from an Agda HighlightingPayload.
   * Stores entries and signals a change so consumers (decoration renderer,
   * semantic tokens provider, etc.) can refresh.
   */
  applyHighlighting(
    document: vscode.TextDocument,
    payload: HighlightingPayload,
    errorOverrideRange?: vscode.Range,
  ): void {
    const uri = document.uri.toString();
    if (payload.remove) {
      this.clearTokenBased(uri);
    }

    let entries = this.entriesByUri.get(uri);
    if (!entries) {
      entries = [];
      this.entriesByUri.set(uri, entries);
    }

    const text = document.getText();
    const fsPath = document.uri.fsPath;
    for (const entry of payload.payload) {
      const useOverride = errorOverrideRange && entry.atoms.includes("error");
      const range = useOverride
        ? errorOverrideRange
        : agdaHighlightRangeToVscode(document, entry.range, text);

      let liveSite: LiveDefinitionSite | null = null;
      let isSelfDef = false;
      if (entry.definitionSite) {
        const { filepath, position: offset } = entry.definitionSite;
        const id = makeDefId(offset as unknown as number);
        if (filepath === fsPath) {
          const position = agdaOffsetToPosition(document, offset, text);
          liveSite = { kind: "sameFile", filepath, position, id };
          isSelfDef = range.start.isEqual(position);
        } else {
          liveSite = { kind: "crossFile", filepath, offset, id };
        }
      }

      entries.push({
        range,
        atoms: entry.atoms,
        definitionSite: liveSite,
        isSelfDef,
      });
    }

    this._onDidChange.fire({ uri });
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Read-only access to stored entries for a URI. */
  getEntries(uri: string): readonly StoredEntry[] {
    return this.entriesByUri.get(uri) ?? [];
  }

  /** Look up the definition site at a position. */
  getDefinitionSite(uri: string, position: vscode.Position): LiveDefinitionSite | undefined {
    const entries = this.entriesByUri.get(uri);
    if (!entries) return undefined;
    for (const entry of entries) {
      if (entry.definitionSite && rangeContains(entry.range, position)) {
        return entry.definitionSite;
      }
    }
    return undefined;
  }

  /** True if highlighting has been populated for this URI (since last clear). */
  hasLoaded(uri: string): boolean {
    return this.entriesByUri.has(uri);
  }

  /** Look up name/type info by definition identity. */
  getNameInfo(uri: string, id: DefId): NameInfo | undefined {
    return this.nameInfoByUri.get(uri)?.get(id);
  }

  /**
   * Replace the URI's name-info map. Invariant: every key must correspond
   * to a live self-def entry in entriesByUri (callers are expected to join
   * ModuleContents responses against the current entries before calling).
   */
  setNameInfo(uri: string, entries: Iterable<[DefId, NameInfo]>): void {
    const map = new Map<DefId, NameInfo>();
    for (const [id, info] of entries) {
      map.set(id, info);
    }
    this.nameInfoByUri.set(uri, map);
    this._onDidChange.fire({ uri });
  }

  // ---------------------------------------------------------------------------
  // Clearing
  // ---------------------------------------------------------------------------

  /** Clear all stored state for a URI. Fires onDidChange so the renderer wipes decorations. */
  clear(uri: string): void {
    const hadState = this.entriesByUri.has(uri) || this.nameInfoByUri.has(uri);
    this.entriesByUri.delete(uri);
    this.nameInfoByUri.delete(uri);
    this.pendingExpansions.delete(uri);
    if (hadState) this._onDidChange.fire({ uri });
  }

  /**
   * Clear token-based highlighting only.
   * For now this clears everything -- a more precise implementation would
   * track which entries came from token-based vs non-token-based sources.
   */
  clearTokenBased(uri: string): void {
    this.clear(uri);
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

    // Evict name-info for definitions whose self-def entries were removed.
    const nameInfo = this.nameInfoByUri.get(uri);
    if (nameInfo && nameInfo.size > 0) {
      const liveIds = new Set<DefId>();
      for (const e of entries) {
        if (e.isSelfDef && e.definitionSite?.kind === "sameFile") {
          liveIds.add(e.definitionSite.id);
        }
      }
      for (const id of nameInfo.keys()) {
        if (!liveIds.has(id)) nameInfo.delete(id);
      }
    }

    this._onDidChange.fire({ uri });
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  dispose(): void {
    this._onDidChange.dispose();
    this.entriesByUri.clear();
    this.nameInfoByUri.clear();
  }
}
