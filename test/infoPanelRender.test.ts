/**
 * Unit tests for InfoPanel rendering.
 * Verifies that GoalSpecific / GoalType responses (including context)
 * produce the expected HTML sections.
 */

import { describe, it, expect } from "vitest";
import { renderDisplayInfo } from "../src/editor/infoPanel.js";
import type { DisplayInfo } from "../src/agda/responses.js";
import { agdaVersion } from "../src/agda/version.js";
import type { DisplayInfoVSCode, LinkedText } from "../src/util/agdaLocation.js";

const testVersion = agdaVersion(2, 7, 0);

/** Wrap a plain string as a LinkedText (single text segment, no locations). */
const textOf = (s: string): LinkedText => [{ kind: "text", text: s }];

/**
 * Convert a test-constructed DisplayInfo to DisplayInfoVSCode.
 * Wraps string fields that become LinkedText in the converted type.
 */
function asConverted(info: DisplayInfo): DisplayInfoVSCode {
  switch (info.kind) {
    case "AllGoalsWarnings":
      return { ...info, errors: info.errors.map(textOf), warnings: info.warnings.map(textOf) };
    case "Error":
      return { ...info, message: textOf(info.message), warnings: info.warnings?.map(textOf) };
    case "CompilationOk":
      return { ...info, errors: info.errors.map(textOf), warnings: info.warnings.map(textOf) };
    case "WhyInScope":
      return { ...info, message: textOf(info.message) };
    default:
      return info as DisplayInfoVSCode;
  }
}

describe("renderDisplayInfo", () => {
  it("GoalType with empty context renders Goal section only", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 0, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalOnly" },
        type: "ℕ",
        entries: [],
        boundary: [],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Goal");
    expect(html).toContain("ℕ");
    expect(html).not.toContain("Context");
  });

  it("GoalType with context entries renders Context section", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 1, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalOnly" },
        type: "ℕ",
        entries: [
          {
            originalName: "n",
            reifiedName: "n",
            binding: "ℕ",
            inScope: true,
          },
        ],
        boundary: [],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;

    // Should have both Goal and Context sections
    expect(html).toContain("Goal");
    expect(html).toContain("Context");

    // Context should contain the variable name and type
    expect(html).toContain("n");
    expect(html).toContain("ℕ");
  });

  it("GoalType with multiple context entries renders all of them", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 0, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalOnly" },
        type: "ℕ",
        entries: [
          { originalName: "x", reifiedName: "x", binding: "ℕ", inScope: true },
          { originalName: "y", reifiedName: "y", binding: "ℕ → ℕ", inScope: true },
          { originalName: "z", reifiedName: "z", binding: "Bool", inScope: false },
        ],
        boundary: [],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Context");
    expect(html).toContain("ctx-table");
    // All three variable names should appear
    expect(html).toContain(">x<");
    expect(html).toContain(">y<");
    expect(html).toContain(">z<");
    // Out-of-scope variable should show "(not in scope)" like Agda's Emacs mode
    expect(html).toContain("not in scope");
  });

  it("GoalType with Have aux renders Have section", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 0, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalAndHave", expr: "suc n" },
        type: "ℕ",
        entries: [{ originalName: "n", reifiedName: "n", binding: "ℕ", inScope: true }],
        boundary: [],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Goal");
    expect(html).toContain("Have");
    expect(html).toContain("suc n");
    expect(html).toContain("Context");
  });

  it("GoalType with boundary renders Boundary section", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 0, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalOnly" },
        type: "ℕ",
        entries: [],
        boundary: ["i = i0 ⊢ zero", "i = i1 ⊢ suc zero"],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Boundary");
    expect(html).toContain("i = i0");
  });

  it("context entry with different original and reified name shows both", () => {
    const info: DisplayInfo = {
      kind: "GoalSpecific",
      interactionPoint: { id: 0, range: [] },
      goalInfo: {
        kind: "GoalType",
        rewrite: "Simplified",
        typeAux: { kind: "GoalOnly" },
        type: "ℕ",
        entries: [{ originalName: "m", reifiedName: "n", binding: "ℕ", inScope: true }],
        boundary: [],
        outputForms: [],
      },
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Context");
    // Should show the reified name and original name
    expect(html).toContain("n");
    expect(html).toContain("(m)");
    expect(html).toContain("ctx-original");
  });

  it("AllGoalsWarnings renders goal list without context", () => {
    const info: DisplayInfo = {
      kind: "AllGoalsWarnings",
      visibleGoals: [
        { kind: "OfType", constraintObj: { id: 0, range: [] }, type: "ℕ" },
        { kind: "OfType", constraintObj: { id: 1, range: [] }, type: "ℕ → ℕ" },
      ],
      invisibleGoals: [],
      warnings: [],
      errors: [],
    };

    const html = renderDisplayInfo(asConverted(info), testVersion).__html;
    expect(html).toContain("Goals");
    expect(html).toContain("goal-table");
    // Should NOT contain a Context section
    expect(html).not.toContain("Context");
  });
});
