import { describe, it, expect } from "vitest";
import { TrackedAbbreviation } from "../src/unicode/engine/TrackedAbbreviation";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";

const provider = new AbbreviationProvider({
  zza: ["A1", "A2", "A3"],
  zzab: ["B"],
});

function make(start: number, shown: string, text: string): TrackedAbbreviation {
  return new TrackedAbbreviation(provider, "\\", start, shown, text);
}

describe("TrackedAbbreviation", () => {
  it("starts in typing mode with active status", () => {
    const ta = make(0, "\\", "");
    expect(ta.text).toBe("");
    expect(ta.kind).toBe("typing");
    expect(ta.status).toBe("active");
    expect(ta.isReplaced).toBe(false);
  });

  it("range covers the whole shown span", () => {
    const ta = make(4, "\\abc", "abc");
    expect(ta.range.start).toBe(4);
    expect(ta.range.length).toBe(4);
  });

  it("desired is leader + text while the text is an incomplete prefix", () => {
    const ta = make(0, "\\zz", "zz");
    expect(ta.desired).toBe("\\zz");
  });

  it("desired is the current cycle symbol when the text is complete", () => {
    const ta = make(0, "\\zza", "zza");
    expect(ta.desired).toBe("A1");
    ta.cycleIndex = 2;
    expect(ta.desired).toBe("A3");
  });

  it("desired is empty when deleted, regardless of symbols", () => {
    const ta = make(0, "A1", "zza");
    ta.status = "deleted";
    expect(ta.desired).toBe("");
  });

  it("cycleSymbols is derived from the provider", () => {
    const ta = make(0, "\\zza", "zza");
    expect(ta.cycleSymbols).toEqual(["A1", "A2", "A3"]);
    expect(ta.isCycleable).toBe(true);
    ta.setText("zzab");
    expect(ta.cycleSymbols).toEqual(["B"]);
    expect(ta.isCycleable).toBe(false);
  });

  it("setText re-derives the cycle index from the remembered one", () => {
    const p = new AbbreviationProvider({ zzq: ["Q1", "Q2", "Q3"] });
    p.setLastSelectedIndex("zzq", 2);
    const ta = new TrackedAbbreviation(p, "\\", 0, "\\zzq", "");
    ta.setText("zzq");
    expect(ta.cycleIndex).toBe(2);
  });

  it("setText clamps a stale remembered index to the symbol list", () => {
    const p = new AbbreviationProvider({ zzq: ["Q1", "Q2"] });
    p.setLastSelectedIndex("zzq", 5);
    const ta = new TrackedAbbreviation(p, "\\", 0, "\\zzq", "");
    ta.setText("zzq");
    expect(ta.cycleIndex).toBe(1);
  });

  it("cycle wraps in both directions and is a no-op without symbols", () => {
    const ta = make(0, "A1", "zza");
    ta.cycle(1);
    expect(ta.cycleIndex).toBe(1);
    ta.cycle(-1);
    ta.cycle(-1);
    expect(ta.cycleIndex).toBe(2); // wrapped backward

    const incomplete = make(0, "\\zz", "zz");
    incomplete.cycle(1);
    expect(incomplete.cycleIndex).toBe(0);
  });

  it("tail is the part of shown past the flushed symbol", () => {
    const ta = make(0, "A1p", "zzap");
    ta.kind = "symbol";
    ta.symbolLen = 2;
    expect(ta.tail).toBe("p");
  });
});
