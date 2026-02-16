/**
 * Integration test: spawns a real Agda process, loads a file with Unicode
 * characters, and verifies what offset system Agda uses in its highlighting
 * responses.
 *
 * RESULT: Agda uses 1-based code-point offsets.
 *
 * VSCode's document.positionAt() expects 0-based UTF-16 code unit offsets.
 * For BMP characters (U+0000..U+FFFF) these coincide, but for supplementary-
 * plane characters (U+10000+, like 𝕄 = U+1D544) one code point becomes two
 * UTF-16 code units, so every position after such a character is shifted.
 *
 * The current agdaOffsetToPosition does `document.positionAt(offset - 1)`,
 * which is only correct for BMP-only files.
 *
 * Runs against all available Agda versions (downloaded by globalSetup).
 */

import { describe, it, expect, inject } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { agdaCpOffsetToUtf16, fromAgdaOffset, type AgdaOffset } from "../src/util/offsets.js";
import { spawnAgda, haskellStringQuote } from "./helpers/agdaSession.js";

// -- Types (minimal subset of our response types) --

interface HighlightingEntry {
  range: [AgdaOffset, AgdaOffset];
  atoms: string[];
  tokenBased: string;
  note: string;
  definitionSite: unknown;
}

interface HighlightingPayload {
  remove: boolean;
  payload: HighlightingEntry[];
}

// -- Helpers --

/**
 * Load a file via an Agda session and collect all highlighting entries.
 */
async function loadAndCollectHighlighting(
  binaryPath: string,
  filepath: string,
): Promise<{
  entries: HighlightingEntry[];
  fileContent: string;
}> {
  const fileContent = fs.readFileSync(filepath, "utf-8");
  const absPath = path.resolve(filepath);
  const session = await spawnAgda(binaryPath);

  try {
    const loadCmd = `IOTCM ${haskellStringQuote(absPath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(absPath)} [])`;
    const responses = await session.sendCommand(loadCmd);

    const entries: HighlightingEntry[] = [];
    for (const r of responses) {
      if (r.kind === "HighlightingInfo" && "direct" in r && r.direct === true) {
        const info = (r as { info: HighlightingPayload }).info;
        entries.push(...info.payload);
      }
    }

    return { entries, fileContent };
  } finally {
    session.close();
  }
}

/**
 * Extract text from a file using code-point offsets (1-based).
 */
function extractAsCodePoints(content: string, from1: AgdaOffset, to1: AgdaOffset): string {
  return [...content].slice(fromAgdaOffset(from1) - 1, fromAgdaOffset(to1) - 1).join("");
}

// -- Tests --

const agdaBinaries = inject("agdaBinaries");
const fixturePath = path.join(__dirname, "fixtures", "Unicode.agda");

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Agda offset system -- v${version}`, () => {
    it("code-point offsets correctly extract known identifiers", async () => {
      const { entries, fileContent } = await loadAndCollectHighlighting(binaryPath, fixturePath);

      // Build a map: for each atom-type+text pair, verify code-point extraction
      const expectedTexts: Record<string, string[]> = {
        datatype: ["ℕ"],
        function: ["𝕄", "α"],
        inductiveconstructor: ["zero", "suc"],
        keyword: ["data", "where"],
        primitive: ["Set"],
      };

      for (const [atom, texts] of Object.entries(expectedTexts)) {
        const matchingEntries = entries.filter((e) => e.atoms.includes(atom));
        const extractedTexts = matchingEntries.map((e) =>
          extractAsCodePoints(fileContent, e.range[0], e.range[1]),
        );

        for (const expected of texts) {
          expect(
            extractedTexts,
            `Expected "${expected}" among ${atom} entries (code-point extraction)`,
          ).toContain(expected);
        }
      }
    }, 30000);

    it("agdaCpOffsetToUtf16 produces correct UTF-16 offsets for all entries", async () => {
      const { entries, fileContent } = await loadAndCollectHighlighting(binaryPath, fixturePath);

      // Use the fixed conversion: code-point → UTF-16, then slice the JS string.
      // This is what the fixed agdaOffsetToPosition does under the hood.
      for (const entry of entries) {
        const [from, to] = entry.range;

        // Code-point extraction (known correct from previous tests)
        const expectedText = extractAsCodePoints(fileContent, from, to);

        // Fixed conversion: code-point offset → UTF-16 offset → string slice
        const utf16From = agdaCpOffsetToUtf16(fileContent, from);
        const utf16To = agdaCpOffsetToUtf16(fileContent, to);
        const fixedText = fileContent.slice(utf16From, utf16To);

        expect(fixedText).toBe(expectedText);
      }
    }, 30000);
  });
}
