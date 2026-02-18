import { describe, it, expect } from "vitest";
import { TrackedAbbreviation } from "../src/unicode/engine/TrackedAbbreviation";
import { Range } from "../src/unicode/engine/Range";

describe("TrackedAbbreviation", () => {
  it("starts with empty abbreviation", () => {
    const ta = new TrackedAbbreviation(new Range(1, 0), "");
    expect(ta.text).toBe("");
  });

  it("returns appended when text is appended at end (caller decides validity)", () => {
    // Abbreviation range starts at offset 1 (after leader at 0), length 0
    const ta = new TrackedAbbreviation(new Range(1, 0), "");
    // Append "t" at offset 1 (end of abbreviation range)
    const result = ta.processChange(new Range(1, 0), "t");
    expect(result).toEqual({ kind: "appended", text: "t" });
    // Abbreviation text is NOT updated -- caller must call acceptAppend
    expect(ta.text).toBe("");

    // Caller decides the append is valid and accepts it
    ta.acceptAppend("t");
    expect(ta.text).toBe("t");
  });

  it("returns appended for non-matching text too (caller decides)", () => {
    // "to" is the current abbreviation; abbreviation range is (1, 2)
    const ta = new TrackedAbbreviation(new Range(1, 2), "to");
    // Append " " at offset 3 (end of abbreviation range)
    const result = ta.processChange(new Range(3, 0), " ");
    expect(result).toEqual({ kind: "appended", text: " " });
    // Abbreviation text unchanged -- caller should NOT call acceptAppend
    expect(ta.text).toBe("to");
  });

  it("moves when change happens before it", () => {
    // Abbreviation at offset 5, length 2
    const ta = new TrackedAbbreviation(new Range(5, 2), "to");
    // Insert 3 chars at offset 0
    const result = ta.processChange(new Range(0, 0), "abc");
    expect(result).toEqual({ kind: "none" });
    // Should shift by +3
    expect(ta.abbreviationRange.start).toBe(8);
  });

  it("is unaffected by changes after it", () => {
    const ta = new TrackedAbbreviation(new Range(1, 2), "to");
    // Insert at offset 10 (well after abbreviation ends at 2)
    const result = ta.processChange(new Range(10, 0), "xyz");
    expect(result).toEqual({ kind: "none" });
  });

  it("stops tracking on overlapping changes it cannot handle", () => {
    // Abbreviation at offset 3, length 2 -> range is (2, 3) (with leader)
    const ta = new TrackedAbbreviation(new Range(3, 2), "to");
    // A replacement that spans across the abbreviation boundary
    const result = ta.processChange(new Range(1, 5), "X");
    expect(result).toEqual({ kind: "stop" });
  });

  it("reports range including leader", () => {
    const ta = new TrackedAbbreviation(new Range(5, 3), "abc");
    // range = abbreviationRange.moveKeepEnd(-1)
    expect(ta.range.start).toBe(4);
    expect(ta.range.length).toBe(4);
  });
});
