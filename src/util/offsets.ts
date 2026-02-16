// Pure offset conversion between Agda code-point offsets and UTF-16 code
// unit offsets. No VSCode dependency — directly testable.
//
// Agda counts Unicode code points (one per character, regardless of how
// many bytes or UTF-16 code units the character occupies). VSCode/JavaScript
// strings use UTF-16, where supplementary-plane characters (U+10000+) take
// two code units (a surrogate pair) instead of one.
//
// For BMP-only text the two are the same, but each supplementary-plane
// character before the target offset adds +1 to the UTF-16 offset.

// ---------------------------------------------------------------------------
// Opaque branded type for Agda's 1-based code-point offsets.
//
// Not assignable to/from number at the type level, so passing an AgdaOffset
// to document.positionAt() or using it in arithmetic is a compile error.
// The only way in/out is through toAgdaOffset / fromAgdaOffset.
// ---------------------------------------------------------------------------

declare const agdaOffsetBrand: unique symbol;

/** A 1-based Agda code-point offset. Opaque — not assignable to/from number. */
export type AgdaOffset = { readonly [agdaOffsetBrand]: true };

/** Wrap a raw number as an AgdaOffset (use at JSON parsing boundaries). */
export function toAgdaOffset(n: number): AgdaOffset {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return n as any;
}

/** Unwrap an AgdaOffset to a raw number (use in conversion functions). */
export function fromAgdaOffset(o: AgdaOffset): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return o as any;
}

// ---------------------------------------------------------------------------
// Conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert a 1-based Agda code-point offset to a 0-based UTF-16 code unit
 * offset suitable for VSCode's document.positionAt().
 */
export function agdaCpOffsetToUtf16(text: string, offset: AgdaOffset): number {
  const targetCp = fromAgdaOffset(offset) - 1; // 0-based code-point count
  let cpCount = 0;
  let utf16 = 0;

  while (cpCount < targetCp && utf16 < text.length) {
    const code = text.codePointAt(utf16)!;
    utf16 += code > 0xffff ? 2 : 1;
    cpCount++;
  }

  return utf16;
}

/**
 * Convert a 0-based UTF-16 code unit offset (from VSCode) to a 1-based
 * Agda code-point offset.
 */
export function utf16OffsetToAgdaCp(text: string, utf16Offset: number): AgdaOffset {
  let cpCount = 0;
  let utf16 = 0;

  while (utf16 < utf16Offset && utf16 < text.length) {
    const code = text.codePointAt(utf16)!;
    utf16 += code > 0xffff ? 2 : 1;
    cpCount++;
  }

  return toAgdaOffset(cpCount + 1); // 1-based
}
