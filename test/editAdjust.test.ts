/**
 * Unit tests for src/util/editAdjust.ts — the edit-adjustment math that keeps
 * stored highlighting in sync with document edits.
 *
 * Uses the vscode mock in test/__mocks__/vscode.ts via the vitest alias.
 */

import { describe, it, expect } from "vitest";
import { Range, Position } from "vscode";
import {
  processChanges,
  adjustRange,
  adjustRangeContaining,
  expandRange,
  computeSingleChange,
  reconstructPreText,
  type EditParams,
} from "../src/util/editAdjust.js";
import { GOAL_MARKER } from "../src/core/goals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build a Range. */
function r(sl: number, sc: number, el: number, ec: number): Range {
  return new Range(sl, sc, el, ec);
}

/** Shorthand to build an EditParams directly (bypassing processChanges). */
function edit(
  sl: number,
  sc: number,
  el: number,
  ec: number,
  lineDelta: number,
  newEndChar: number,
): EditParams {
  return { editRange: r(sl, sc, el, ec), lineDelta, newEndChar };
}

/** Build a fake TextDocumentContentChangeEvent for processChanges. */
function change(sl: number, sc: number, el: number, ec: number, text: string) {
  return {
    range: r(sl, sc, el, ec),
    rangeOffset: 0,
    rangeLength: 0,
    text,
  };
}

/** Assert two ranges have equal coordinates. */
function expectRange(actual: Range | null, sl: number, sc: number, el: number, ec: number) {
  expect(actual).not.toBeNull();
  expect(actual!.start.line).toBe(sl);
  expect(actual!.start.character).toBe(sc);
  expect(actual!.end.line).toBe(el);
  expect(actual!.end.character).toBe(ec);
}

// ---------------------------------------------------------------------------
// processChanges
// ---------------------------------------------------------------------------

describe("processChanges", () => {
  it("computes lineDelta and newEndChar for a single-line insertion", () => {
    // Insert "abc" at (2, 5) — replaces nothing
    const result = processChanges([change(2, 5, 2, 5, "abc")]);
    expect(result).toHaveLength(1);
    expect(result[0].lineDelta).toBe(0);
    expect(result[0].newEndChar).toBe(8); // 5 + 3
  });

  it("computes lineDelta for a multi-line insertion", () => {
    // Insert "abc\ndef" at (1, 0) — 1 new line
    const result = processChanges([change(1, 0, 1, 0, "abc\ndef")]);
    expect(result).toHaveLength(1);
    expect(result[0].lineDelta).toBe(1);
    expect(result[0].newEndChar).toBe(3); // "def".length
  });

  it("computes negative lineDelta for line deletion", () => {
    // Delete from (1, 0) to (3, 0) — removes 2 lines, replaces with nothing
    const result = processChanges([change(1, 0, 3, 0, "")]);
    expect(result).toHaveLength(1);
    expect(result[0].lineDelta).toBe(-2);
    expect(result[0].newEndChar).toBe(0); // start.character + "".length
  });

  it("sorts changes in reverse document order", () => {
    const result = processChanges([
      change(1, 0, 1, 1, "x"),
      change(5, 0, 5, 1, "y"),
      change(3, 0, 3, 1, "z"),
    ]);
    expect(result).toHaveLength(3);
    // Should be sorted: line 5, line 3, line 1
    expectRange(result[0].editRange, 5, 0, 5, 1);
    expectRange(result[1].editRange, 3, 0, 3, 1);
    expectRange(result[2].editRange, 1, 0, 1, 1);
  });

  it("handles ? → goal marker expansion (replace 1 char with GOAL_MARKER)", () => {
    // Replace "?" at (3, 10)-(3, 11) with GOAL_MARKER ("{!  !}", 6 chars)
    const result = processChanges([change(3, 10, 3, 11, GOAL_MARKER)]);
    expect(result).toHaveLength(1);
    expect(result[0].lineDelta).toBe(0);
    expect(result[0].newEndChar).toBe(10 + GOAL_MARKER.length); // 16
  });
});

// ---------------------------------------------------------------------------
// adjustRange — for arbitrary user edits
// ---------------------------------------------------------------------------

describe("adjustRange", () => {
  describe("range entirely before edit", () => {
    it("returns unchanged range", () => {
      const range = r(0, 0, 0, 5);
      const ed = edit(1, 0, 1, 3, 0, 5); // edit on line 1
      const result = adjustRange(range, ed);
      expectRange(result, 0, 0, 0, 5);
    });

    it("returns unchanged when range.end == edit.start", () => {
      const range = r(0, 0, 1, 0);
      const ed = edit(1, 0, 1, 3, 0, 5);
      const result = adjustRange(range, ed);
      expectRange(result, 0, 0, 1, 0);
    });
  });

  describe("range entirely after edit", () => {
    it("shifts range on a different line", () => {
      const range = r(5, 2, 5, 8);
      // Edit on line 3: delete 3 chars, insert 5 chars — same line, +0 lines
      const ed = edit(3, 0, 3, 3, 0, 5);
      const result = adjustRange(range, ed);
      expectRange(result, 5, 2, 5, 8); // different line, no char shift
    });

    it("shifts line when edit adds lines", () => {
      const range = r(3, 0, 3, 10);
      // Insert a newline at (1, 5): lineDelta = +1
      const ed = edit(1, 5, 1, 5, 1, 0);
      const result = adjustRange(range, ed);
      expectRange(result, 4, 0, 4, 10); // shifted down by 1 line
    });

    it("shifts line when edit removes lines", () => {
      const range = r(5, 0, 5, 10);
      // Delete lines 2-3: lineDelta = -2
      const ed = edit(2, 0, 4, 0, -2, 0);
      const result = adjustRange(range, ed);
      expectRange(result, 3, 0, 3, 10); // shifted up by 2 lines
    });

    it("shifts character when range.start is on the edit end line", () => {
      const range = r(2, 10, 2, 15);
      // Edit on line 2: replace chars 3-5 with "abcdef" (3→6 chars)
      // editRange (2,3)-(2,5), newEndChar = 9, lineDelta = 0
      const ed = edit(2, 3, 2, 5, 0, 9);
      const result = adjustRange(range, ed);
      // start: char 10 - 5 + 9 = 14; end: char 15 - 5 + 9 = 19
      expectRange(result, 2, 14, 2, 19);
    });
  });

  describe("range intersects edit", () => {
    it("returns null for partial overlap from the left", () => {
      const range = r(1, 5, 1, 15);
      const ed = edit(1, 10, 1, 20, 0, 15);
      expect(adjustRange(range, ed)).toBeNull();
    });

    it("returns null for partial overlap from the right", () => {
      const range = r(1, 10, 1, 20);
      const ed = edit(1, 5, 1, 15, 0, 10);
      expect(adjustRange(range, ed)).toBeNull();
    });

    it("returns null when edit is inside range", () => {
      const range = r(1, 0, 1, 20);
      const ed = edit(1, 5, 1, 10, 0, 8);
      expect(adjustRange(range, ed)).toBeNull();
    });

    it("returns null when range is inside edit", () => {
      const range = r(1, 5, 1, 10);
      const ed = edit(1, 0, 1, 20, 0, 5);
      expect(adjustRange(range, ed)).toBeNull();
    });

    it("returns null for multi-line overlap", () => {
      const range = r(2, 0, 4, 5);
      const ed = edit(3, 0, 5, 0, -2, 0);
      expect(adjustRange(range, ed)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("range.start == edit.end → shifts (not intersection)", () => {
      const range = r(1, 5, 1, 10);
      // Edit ends exactly where range starts
      const ed = edit(1, 0, 1, 5, 0, 8);
      const result = adjustRange(range, ed);
      // start: char 5 - 5 + 8 = 8; end: char 10 - 5 + 8 = 13
      expectRange(result, 1, 8, 1, 13);
    });

    it("zero-width range after edit → shifts", () => {
      const range = r(1, 10, 1, 10);
      const ed = edit(1, 0, 1, 5, 0, 8);
      const result = adjustRange(range, ed);
      expectRange(result, 1, 13, 1, 13);
    });

    it("zero-width edit (pure insertion) before range → shifts", () => {
      const range = r(1, 10, 1, 15);
      const ed = edit(1, 5, 1, 5, 0, 8); // insert 3 chars at (1,5)
      const result = adjustRange(range, ed);
      expectRange(result, 1, 13, 1, 18);
    });
  });
});

// ---------------------------------------------------------------------------
// expandRange — for ? → goal marker expansion
// ---------------------------------------------------------------------------

describe("expandRange", () => {
  // Typical scenario: "?" is at (3, 10)-(3, 11), replaced with GOAL_MARKER
  // ("{!  !}", 6 chars) → (3, 10)-(3, 16)
  // editRange: (3, 10)-(3, 11), lineDelta: 0, newEndChar: 10 + GOAL_MARKER.length = 16
  const newEnd = 10 + GOAL_MARKER.length; // 16
  const qExpand = edit(3, 10, 3, 11, 0, newEnd);

  it("range entirely before insertion point → unchanged", () => {
    const range = r(0, 0, 0, 10);
    const result = expandRange(range, qExpand);
    expect(result).toBe(range); // same reference — no change
  });

  it("range entirely after insertion point → shifts by delta", () => {
    const range = r(3, 15, 3, 20);
    const result = expandRange(range, qExpand);
    // insertionPoint is (3, 11). Both start and end are after.
    // start: char 15 - 11 + newEnd = 20; end: char 20 - 11 + newEnd = 25
    expectRange(result, 3, 15 - 11 + newEnd, 3, 20 - 11 + newEnd);
  });

  it("range covering ? → grows to cover goal marker", () => {
    // The "hole" decoration covering "?" exactly
    const range = r(3, 10, 3, 11);
    const result = expandRange(range, qExpand);
    // start (3,10) is before insertionPoint (3,11) → unchanged
    // end (3,11) is at insertionPoint → shift: 11 - 11 + newEnd = newEnd
    expectRange(result, 3, 10, 3, newEnd);
  });

  it("range starting before ? and ending after → grows", () => {
    const range = r(3, 5, 3, 20);
    const result = expandRange(range, qExpand);
    // start (3,5) before insertionPoint → unchanged
    // end (3,20) after insertionPoint → 20 - 11 + newEnd = 25
    expectRange(result, 3, 5, 3, 20 - 11 + newEnd);
  });

  it("range on a different line after edit → shifted by lineDelta only", () => {
    // Multi-line expansion (rare but possible): insert "{\n!\n!}" replacing "?"
    // editRange: (5, 3)-(5, 4), lineDelta: 2, newEndChar: 2
    const multiLineExpand = edit(5, 3, 5, 4, 2, 2);
    const range = r(7, 0, 7, 10);
    const result = expandRange(range, multiLineExpand);
    // Both start/end are after insertionPoint (5,4), different line
    expectRange(result, 9, 0, 9, 10);
  });

  it("range ending exactly at insertion point → grows", () => {
    // Range ends at exactly the insertion point (end of ?)
    const range = r(3, 8, 3, 11);
    const result = expandRange(range, qExpand);
    // start (3,8) before (3,11) → unchanged
    // end (3,11) at insertionPoint → 11 - 11 + newEnd = newEnd
    expectRange(result, 3, 8, 3, newEnd);
  });

  it("range starting at insertion point → shifts", () => {
    // Range starts at the insertion point
    const range = r(3, 11, 3, 15);
    const result = expandRange(range, qExpand);
    // start (3,11) is NOT before (3,11) → shift: 11 - 11 + newEnd = newEnd
    // end (3,15) is after → shift: 15 - 11 + newEnd = newEnd + 4
    expectRange(result, 3, newEnd, 3, 15 - 11 + newEnd);
  });
});

// ---------------------------------------------------------------------------
// Integration: processChanges + adjustRange
// ---------------------------------------------------------------------------

describe("processChanges + adjustRange integration", () => {
  it("typing a character shifts subsequent ranges", () => {
    // User types "x" at (2, 5) — inserts 1 char
    const changes = [change(2, 5, 2, 5, "x")];
    const edits = processChanges(changes);
    expect(edits).toHaveLength(1);

    // Range before insertion → unchanged
    expectRange(adjustRange(r(2, 0, 2, 3), edits[0]), 2, 0, 2, 3);

    // Range after insertion → shifted right by 1
    expectRange(adjustRange(r(2, 10, 2, 15), edits[0]), 2, 11, 2, 16);

    // Range containing insertion point → removed
    expect(adjustRange(r(2, 3, 2, 8), edits[0])).toBeNull();
  });

  it("deleting a line shifts subsequent ranges up", () => {
    // Delete entire line 3 (newline-to-newline)
    const changes = [change(3, 0, 4, 0, "")];
    const edits = processChanges(changes);

    // Range on line 5 → moved to line 4
    expectRange(adjustRange(r(5, 0, 5, 10), edits[0]), 4, 0, 4, 10);

    // Range on line 3 → intersects → removed
    expect(adjustRange(r(3, 2, 3, 8), edits[0])).toBeNull();
  });

  it("multiple changes processed in reverse order", () => {
    // Two insertions: "a" at (1, 0) and "b" at (5, 0)
    const changes = [change(1, 0, 1, 0, "a"), change(5, 0, 5, 0, "b")];
    const edits = processChanges(changes);

    // processChanges sorts in reverse: line 5 first, then line 1
    expectRange(edits[0].editRange, 5, 0, 5, 0);
    expectRange(edits[1].editRange, 1, 0, 1, 0);

    // Apply both edits to a range on line 7
    let range: Range | null = r(7, 0, 7, 10);
    for (const ed of edits) {
      range = adjustRange(range!, ed);
    }
    // Neither edit intersects line 7; both are zero-width insertions on earlier lines
    // But the range is on a different line from both edits, so no char shift — just stays
    expectRange(range, 7, 0, 7, 10);
  });
});

// ---------------------------------------------------------------------------
// computeSingleChange — undo/redo collation
// ---------------------------------------------------------------------------

describe("computeSingleChange", () => {
  it("returns null for identical texts", () => {
    expect(computeSingleChange("hello", "hello")).toBeNull();
  });

  it("detects a simple insertion", () => {
    const result = computeSingleChange("ab", "aXb");
    expect(result).not.toBeNull();
    // In the before-text "ab", the changed region is [1, 1) (empty) → "X"
    expectRange(result!.range, 0, 1, 0, 1);
    expect(result!.text).toBe("X");
    expect(result!.rangeLength).toBe(0);
  });

  it("detects a simple deletion", () => {
    const result = computeSingleChange("aXb", "ab");
    expect(result).not.toBeNull();
    // In the before-text "aXb", the changed region is [1, 2) → ""
    expectRange(result!.range, 0, 1, 0, 2);
    expect(result!.text).toBe("");
    expect(result!.rangeLength).toBe(1);
  });

  it("detects a replacement", () => {
    const result = computeSingleChange("foo = id {!  !}\n", "foo = {! id ? !}\n");
    expect(result).not.toBeNull();
    // Common prefix: "foo = " (6 chars)
    // Common suffix: " !}\n" (4 chars)
    // Before changed region: "id {! " (offset 6..12)
    // After changed region: "{! id ?" (offset 6..13)
    expectRange(result!.range, 0, 6, 0, 12);
    expect(result!.text).toBe("{! id ?");
    expect(result!.rangeLength).toBe(6);
  });

  it("handles multi-line changes", () => {
    const result = computeSingleChange("a\nb\nc", "a\nX\nc");
    expect(result).not.toBeNull();
    // Common prefix: "a\n" (2 chars, up to line 1 col 0)
    // Common suffix: "\nc" (2 chars)
    // Before changed region: "b" (line 1, col 0..1)
    // After changed region: "X"
    expectRange(result!.range, 1, 0, 1, 1);
    expect(result!.text).toBe("X");
  });

  it("handles give→undo scenario (the core bug)", () => {
    // Post-give text: "foo = id {!  !}\n"
    // Pre-give text (restored by undo): "foo = {! id ? !}\n"
    // The merged change should cross the goal boundary at col 9.
    const postGive = "foo = id {!  !}\n";
    const preGive = "foo = {! id ? !}\n";

    const result = computeSingleChange(postGive, preGive);
    expect(result).not.toBeNull();

    // Common prefix: "foo = " (6 chars)
    // Common suffix: " !}\n" (4 chars)
    // In the before-text (postGive), the changed region is [6, 12) = "id {! "
    // After changed region: "{! id ?" (7 chars)
    // This crosses the goal boundary at col 9, so adjustRangeContaining
    // will correctly remove the goal.
    expectRange(result!.range, 0, 6, 0, 12);
    expect(result!.text).toBe("{! id ?");

    // Verify that this change WOULD remove a goal at [0:9, 0:15]
    // The goal {!  !} is at [9,15] in the pre-change doc (postGive).
    // The edit replaces [6,12) — which starts before the goal and ends
    // inside it, crossing the left boundary.
    const goalRange = r(0, 9, 0, 15);
    const editParams = processChanges([result!])[0];
    expect(adjustRangeContaining(goalRange, editParams, 2)).toBeNull();
  });

  it("holeAware shrinks prefix past {! when change is interior-only", () => {
    // When Agda gives back just ?, the give edit replaces {! expr !} with
    // {!  !}. Undo restores the original. The minimal diff has {! in the
    // prefix and !} in the suffix, making the change look interior-only.
    // With holeAware=true, the prefix is shrunk to before the {!.
    const postGive = "foo {!  !} bar";
    const preGive = "foo {! id ? !} bar";

    // Without holeAware: interior-only insertion
    const naive = computeSingleChange(postGive, preGive);
    expect(naive).not.toBeNull();
    // prefix="foo {! " (7), suffix=" !} bar" (7) → insert "id ?" at col 7
    expectRange(naive!.range, 0, 7, 0, 7);
    expect(naive!.text).toBe("id ?");

    // With holeAware: prefix shrunk to "foo " (4)
    const aware = computeSingleChange(postGive, preGive, true);
    expect(aware).not.toBeNull();
    expectRange(aware!.range, 0, 4, 0, 7);
    expect(aware!.text).toBe("{! id ?");

    // The aware change crosses the goal boundary
    const goalRange = r(0, 4, 0, 10); // {!  !} at col 4..10
    const editParams = processChanges([aware!])[0];
    expect(adjustRangeContaining(goalRange, editParams, 2)).toBeNull();
  });

  it("holeAware does not shrink when there is no matching !} in suffix", () => {
    // If the suffix doesn't contain !}, no shrinking needed
    const result = computeSingleChange("foo {! ab", "foo {! XY", true);
    expect(result).not.toBeNull();
    expectRange(result!.range, 0, 7, 0, 9);
    expect(result!.text).toBe("XY");
  });

  it("holeAware handles nested {! !} in prefix correctly", () => {
    // Nested and fully matched {! !} in the prefix shouldn't trigger shrinking
    const result = computeSingleChange("foo {! x !} {!  !} bar", "foo {! x !} {! y !} bar", true);
    expect(result).not.toBeNull();
    // prefix="foo {! x !} {! " (15), suffix=" !} bar" (7)
    // The {! x !} in the prefix is fully matched. The second {! is unmatched.
    // Suffix has unmatched !}. Shrink to before the second {! (pos 12).
    expectRange(result!.range, 0, 12, 0, 15);
    expect(result!.text).toBe("{! y");
  });
});

// ---------------------------------------------------------------------------
// reconstructPreText — recover pre-change text for native undo collation
// ---------------------------------------------------------------------------

describe("reconstructPreText", () => {
  it("reconstructs pre-text for a single insertion", () => {
    // Before: "ab", after inserting "X" at offset 1: "aXb"
    // The change: rangeOffset=1, rangeLength=0, text="X"
    const postText = "aXb";
    const pre = reconstructPreText(postText, [
      { range: r(0, 1, 0, 1), rangeOffset: 1, rangeLength: 0, text: "X" },
    ]);
    // Pre-text should be "ab" (rangeLength=0, so no placeholder)
    expect(pre).toBe("ab");
  });

  it("reconstructs pre-text for a single deletion", () => {
    // Before: "aXb", after deleting "X" at offset 1: "ab"
    // The change: rangeOffset=1, rangeLength=1, text=""
    const postText = "ab";
    const pre = reconstructPreText(postText, [
      { range: r(0, 1, 0, 2), rangeOffset: 1, rangeLength: 1, text: "" },
    ]);
    // Pre-text should be "a\0b" — placeholder for the deleted char.
    // computeSingleChange("a\0b", "ab") will correctly find the changed region.
    expect(pre).toBe("a\0b");

    // Verify the round-trip: computeSingleChange with this pre-text works
    const merged = computeSingleChange(pre, postText);
    expect(merged).not.toBeNull();
    expectRange(merged!.range, 0, 1, 0, 2);
    expect(merged!.text).toBe("");
  });

  it("handles multiple changes (native undo of a give)", () => {
    // Simulating native undo of give on "foo = {! id ? !}\n".
    // Give replaced {! id ? !} with "id {!  !}", producing "foo = id {!  !}\n".
    // Native undo reverses this as two contentChanges in one event:
    //   1. Delete "id " at offset 6, length 3 (insert nothing)
    //   2. Insert "id ?" at offset 9, length 0
    //
    // Post-undo text: "foo = {! id ? !}\n" (restored)
    // Pre-undo text: "foo = id {!  !}\n" (post-give)
    //
    // BUT: changes have ranges in the PRE-change document (the post-give text).
    // In "foo = id {!  !}\n":
    //   Change 1: delete [6,9) = "id ", rangeOffset=6, rangeLength=3, text=""
    //   Change 2: insert at offset 9 (after deletion, but offsets are pre-doc),
    //             rangeOffset=12, rangeLength=0, text="id ?"
    //
    // Hmm, actually native undo changes are more like:
    //   The original edit was: replace [6,16) with "id {!  !}"
    //   Undo reverses it: replace [6,15) with "{! id ? !}"
    // But VS Code may decompose this into multiple changes.
    // Let's test with a simple two-change scenario.

    const postText = "foo = {! id ? !}\n";
    // Two changes (in pre-doc coords of "foo = id {!  !}\n"):
    //   Change A: delete "id " at [6,9), rangeLength=3, text=""
    //   Change B: insert "id ?" at [12,12), rangeLength=0, text="id ?"
    const changes = [
      { range: r(0, 6, 0, 9), rangeOffset: 6, rangeLength: 3, text: "" },
      { range: r(0, 12, 0, 12), rangeOffset: 12, rangeLength: 0, text: "id ?" },
    ];
    const pre = reconstructPreText(postText, changes);

    // Pre should be: "foo = " + "\0\0\0" + "{! " + "" + "!}\n"
    // = "foo = \0\0\0{! !}\n" — wait, let me trace more carefully.
    //
    // Pre-doc: "foo = id {!  !}\n" (16 chars)
    // sorted by rangeOffset: change A (offset 6), change B (offset 12)
    //
    // Gap before A: pre[0..6) = post[0..6) = "foo = "
    // Change A: rangeLength=3 → "\0\0\0", skip text.length=0 in post
    //   preCursor=9, postCursor=6
    // Gap before B: pre[9..12) → post[6..9) = "{! "
    // Change B: rangeLength=0 → "", skip text.length=4 in post
    //   preCursor=12, postCursor=13
    // Remainder: post[13..] = " !}\n"
    expect(pre).toBe("foo = \0\0\0{!  !}\n");
    expect(pre.length).toBe(16); // same as "foo = id {!  !}\n"

    // Verify computeSingleChange finds the right merged change.
    // pre:  "foo = \0\0\0{!  !}\n"   (16 chars)
    // post: "foo = {! id ? !}\n"     (17 chars)
    // Common prefix: "foo = " (6)
    // Common suffix: " !}\n" (4)
    // Changed region in pre: [6, 12) = "\0\0\0{! "
    const merged = computeSingleChange(pre, postText);
    expect(merged).not.toBeNull();
    expectRange(merged!.range, 0, 6, 0, 12);

    // The key check: this merged change removes a goal at [0:9, 0:15]
    const goalRange = r(0, 9, 0, 15);
    const editParams = processChanges([merged!])[0];
    expect(adjustRangeContaining(goalRange, editParams, 2)).toBeNull();
  });
});
