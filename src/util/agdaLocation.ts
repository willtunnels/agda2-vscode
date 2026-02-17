// Shared utilities for parsing and converting Agda source locations.
//
// Agda error/warning messages include source locations whose column numbers
// count Unicode code points (1 per character). VS Code counts UTF-16 code
// units (supplementary-plane characters like 𝕄 take 2). This module converts
// between the two systems.
//
// Location formats in Agda messages:
//
//     /path/to/File.agda:10,5-15     (single-line, Agda < 2.8.0)
//     /path/to/File.agda:10.5-15     (single-line, Agda >= 2.8.0)
//     /path/to/File.agda:10,5-12,3   (multi-line,  Agda < 2.8.0)
//     /path/to/File.agda:10.5-12.3   (multi-line,  Agda >= 2.8.0)
//
// Agda 2.8.0 changed the separator from comma to dot. The running Agda
// version is threaded through parsing and display functions to select the
// matching format.
//
// Agda also emits goal-relative ranges like "10,5-15" without a file path.
// These are positions within the goal expression, NOT file positions. We do
// not convert or link them (matching Emacs, which only matches absolute paths).
//
// All column numbers are 1-based Agda code-point offsets. After conversion
// they become 1-based VS Code UTF-16 column numbers (for display) or 0-based
// (for vscode.Range).

import * as vscode from "vscode";
import type { ComputeMode } from "../agda/commands.js";
import type {
  DisplayInfo,
  OutputConstraint,
  NameTypePair,
  ResponseContextEntry,
  InteractionPointWithRange,
  GoalInfo,
} from "../agda/responses.js";
import { type AgdaVersion, V2_8, versionGte } from "../agda/version.js";
import { agdaCpOffsetToUtf16, toAgdaOffset } from "./offsets.js";

// ---------------------------------------------------------------------------
// LinkedText -- text with embedded clickable file locations
// ---------------------------------------------------------------------------
//
// Represents a string that may contain file:line,col locations. Each location has been parsed and
// its columns converted from Agda code points to VS Code UTF-16. The info panel renders links from
// the structured data. displaySegment extracts plain text for non-clickable contexts.

/** A single-line location: filepath:line,col-endCol */
export type SingleLineLocation = {
  kind: "single-line-location";
  filepath: string;
  line: number;   // 1-based VS Code line
  col: number;    // 1-based VS Code UTF-16 column
  endCol: number; // 1-based VS Code UTF-16 end column
};

/** A multi-line location: filepath:line,col-endLine,endCol */
export type MultiLineLocation = {
  kind: "multi-line-location";
  filepath: string;
  line: number;    // 1-based VS Code line
  col: number;     // 1-based VS Code UTF-16 column
  endLine: number; // 1-based VS Code end line
  endCol: number;  // 1-based VS Code UTF-16 end column
};

export type ResolvedLocation = SingleLineLocation | MultiLineLocation;

export type LinkedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "unresolved-location"; filepath: string }
  | ResolvedLocation;

export type LinkedText = LinkedTextSegment[];

export function isResolvedLocation(seg: LinkedTextSegment): seg is ResolvedLocation {
  return seg.kind === "single-line-location" || seg.kind === "multi-line-location";
}

export function displayLinkedText(lt: LinkedText, version: AgdaVersion): string {
  return lt.map((seg) => displaySegment(seg, version)).join("");
}

/**
 * Display text for a single segment. Resolved locations reconstruct
 * "filepath:line,col-end" (or dot-separated for Agda >= 2.8.0).
 * Unresolved locations show "filepath:?,?-?,?".
 */
export function displaySegment(seg: LinkedTextSegment, version: AgdaVersion): string {
  const sep = versionGte(version, V2_8) ? "." : ",";
  switch (seg.kind) {
    case "text":
      return seg.text;
    case "unresolved-location":
      return `${seg.filepath}:?${sep}?-?${sep}?`;
    case "single-line-location":
      return `${seg.filepath}:${seg.line}${sep}${seg.col}-${seg.endCol}`;
    case "multi-line-location":
      return `${seg.filepath}:${seg.line}${sep}${seg.col}-${seg.endLine}${sep}${seg.endCol}`;
  }
}

/**
  * DisplayInfoVSCode -- DisplayInfo with LinkedText for location-bearing fields
  */
export type DisplayInfoVSCode =
  | { kind: "CompilationOk"; backend?: string; warnings: LinkedText[]; errors: LinkedText[] }
  | { kind: "Constraints"; constraints: string[] }
  | {
      kind: "AllGoalsWarnings";
      visibleGoals: OutputConstraint[];
      invisibleGoals: OutputConstraint[];
      warnings: LinkedText[];
      errors: LinkedText[];
    }
  | { kind: "Time"; time: string }
  | { kind: "Error"; message: LinkedText; warnings?: LinkedText[] }
  | { kind: "IntroNotFound" }
  | { kind: "IntroConstructorUnknown"; constructors: string[] }
  | { kind: "Auto"; info: string }
  | { kind: "ModuleContents"; contents: NameTypePair[]; telescope: string[]; names: string[] }
  | { kind: "SearchAbout"; search: string; results: NameTypePair[] }
  | { kind: "WhyInScope"; message: LinkedText; thing?: string; filepath?: string }
  | { kind: "NormalForm"; computeMode?: ComputeMode; expr: string }
  | { kind: "InferredType"; expr: string }
  | { kind: "Context"; context: ResponseContextEntry[] }
  | { kind: "Version"; version: string }
  | { kind: "GoalSpecific"; interactionPoint: InteractionPointWithRange; goalInfo: GoalInfo };

/** Agda file extension pattern (non-capturing). Matches .agda, .lagda, .lagda.md, etc. */
const AGDA_EXT = String.raw`\.(?:agda|lagda(?:\.(?:md|rst|tex|org))?)`;

/** Agda file path pattern (capturing group 1). */
const AGDA_PATH = String.raw`((?:\/[\w.+\-/]+)?[\w.+\-]+${AGDA_EXT})`;

/**
 * Build a location regex for the given Agda version's separator.
 * Groups: filepath, line, col, end1, end2?.
 */
function buildLocationRegex(version: AgdaVersion): RegExp {
  const sep = versionGte(version, V2_8) ? "\\." : ",";
  const range = String.raw`(\d+)${sep}(\d+)-(\d+)(?:${sep}(\d+))?`;
  return new RegExp(String.raw`${AGDA_PATH}:${range}`, "g");
}

/** A raw regex match from a location string */
interface LocationMatch {
  textStart: number;
  textEnd: number;
  filepath: string;
  line: number;             // 1-based
  col: number;              // 1-based Agda code-point
  end1: number;
  end2: number | undefined;
}

/**
 * Find all file-path locations in a string.
 * Goal-relative ranges like "1,1-4" (no file path) are ignored.
 */
function findLocationsInString(text: string, version: AgdaVersion): LocationMatch[] {
  const locations: LocationMatch[] = [];
  const locationRe = buildLocationRegex(version);
  let match: RegExpExecArray | null;
  while ((match = locationRe.exec(text)) !== null) {
    locations.push({
      textStart: match.index,
      textEnd: match.index + match[0].length,
      filepath: match[1],
      line: Number(match[2]),
      col: Number(match[3]),
      end1: Number(match[4]),
      end2: match[5] ? Number(match[5]) : undefined,
    });
  }
  return locations;
}

/** A function that returns a line's text given a 1-based Agda line number. */
type LineGetter = (agdaLine: number) => string;

function lineGetterFromDocument(doc: vscode.TextDocument): LineGetter {
  return (agdaLine: number) => {
    const line0 = agdaLine - 1;
    if (line0 < 0 || line0 >= doc.lineCount) return "";
    return doc.lineAt(line0).text;
  };
}

function convertLocation(loc: LocationMatch, getLine: LineGetter): ResolvedLocation {
  const lineText = getLine(loc.line);
  const newCol = agdaColToVscodeCol(lineText, loc.col);

  if (loc.end2 !== undefined) {
    // Multi-line: line,col-endLine,endCol
    const endLineText = getLine(loc.end1);
    const newEnd2 = agdaColToVscodeCol(endLineText, loc.end2);
    return { kind: "multi-line-location", filepath: loc.filepath, line: loc.line, col: newCol, endLine: loc.end1, endCol: newEnd2 };
  } else {
    // Single-line: line,col-endCol
    const newEnd1 = agdaColToVscodeCol(lineText, loc.end1);
    return { kind: "single-line-location", filepath: loc.filepath, line: loc.line, col: newCol, endCol: newEnd1 };
  }
}

/**
 * Convert a 1-based Agda code-point column to a 1-based VS Code UTF-16
 * column, given the text of that line.
 *
 * For BMP-only lines the result is identical. For lines containing
 * supplementary-plane characters (U+10000+), columns after such characters
 * are shifted because each one occupies 2 UTF-16 code units instead of 1.
 */
export function agdaColToVscodeCol(lineText: string, agdaCol: number): number {
  const utf16_0based = agdaCpOffsetToUtf16(lineText, toAgdaOffset(agdaCol));
  return utf16_0based + 1; // back to 1-based
}

/**
 * Assemble a LinkedText from location matches, filling in the gaps with `text`.
 */
function assembleLinkedText(
  text: string,
  locations: readonly { textStart: number; textEnd: number; seg: LinkedTextSegment }[],
): LinkedText {
  const segments: LinkedText = [];
  let cursor = 0;
  for (const loc of locations) {
    if (loc.textStart > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, loc.textStart) });
    }
    segments.push(loc.seg);
    cursor = loc.textEnd;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Parse all full-path locations in a text string and convert their Agda
 * code-point columns to VS Code UTF-16 columns. Returns a LinkedText -- an
 * array of plain-text and location-link segments.
 *
 * Goal-relative ranges like "1,1-4" are left as plain text -- they are
 * positions within the goal expression, not file positions.
 */
export async function parseLocationsInString(
  text: string,
  docCache: Map<string, vscode.TextDocument>,
  version: AgdaVersion,
): Promise<LinkedText> {
  // Helper: get or open a document, cache it
  async function getDoc(filepath: string): Promise<vscode.TextDocument | null> {
    const cached = docCache.get(filepath);
    if (cached) return cached;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filepath));
      docCache.set(filepath, doc);
      return doc;
    } catch {
      return null;
    }
  }

  const matches = findLocationsInString(text, version);

  const resolved: { textStart: number; textEnd: number; seg: LinkedTextSegment }[] = [];
  for (const loc of matches) {
    const doc = await getDoc(loc.filepath);
    if (!doc) {
      resolved.push({ textStart: loc.textStart, textEnd: loc.textEnd, seg: { kind: "unresolved-location", filepath: loc.filepath } });
      continue;
    }
    resolved.push({ textStart: loc.textStart, textEnd: loc.textEnd, seg: convertLocation(loc, lineGetterFromDocument(doc)) });
  }

  return assembleLinkedText(text, resolved);
}

/**
 * Convert a DisplayInfo from Agda code-point columns to VS Code UTF-16
 * columns. Opens referenced files as needed for column conversion.
 * String fields that may contain file locations are converted to LinkedText.
 */
export async function convertDisplayInfo(
  info: DisplayInfo,
  currentDocument: vscode.TextDocument,
  currentFilepath: string,
  version: AgdaVersion,
): Promise<DisplayInfoVSCode> {
  const docCache = new Map<string, vscode.TextDocument>();
  docCache.set(currentFilepath, currentDocument);

  const conv = (s: string) => parseLocationsInString(s, docCache, version);
  const convAll = (ss: string[]) => Promise.all(ss.map(conv));

  switch (info.kind) {
    case "AllGoalsWarnings":
      return {
        ...info,
        errors: await convAll(info.errors),
        warnings: await convAll(info.warnings),
      };
    case "Error":
      return {
        ...info,
        message: await conv(info.message),
        warnings: info.warnings ? await convAll(info.warnings) : undefined,
      };
    case "CompilationOk":
      return {
        ...info,
        errors: await convAll(info.errors),
        warnings: await convAll(info.warnings),
      };
    case "WhyInScope":
      return {
        ...info,
        message: await conv(info.message),
      };
    default:
      return info;
  }
}
