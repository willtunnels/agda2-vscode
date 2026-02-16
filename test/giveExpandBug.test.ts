/**
 * Regression test for the give-with-question-mark bug.
 *
 * Scenario (from test/Test.agda):
 *
 *   add n m = {! ? !}    -- goal 0
 *   ...
 *   thing : {!  !}       -- goal 1
 *
 * When we "give" the content of goal 0 (which is "?"), Agda responds with
 * GiveAction { str: "?" }.  The give edit replaces {! ? !} with the raw "?"
 * (matching Agda's internal state), and the InteractionPoints handler then
 * expands lone ? marks to {!  !} using the standard load-time expansion path.
 *
 * The old bug: handleGiveAction called expandQuestionMarks("?") → "{!  !}",
 * making the VS Code document diverge from Agda's view by 5 characters.
 * InteractionPoints offsets (based on Agda's document where the replacement
 * was "?") then placed all subsequent goals at wrong positions.
 *
 * The fix: handleGiveAction writes the raw string.  GiveAction is processed
 * before InteractionPoints, so the document matches Agda's offsets.  The
 * InteractionPoints handler's existing ? → {!  !} expansion then fires
 * naturally, and forceScan=true ensures goal positions are found by scanning.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Range, Position } from "vscode";
import { GoalManager, expandQuestionMarks, GOAL_MARKER } from "../src/core/goals.js";
import { HighlightingManager } from "../src/core/highlighting.js";
import { toAgdaOffset } from "../src/util/offsets.js";
import type { InteractionPointWithRange, HighlightingPayload } from "../src/agda/responses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock TextDocument from source text. */
function mockDocument(uri: string, text: string) {
  const lines = text.split("\n");

  function offsetAt(pos: Position): number {
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    return offset + Math.min(pos.character, (lines[pos.line] ?? "").length);
  }

  function positionAt(offset: number): Position {
    let line = 0;
    let col = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === "\n") {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    return new Position(line, col);
  }

  return {
    uri: { toString: () => uri, fsPath: uri },
    getText(range?: Range) {
      if (!range) return text;
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    offsetAt,
    positionAt,
    lineAt(line: number) {
      return {
        text: lines[line] ?? "",
        range: new Range(line, 0, line, (lines[line] ?? "").length),
      };
    },
    languageId: "agda",

    /** Mutate the mock document text (simulates applyEdit). */
    _replaceRange(range: Range, replacement: string) {
      const start = offsetAt(range.start);
      const end = offsetAt(range.end);
      text = text.slice(0, start) + replacement + text.slice(end);
      lines.length = 0;
      lines.push(...text.split("\n"));
    },
    _getText() {
      return text;
    },
  } as any;
}

/** Build an InteractionPointWithRange with Agda-offset ranges. */
function ipWithRange(
  id: number,
  startOffset: number,
  endOffset: number,
): InteractionPointWithRange {
  return {
    id,
    range: [
      {
        start: { pos: toAgdaOffset(startOffset), line: 0, col: 0 },
        end: { pos: toAgdaOffset(endOffset), line: 0, col: 0 },
      },
    ],
  };
}

/** Build a content change event. */
function change(range: Range, text: string) {
  return {
    range,
    rangeOffset: 0,
    rangeLength: 0,
    text,
  };
}

// ---------------------------------------------------------------------------
// Document text (from test/Test.agda, using ASCII arrows for simplicity)
// ---------------------------------------------------------------------------

// Using -> instead of → so that code-point offsets = UTF-16 offsets,
// avoiding supplementary-plane complications.
const INITIAL_TEXT = [
  "data Nat : Set where", // line 0
  "  zero : Nat", // line 1
  "  suc : Nat -> Nat", // line 2
  "", // line 3
  "add : Nat -> Nat -> Nat", // line 4
  "add n m = {! ? !}", // line 5 -- goal 0
  "", // line 6
  "thing : {!  !}", // line 7 -- goal 1
  "thing = zero", // line 8
].join("\n");

describe("give-with-question-mark bug", () => {
  let gm: GoalManager;
  let hm: HighlightingManager;

  beforeEach(() => {
    gm = new GoalManager();
    hm = new HighlightingManager();
  });

  /**
   * Helper: set up the initial load state and return useful offsets.
   */
  function setupInitialLoad(doc: ReturnType<typeof mockDocument>, uri: string) {
    const text = doc.getText();
    const goal0Start = text.indexOf("{! ? !}");
    const goal0End = goal0Start + "{! ? !}".length;
    const goal1Start = text.indexOf("{!  !}");
    const goal1End = goal1Start + "{!  !}".length;

    const initialIPs: InteractionPointWithRange[] = [
      ipWithRange(0, goal0Start + 1, goal0End + 1),
      ipWithRange(1, goal1Start + 1, goal1End + 1),
    ];
    gm.updateGoals(doc, initialIPs);

    return { goal0Start, goal0End, goal1Start, goal1End };
  }

  /**
   * Simulate the give edit using the raw string (the fixed handleGiveAction
   * behavior), plus the onDidChangeTextDocument adjustment.
   *
   * Returns the Agda-view InteractionPoints for the post-give batch.
   */
  function simulateGiveEdit(
    doc: ReturnType<typeof mockDocument>,
    uri: string,
    offsets: ReturnType<typeof setupInitialLoad>,
  ) {
    const allGoals = gm.getAll(uri);
    const goal0Range = allGoals[0].range;

    // The fixed handleGiveAction writes the raw string, NOT expandQuestionMarks
    const replacement = "?";

    // Apply the edit to the document
    doc._replaceRange(goal0Range, replacement);

    // Simulate onDidChangeTextDocument handler
    const editChange = change(goal0Range, replacement);
    gm.adjustForEdits(uri, [editChange]);
    hm.adjustForEdits(uri, [editChange]);

    // Build the InteractionPoints as Agda sees them: the give replaced
    // {! ? !} (7 chars) with "?" (1 char), shifting everything after by -6.
    const agdaShrink = "{! ? !}".length - "?".length; // 6
    const postGiveIPs: InteractionPointWithRange[] = [
      ipWithRange(2, offsets.goal0Start + 1, offsets.goal0Start + 2), // new "?" goal
      ipWithRange(1, offsets.goal1Start + 1 - agdaShrink, offsets.goal1End + 1 - agdaShrink),
    ];

    return postGiveIPs;
  }

  // -------------------------------------------------------------------------
  // The old bug: expandQuestionMarks in handleGiveAction made offsets diverge
  // -------------------------------------------------------------------------

  it("old bug: expanding ? in handleGiveAction corrupts goal 1 position", () => {
    const uri = "file:///test/Test.agda";
    const doc = mockDocument(uri, INITIAL_TEXT);

    const offsets = setupInitialLoad(doc, uri);
    expect(doc.getText(gm.getAll(uri)[0].range)).toBe("{! ? !}");
    expect(doc.getText(gm.getAll(uri)[1].range)).toBe("{!  !}");

    // OLD (buggy) behavior: handleGiveAction calls expandQuestionMarks
    const goal0Range = gm.getAll(uri)[0].range;
    const buggyReplacement = expandQuestionMarks("?");
    expect(buggyReplacement).toBe(GOAL_MARKER); // "{!  !}" -- 6 chars, not 1

    doc._replaceRange(goal0Range, buggyReplacement);
    gm.adjustForEdits(uri, [change(goal0Range, buggyReplacement)]);

    // Now InteractionPoints arrives with Agda's offsets (based on "?" = 1 char)
    const agdaShrink = "{! ? !}".length - "?".length; // 6
    const postGiveIPs: InteractionPointWithRange[] = [
      ipWithRange(2, offsets.goal0Start + 1, offsets.goal0Start + 2),
      ipWithRange(1, offsets.goal1Start + 1 - agdaShrink, offsets.goal1End + 1 - agdaShrink),
    ];

    // Using forceScan=false trusts Agda's offsets -- which are now wrong
    gm.updateGoals(doc, postGiveIPs, false);

    const goal1 = gm.getAll(uri).find((g) => g.id === 1)!;
    expect(goal1).toBeDefined();

    // Bug: goal 1 points 5 characters too early
    expect(doc.getText(goal1.range)).not.toBe("{!  !}");
  });

  // -------------------------------------------------------------------------
  // The fix: write raw ?, let InteractionPoints expand it naturally
  // -------------------------------------------------------------------------

  it("fix: raw ? in give keeps offsets aligned, InteractionPoints expands naturally", () => {
    const uri = "file:///test/Test.agda";
    const doc = mockDocument(uri, INITIAL_TEXT);

    const offsets = setupInitialLoad(doc, uri);

    // Simulate give with raw "?" (the fixed behavior)
    const postGiveIPs = simulateGiveEdit(doc, uri, offsets);

    // After the give edit, the document has "?" where goal 0 was.
    // Agda's offsets match the document -- getText at the new goal's range
    // should return "?".
    const newGoalIp = postGiveIPs[0];
    const interval = newGoalIp.range[0];
    const newGoalStart = doc.positionAt((interval.start.pos as unknown as number) - 1);
    const newGoalEnd = doc.positionAt((interval.end.pos as unknown as number) - 1);
    expect(doc.getText(new Range(newGoalStart, newGoalEnd))).toBe("?");

    // Now simulate the InteractionPoints handler:
    // 1. It finds "?" at the Agda-specified offset → triggers expansion
    // 2. Expansion sets forceScan=true
    // 3. updateGoals scans the document for {! !} patterns

    // Step 1: detect the ? (simulating the getText(range) === "?" check)
    const questionMarks: Range[] = [];
    for (const ip of postGiveIPs) {
      if (ip.range.length > 0) {
        const iv = ip.range[0];
        const start = doc.positionAt((iv.start.pos as unknown as number) - 1);
        const end = doc.positionAt((iv.end.pos as unknown as number) - 1);
        const range = new Range(start, end);
        if (doc.getText(range) === "?") {
          questionMarks.push(range);
        }
      }
    }

    // The "?" from the give result should be detected
    expect(questionMarks).toHaveLength(1);

    // Step 2: expand ? → {!  !}
    for (const range of questionMarks) {
      doc._replaceRange(range, GOAL_MARKER);
      gm.adjustForEdits(uri, [change(range, GOAL_MARKER)]);
      hm.adjustForEdits(uri, [change(range, GOAL_MARKER)]);
    }

    // Step 3: updateGoals with forceScan=true
    gm.updateGoals(doc, postGiveIPs, true);

    const finalGoals = gm.getAll(uri);
    expect(finalGoals).toHaveLength(2);

    // Goal 2 (new goal from give) should be the {!  !} on line 5
    const goal2 = finalGoals.find((g) => g.id === 2)!;
    expect(goal2).toBeDefined();
    expect(doc.getText(goal2.range)).toBe("{!  !}");
    expect(goal2.range.start.line).toBe(5);

    // Goal 1 (original second goal) should still be {!  !} on line 7
    const goal1 = finalGoals.find((g) => g.id === 1)!;
    expect(goal1).toBeDefined();
    expect(doc.getText(goal1.range)).toBe("{!  !}");
    expect(goal1.range.start.line).toBe(7);
  });

  it("fix: highlighting offsets remain valid after give-with-?", () => {
    const uri = "file:///test/Test.agda";
    const doc = mockDocument(uri, INITIAL_TEXT);
    const text = doc.getText();

    const offsets = setupInitialLoad(doc, uri);

    // Apply initial highlighting for "thing" on line 7
    const thingStart = text.indexOf("thing : {!");
    const thingEnd = thingStart + "thing".length;
    const mockEditor = { document: doc, setDecorations: () => {} } as any;
    hm.applyHighlighting(mockEditor, {
      remove: false,
      payload: [
        {
          range: [toAgdaOffset(thingStart + 1), toAgdaOffset(thingEnd + 1)],
          atoms: ["function"],
          tokenBased: "TokenBased",
          note: "",
          definitionSite: null,
        },
      ],
    });

    // Simulate give with raw "?" (the fixed behavior)
    const postGiveIPs = simulateGiveEdit(doc, uri, offsets);

    // After the give, Agda sends re-highlighting with offsets based on its
    // document.  Now those offsets MATCH the VS Code document (since we
    // wrote raw "?", not "{!  !}").
    const agdaShrink = "{! ? !}".length - "?".length;
    const agdaThingStart = thingStart + 1 - agdaShrink;
    const agdaThingEnd = thingEnd + 1 - agdaShrink;

    hm.applyHighlighting(mockEditor, {
      remove: true,
      payload: [
        {
          range: [toAgdaOffset(agdaThingStart), toAgdaOffset(agdaThingEnd)],
          atoms: ["function"],
          tokenBased: "TokenBased",
          note: "",
          definitionSite: null,
        },
      ],
    });

    // The highlighting should land at the correct position
    const tokens = hm.provideDocumentSemanticTokens(doc);
    expect(tokens.data.length).toBeGreaterThanOrEqual(5);

    const tokenLine = tokens.data[0];
    const tokenCol = tokens.data[1];
    const tokenLen = tokens.data[2];

    expect(tokenLine).toBe(7); // "thing" is on line 7
    expect(tokenCol).toBe(0); // starts at col 0
    expect(tokenLen).toBe("thing".length); // 5 characters
  });
});
