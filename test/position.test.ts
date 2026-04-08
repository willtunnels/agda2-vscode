/**
 * Unit tests for the code-point ↔ UTF-16 offset conversion.
 *
 * These test the pure conversion functions directly (no VSCode mock needed).
 */

import { describe, it, expect } from "vitest";
import {
  agdaCpOffsetToUtf16,
  utf16OffsetToAgdaCp,
  toAgdaOffset,
  fromAgdaOffset,
} from "../src/util/offsets.js";

// Helper: shorthand for creating test AgdaOffset values
const ao = toAgdaOffset;
const raw = fromAgdaOffset;

// Test strings:
//   "abc"       -- pure ASCII, all offsets equal
//   "aℕb"       -- BMP char ℕ (U+2115): 1 code point, 1 UTF-16 code unit
//   "a𝕄b"       -- supplementary char 𝕄 (U+1D544): 1 code point, 2 UTF-16 code units
//   "𝕄α"        -- supplementary then BMP: offsets diverge after 𝕄
//   "a𝕄𝕄b"      -- two supplementary chars: divergence accumulates

describe("agdaCpOffsetToUtf16", () => {
  it("ASCII: code-point and UTF-16 offsets are the same", () => {
    const text = "abcdef";
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(4))).toBe(3); // 'd'
    expect(agdaCpOffsetToUtf16(text, ao(7))).toBe(6); // past end
  });

  it("BMP Unicode: code-point and UTF-16 offsets are the same", () => {
    const text = "aℕb";
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(1); // 'ℕ'
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(2); // 'b'
  });

  it("supplementary plane char: UTF-16 offset is +1 after it", () => {
    const text = "a𝕄b";
    // 𝕄 is U+1D544 -- 1 code point, 2 UTF-16 code units (surrogate pair)
    //           cp:  1 2 3    (3 code points)
    //           u16: 0 1 3    ('a'=0, '𝕄'=1..2, 'b'=3)
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(1); // '𝕄'
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(3); // 'b' -- shifted by 1
  });

  it("two supplementary chars: offset divergence accumulates", () => {
    const text = "a𝕄𝕄b";
    //           cp:  1 2 3 4    (4 code points)
    //           u16: 0 1 3 5    ('a'=0, '𝕄'=1..2, '𝕄'=3..4, 'b'=5)
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(1); // first '𝕄'
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(3); // second '𝕄'
    expect(agdaCpOffsetToUtf16(text, ao(4))).toBe(5); // 'b' -- shifted by 2
  });

  it("supplementary then BMP: α after 𝕄", () => {
    const text = "𝕄α";
    //           cp:  1 2      (2 code points)
    //           u16: 0 2      ('𝕄'=0..1, 'α'=2)
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // '𝕄'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(2); // 'α'
  });

  it("offset past end of string", () => {
    const text = "a𝕄";
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(3); // past end
  });

  it("offset 1 always returns 0", () => {
    expect(agdaCpOffsetToUtf16("", ao(1))).toBe(0);
    expect(agdaCpOffsetToUtf16("abc", ao(1))).toBe(0);
    expect(agdaCpOffsetToUtf16("𝕄", ao(1))).toBe(0);
  });

  it("CRLF: \\r is skipped (Agda uses text-mode IO, never sees \\r)", () => {
    // Agda reads "ab\ncd" (5 code points), but VS Code text is "ab\r\ncd"
    const text = "ab\r\ncd";
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(1); // 'b'
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(2); // '\r' skipped, points to '\r\n' pair
    expect(agdaCpOffsetToUtf16(text, ao(4))).toBe(4); // 'c'
    expect(agdaCpOffsetToUtf16(text, ao(5))).toBe(5); // 'd'
  });

  it("CRLF + supplementary: offsets correct after both \\r and surrogate pairs", () => {
    // Agda sees "𝕄\nα" (3 code points), VS Code text is "𝕄\r\nα"
    const text = "𝕄\r\nα";
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // '𝕄' (2 UTF-16 units)
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(2); // '\r' skipped, '\n' at u16=3
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(4); // 'α'
  });

  it("multiple CRLF lines: drift accumulates correctly", () => {
    // Agda sees "a\nb\nc" (5 cp), VS Code text is "a\r\nb\r\nc"
    const text = "a\r\nb\r\nc";
    expect(agdaCpOffsetToUtf16(text, ao(1))).toBe(0); // 'a'
    expect(agdaCpOffsetToUtf16(text, ao(2))).toBe(1); // '\n' (but at u16=2 after \r)
    expect(agdaCpOffsetToUtf16(text, ao(3))).toBe(3); // 'b'
    expect(agdaCpOffsetToUtf16(text, ao(4))).toBe(4); // '\n' (but at u16=5 after \r)
    expect(agdaCpOffsetToUtf16(text, ao(5))).toBe(6); // 'c'
  });
});

describe("utf16OffsetToAgdaCp", () => {
  it("ASCII: offsets are the same", () => {
    const text = "abcdef";
    expect(raw(utf16OffsetToAgdaCp(text, 0))).toBe(1); // 'a' → Agda 1
    expect(raw(utf16OffsetToAgdaCp(text, 3))).toBe(4); // 'd' → Agda 4
  });

  it("BMP Unicode: offsets are the same", () => {
    const text = "aℕb";
    expect(raw(utf16OffsetToAgdaCp(text, 0))).toBe(1); // 'a'
    expect(raw(utf16OffsetToAgdaCp(text, 1))).toBe(2); // 'ℕ'
    expect(raw(utf16OffsetToAgdaCp(text, 2))).toBe(3); // 'b'
  });

  it("supplementary plane char: UTF-16 offset 3 → code-point 3", () => {
    const text = "a𝕄b";
    expect(raw(utf16OffsetToAgdaCp(text, 0))).toBe(1); // 'a'
    expect(raw(utf16OffsetToAgdaCp(text, 1))).toBe(2); // start of '𝕄'
    expect(raw(utf16OffsetToAgdaCp(text, 3))).toBe(3); // 'b'
  });

  it("two supplementary chars: divergence accumulates", () => {
    const text = "a𝕄𝕄b";
    expect(raw(utf16OffsetToAgdaCp(text, 0))).toBe(1); // 'a'
    expect(raw(utf16OffsetToAgdaCp(text, 1))).toBe(2); // first '𝕄'
    expect(raw(utf16OffsetToAgdaCp(text, 3))).toBe(3); // second '𝕄'
    expect(raw(utf16OffsetToAgdaCp(text, 5))).toBe(4); // 'b'
  });

  it("round-trip: agdaCp → utf16 → agdaCp", () => {
    const text = "data 𝕄 : ℕ → ℕ\nα = zero";
    const codePoints = [...text];
    for (let cp1 = 1; cp1 <= codePoints.length + 1; cp1++) {
      const offset = ao(cp1);
      const utf16 = agdaCpOffsetToUtf16(text, offset);
      const roundTripped = utf16OffsetToAgdaCp(text, utf16);
      expect(raw(roundTripped)).toBe(cp1);
    }
  });

  it("CRLF: \\r is skipped in reverse conversion", () => {
    const text = "ab\r\ncd";
    // utf16 offsets: a=0, b=1, \r=2, \n=3, c=4, d=5
    // Agda code points (no \r): a=1, b=2, \n=3, c=4, d=5
    expect(raw(utf16OffsetToAgdaCp(text, 0))).toBe(1); // 'a'
    expect(raw(utf16OffsetToAgdaCp(text, 1))).toBe(2); // 'b'
    expect(raw(utf16OffsetToAgdaCp(text, 4))).toBe(4); // 'c'
    expect(raw(utf16OffsetToAgdaCp(text, 5))).toBe(5); // 'd'
  });

  it("CRLF round-trip: agdaCp → utf16 → agdaCp", () => {
    const text = "data 𝕄 : ℕ → ℕ\r\nα = zero";
    // Code points as Agda sees them (no \r)
    const agdaText = text.replace(/\r/g, "");
    const codePoints = [...agdaText];
    for (let cp1 = 1; cp1 <= codePoints.length + 1; cp1++) {
      const offset = ao(cp1);
      const utf16 = agdaCpOffsetToUtf16(text, offset);
      const roundTripped = utf16OffsetToAgdaCp(text, utf16);
      expect(raw(roundTripped)).toBe(cp1);
    }
  });
});
