/**
 * Tests for cursor positioning after give/refine/case.
 *
 * Part 1: Unit tests for mapCursorThroughEdit (pure function).
 * Part 2: Integration tests that spawn Agda, send Cmd_give / Cmd_make_case,
 *         and verify the replacement text + cursor mapping.
 * Part 3: End-to-end give flow (? expansion) via EditorTestHarness.
 * Part 4: End-to-end give flow (stale offset handling) via EditorTestHarness.
 *
 * Integration tests run against all available Agda versions (downloaded by globalSetup).
 */

import { describe, it, expect, inject } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mapCursorThroughEdit } from "../src/core/responseProcessor.js";
import type { AgdaResponse } from "../src/agda/responses.js";
import { spawnAgda, haskellStringQuote } from "./helpers/agdaSession.js";

// ---------------------------------------------------------------------------
// Part 1: mapCursorThroughEdit unit tests (version-independent)
// ---------------------------------------------------------------------------

describe("mapCursorThroughEdit", () => {
  it("identical strings: cursor stays at same offset", () => {
    expect(mapCursorThroughEdit("hello", "hello", 0)).toBe(0);
    expect(mapCursorThroughEdit("hello", "hello", 2)).toBe(2);
    expect(mapCursorThroughEdit("hello", "hello", 5)).toBe(5);
  });

  it("give: {! zero !} → ' zero' (no common prefix/suffix)", () => {
    const old = "{! zero !}";
    const rep = " zero";
    // P=0, S=0 -- cursor clamps to min(offset, new.length)
    expect(mapCursorThroughEdit(old, rep, 0)).toBe(0); // on {
    expect(mapCursorThroughEdit(old, rep, 1)).toBe(1); // on !
    expect(mapCursorThroughEdit(old, rep, 3)).toBe(3); // on z
    expect(mapCursorThroughEdit(old, rep, 5)).toBe(4); // past content → last char
    expect(mapCursorThroughEdit(old, rep, 9)).toBe(4); // on } → last char
    expect(mapCursorThroughEdit(old, rep, 10)).toBe(5); // past end → past end (suffix check)
  });

  it("shared prefix: '{! suc zero !}' → '{! suc (suc zero) !}'", () => {
    const old = "{! suc zero !}";
    const rep = "{! suc (suc zero) !}";
    // Common prefix: "{! suc " (7 chars)
    // Common suffix: " !}" (3 chars)
    expect(mapCursorThroughEdit(old, rep, 0)).toBe(0); // in prefix: {
    expect(mapCursorThroughEdit(old, rep, 3)).toBe(3); // in prefix: s
    expect(mapCursorThroughEdit(old, rep, 6)).toBe(6); // in prefix: space
    expect(mapCursorThroughEdit(old, rep, 7)).toBe(7); // start of middle: z → clamp
    // old suffix starts at 11 ({! suc zero| !}), new suffix starts at 17
    expect(mapCursorThroughEdit(old, rep, 11)).toBe(17); // old " !}" → new " !}"
    expect(mapCursorThroughEdit(old, rep, 13)).toBe(19); // on }
  });

  it("shared suffix: 'abc xyz' → 'xyz' (suffix match)", () => {
    const old = "abc xyz";
    const rep = "xyz";
    // P=0, S=3 ("xyz")
    // old.length=7, suffix region starts at 7-3=4
    expect(mapCursorThroughEdit(old, rep, 0)).toBe(0); // in middle
    expect(mapCursorThroughEdit(old, rep, 3)).toBe(0); // in middle → clamp to new.len-S=0
    expect(mapCursorThroughEdit(old, rep, 4)).toBe(0); // start of suffix: x
    expect(mapCursorThroughEdit(old, rep, 5)).toBe(1); // y
    expect(mapCursorThroughEdit(old, rep, 6)).toBe(2); // z
  });

  it("empty old text", () => {
    expect(mapCursorThroughEdit("", "hello", 0)).toBe(0);
  });

  it("empty new text", () => {
    expect(mapCursorThroughEdit("hello", "", 0)).toBe(0);
    expect(mapCursorThroughEdit("hello", "", 3)).toBe(0);
  });

  it("paren give: '{! zero !}' → 'zero' (no-paren give result)", () => {
    const old = "{! zero !}";
    const rep = "zero";
    // P=0, S=0
    expect(mapCursorThroughEdit(old, rep, 3)).toBe(3); // on z → min(3,3)=3
    expect(mapCursorThroughEdit(old, rep, 6)).toBe(3); // past content → last char
  });
});

// ---------------------------------------------------------------------------
// Part 2: Integration tests (all downloaded Agda versions)
// ---------------------------------------------------------------------------

const agdaBinaries = inject("agdaBinaries");

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Give/Case cursor position -- Agda v${version}`, () => {
    // Work on a temporary copy so we don't modify the fixture
    const fixtureSrc = path.resolve(__dirname, "fixtures", "GiveCase.agda");
    let tmpDir: string;
    let tmpFile: string;

    function setupTmpFile(): void {
      tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "agda-test-"));
      tmpFile = path.join(tmpDir, "GiveCase.agda");
      fs.copyFileSync(fixtureSrc, tmpFile);
    }

    function cleanupTmpFile(): void {
      try {
        // Remove .agdai files and the temp directory
        for (const f of fs.readdirSync(tmpDir)) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
        fs.rmdirSync(tmpDir);
      } catch {
        /* best effort */
      }
    }

    it("Cmd_give returns GiveAction with replacement text, cursor maps correctly", async () => {
      setupTmpFile();
      const agda = await spawnAgda(binaryPath);
      try {
        const quoted = haskellStringQuote(tmpFile);

        // Load the file
        const loadResponses = await agda.sendCommand(
          `IOTCM ${quoted} NonInteractive Direct (Cmd_load ${quoted} [])`,
        );

        // Find interaction points
        const ipResponse = loadResponses.find((r) => r.kind === "InteractionPoints");
        expect(ipResponse).toBeDefined();
        const ips = (ipResponse as Extract<AgdaResponse, { kind: "InteractionPoints" }>)
          .interactionPoints;
        expect(ips.length).toBeGreaterThanOrEqual(2);

        // Goal 0 has content "zero" -- give it
        const goalId = ips[0].id;
        const giveResponses = await agda.sendCommand(
          `IOTCM ${quoted} NonInteractive Direct (Cmd_give WithoutForce ${goalId} noRange "zero")`,
        );

        const giveAction = giveResponses.find((r) => r.kind === "GiveAction");
        expect(giveAction).toBeDefined();

        const ga = giveAction as Extract<AgdaResponse, { kind: "GiveAction" }>;
        expect("str" in ga.giveResult).toBe(true);

        const replacement = (ga.giveResult as { str: string }).str;

        // Read the original goal text from the file
        const fileContent = fs.readFileSync(tmpFile, "utf-8");
        const goalMatch = fileContent.match(/\{! zero !\}/);
        expect(goalMatch).not.toBeNull();

        const goalText = goalMatch![0]; // "{! zero !}"

        // Verify cursor mapping: cursor on 'z' in "{! zero !}" should map
        // to within the replacement text at a valid position
        const zOffset = goalText.indexOf("z");
        expect(zOffset).toBeGreaterThan(0);

        const mappedZ = mapCursorThroughEdit(goalText, replacement, zOffset);
        expect(mappedZ).toBeGreaterThanOrEqual(0);
        expect(mappedZ).toBeLessThanOrEqual(replacement.length);

        // Cursor on '!' of "!}" should clamp to end of replacement
        const closingBang = goalText.lastIndexOf("!");
        const mappedEnd = mapCursorThroughEdit(goalText, replacement, closingBang);
        expect(mappedEnd).toBeLessThanOrEqual(replacement.length);

        // Cursor before goal start stays at 0
        expect(mapCursorThroughEdit(goalText, replacement, 0)).toBe(0);
      } finally {
        agda.close();
        cleanupTmpFile();
      }
    }, 30000);

    it("Cmd_make_case returns MakeCase with clause text containing new holes", async () => {
      setupTmpFile();
      const agda = await spawnAgda(binaryPath);
      try {
        const quoted = haskellStringQuote(tmpFile);

        // Load the file
        const loadResponses = await agda.sendCommand(
          `IOTCM ${quoted} NonInteractive Direct (Cmd_load ${quoted} [])`,
        );

        const ipResponse = loadResponses.find((r) => r.kind === "InteractionPoints");
        expect(ipResponse).toBeDefined();
        const ips = (ipResponse as Extract<AgdaResponse, { kind: "InteractionPoints" }>)
          .interactionPoints;

        // Goal 1 has content "n" -- case split on n
        const goalId = ips[1].id;
        const caseResponses = await agda.sendCommand(
          `IOTCM ${quoted} NonInteractive Direct (Cmd_make_case ${goalId} noRange "n")`,
        );

        const makeCase = caseResponses.find((r) => r.kind === "MakeCase");
        expect(makeCase).toBeDefined();

        const mc = makeCase as Extract<AgdaResponse, { kind: "MakeCase" }>;
        expect(mc.variant).toBe("Function");

        // Should produce two clauses (one for zero, one for suc)
        expect(mc.clauses.length).toBe(2);

        // One clause should match zero, one should match suc
        const joined = mc.clauses.join("\n");
        expect(joined).toContain("zero");
        expect(joined).toContain("suc");

        // At least one clause should contain a hole (?)
        const hasHole = mc.clauses.some((c) => c.includes("?") || c.includes("{!"));
        expect(hasHole).toBe(true);
      } finally {
        agda.close();
        cleanupTmpFile();
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Part 3: Full end-to-end give flow via EditorTestHarness
//
// These tests exercise the complete give pipeline -- document mutation, goal
// tracking, and decoration placement -- using the simulated editor harness.
// They would fail without the fixes in handleGiveAction (? expansion) and
// processBatchedResponses (forceScan after give).
// ---------------------------------------------------------------------------

import { EditorTestHarness } from "./helpers/editorTestHarness.js";
import { MockDocumentEditor } from "./helpers/mockDocumentEditor.js";
import { Position, Range, Selection, MockTextDocument } from "./__mocks__/vscode.js";
import { GoalManager } from "../src/core/goals.js";
import { processBatchedResponses, noopCallbacks } from "../src/core/responseProcessor.js";

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Give with ? expansion (harness) -- Agda v${version}`, () => {
    const fixtureContent = fs.readFileSync(
      path.resolve(__dirname, "fixtures", "GiveWithMeta.agda"),
      "utf-8",
    );

    it("give 'suc ?' expands ? to {!  !} and tracks the new goal", async () => {
      const h = new EditorTestHarness(binaryPath, fixtureContent, "GiveWithMeta.agda");
      try {
        await h.load();

        // Should have 1 goal initially
        const goalsBefore = h.getGoals();
        expect(goalsBefore.length).toBe(1);
        expect(goalsBefore[0].text).toContain("{!");

        // Give "suc ?" -- Agda returns a bare ? which must be expanded
        await h.give(goalsBefore[0].id, "suc ?");

        // The document should contain {!  !}, NOT a bare ?
        const content = h.getContent();
        expect(content).toContain("suc {!  !}");
        expect(content).not.toMatch(/suc \?(?!\})/); // no bare "suc ?" left

        // GoalManager should track the new goal and it should point at {!  !}
        const goalsAfter = h.getGoals();
        expect(goalsAfter.length).toBe(1);
        expect(goalsAfter[0].text).toBe("{!  !}");
      } finally {
        h.close();
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Part 4: Goal offset after give -- stale offsets handled by forceScan
//
// After giving goal ?0, Agda's InteractionPoints offsets refer to the
// pre-give document. The harness (like the real extension) uses forceScan
// to find goals by scanning for {! !} patterns instead.
// This test verifies the remaining goal is correctly tracked.
// ---------------------------------------------------------------------------

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Goal offset after give (harness) -- Agda v${version}`, () => {
    const fixtureContent = fs.readFileSync(
      path.resolve(__dirname, "fixtures", "GiveStaleOffset.agda"),
      "utf-8",
    );

    it("after give, remaining goal is correctly located at {!  !}", async () => {
      const h = new EditorTestHarness(binaryPath, fixtureContent, "GiveStaleOffset.agda");
      try {
        await h.load();

        // Should have 2 goals initially
        const goalsBefore = h.getGoals();
        expect(goalsBefore.length).toBe(2);

        // Find the goal that contains "zero" (goal ?0 from the fixture)
        const goal0 = goalsBefore.find((g) => g.text.includes("zero"));
        expect(goal0, "Should find goal containing 'zero'").toBeDefined();

        // Give "zero" to goal ?0
        await h.give(goal0!.id, "zero");

        // After give, only 1 goal should remain
        const goalsAfter = h.getGoals();
        expect(goalsAfter.length).toBe(1);

        // The remaining goal should be the empty {!  !} from line 8
        const remainingGoal = goalsAfter[0];
        expect(remainingGoal.text).toBe("{!  !}");

        // Verify the goal is on the correct line (line 8 in the fixture = line index 7)
        expect(remainingGoal.range.start.line).toBe(7);

        // The document should have "zero" where the first goal was
        const content = h.getContent();
        const addLine = content.split("\n").find((l) => l.includes("add n m"));
        expect(addLine).toContain("zero");
        expect(addLine).not.toContain("{!");
      } finally {
        h.close();
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Part 5: Cursor at goal delimiter after give
//
// When the cursor is on the closing delimiter (!}) of a goal, giving the
// goal replaces {! ... !} with shorter text. The cursor should end up
// within the replacement, not one past the end of the (now shorter) line.
// ---------------------------------------------------------------------------

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Cursor at goal delimiter after give -- Agda v${version}`, () => {
    const fixtureContent = fs.readFileSync(
      path.resolve(__dirname, "fixtures", "GiveStaleOffset.agda"),
      "utf-8",
    );

    it("cursor on closing } does not end up past end of line", async () => {
      const h = new EditorTestHarness(binaryPath, fixtureContent, "GiveStaleOffset.agda");
      try {
        await h.load();
        const goals = h.getGoals();
        const goal = goals.find((g) => g.text.includes("zero"));
        expect(goal).toBeDefined();

        // Place cursor on the closing } of {! zero !}
        //   add n m = {! zero !}
        //                     ^ cursor here
        const closingBrace = new Position(goal!.range.end.line, goal!.range.end.character - 1);
        h.editor.selection = new Selection(closingBrace, closingBrace) as any;

        await h.give(goal!.id, "zero");

        // After give, the line is shorter (e.g. "add n m =  zero").
        // The cursor should be within the line, not past its end.
        const cursor = h.editor.selection.active;
        const lineText = h.editor.document.lineAt(cursor.line).text;
        expect(cursor.character).toBeLessThan(lineText.length);
      } finally {
        h.close();
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Part 6: Paren give with ? in content expands question marks
//
// When Agda returns { paren: true/false } for a give, the replacement is
// built from the goal content in the document. Any bare ? in the content
// must be expanded to {!  !} -- otherwise the user gets a bare ? that
// isn't a goal marker. This matters for the give → undo → reload → give
// cycle: the ? must be expanded each time.
//
// This test bypasses Agda and crafts a GiveAction { paren: false } response
// directly to exercise the paren branch of handleGiveAction.
// ---------------------------------------------------------------------------

describe("Paren give expands ? in goal content", () => {
  //   0123456789...
  //   foo = {! id ? !}
  const content = "foo = {! id ? !}\n";
  const goalStart = 6; // character offset of {
  const goalEnd = 16; // character offset after }

  it("paren: false expands ? to {!  !}", async () => {
    const editor = new MockDocumentEditor(content);
    const goals = new GoalManager();
    try {
      // Register the goal by simulating an InteractionPoints response
      const ipResponse: AgdaResponse = {
        kind: "InteractionPoints",
        interactionPoints: [
          {
            id: 0,
            range: [
              {
                start: { pos: goalStart + 1, line: 1, col: goalStart + 1 },
                end: { pos: goalEnd + 1, line: 1, col: goalEnd + 1 },
              },
            ],
          },
        ],
      };
      await processBatchedResponses(editor, [ipResponse], goals, noopCallbacks);

      // Verify goal was registered
      const goalsBefore = goals.getAll(editor.document.uri.toString());
      expect(goalsBefore.length).toBe(1);
      expect(editor.document.getText(goalsBefore[0].range)).toBe("{! id ? !}");

      // Now send a GiveAction with paren: false (use content as-is)
      const giveResponse: AgdaResponse = {
        kind: "GiveAction",
        interactionPoint: { id: 0, range: [] },
        giveResult: { paren: false },
      };
      const ipAfter: AgdaResponse = {
        kind: "InteractionPoints",
        interactionPoints: [
          // Agda returns a new interaction point for the expanded ?
          { id: 1, range: [] },
        ],
      };
      await processBatchedResponses(editor, [giveResponse, ipAfter], goals, noopCallbacks);

      // The bare ? should have been expanded to {!  !}
      const text = editor.document.getText();
      expect(text).toContain("id {!  !}");
      expect(text).not.toMatch(/id \?/);
    } finally {
      goals.dispose();
    }
  });

  it("paren: true wraps in parens and expands ?", async () => {
    const editor = new MockDocumentEditor(content);
    const goals = new GoalManager();
    try {
      const ipResponse: AgdaResponse = {
        kind: "InteractionPoints",
        interactionPoints: [
          {
            id: 0,
            range: [
              {
                start: { pos: goalStart + 1, line: 1, col: goalStart + 1 },
                end: { pos: goalEnd + 1, line: 1, col: goalEnd + 1 },
              },
            ],
          },
        ],
      };
      await processBatchedResponses(editor, [ipResponse], goals, noopCallbacks);

      const giveResponse: AgdaResponse = {
        kind: "GiveAction",
        interactionPoint: { id: 0, range: [] },
        giveResult: { paren: true },
      };
      const ipAfter: AgdaResponse = {
        kind: "InteractionPoints",
        interactionPoints: [{ id: 1, range: [] }],
      };
      await processBatchedResponses(editor, [giveResponse, ipAfter], goals, noopCallbacks);

      const text = editor.document.getText();
      expect(text).toContain("(id {!  !})");
      expect(text).not.toMatch(/id \?/);
    } finally {
      goals.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 7: Give → undo → goal should be gone
//
// After give, the old goal is replaced and new goals are created by
// updateGoals (forceScan). When the user undoes, the text reverts but
// Agda's state is stale. The extension must NOT preserve a goal at the
// old position -- otherwise the user can issue a give with a stale goal
// ID, causing Agda to return a different paren flag.
//
// In Emacs agda2-mode, the goal overlay is destroyed during give and not
// restored by undo, so the user is forced to reload. We should match
// that: after undo, no goal should exist at the old position.
// ---------------------------------------------------------------------------

describe("Give then undo removes goal", () => {
  //   0123456789...
  //   foo = {! id ? !}
  const content = "foo = {! id ? !}\n";
  const goalStart = 6;
  const goalEnd = 16;

  /** Helper: set up initial goal and process give. Returns post-give state. */
  async function setupAndGive(parenFlag: boolean) {
    const editor = new MockDocumentEditor(content);
    const goals = new GoalManager();
    const uri = editor.document.uri.toString();

    // Register goal 0 via InteractionPoints
    const ipResponse: AgdaResponse = {
      kind: "InteractionPoints",
      interactionPoints: [
        {
          id: 0,
          range: [
            {
              start: { pos: goalStart + 1, line: 1, col: goalStart + 1 },
              end: { pos: goalEnd + 1, line: 1, col: goalEnd + 1 },
            },
          ],
        },
      ],
    };
    await processBatchedResponses(editor, [ipResponse], goals, noopCallbacks);

    // Snapshot the pre-give text and goal range
    const preGiveText = editor.document.getText();
    const goal0 = goals.getAll(uri)[0];
    expect(goal0).toBeDefined();
    expect(editor.document.getText(goal0.range)).toBe("{! id ? !}");

    // Process give + new InteractionPoints
    const giveResponse: AgdaResponse = {
      kind: "GiveAction",
      interactionPoint: { id: 0, range: [] },
      giveResult: { paren: parenFlag },
    };
    const ipAfter: AgdaResponse = {
      kind: "InteractionPoints",
      interactionPoints: [{ id: 1, range: [] }],
    };
    await processBatchedResponses(editor, [giveResponse, ipAfter], goals, noopCallbacks);

    const postGiveText = editor.document.getText();
    return { editor, goals, uri, preGiveText, postGiveText };
  }

  /**
   * Simulate undo the way VS Code actually fires it, with undo collation.
   *
   * Real VS Code (especially VSCodeVim) decomposes a replace edit into
   * atomic insert/delete ops and undoes them as **separate
   * onDidChangeTextDocument events**. Each individual event looks like an
   * interior-only edit, so adjustRangeContaining would grow/shift the
   * goal instead of removing it.
   *
   * The fix: undo collation. Before undo, call beginUndoCollation (which
   * snapshots the pre-undo text). During undo, skip goal adjustForEdits.
   * After undo, call endUndoCollation which computes a single merged
   * change and processes it through adjustForEdits -- correctly removing
   * goals whose boundaries were crossed.
   *
   * @param undoSteps  Array of {range, text} pairs, each fired as a
   *   separate onDidChangeTextDocument event, in the order VS Code fires
   *   them.
   */
  function simulateUndo(
    editor: MockDocumentEditor,
    goals: GoalManager,
    preGiveText: string,
    undoSteps: { range: Range; text: string }[],
  ) {
    const uri = editor.document.uri.toString();
    const preUndoText = editor.document.getText();

    // Begin undo collation -- this snapshots pre-undo text
    goals.beginUndoCollation(uri, preUndoText);

    // Apply each undo step as a separate event, just like VS Code does.
    // During collation, onDidChangeTextDocument skips goals.adjustForEdits.
    for (const step of undoSteps) {
      const startOff = editor.document.offsetAt(step.range.start);
      const endOff = editor.document.offsetAt(step.range.end);
      const before = editor.document.getText();
      const after = before.slice(0, startOff) + step.text + before.slice(endOff);
      MockTextDocument.setContents(editor.document, after);

      // During collation, goals.adjustForEdits is NOT called (skipped)
      expect(goals.isCollatingUndo(uri)).toBe(true);
    }

    // Verify the document was fully restored
    expect(editor.document.getText()).toBe(preGiveText);

    // End undo collation -- computes merged change and processes it
    goals.endUndoCollation(uri, editor.document.getText());
  }

  it("paren: false -- no goal survives undo", async () => {
    const { editor, goals, uri, preGiveText, postGiveText } = await setupAndGive(false);

    // After give, document is "foo = id {!  !}\n", goal 1 at the {!  !}
    expect(postGiveText).toBe("foo = id {!  !}\n");
    const goalsAfterGive = goals.getAll(uri);
    expect(goalsAfterGive.length).toBe(1);
    expect(goalsAfterGive[0].id).toBe(1);
    const goal1 = goalsAfterGive[0];
    expect(editor.document.getText(goal1.range)).toBe("{!  !}");

    // Simulate undo as VS Code actually fires it: two separate events.
    // Observed from real VS Code logs -- the replace [0:6,0:16]->"id {!  !}"
    // was decomposed by VS Code into delete+insert, and undo reverses them
    // as two separate onDidChangeTextDocument events:
    //   Event 1: insert "id ?" inside the hole interior (undoes the delete)
    //   Event 2: delete the "id " prefix (undoes the insert)
    //
    // Post-give: "foo = id {!  !}\n"
    //             0123456789...
    // goal 1 is at [0:9, 0:15] (the {!  !})
    const g1Start = goal1.range.start.character; // 9
    const g1End = goal1.range.end.character; // 15
    // Event 1: insert "id ?" at col g1End-2-1 = inside interior
    // From logs: insert at col (goalEnd - 3) in post-give coords
    // Actually, let's compute from the log pattern:
    // Log showed insert at 8:16 where goal1 was [8:13-8:19], so offset 3 from goal start + 3 = 16
    // That's goalStart + 3 in the post-give doc = g1Start + 3
    const insertCol = g1Start + 3; // col 12 in post-give doc
    simulateUndo(editor, goals, preGiveText, [
      // Event 1: insert deleted content back inside the hole
      { range: new Range(0, insertCol, 0, insertCol), text: "id ?" },
      // Event 2: delete the inserted prefix
      { range: new Range(0, goalStart, 0, g1Start), text: "" },
    ]);

    // The critical check: no goal should exist at any position in the
    // restored {! id ? !} text. The user must reload to get goals back.
    const goalsAfterUndo = goals.getAll(uri);
    const goalAtOldPos = goals.getGoalAt(
      uri,
      new Position(0, goalStart + 3), // inside the old goal
    );
    expect(goalAtOldPos).toBeUndefined();
    expect(goalsAfterUndo.length).toBe(0);
  });

  // The paren:true case has the same fundamental problem -- VS Code fires
  // 3 undo steps (one for each atomic edit in the decomposition), each
  // individually surviving adjustRangeContaining.  We don't test the exact
  // decomposition here since it depends on VS Code's diff algorithm, but
  // the paren:false case above demonstrates the bug.
});
