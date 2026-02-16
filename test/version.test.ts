import { describe, it, expect } from "vitest";
import {
  agdaVersion,
  parseAgdaVersion,
  versionGte,
  formatVersion,
  MIN_AGDA_VERSION,
  V2_7,
} from "../src/agda/version.js";

describe("agdaVersion", () => {
  it("requires at least one component", () => {
    expect(() => agdaVersion()).toThrow("at least one component");
  });
});

describe("parseAgdaVersion", () => {
  it("parses 'Agda version 2.7.0.1'", () => {
    const v = parseAgdaVersion("Agda version 2.7.0.1");
    expect(formatVersion(v)).toBe("2.7.0.1");
  });

  it("parses 'Agda version 2.6.1'", () => {
    const v = parseAgdaVersion("Agda version 2.6.1");
    expect(formatVersion(v)).toBe("2.6.1");
  });

  it("parses with trailing newline", () => {
    const v = parseAgdaVersion("Agda version 2.6.4.3\n");
    expect(formatVersion(v)).toBe("2.6.4.3");
  });

  it("parses with trailing text", () => {
    const v = parseAgdaVersion("Agda version 2.6.2-rc1 (extra info)");
    expect(formatVersion(v)).toBe("2.6.2");
  });

  it("throws on empty string", () => {
    expect(() => parseAgdaVersion("")).toThrow("Could not parse");
  });

  it("throws on unrelated output", () => {
    expect(() => parseAgdaVersion("ghc 9.4.7")).toThrow("Could not parse");
  });
});

describe("versionGte", () => {
  it("equal versions", () => {
    expect(versionGte(agdaVersion(2, 7, 0), agdaVersion(2, 7, 0))).toBe(true);
  });

  it("greater major", () => {
    expect(versionGte(agdaVersion(3, 0, 0), agdaVersion(2, 7, 0))).toBe(true);
  });

  it("greater minor", () => {
    expect(versionGte(agdaVersion(2, 8, 0), agdaVersion(2, 7, 0))).toBe(true);
  });

  it("greater patch", () => {
    expect(versionGte(agdaVersion(2, 7, 1), agdaVersion(2, 7, 0))).toBe(true);
  });

  it("less major", () => {
    expect(versionGte(agdaVersion(1, 9, 9), agdaVersion(2, 0, 0))).toBe(false);
  });

  it("less minor", () => {
    expect(versionGte(agdaVersion(2, 5, 9), agdaVersion(2, 6, 0))).toBe(false);
  });

  it("less patch", () => {
    expect(versionGte(agdaVersion(2, 6, 0), agdaVersion(2, 6, 1))).toBe(false);
  });

  it("shorter array padded with 0: 2.6.1 >= 2.6.1.0", () => {
    expect(versionGte(agdaVersion(2, 6, 1), agdaVersion(2, 6, 1, 0))).toBe(true);
  });

  it("shorter array padded with 0: 2.6.1.0 >= 2.6.1", () => {
    expect(versionGte(agdaVersion(2, 6, 1, 0), agdaVersion(2, 6, 1))).toBe(true);
  });

  it("longer version is greater: 2.6.4.3 >= 2.6.4", () => {
    expect(versionGte(agdaVersion(2, 6, 4, 3), agdaVersion(2, 6, 4))).toBe(true);
  });

  it("longer version is less: 2.6.4 < 2.6.4.3", () => {
    expect(versionGte(agdaVersion(2, 6, 4), agdaVersion(2, 6, 4, 3))).toBe(false);
  });
});

describe("formatVersion", () => {
  it("formats 3-component", () => {
    expect(formatVersion(agdaVersion(2, 6, 1))).toBe("2.6.1");
  });

  it("formats 4-component", () => {
    expect(formatVersion(agdaVersion(2, 7, 0, 1))).toBe("2.7.0.1");
  });
});

describe("well-known constants", () => {
  it("MIN_AGDA_VERSION is 2.6.1", () => {
    expect(formatVersion(MIN_AGDA_VERSION)).toBe("2.6.1");
  });

  it("V2_7 is 2.7.0", () => {
    expect(formatVersion(V2_7)).toBe("2.7.0");
  });

  it("2.6.0 < MIN_AGDA_VERSION", () => {
    expect(versionGte(agdaVersion(2, 6, 0), MIN_AGDA_VERSION)).toBe(false);
  });

  it("2.6.1 >= MIN_AGDA_VERSION", () => {
    expect(versionGte(agdaVersion(2, 6, 1), MIN_AGDA_VERSION)).toBe(true);
  });

  it("2.6.4.3 >= MIN_AGDA_VERSION", () => {
    expect(versionGte(agdaVersion(2, 6, 4, 3), MIN_AGDA_VERSION)).toBe(true);
  });

  it("2.7.0.1 >= V2_7", () => {
    expect(versionGte(agdaVersion(2, 7, 0, 1), V2_7)).toBe(true);
  });

  it("2.6.4.3 < V2_7", () => {
    expect(versionGte(agdaVersion(2, 6, 4, 3), V2_7)).toBe(false);
  });
});
