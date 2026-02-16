/**
 * Unit tests for src/core/goals.ts — goal management, clearing on edit,
 * and the {! !} hole scanner.
 *
 * Uses the vscode mock in test/__mocks__/vscode.ts via the vitest alias.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Range, Position } from "vscode";
import { GoalManager, GOAL_MARKER, expandQuestionMarks } from "../src/core/goals.js";
import type { InteractionPointWithRange } from "../src/agda/responses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock document for updateGoals with forceScan. */
function mockDocument(uri: string, text: string) {
  const lines = text.split("\n");

  function offsetAt(pos: Position): number {
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    return offset + pos.character;
  }

  return {
    uri: { toString: () => uri },
    getText(range?: Range) {
      if (!range) return text;
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    positionAt(offset: number) {
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
    },
  } as any;
}

/** Build an InteractionPointWithRange with no Agda range (forces scan). */
function ip(id: number): InteractionPointWithRange {
  return { id, range: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GoalManager", () => {
  let gm: GoalManager;

  beforeEach(() => {
    gm = new GoalManager();
  });

  // -- updateGoals + forceScan (exercises findHoleRanges) -------------------

  describe("updateGoals with forceScan", () => {
    it("finds a single {!!} hole", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].id).toBe(0);
      expect(goals[0].range.start.line).toBe(0);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(8);
    });

    it("finds multiple holes", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!} + {!!}");
      gm.updateGoals(doc, [ip(0), ip(1)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(2);
      expect(goals[0].id).toBe(0);
      expect(goals[1].id).toBe(1);
    });

    it("finds holes on multiple lines", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}\ng = {!!}");
      gm.updateGoals(doc, [ip(0), ip(1)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(2);
      expect(goals[0].range.start.line).toBe(0);
      expect(goals[1].range.start.line).toBe(1);
    });

    it("handles nested holes", () => {
      // {! {!!} !} is a nested hole — only the outermost counts
      const doc = mockDocument("file:///a.agda", "f = {! {!!} !}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(14);
    });

    it("skips holes inside line comments", () => {
      const doc = mockDocument("file:///a.agda", "-- {!!}\nf = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
    });

    it("skips holes inside block comments", () => {
      const doc = mockDocument("file:///a.agda", "{- {!!} -}\nf = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
    });

    it("skips holes inside string literals", () => {
      const doc = mockDocument("file:///a.agda", 'f = "{!!}" ++ {!!}');
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      // The real hole starts after the string
      expect(goals[0].range.start.character).toBe(14);
    });

    it("handles hole with content", () => {
      const doc = mockDocument("file:///a.agda", "f = {! x + y !}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(15);
    });

    it("returns empty when no interaction points", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("limits goals to min(interactionPoints, holeRanges)", () => {
      // More IPs than holes — only pairs up what it can
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0), ip(1), ip(2)], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(1);
    });

    it("finds spaced GOAL_MARKER form", () => {
      const doc = mockDocument("file:///a.agda", `f = ${GOAL_MARKER}`);
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(4 + GOAL_MARKER.length);
    });

    it("extracts empty content from GOAL_MARKER", () => {
      const doc = mockDocument("file:///a.agda", `f = ${GOAL_MARKER}`);
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(gm.getGoalContent(goals[0], doc)).toBe("");
    });
  });

  // -- findHoleRanges edge cases --------------------------------------------

  describe("findHoleRanges tricky cases", () => {
    it("nested block comments hide holes", () => {
      // {- {- {!!} -} -} should hide the hole entirely
      const doc = mockDocument("file:///a.agda", "{- {- {!!} -} -}\nf = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
    });

    it("block comment with multiple close markers", () => {
      // Only the matching -} closes the comment
      const doc = mockDocument("file:///a.agda", "{- -} {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(6);
    });

    it("line comment does not extend past newline", () => {
      const doc = mockDocument("file:///a.agda", "-- comment\n{!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
    });

    it("line comment at end of file with no newline hides trailing hole", () => {
      const doc = mockDocument("file:///a.agda", "-- {!!}");
      gm.updateGoals(doc, [], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("deeply nested holes produce one outer range", () => {
      // {! {! {!!} !} !} — three nesting levels, one outermost hole
      const doc = mockDocument("file:///a.agda", "f = {! {! {!!} !} !}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(20);
    });

    it("adjacent holes are separate", () => {
      const doc = mockDocument("file:///a.agda", "{!!}{!!}");
      gm.updateGoals(doc, [ip(0), ip(1)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(2);
      expect(goals[0].range.start.character).toBe(0);
      expect(goals[0].range.end.character).toBe(4);
      expect(goals[1].range.start.character).toBe(4);
      expect(goals[1].range.end.character).toBe(8);
    });

    it("string with escaped quote does not leak", () => {
      // "hello\"world" should not confuse the parser
      const doc = mockDocument("file:///a.agda", 'f = "he\\"llo{!" ++ {!!}');
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(19);
    });

    it("{- inside a hole does not start a block comment", () => {
      // Holes take priority over block comments once inside {! ... !}
      const doc = mockDocument("file:///a.agda", "f = {! {- !}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(12);
    });

    it("{-! is not treated as a block comment opener", () => {
      // Agda uses {-! for pragmas — should not start a comment
      // The code checks for {- followed by non-! to avoid this
      const doc = mockDocument("file:///a.agda", "{-! BUILTIN !-}\nf = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
    });

    it("unmatched !} outside a hole is ignored", () => {
      const doc = mockDocument("file:///a.agda", "!} {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(3);
    });

    it("unclosed hole produces no range", () => {
      const doc = mockDocument("file:///a.agda", "f = {! oops");
      gm.updateGoals(doc, [], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("multiline hole", () => {
      const text = "f = {!\n  zero\n!}";
      const doc = mockDocument("file:///a.agda", text);
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(0);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.line).toBe(2);
      expect(goals[0].range.end.character).toBe(2);
    });

    it("block comment between two holes", () => {
      const doc = mockDocument("file:///a.agda", "{!!} {- comment -} {!!}");
      gm.updateGoals(doc, [ip(0), ip(1)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(2);
      expect(goals[0].range.start.character).toBe(0);
      expect(goals[1].range.start.character).toBe(19);
    });

    it("empty block comment immediately before hole", () => {
      const doc = mockDocument("file:///a.agda", "{--}{!!}");
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
    });

    it("string literal inside a hole is not special", () => {
      // Inside a hole, strings are not parsed — everything is literal until !}
      const doc = mockDocument("file:///a.agda", '{! "hello" !}');
      gm.updateGoals(doc, [ip(0)], true);
      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(0);
      expect(goals[0].range.end.character).toBe(13);
    });
  });

  // -- clear ----------------------------------------------------------------

  describe("clear", () => {
    it("clears goals for a URI that has goals", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(1);

      gm.clear("file:///a.agda");
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("is idempotent — second call is a no-op", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      gm.clear("file:///a.agda");
      gm.clear("file:///a.agda"); // no-op
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("is a no-op for unknown URIs", () => {
      gm.clear("file:///unknown.agda"); // should not throw
      expect(gm.getAll("file:///unknown.agda")).toHaveLength(0);
    });

    it("does not affect goals for other URIs", () => {
      const docA = mockDocument("file:///a.agda", "f = {!!}");
      const docB = mockDocument("file:///b.agda", "g = {!!}");
      gm.updateGoals(docA, [ip(0)], true);
      gm.updateGoals(docB, [ip(1)], true);

      gm.clear("file:///a.agda");
      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
      expect(gm.getAll("file:///b.agda")).toHaveLength(1);
    });
  });

  // -- getGoalAt after clearing --------------------------------------------

  describe("getGoalAt after clearing", () => {
    it("returns undefined after clear", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Goal exists before clearing
      const before = gm.getGoalAt("file:///a.agda", new Position(0, 5));
      expect(before).toBeDefined();
      expect(before!.id).toBe(0);

      gm.clear("file:///a.agda");

      const after = gm.getGoalAt("file:///a.agda", new Position(0, 5));
      expect(after).toBeUndefined();
    });
  });

  // -- nextGoal / previousGoal after clearing ------------------------------

  describe("navigation after clearing", () => {
    it("nextGoal returns undefined after clearing", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      expect(gm.nextGoal("file:///a.agda", new Position(0, 0))).toBeDefined();

      gm.clear("file:///a.agda");
      expect(gm.nextGoal("file:///a.agda", new Position(0, 0))).toBeUndefined();
    });

    it("previousGoal returns undefined after clearing", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      expect(gm.previousGoal("file:///a.agda", new Position(0, 10))).toBeDefined();

      gm.clear("file:///a.agda");
      expect(gm.previousGoal("file:///a.agda", new Position(0, 10))).toBeUndefined();
    });
  });

  // -- adjustForEdits -------------------------------------------------------

  describe("adjustForEdits", () => {
    /** Build a fake TextDocumentContentChangeEvent. */
    function change(sl: number, sc: number, el: number, ec: number, text: string) {
      return {
        range: new Range(sl, sc, el, ec),
        rangeOffset: 0,
        rangeLength: 0,
        text,
      };
    }

    it("typing inside a goal preserves the goal (range grows)", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Type "zero" at position (0,6) — inside the goal: {!zero!}
      // Edit: replace (0,6)-(0,6) with "zero"
      gm.adjustForEdits("file:///a.agda", [change(0, 6, 0, 6, "zero")]);

      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].id).toBe(0);
    });

    it("typing before a goal shifts it right", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Insert "xx" at (0,0): "xxf = {!!}"
      gm.adjustForEdits("file:///a.agda", [change(0, 0, 0, 0, "xx")]);

      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(6); // 4 + 2
      expect(goals[0].range.end.character).toBe(10); // 8 + 2
    });

    it("typing after a goal leaves it unchanged", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Insert " -- comment" at (0,8): "f = {!!} -- comment"
      gm.adjustForEdits("file:///a.agda", [change(0, 8, 0, 8, " -- comment")]);

      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.character).toBe(4);
      expect(goals[0].range.end.character).toBe(8);
    });

    it("deleting a goal removes it but preserves others", () => {
      // "f = {!!}\ng = {!!}" — two goals
      const doc = mockDocument("file:///a.agda", "f = {!!}\ng = {!!}");
      gm.updateGoals(doc, [ip(0), ip(1)], true);
      expect(gm.getAll("file:///a.agda")).toHaveLength(2);

      // Delete first goal: replace (0,4)-(0,8) with "zero"
      gm.adjustForEdits("file:///a.agda", [change(0, 4, 0, 8, "zero")]);

      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].id).toBe(1); // second goal survives
    });

    it("inserting a newline before a goal shifts it down", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Insert newline at (0,0): "\nf = {!!}"
      gm.adjustForEdits("file:///a.agda", [change(0, 0, 0, 0, "\n")]);

      const goals = gm.getAll("file:///a.agda");
      expect(goals).toHaveLength(1);
      expect(goals[0].range.start.line).toBe(1);
      expect(goals[0].range.start.character).toBe(4);
    });

    it("is a no-op for URIs with no goals", () => {
      // Should not throw
      gm.adjustForEdits("file:///unknown.agda", [change(0, 0, 0, 0, "x")]);
      expect(gm.getAll("file:///unknown.agda")).toHaveLength(0);
    });

    it("removes all goals when all are intersected, cleans up map entry", () => {
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Delete everything: replace (0,0)-(0,8) with ""
      gm.adjustForEdits("file:///a.agda", [change(0, 0, 0, 8, "")]);

      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("deleting opening ! from {!!} removes the goal", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Delete the ! at (0,5): "f = {!}" → "f = {}": edit (0,5)-(0,6) → ""
      gm.adjustForEdits("file:///a.agda", [change(0, 5, 0, 6, "")]);

      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("deleting closing ! from {!!} removes the goal", () => {
      // "f = {!!}" — goal at (0,4)-(0,8)
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Delete the ! at (0,6): "f = {!!}" → "f = {!}": edit (0,6)-(0,7) → ""
      gm.adjustForEdits("file:///a.agda", [change(0, 6, 0, 7, "")]);

      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("deleting ! from spaced {!  !} removes the goal", () => {
      // "f = {!  !}" — goal at (0,4)-(0,10)
      const doc = mockDocument("file:///a.agda", "f = {!  !}");
      gm.updateGoals(doc, [ip(0)], true);

      // Delete the ! at (0,8): edit (0,8)-(0,9) → ""
      gm.adjustForEdits("file:///a.agda", [change(0, 8, 0, 9, "")]);

      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });

    it("give replacement: replace goal range with result text removes the goal", () => {
      // Simulates handleGiveAction: replace {!!} with "zero"
      const doc = mockDocument("file:///a.agda", "f = {!!}");
      gm.updateGoals(doc, [ip(0)], true);

      // Replace (0,4)-(0,8) with "zero" — entire goal range
      gm.adjustForEdits("file:///a.agda", [change(0, 4, 0, 8, "zero")]);

      expect(gm.getAll("file:///a.agda")).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// expandQuestionMarks (free function, no GoalManager needed)
// ---------------------------------------------------------------------------

describe("expandQuestionMarks", () => {
  const M = GOAL_MARKER; // "{!  !}"

  it("expands lone ? separated by spaces", () => {
    expect(expandQuestionMarks("add ? ?")).toBe(`add ${M} ${M}`);
  });

  it("returns unchanged text with no ?", () => {
    expect(expandQuestionMarks("zero")).toBe("zero");
  });

  it("expands a single lone ?", () => {
    expect(expandQuestionMarks("?")).toBe(M);
  });

  it("expands ? in parenthesized expression with spaces", () => {
    expect(expandQuestionMarks("f ? (suc ? )")).toBe(`f ${M} (suc ${M} )`);
  });

  it("expands ? adjacent to parens (parens are delimiters in Agda)", () => {
    expect(expandQuestionMarks("(suc ?)")).toBe(`(suc ${M})`);
  });

  it("does not expand ? adjacent to non-whitespace (?x)", () => {
    expect(expandQuestionMarks("?x")).toBe("?x");
  });

  it("does not expand ? adjacent to non-whitespace (x?)", () => {
    expect(expandQuestionMarks("x?")).toBe("x?");
  });

  it("does not expand ? surrounded by non-whitespace (f?g)", () => {
    expect(expandQuestionMarks("f?g")).toBe("f?g");
  });

  it("does not expand ? inside a line comment", () => {
    expect(expandQuestionMarks("x -- ?")).toBe("x -- ?");
  });

  it("does not expand ? inside a block comment", () => {
    expect(expandQuestionMarks("{- ? -} ?")).toBe(`{- ? -} ${M}`);
  });

  it("does not expand ? inside a string literal", () => {
    expect(expandQuestionMarks('"?" ?')).toBe(`"?" ${M}`);
  });

  it("handles escaped quote in string literal", () => {
    expect(expandQuestionMarks('"\\\"?" ?')).toBe(`"\\\"?" ${M}`);
  });

  it("expands ? in typical case split clause", () => {
    expect(expandQuestionMarks("add (suc n) m = ?")).toBe(`add (suc n) m = ${M}`);
  });

  it("does not expand ? inside an existing hole", () => {
    expect(expandQuestionMarks("{! ? !}")).toBe("{! ? !}");
  });

  it("expands ? at start and end of text", () => {
    expect(expandQuestionMarks("? + ?")).toBe(`${M} + ${M}`);
  });

  it("returns empty string unchanged", () => {
    expect(expandQuestionMarks("")).toBe("");
  });

  it("handles multiple ? with various separators", () => {
    expect(expandQuestionMarks("f ? , ? ; ?")).toBe(`f ${M} , ${M} ; ${M}`);
  });

  it("expands ? immediately after opening paren", () => {
    expect(expandQuestionMarks("(?)")).toBe(`(${M})`);
  });

  it("expands ? adjacent to braces (braces are delimiters in Agda)", () => {
    expect(expandQuestionMarks("f {?}")).toBe(`f {${M}}`);
  });

  it("expands ? between parens with no spaces", () => {
    expect(expandQuestionMarks("(?(?)?)")).toBe(`(${M}(${M})${M})`);
  });
});
