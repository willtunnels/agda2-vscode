/**
 * Integration test: spawns a real Agda process, loads a file with
 * supplementary-plane Unicode characters that causes an error, and
 * verifies that our column conversion produces correct VS Code positions.
 *
 * Also tests the pure agdaColToVscodeCol function directly.
 *
 * Runs against all available Agda versions (downloaded by globalSetup).
 */

import { describe, it, expect, inject } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseAgdaVersion, versionGte, V2_8, agdaVersion } from "../src/agda/version.js";
import {
  agdaColToVscodeCol,
  isResolvedLocation,
  parseLocationsInString,
  displayLinkedText,
} from "../src/util/agdaLocation.js";
import {
  spawnAgda,
  haskellStringQuote,
  findDisplayInfo,
} from "./helpers/agdaSession.js";

// -- Pure column conversion tests (version-independent) --

describe("agdaColToVscodeCol", () => {
  it("returns same column for BMP-only text", () => {
    // "hello" -- all BMP, 1-based col 3 → 1-based VS Code col 3
    expect(agdaColToVscodeCol("hello", 3)).toBe(3);
  });

  it("shifts column after supplementary-plane character", () => {
    // "𝕄error = bbb"
    // 𝕄 is U+1D544 (2 UTF-16 code units)
    // Code points: 𝕄=1, e=2, r=3, r=4, o=5, r=6, " "=7, ==8, " "=9, b=10, b=11, b=12
    // UTF-16:      𝕄=1-2, e=3, r=4, r=5, o=6, r=7, " "=8, ==9, " "=10, b=11, b=12, b=13
    const line = "𝕄error = bbb";
    expect(agdaColToVscodeCol(line, 1)).toBe(1); // 𝕄 itself (start)
    expect(agdaColToVscodeCol(line, 2)).toBe(3); // e (after 𝕄's 2 code units)
    expect(agdaColToVscodeCol(line, 10)).toBe(11); // first b
    expect(agdaColToVscodeCol(line, 12)).toBe(13); // third b
  });

  it("shifts column after multiple supplementary-plane characters", () => {
    // "𝕄𝕏x" -- two supplementary chars then BMP
    // Code points: 𝕄=1, 𝕏=2, x=3
    // UTF-16: 𝕄=1-2, 𝕏=3-4, x=5
    const line = "𝕄𝕏x";
    expect(agdaColToVscodeCol(line, 1)).toBe(1); // 𝕄
    expect(agdaColToVscodeCol(line, 2)).toBe(3); // 𝕏
    expect(agdaColToVscodeCol(line, 3)).toBe(5); // x
  });
});

// -- Integration tests with Agda (run for each downloaded version) --

const agdaBinaries = inject("agdaBinaries");
const fixturePath = path.resolve(path.join(__dirname, "fixtures", "UnicodeError.agda"));

/** Detect the installed Agda version from a specific binary. */
function detectVersion(binaryPath: string) {
  const stdout = execFileSync(binaryPath, ["--version"], { encoding: "utf-8" });
  return parseAgdaVersion(stdout);
}

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Location conversion -- Agda v${version}`, () => {
    it("parseLocationsInString converts code-point columns to UTF-16", async () => {
      const agdaVersion = detectVersion(binaryPath);
      const sep = versionGte(agdaVersion, V2_8) ? "." : ",";

      const agda = await spawnAgda(binaryPath);
      try {
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const responses = await agda.sendCommand(loadCmd);
        const info = findDisplayInfo(responses);

        expect(info).toBeDefined();
        expect(info!.kind).toBe("Error");

        if (info!.kind === "Error") {
          const fileContent = fs.readFileSync(fixturePath, "utf-8");
          const lines = fileContent.split("\n");

          // Build a minimal mock document for parseLocationsInString
          const mockDoc = {
            lineCount: lines.length,
            lineAt(line: number) {
              return { text: lines[line] ?? "" };
            },
            uri: { toString: () => `file://${fixturePath}` },
          } as any;

          const docCache = new Map<string, any>();
          docCache.set(fixturePath, mockDoc);

          const linked = await parseLocationsInString(info!.message, docCache, agdaVersion);
          const converted = displayLinkedText(linked, agdaVersion);

          // Line 16 is "𝕄error = bbb"
          // 𝕄 is supplementary (2 UTF-16 code units), so cols shift by +1.
          // Agda col 10 → VS Code col 11, Agda col 13 → VS Code col 14.
          expect(converted).toContain(`:16${sep}11-14`);
          expect(converted).not.toContain(`:16${sep}10-13`);

          // The message body should still mention bbb
          expect(converted).toContain("bbb");

          // Verify we got structured location data
          const locSegments = linked.filter(isResolvedLocation);
          expect(locSegments.length).toBeGreaterThan(0);
          expect(locSegments[0].col).toBe(11);
        }
      } finally {
        agda.close();
      }
    }, 30000);
  });
}

// Version-independent pure test (no Agda binary needed)
describe("BMP-only location conversion", () => {
  it("BMP-only error locations are unchanged after conversion", async () => {
    // Use pre-2.8.0 version (comma-format input)
    const version = agdaVersion(2, 7, 0);
    const text = "/path/to/File.agda:5,3-10\nSome error";
    const mockDoc = {
      lineCount: 10,
      lineAt(_line: number) {
        return { text: "abcdefghij" };
      },
      uri: { toString: () => "file:///path/to/File.agda" },
    } as any;

    const docCache = new Map<string, any>();
    docCache.set("/path/to/File.agda", mockDoc);

    const linked = await parseLocationsInString(text, docCache, version);
    const converted = displayLinkedText(linked, version);
    // BMP-only: columns should be identical
    expect(converted).toContain(":5,3-10");
  });
});
