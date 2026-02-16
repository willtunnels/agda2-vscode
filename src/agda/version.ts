// Opaque Agda version type with parsing and comparison.
//
// Like AgdaOffset, AgdaVersion is a branded type that is not assignable
// to/from number[]. Construction is only possible through agdaVersion()
// or parseAgdaVersion(). This prevents accidentally comparing versions
// with array operators or constructing them from arbitrary arrays.

// ---------------------------------------------------------------------------
// Opaque branded type
// ---------------------------------------------------------------------------

declare const agdaVersionBrand: unique symbol;

/** An Agda version. Opaque -- not assignable to/from number[]. */
export type AgdaVersion = { readonly [agdaVersionBrand]: true };

function wrap(parts: number[]): AgdaVersion {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parts as any;
}

function unwrap(v: AgdaVersion): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return v as any;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Build an AgdaVersion from numeric components (e.g. `agdaVersion(2, 7, 0, 1)`). */
export function agdaVersion(...parts: number[]): AgdaVersion {
  if (parts.length === 0) throw new Error("AgdaVersion requires at least one component");
  return wrap(parts);
}

/**
 * Parse the output of `agda --version` into an AgdaVersion.
 * Expected format: "Agda version 2.7.0.1" (with possible trailing text).
 */
export function parseAgdaVersion(stdout: string): AgdaVersion {
  const match = stdout.match(/Agda version (\d+(?:\.\d+)*)/);
  if (!match) {
    throw new Error(`Could not parse Agda version from: ${stdout.trim()}`);
  }
  const parts = match[1].split(".").map(Number);
  return wrap(parts);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Lexicographic greater-than-or-equal comparison.
 * Shorter arrays are padded with 0 (so 2.6.1 equals 2.6.1.0).
 */
export function versionGte(a: AgdaVersion, b: AgdaVersion): boolean {
  const pa = unwrap(a);
  const pb = unwrap(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true; // equal
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Format a version for display (e.g. "2.7.0.1"). */
export function formatVersion(v: AgdaVersion): string {
  return unwrap(v).join(".");
}

// ---------------------------------------------------------------------------
// Well-known versions
// ---------------------------------------------------------------------------

/** Minimum supported Agda version (introduction of enriched --interaction-json). */
export const MIN_AGDA_VERSION = agdaVersion(2, 6, 1);

/** Agda 2.6.2
 *  - Cmd_metas gained a Rewrite argument.
 *  - ToggleIrrelevantArgs added.
 */
export const V2_6_2 = agdaVersion(2, 6, 2);

/** Agda 2.7.0
 *  - Mimer replaced Agsy
 *  - Cmd_autoOne/Cmd_autoAll gained a Rewrite argument.
 */
export const V2_7 = agdaVersion(2, 7, 0);

/** Agda 2.8.0
 *  - Cmd_no_metas -> Cmd_load_no_metas
 *  - new Cmd_backend_top/hole
 *  - ',' -> '.' in error locations
 *  - Interval' gained a file field (3-arg Read format)
 */
export const V2_8 = agdaVersion(2, 8, 0);
