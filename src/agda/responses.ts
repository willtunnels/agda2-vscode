// Agda 2.6.1+ JSON interaction protocol response types.
// Derived from Agda.Interaction.JSONTop and Agda.Interaction.Response.
// See version-specific comments throughout for backward compatibility notes.

import type { ComputeMode } from "./commands.js";
import type { AgdaOffset } from "../util/offsets.js";

// --- Primitives ---

export type InteractionPointId = number;

/** Interaction point as returned in InteractionPoints response (has id + range). */
export interface InteractionPointWithRange {
  id: number;
  range: Range;
}

export interface Position {
  pos: AgdaOffset; // 1-based absolute code-point offset
  line: number; // 1-based
  col: number; // 1-based
}

export interface Interval {
  start: Position;
  end: Position;
}

/** Array of intervals. Empty array = noRange. */
export type Range = Interval[];

// --- Status ---

export interface Status {
  showImplicitArguments: boolean;
  showIrrelevantArguments: boolean;
  checked: boolean;
}

// --- Give ---

export type GiveResult = { str: string } | { paren: true } | { paren: false };

// --- MakeCase ---

export type MakeCaseVariant = "Function" | "ExtendedLambda";

// --- Highlighting ---

export type TokenBased = "TokenBased" | "NotOnlyTokenBased";

export interface DefinitionSite {
  filepath: string;
  position: AgdaOffset;
}

export interface HighlightingEntry {
  range: [AgdaOffset, AgdaOffset]; // [from, to] 1-based code-point offsets
  atoms: string[]; // lowercased aspect names
  tokenBased: TokenBased;
  note: string;
  definitionSite: DefinitionSite | null;
}

export interface HighlightingPayload {
  remove: boolean;
  payload: HighlightingEntry[];
}

// --- Context ---

export interface ResponseContextEntry {
  originalName: string;
  reifiedName: string;
  binding: string;
  inScope: boolean;
}

// --- GoalTypeAux ---

export type GoalTypeAux =
  | { kind: "GoalOnly" }
  | { kind: "GoalAndHave"; expr: string }
  | { kind: "GoalAndElaboration"; term: string };

// --- GoalInfo (inside GoalSpecific) ---

export type GoalInfo =
  | { kind: "HelperFunction"; signature: string }
  | { kind: "NormalForm"; computeMode: ComputeMode; expr: string }
  | {
      kind: "GoalType";
      rewrite: string;
      typeAux: GoalTypeAux;
      type: string;
      entries: ResponseContextEntry[];
      boundary: string[];
      outputForms: string[];
    }
  | { kind: "CurrentGoal"; rewrite: string; type: string }
  | { kind: "InferredType"; expr: string };

// --- Name/Type pair (used by ModuleContents and SearchAbout) ---

export interface NameTypePair {
  name: string;
  term: string;
}

// --- Solution ---

export interface Solution {
  interactionPoint: InteractionPointId;
  expression: string;
}

// --- TCWarning / TCErr ---
// Wire format for Agda >= 2.6.2 (Agda <= 2.6.1 sends bare strings).
// normalizeResponse extracts .message so downstream code sees plain strings.

export interface TCWarning {
  message: string;
}

export interface TCErr {
  message: string;
}

// --- OutputConstraint (goal/constraint display) ---
// constraintObj varies by context:
//   Visible goals:   InteractionPointWithRange { id, range }
//   Invisible goals: NamedMeta { name, range }

export interface NamedMeta {
  name: string;
  range: Range;
}

export type ConstraintObj = InteractionPointWithRange | NamedMeta | string;

export interface OutputConstraintOfType {
  kind: "OfType";
  constraintObj: ConstraintObj;
  type: string;
}

export type OutputConstraint =
  | OutputConstraintOfType
  | { kind: "JustType"; constraintObj: ConstraintObj }
  | { kind: "JustSort"; constraintObj: ConstraintObj };

// --- DisplayInfo ---

export type DisplayInfo =
  | { kind: "CompilationOk"; backend?: string; warnings: string[]; errors: string[] }
  | { kind: "Constraints"; constraints: string[] }
  | {
      kind: "AllGoalsWarnings";
      visibleGoals: OutputConstraint[];
      invisibleGoals: OutputConstraint[];
      warnings: string[];
      errors: string[];
    }
  | { kind: "Time"; time: string }
  | { kind: "Error"; message: string; warnings?: string[] }
  | { kind: "IntroNotFound" }
  | { kind: "IntroConstructorUnknown"; constructors: string[] }
  | { kind: "Auto"; info: string }
  | { kind: "ModuleContents"; contents: NameTypePair[]; telescope: string[]; names: string[] }
  | { kind: "SearchAbout"; search: string; results: NameTypePair[] }
  | { kind: "WhyInScope"; message: string; thing?: string; filepath?: string }
  | { kind: "NormalForm"; computeMode?: ComputeMode; expr: string }
  | { kind: "InferredType"; expr: string }
  | { kind: "Context"; context: ResponseContextEntry[] }
  | { kind: "Version"; version: string }
  | { kind: "GoalSpecific"; interactionPoint: InteractionPointWithRange; goalInfo: GoalInfo };

// --- Top-level Response ---

export type AgdaResponse =
  | { kind: "HighlightingInfo"; direct: true; info: HighlightingPayload }
  | { kind: "HighlightingInfo"; direct: false; filepath: string }
  | { kind: "Status"; status: Status }
  | { kind: "JumpToError"; filepath: string; position: AgdaOffset }
  | { kind: "InteractionPoints"; interactionPoints: InteractionPointWithRange[] }
  | { kind: "GiveAction"; interactionPoint: InteractionPointWithRange; giveResult: GiveResult }
  | {
      kind: "MakeCase";
      interactionPoint: InteractionPointWithRange;
      variant: MakeCaseVariant;
      clauses: string[];
    }
  | { kind: "SolveAll"; solutions: Solution[] }
  | { kind: "DisplayInfo"; info: DisplayInfo }
  | { kind: "RunningInfo"; debugLevel: number; message: string }
  | { kind: "ClearRunningInfo" }
  | { kind: "ClearHighlighting"; tokenBased: TokenBased }
  | { kind: "DoneAborting" }
  | { kind: "DoneExiting" };

// ---------------------------------------------------------------------------
// Response normalization — called at the parse boundary (protocol.ts).
// ---------------------------------------------------------------------------

/**
 * Extract a display string from a warning/error/constraint item.
 * Handles bare strings (Agda <= 2.6.1) and { message: string } objects (>= 2.6.2).
 */
export function normalizeMessage(item: unknown): string {
  if (typeof item === "string") return item;
  if (
    typeof item === "object" &&
    item !== null &&
    "message" in item &&
    typeof (item as { message: unknown }).message === "string"
  ) {
    return (item as { message: string }).message;
  }
  return JSON.stringify(item, null, 2);
}

interface RawDisplayInfo {
  kind: string;
  warnings?: unknown[];
  errors?: unknown[];
  constraints?: unknown[];
  message?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * Normalize a freshly-parsed AgdaResponse in place.
 * Converts DisplayInfo warning/error/constraint arrays from unknown[] to string[],
 * and ensures the Error variant always has a top-level `message` string.
 */
export function normalizeResponse(raw: AgdaResponse): AgdaResponse {
  if (raw.kind !== "DisplayInfo") return raw;

  const info = raw.info as unknown as RawDisplayInfo;

  if (Array.isArray(info.warnings)) {
    info.warnings = info.warnings.map(normalizeMessage);
  }
  if (Array.isArray(info.errors)) {
    info.errors = info.errors.map(normalizeMessage);
  }
  if (Array.isArray(info.constraints)) {
    info.constraints = info.constraints.map(normalizeMessage);
  }

  // Error variant: Agda nests the message inside an `error` object — pull it up.
  if (info.kind === "Error" && typeof info.message !== "string") {
    if (info.error != null) {
      info.message = normalizeMessage(info.error);
    } else {
      info.message = "Unknown error";
    }
    delete info.error;
  }

  return raw;
}
