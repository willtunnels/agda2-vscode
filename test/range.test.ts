import { describe, it, expect } from "vitest";
import { Range } from "../src/unicode/engine/Range";

describe("Range", () => {
  it("computes endInclusive correctly", () => {
    const r = new Range(5, 3);
    expect(r.endInclusive).toBe(7);
  });

  it("containsRange", () => {
    const outer = new Range(1, 5); // 1..5
    expect(outer.containsRange(new Range(1, 5))).toBe(true);
    expect(outer.containsRange(new Range(2, 2))).toBe(true);
    expect(outer.containsRange(new Range(0, 1))).toBe(false);
    expect(outer.containsRange(new Range(5, 2))).toBe(false);
  });

  it("move shifts start", () => {
    const r = new Range(3, 2);
    const moved = r.move(5);
    expect(moved.start).toBe(8);
    expect(moved.length).toBe(2);
  });

  it("moveEnd adjusts length", () => {
    const r = new Range(1, 3);
    const extended = r.moveEnd(2);
    expect(extended.start).toBe(1);
    expect(extended.length).toBe(5);
  });

  it("moveStart shifts start but keeps end", () => {
    const r = new Range(2, 5); // 2..6
    const moved = r.moveStart(2);
    expect(moved.start).toBe(4);
    expect(moved.length).toBe(3);
    expect(moved.endInclusive).toBe(6);
  });

  it("moveStart throws if delta > length", () => {
    const r = new Range(2, 3);
    expect(() => r.moveStart(4)).toThrow();
  });

  it("isBefore and isAfter", () => {
    const a = new Range(0, 2); // 0..1
    const b = new Range(3, 2); // 3..4

    expect(a.isBefore(b)).toBe(true);
    expect(b.isBefore(a)).toBe(false);
    expect(b.isAfter(a)).toBe(true);
    expect(a.isAfter(b)).toBe(false);
  });

  it("equals", () => {
    expect(new Range(1, 3).equals(new Range(1, 3))).toBe(true);
    expect(new Range(1, 3).equals(new Range(1, 4))).toBe(false);
    expect(new Range(1, 3).equals(new Range(2, 3))).toBe(false);
  });

  it("withLength", () => {
    const r = new Range(5, 3).withLength(10);
    expect(r.start).toBe(5);
    expect(r.length).toBe(10);
  });

  it("throws on negative length", () => {
    expect(() => new Range(0, -1)).toThrow();
  });
});
