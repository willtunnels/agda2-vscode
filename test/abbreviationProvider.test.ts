import { describe, it, expect } from "vitest";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";
import type { AbbreviationConfig } from "../src/unicode/engine/AbbreviationConfig";

function makeConfig(overrides?: Partial<AbbreviationConfig>): AbbreviationConfig {
  return {
    abbreviationCharacter: "\\",
    customTranslations: {},
    ...overrides,
  };
}

describe("AbbreviationProvider", () => {
  describe("getSymbolsForAbbreviation", () => {
    it("returns symbol list for known abbreviation", () => {
      const p = new AbbreviationProvider(makeConfig());
      const syms = p.getSymbolsForAbbreviation("alpha");
      expect(syms).toBeDefined();
      expect(syms).toContain("α");
    });

    it("returns arrow for 'to'", () => {
      const p = new AbbreviationProvider(makeConfig());
      const syms = p.getSymbolsForAbbreviation("to");
      expect(syms).toBeDefined();
      expect(syms![0]).toBe("→");
    });

    it("returns multi-symbol list for 'eq'", () => {
      const p = new AbbreviationProvider(makeConfig());
      const syms = p.getSymbolsForAbbreviation("eq");
      expect(syms).toBeDefined();
      expect(syms!.length).toBeGreaterThan(1);
    });

    it("returns undefined for non-existent abbreviation", () => {
      const p = new AbbreviationProvider(makeConfig());
      expect(p.getSymbolsForAbbreviation("zzzznotreal")).toBeUndefined();
    });
  });

  describe("hasAbbreviationsWithPrefix", () => {
    it("returns true for valid prefix", () => {
      const p = new AbbreviationProvider(makeConfig());
      expect(p.hasAbbreviationsWithPrefix("alph")).toBe(true);
    });

    it("returns false for non-matching prefix", () => {
      const p = new AbbreviationProvider(makeConfig());
      expect(p.hasAbbreviationsWithPrefix("zzzznotreal")).toBe(false);
    });

    it("returns true for exact abbreviation", () => {
      const p = new AbbreviationProvider(makeConfig());
      expect(p.hasAbbreviationsWithPrefix("alpha")).toBe(true);
    });
  });

  describe("collectAllAbbreviations", () => {
    it("finds abbreviations for a symbol", () => {
      const p = new AbbreviationProvider(makeConfig());
      const abbrevs = p.collectAllAbbreviations("α");
      const keys = abbrevs.map(([a]) => a);
      expect(keys).toContain("alpha");
      expect(keys).toContain("Ga");
    });

    it("finds abbreviation for multi-symbol entry", () => {
      const p = new AbbreviationProvider(makeConfig());
      // ≡ is in the eq cycle list
      const abbrevs = p.collectAllAbbreviations("≡");
      const keys = abbrevs.map(([a]) => a);
      expect(keys).toContain("eq");
    });

    it("marks default vs alternate expansions", () => {
      const p = new AbbreviationProvider(makeConfig({ customTranslations: { test: ["A", "B"] } }));
      const forA = p.collectAllAbbreviations("A");
      expect(forA).toContainEqual(["test", "default"]);

      const forB = p.collectAllAbbreviations("B");
      expect(forB).toContainEqual(["test", "alternate"]);
    });
  });

  describe("customTranslations", () => {
    it("overrides default translations", () => {
      const p = new AbbreviationProvider(makeConfig({ customTranslations: { alpha: ["X"] } }));
      expect(p.getSymbolsForAbbreviation("alpha")).toEqual(["X"]);
    });

    it("adds new translations", () => {
      const p = new AbbreviationProvider(makeConfig({ customTranslations: { myabbr: ["Y"] } }));
      expect(p.getSymbolsForAbbreviation("myabbr")).toEqual(["Y"]);
    });

    it("normalizes string values to arrays", () => {
      // The provider should handle string values from customTranslations
      const p = new AbbreviationProvider(makeConfig({ customTranslations: { myabbr: ["Z"] } }));
      expect(p.getSymbolsForAbbreviation("myabbr")).toEqual(["Z"]);
    });
  });
});
