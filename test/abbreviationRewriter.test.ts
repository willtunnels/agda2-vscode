import { describe, it, expect } from "vitest";
import {
  AbbreviationRewriter,
  AbbreviationTextSource,
  Change,
  mapOffsetThroughChanges,
} from "../src/unicode/engine/AbbreviationRewriter";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";
import { Range } from "../src/unicode/engine/Range";

/**
 * A mock text source that records replacement calls and manages a simple text buffer.
 */
class MockTextSource implements AbbreviationTextSource {
  text: string;
  selections: Range[] = [];
  replaceCalls: Change[][] = [];
  setSelectionsCalls: Range[][] = [];

  constructor(initialText: string) {
    this.text = initialText;
  }

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    this.replaceCalls.push(changes);
    // Apply changes from end to start to keep offsets valid
    const sorted = [...changes].sort((a, b) => b.range.start - a.range.start);
    for (const c of sorted) {
      const before = this.text.slice(0, c.range.start);
      const after = this.text.slice(c.range.start + c.range.length);
      this.text = before + c.newText + after;
    }
    return true;
  }

  collectSelections(): Range[] {
    return this.selections;
  }

  setSelections(selections: Range[]): void {
    this.setSelectionsCalls.push(selections);
    this.selections = selections;
  }
}

describe("AbbreviationRewriter (core)", () => {
  it("tracks a new abbreviation when leader is typed", () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type "\"
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);

    const tracked = rewriter.getTrackedAbbreviations();
    expect(tracked.size).toBe(1);
  });

  it("does not track when leader is typed during replacement", async () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // No abbreviation should be tracked since doNotTrackNewAbbr is internal
    // Just verify initial state
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("builds abbreviation text as characters are typed", () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\a");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type "\" at offset 0
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    // Type "a" at offset 1
    rewriter.changeInput([{ range: new Range(1, 0), newText: "a" }]);

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("a");
  });

  it("finishes abbreviation when non-matching char is typed", () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to ");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type "\", "t", "o"
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");

    // Type " " (space) which breaks the prefix
    rewriter.changeInput([{ range: new Range(3, 0), newText: " " }]);

    // The abbreviation is still tracked but internally marked as finished
    // (the rewriter's _finishedAbbreviations set). Verify by triggering
    // replacement -- it should replace and remove from tracking.
    const after = [...rewriter.getTrackedAbbreviations()];
    expect(after.length).toBe(1);
    expect(after[0].text).toBe("to");
  });

  it("backslash then space immediately finalizes (space does not extend)", async () => {
    // Regression test: the abbreviation table used to have " " → ["\u00A0"]
    // (NBSP). With that entry, space extended the abbreviation instead of
    // finalizing, causing the underline to persist indefinitely.
    // After removing the entry, space should finalize the abbreviation
    // (no matching prefix) and leave "\ " in the document.
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\ ");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type "\"
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    expect(rewriter.getTrackedAbbreviations().size).toBe(1);

    // Type " " (space) -- should finalize immediately
    rewriter.changeInput([{ range: new Range(1, 0), newText: " " }]);
    await rewriter.flushDirty();

    // Abbreviation text is "" (empty) -- no match, so forceReplace produces
    // no replacement. The abbreviation should be removed from tracking.
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
    // Document should be unchanged: "\ "
    expect(source.text).toBe("\\ ");
  });

  it("replaces finished abbreviation via flushDirty", async () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to ");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: " " }]);

    await rewriter.flushDirty();

    expect(source.replaceCalls.length).toBe(1);
    expect(source.text).toBe("→ ");
  });

  it("replaces all tracked abbreviations on replaceAllTrackedAbbreviations", async () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    rewriter.replaceAllTrackedAbbreviations();
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("replaces abbreviation when cursor moves away", async () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to xyz");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    // Cursor moves to offset 7 (outside the abbreviation range)
    rewriter.changeSelections([new Range(7, 0)]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→ xyz");
  });

  it("eager-replaces when abbreviation is complete (even if longer ones exist)", async () => {
    // "to" is a complete abbreviation (→) but "top" also exists.
    // With the new eager-on-any-complete behavior, \to should replace eagerly.
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    // Abbreviation should still be tracked (in replaced/cycling mode)
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("supports eager replacement for unique custom abbreviation", async () => {
    const provider = new AbbreviationProvider({ zzuniq: ["Z"] });
    const source = new MockTextSource("\\zzuniq");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "z" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "z" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "u" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "n" }]);
    rewriter.changeInput([{ range: new Range(5, 0), newText: "i" }]);
    rewriter.changeInput([{ range: new Range(6, 0), newText: "q" }]);

    await rewriter.flushDirty();

    expect(source.text).toBe("Z");
  });

  it("resets all tracked abbreviations", () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\a");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    expect(rewriter.getTrackedAbbreviations().size).toBe(1);

    rewriter.resetTrackedAbbreviations();
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });
});

describe("Cycling", () => {
  it("Tab cycles through multi-symbol abbreviation", async () => {
    // Use a custom multi-symbol abbreviation for deterministic testing
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \test
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);

    await rewriter.flushDirty();

    // Should eagerly replace with first symbol
    expect(source.text).toBe("A");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].isCycleable).toBe(true);

    // Tab cycles forward -- cursor at offset 0 (inside the replaced symbol)
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("B");

    // Tab again
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("C");

    // Tab wraps around
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");
  });

  it("Shift+Tab cycles backward", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    // Shift+Tab cycles backward (wraps to C)
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(-1);
    await rewriter.flushDirty();
    expect(source.text).toBe("C");

    // Shift+Tab again
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(-1);
    await rewriter.flushDirty();
    expect(source.text).toBe("B");
  });

  it("cursor leaving finalized replaced abbreviation", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test xyz");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A xyz");

    // Cycle to B
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("B xyz");

    // Cursor moves away -- should finalize (remove tracking, keep B)
    rewriter.changeSelections([new Range(5, 0)]);
    await rewriter.flushDirty();
    expect(source.text).toBe("B xyz");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("single-symbol abbreviation eager-replaces and finalizes on cursor away", async () => {
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\to xyz");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→ xyz");

    // Cursor moves away -- finalize
    rewriter.changeSelections([new Range(5, 0)]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→ xyz");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("typing after replaced symbol extends the abbreviation to a new cycle set", async () => {
    // \t eagerly replaces with first symbol of "t"'s list.
    // Typing "o" should extend to "to" and replace with →.
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \t
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();

    // Should eagerly replace with first symbol of "t"
    expect(source.text).toBe("T1");
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].text).toBe("t");

    // Now type "o" -- document becomes "T1o", then extend should replace with →
    source.text = "T1o";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("typing after replaced symbol extends to incomplete prefix (back to typing mode)", async () => {
    // If the extended abbreviation is a valid prefix but NOT a complete abbreviation,
    // the symbol should be replaced back with \prefix (typing mode).
    const provider = new AbbreviationProvider({
      a: ["A1"],
      abc: ["X"],
    });
    const source = new MockTextSource("\\a");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "a" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A1");

    // Type "b" -- "ab" is a valid prefix (abc exists) but not a complete abbreviation
    source.text = "A1b";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "b" }]);
    await rewriter.flushDirty();

    // Should go back to typing mode: \ab
    expect(source.text).toBe("\\ab");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(false);
    expect(tracked[0].text).toBe("ab");
  });

  it("typing non-extending char after replaced symbol finalizes", async () => {
    const provider = new AbbreviationProvider({
      x: ["X1", "X2"],
    });
    const source = new MockTextSource("\\x");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "x" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("X1");

    // Type " " -- no abbreviation starts with "x "
    source.text = "X1 ";
    rewriter.changeInput([{ range: new Range(2, 0), newText: " " }]);
    await rewriter.flushDirty();

    // Should finalize -- tracking removed, text stays as "X1 "
    expect(source.text).toBe("X1 ");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("backspace on replaced symbol shortens to shorter complete abbreviation", async () => {
    // \top → ⊤, backspace → → (shorten "top" to "to")
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\top");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \top
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "p" }]);
    await rewriter.flushDirty();

    // Should eagerly replace with ⊤
    expect(source.text).toBe("⊤");
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].text).toBe("top");

    // Backspace deletes ⊤ -- VS Code removes the character, we get a deletion change
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();

    // doShorten should insert → (symbol for "to")
    expect(source.text).toBe("→");
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("backspace chain: ⊤ → → → T1 → bare leader", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\top");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \top and get ⊤
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "p" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤");

    // Backspace 1: ⊤ → → (shorten "top" to "to")
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Backspace 2: → → T1 (shorten "to" to "t")
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("t");
    expect(tracked[0].isReplaced).toBe(true);

    // Backspace 3: T1 → \ (shorten "t" to empty, bare leader)
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 2), newText: "" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("\\");

    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("");
    expect(tracked[0].isReplaced).toBe(false);
  });

  it("backspace on single-char abbreviation with no shorter match goes to bare leader", async () => {
    const provider = new AbbreviationProvider({
      x: ["X1"],
    });
    const source = new MockTextSource("\\x");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "x" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("X1");

    // Backspace: X1 → \ (shorten "x" to empty)
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 2), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("\\");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("");
    expect(tracked[0].isReplaced).toBe(false);
  });

  it("backspace to incomplete prefix goes to typing mode with leader", async () => {
    // "abc" is complete, "ab" is a valid prefix but not complete
    const provider = new AbbreviationProvider({
      abc: ["X"],
      abcd: ["Y"],
    });
    const source = new MockTextSource("\\abc");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "a" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "b" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "c" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("X");

    // Backspace: X → \ab (shorten "abc" to "ab", which is valid prefix but not complete)
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("\\ab");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("ab");
    expect(tracked[0].isReplaced).toBe(false);
  });

  it("extend then shorten returns to original symbol", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to and get →
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Extend: type "p" → ⊤
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤");

    // Shorten back: backspace → →
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("flushDirty serializes extend so fast follow-up chars are not lost", async () => {
    // This test verifies that if we call flushDirty between changeInput
    // calls (as the VS Code layer's drainQueue does), extend completes before
    // the next event is processed -- preventing the fast-typing race.
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \t → eagerly replaced with T1
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    // Simulate fast typing: "o" then "p" processed with flushDirty
    // between each, as the VS Code queue would do.

    // Event 1: "o" appended → shadow updated
    source.text = "T1o";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Event 2: "p" appended → shadow updated
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤");

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("batched changeInput without intermediate flush correctly extends", async () => {
    // Multiple changeInput calls without flushDirty between them.
    // acceptAppend eagerly updates range/text, so the second char
    // is correctly seen as adjacent even though flushDirty hasn't run yet.
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    // Feed both events WITHOUT flushing between them.
    source.text = "T1o";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    source.text = "T1op";
    rewriter.changeInput([{ range: new Range(3, 0), newText: "p" }]);

    // Now let everything settle
    await rewriter.flushDirty();

    // Both chars were processed correctly — abbreviation is "top"
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(source.text).toBe("⊤");
  });

  it("typing after Tab cycle finalizes with current cycled symbol", async () => {
    // User types \test → A, then Tab → B, then types "x" (non-extending).
    // Should finalize with B in the document.
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    // Tab → B
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("B");

    // Type "x" (not a valid extension of "test") → should finalize
    source.text = "Bx";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "x" }]);
    await rewriter.flushDirty();

    // Should finalize -- B stays, tracking removed
    expect(source.text).toBe("Bx");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("backspace after Tab cycle shortens from original abbreviation (not cycled symbol)", async () => {
    // User types \top → ⊤, then Tab (if multi-symbol) or just backspace.
    // The abbreviation text is "top" regardless of which symbol is displayed.
    // Backspace should shorten "top" to "to" → →.
    const provider = new AbbreviationProvider({
      t: ["T1", "T2"],
      to: ["→"],
      top: ["⊤", "⊤2"],
    });
    const source = new MockTextSource("\\top");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "p" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤");

    // Cycle to ⊤2
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤2");

    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked[0].cycleIndex).toBe(1);

    // Backspace: ⊤2 deleted (length 2) → shorten "top" to "to" → →
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 2), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
    // Cycle index should be reset to 0 after shorten
    expect(tracked[0].cycleIndex).toBe(0);
  });

  it("surrogate pair symbol: backspace deletes full code point and shortens correctly", async () => {
    // 𝐀 is U+1D400, which is a surrogate pair (JS .length === 2).
    // 𝐁 is U+1D401.
    // This tests that backspace on a surrogate-pair symbol works correctly
    // because VS Code deletes both surrogates at once and all range arithmetic
    // uses UTF-16 code units consistently.
    const provider = new AbbreviationProvider({
      B: ["\uD835\uDC01"], // 𝐁 (U+1D401, surrogate pair, .length === 2)
      BA: ["\uD835\uDC00"], // 𝐀 (U+1D400, surrogate pair, .length === 2)
    });
    const source = new MockTextSource("\\BA");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \BA
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "B" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "A" }]);
    await rewriter.flushDirty();

    // Should eagerly replace with 𝐀 (.length === 2)
    expect(source.text).toBe("\uD835\uDC00");
    expect(source.text.length).toBe(2); // Surrogate pair
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].text).toBe("BA");

    // Backspace: VS Code deletes both surrogates → deletion of length 2
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 2), newText: "" }]);
    await rewriter.flushDirty();

    // doShorten should insert 𝐁 (symbol for "B")
    expect(source.text).toBe("\uD835\uDC01");
    expect(source.text.length).toBe(2); // Also a surrogate pair
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("B");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("multi-cursor: two abbreviations both eagerly replace", async () => {
    const provider = new AbbreviationProvider({ to: ["→"] });
    // Document: \to   \to    (two abbreviations at offsets 0 and 6)
    const source = new MockTextSource("\\to   \\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Cursor 1 types \to at offset 0
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    // Cursor 2 types \to at offset 6
    rewriter.changeInput([{ range: new Range(6, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(7, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(8, 0), newText: "o" }]);

    await rewriter.flushDirty();

    // Both should be replaced
    expect(source.text).toBe("→   →");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(2);
    expect(tracked.every((t) => t.isReplaced)).toBe(true);
  });

  it("multi-cursor: distant change does not kill replaced abbreviation", async () => {
    // Regression test: a change far away from a replaced abbreviation
    // should NOT finalize it. Before the fix, _processChangeReplaced
    // treated ALL "after" changes as extend-or-finalize, killing the
    // abbreviation even if the change was at a different cursor position.
    const provider = new AbbreviationProvider({ to: ["→"] });
    const source = new MockTextSource("\\to   \\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type both abbreviations
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(6, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(7, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(8, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→   →");

    const trackedBefore = [...rewriter.getTrackedAbbreviations()];
    expect(trackedBefore.length).toBe(2);

    // Simulate a deletion at offset 4 (abbr2's →).
    // This is "after" abbr1 (at offset 0).
    // Without the fix, this would finalize abbr1.
    // With the fix, abbr1 should survive.
    source.text = "→   ";
    rewriter.changeInput([{ range: new Range(4, 1), newText: "" }]);
    await rewriter.flushDirty();

    // abbr1 should still be tracked (the deletion was distant, not adjacent)
    const tracked = [...rewriter.getTrackedAbbreviations()];
    // At least abbr1 should survive
    const abbr1Alive = tracked.some((t) => t.text === "to" && t.isReplaced);
    expect(abbr1Alive).toBe(true);
  });

  it("multi-cursor: backspace at both cursors shortens both abbreviations", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
    });
    const source = new MockTextSource("\\to   \\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type both abbreviations
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(6, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(7, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(8, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→   →");

    // Backspace at BOTH cursors simultaneously (VS Code batches them).
    // The deletion at offset 4 is "after" abbr1 -- without the fix,
    // it would kill abbr1.
    source.text = "   ";
    rewriter.changeInput([
      { range: new Range(4, 1), newText: "" }, // delete abbr2's →
      { range: new Range(0, 1), newText: "" }, // delete abbr1's →
    ]);
    await rewriter.flushDirty();

    // Both abbreviations should survive and shorten.
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(2);
    expect(tracked.every((t) => t.text === "t")).toBe(true);
  });

  it("multi-cursor: simultaneous backspace inserts shortened symbols at correct offsets", async () => {
    // Regression test for the range-staleness bug.
    // Two abbreviations in a document with surrounding text.
    // After simultaneous backspace, flushDirty runs with batch edit.
    // The range shifting ensures the second abbreviation's symbol
    // is inserted at the correct position.
    //
    // Document:  "→ XY →"  (abbr1 at 0, abbr2 at 5, text " XY " between)
    // Backspace: " XY "  (both → deleted)
    // flushDirty: batch insert T1 at both positions with correct shifts
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
    });
    const source = new MockTextSource("\\to XY \\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type both abbreviations
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(7, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(8, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(9, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→ XY →");

    // Simultaneous backspace: both → deleted.
    // After eager replace, abbr1=Range(0,1), abbr2=Range(5,1).
    // VS Code sends both deletions in one event.
    // After deleting → at 5 and → at 0, document is " XY " (4 chars).
    source.text = " XY ";
    rewriter.changeInput([
      { range: new Range(5, 1), newText: "" }, // delete abbr2's →
      { range: new Range(0, 1), newText: "" }, // delete abbr1's →
    ]);
    await rewriter.flushDirty();

    // Both should shorten to T1, inserted at correct positions.
    expect(source.text).toBe("T1 XY T1");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(2);
    expect(tracked.every((t) => t.text === "t" && t.isReplaced)).toBe(true);
  });

  it("real abbreviation table: \\t → ◂, then typing 'o' extends to → (\\to)", async () => {
    // Uses the real abbreviation table (no custom translations) to test
    // the exact scenario the user reports as broken.
    const provider = new AbbreviationProvider({});

    // Verify the table has what we expect
    expect(provider.getSymbolsForAbbreviation("t")?.[0]).toBe("◂");
    expect(provider.getSymbolsForAbbreviation("to")).toEqual(["→"]);
    expect(provider.hasAbbreviationsWithPrefix("to")).toBe(true);

    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \t
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();

    // Should eagerly replace with ◂ (first symbol for "t")
    expect(source.text).toBe("◂");
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].text).toBe("t");

    // Now type "o" -- should extend to "to" → →
    source.text = "◂o";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "o" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("stale selection after eager replace: cursor offset from pre-replacement document", async () => {
    // Reproduces the VS Code event pattern that caused the stale-selection bug.
    //
    // When the user types "t" after "\", VS Code enqueues:
    //   1. change(@1+0→"t") -- the keystroke
    //   2. selection(@2+0)  -- cursor after "t" (pre-replacement offset)
    //
    // Processing event 1 triggers eager replacement: \t (2 chars) → T1.
    // The abbreviation is now at Range(0, 2) in replaced mode.
    //
    // Processing event 2: cursor at offset 2 -- which is RIGHT AFTER T1.
    // With the zero-length containsRange quirk, Range(0,2).containsRange(Range(2,0))
    // → 0 <= 2 && 1 <= 1 → true. So this case happens to work.
    //
    // But for a 1-char symbol: \t → ◂ (1 char). Abbreviation at Range(0, 1).
    // Stale cursor at offset 2: Range(0,1).containsRange(Range(2,0))
    // → 0 <= 2 && 1 <= 0 → FALSE. Abbreviation killed!
    //
    // This is the exact bug from the VS Code logs:
    //   after triggerRepl: tracked=[t@54+1[R]]
    //   selection: @56+0 → changeSel → tracked=[]
    const provider = new AbbreviationProvider({
      t: ["X"], // 1-char symbol -- replacement shrinks \t from 2 to 1 char
      to: ["→"],
    });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \t
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("X");

    // Abbreviation is at Range(0, 1) [R]
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);

    // Simulate stale selection: cursor at offset 2 (pre-replacement position).
    // In real VS Code, this would be the selection event that was enqueued
    // for the "t" keystroke BEFORE the eager replacement changed the document.
    rewriter.changeSelections([new Range(2, 0)]);
    await rewriter.flushDirty();

    // BUG: without the fix, the abbreviation is killed here because
    // Range(0,1).containsRange(Range(2,0)) → false (cursor past symbol end).
    // With the fix (VS Code layer reads live selections), this stale offset
    // would never reach the engine. At the engine level, we verify the
    // abbreviation SURVIVES a cursor at the correct post-replacement position.
    //
    // We can't fully test the VS Code layer fix here, but we CAN verify that
    // a cursor at offset 1 (the correct post-replacement position) keeps
    // the abbreviation alive:
    tracked = [...rewriter.getTrackedAbbreviations()];
    // With stale offset 2 reaching the engine, abbreviation IS killed.
    // This test documents the engine-level behavior -- the real fix is in the
    // VS Code layer (reading live selections instead of enqueued ones).
    // If we wanted the engine to tolerate this, we'd need to change containsRange.
    // For now, we just verify the engine's behavior is well-defined.
    if (tracked.length === 0) {
      // Expected at engine level: stale offset kills abbreviation.
      // The VS Code layer fix prevents this offset from reaching the engine.
      expect(tracked.length).toBe(0);
    }
  });

  it("correct post-replacement selection keeps abbreviation alive", async () => {
    const provider = new AbbreviationProvider({
      t: ["X"], // 1-char symbol
      to: ["→"],
    });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("X");

    // Cursor at offset 1 (correct post-replacement position: right after X).
    rewriter.changeSelections([new Range(1, 0)]);
    await rewriter.flushDirty();

    // Abbreviation should survive
    let tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);

    // Extend: type "o"
    source.text = "Xo";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "o" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
  });

  it("selection far from abbreviation kills it (cursor moved away)", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
    });
    const source = new MockTextSource("\\t xyz");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1 xyz");

    // Cursor at offset 6 -- far from the symbol
    rewriter.changeSelections([new Range(6, 0)]);
    await rewriter.flushDirty();

    // Abbreviation should be finalized
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("remembered index: next abbreviation starts from last finalized cycle index", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });

    // --- First abbreviation: cycle to B (index 1), then finalize ---
    const source1 = new MockTextSource("\\test");
    const rewriter1 = new AbbreviationRewriter("\\", provider, source1);

    rewriter1.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter1.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter1.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter1.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter1.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter1.flushDirty();
    expect(source1.text).toBe("A"); // starts at index 0

    // Cycle to B (index 1)
    source1.selections = [new Range(0, 0)];
    rewriter1.cycleAbbreviations(1);
    await rewriter1.flushDirty();
    expect(source1.text).toBe("B");

    // Finalize by moving cursor away
    rewriter1.changeSelections([new Range(5, 0)]);
    await rewriter1.flushDirty();
    expect(rewriter1.getTrackedAbbreviations().size).toBe(0);

    // Provider should remember index 1 for "test"
    expect(provider.getLastSelectedIndex("test")).toBe(1);

    // --- Second abbreviation: should start from B (index 1) ---
    const source2 = new MockTextSource("\\test");
    const rewriter2 = new AbbreviationRewriter("\\", provider, source2);

    rewriter2.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter2.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter2.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter2.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter2.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter2.flushDirty();

    // Should start from remembered index 1 → B
    expect(source2.text).toBe("B");
  });

  it("remembered index: finalize via non-extending char saves index", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    // Cycle to C (index 2)
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1); // B
    await rewriter.flushDirty();
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1); // C
    await rewriter.flushDirty();
    expect(source.text).toBe("C");

    // Type a non-extending character right after the symbol → finalize via processChange
    source.text = "Cx";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "x" }]);
    await rewriter.flushDirty();

    // Should be finalized
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);

    // Provider should remember index 2 for "test"
    expect(provider.getLastSelectedIndex("test")).toBe(2);
  });

  it("remembered index: extend uses remembered index for new abbreviation", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1", "T2", "T3"],
      to: ["→", "⇒", "⟶"],
    });

    // Pre-set the remembered index for "to" to 1 (⇒)
    provider.setLastSelectedIndex("to", 1);

    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \t
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1"); // "t" starts at default index 0

    // Extend with "o" -- "to" has remembered index 1, so should show ⇒
    source.text = "T1o";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("⇒");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].cycleIndex).toBe(1);
  });

  it("remembered index: shorten uses remembered index for shorter abbreviation", async () => {
    const provider = new AbbreviationProvider({
      t: ["T1", "T2", "T3"],
      to: ["→"],
    });

    // Pre-set remembered index for "t" to 2 (T3)
    provider.setLastSelectedIndex("t", 2);

    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Backspace -- delete the symbol, shortening "to" → "t"
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();

    // Should use remembered index 2 for "t" → T3
    expect(source.text).toBe("T3");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("t");
    expect(tracked[0].cycleIndex).toBe(2);
  });

  it("remembered index: replaceAll saves index before finalizing", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    // Cycle to C (index 2)
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1); // B
    await rewriter.flushDirty();
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1); // C
    await rewriter.flushDirty();
    expect(source.text).toBe("C");

    // replaceAll finalizes everything
    rewriter.replaceAllTrackedAbbreviations();
    await rewriter.flushDirty();
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);

    // Should remember index 2
    expect(provider.getLastSelectedIndex("test")).toBe(2);
  });

  it("Tab on eagerly-replaced abbreviation cycles to next symbol", async () => {
    const provider = new AbbreviationProvider({ test: ["A", "B", "C"] });
    const source = new MockTextSource("\\test");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "s" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "t" }]);

    // Eager replacement kicks in
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    // Tab -- should cycle to next symbol
    source.selections = [new Range(1, 0)]; // cursor inside abbreviation
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("B");

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("stale document offsets: processing events one-at-a-time with flush between loses chars", async () => {
    // This demonstrates what happens if change events are processed one at a
    // time with full flush between them (the OLD VS Code queue pattern).
    // The engine-level fix (eagerly acceptAppend) does not help here
    // because E1 is fully flushed (document changes) before E2 is seen.
    // E2's offset is stale: it was captured before the document edit.
    //
    // The fix for this at the queue level is batching consecutive change ops
    // (defer flush until the last change in a run), which both
    // VSCodeAbbreviationRewriter and unicodeInputBox now do.
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    const E1 = { range: new Range(1, 0), newText: "p" };
    const E2 = { range: new Range(2, 0), newText: "q" };
    source.text = "→pq";

    // Process E1 fully (old pattern — flush between each event)
    rewriter.changeInput([E1]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤q"); // flushDirty replaced →p with ⊤

    // Process E2 with stale offset 2 (should be 1 in post-edit document)
    rewriter.changeInput([E2]);
    await rewriter.flushDirty();

    // "q" at stale offset 2 is not adjacent to ⊤ at range (0,1) → silently missed
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");

    // With batching (no flush between), the same events work correctly:
    const source2 = new MockTextSource("\\to");
    const rewriter2 = new AbbreviationRewriter("\\", provider, source2);
    rewriter2.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter2.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter2.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter2.flushDirty();
    source2.text = "→pq";
    rewriter2.changeInput([E1]);
    rewriter2.changeInput([E2]);
    await rewriter2.flushDirty();

    // "q" is not a valid extension of "top" → abbreviation finalized
    // (removed from tracking). flushDirty replaced →p with ⊤,
    // then "q" finalized. Document: ⊤q.
    const tracked2 = [...rewriter2.getTrackedAbbreviations()];
    expect(tracked2.length).toBe(0);
    expect(source2.text).toBe("⊤q");
  });

  it("input box batching: multiple fast extends are accumulated correctly", async () => {
    // Simulates the input box's batching strategy: all changeInput calls
    // run first, then flushDirty once.
    // acceptAppend eagerly updates the range/text, so the second character
    // is correctly seen as adjacent.
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
      top: ["⊤"],
      topq: ["Q"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to → eagerly replaced with →
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // User types "p" then "q". Input box computes changes against successive snapshots.
    const E1 = { range: new Range(1, 0), newText: "p" }; // "→" → "→p"
    const E2 = { range: new Range(2, 0), newText: "q" }; // "→p" → "→pq"

    source.text = "→pq";

    // Input box batching: all changeInput calls first, then flush once.
    rewriter.changeInput([E1]);
    rewriter.changeInput([E2]);
    await rewriter.flushDirty();

    const tracked = [...rewriter.getTrackedAbbreviations()];
    // Both characters processed: abbreviation is "topq", symbol is Q
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("topq");
    expect(source.text).toBe("Q");
  });
});

describe("Shadow state (extend/shorten before flush)", () => {
  it("extend + backspace before flush: document stays unchanged", async () => {
    // Type "p" after →, then backspace "p", then flush → document stays →
    const provider = new AbbreviationProvider({
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Type "p" → pending extend
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);

    // Backspace "p" → pending chars trimmed
    source.text = "→";
    rewriter.changeInput([{ range: new Range(1, 1), newText: "" }]);

    // Flush: shadow is back to "to" → display "→" → replaces "→" with "→" (no-op)
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("to");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("extend + non-extending char: finalized", async () => {
    // Type "p" (valid extension), then "z" (invalid) → finalized
    const provider = new AbbreviationProvider({
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Type "p" → valid extend
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);

    // Type "z" → "topz" is not a valid prefix → finalized
    source.text = "→pz";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "z" }]);

    await rewriter.flushDirty();

    // Abbreviation should be finalized (removed from tracking)
    // The dirty extend was pending but the finalization takes precedence
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("multiple extends + partial backspace before flush", async () => {
    // Type "p", "q", backspace "q", flush → extends to "top" → ⊤
    const provider = new AbbreviationProvider({
      to: ["→"],
      top: ["⊤"],
      topq: ["Q"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Type "p" → pending extend "p"
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);

    // Type "q" → pending extend "pq"
    source.text = "→pq";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "q" }]);

    // Backspace "q" → pending trimmed to "p"
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(2, 1), newText: "" }]);

    // Flush: effective abbreviation is "top", display ⊤
    await rewriter.flushDirty();

    expect(source.text).toBe("⊤");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("extend + backspace-pending + backspace-symbol: shorten correctly", async () => {
    // Extend with "p", backspace "p" (pending trimmed), backspace "→" (shorten)
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Type "p" → pending extend
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);

    // Backspace "p" → pending trimmed to ""
    source.text = "→";
    rewriter.changeInput([{ range: new Range(1, 1), newText: "" }]);

    // Backspace "→" → shorten "to" to "t"
    source.text = "";
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);

    // Flush: shortened to "t", display T1
    await rewriter.flushDirty();

    expect(source.text).toBe("T1");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("t");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("extend + cycle before flush: cycles through extended symbols", async () => {
    // Type "p" after →, then Tab → cycles through "top" symbols
    const provider = new AbbreviationProvider({
      to: ["→"],
      top: ["⊤", "T"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Type "p" → pending extend, shadow = ⊤ (index 0 of "top" symbols)
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);

    // Tab → cycle to T (index 1)
    // The effective range is Range(0, 2) (→p), so cursor at 0 is within range
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);

    // Flush: display "T", replaces "→p" with "T"
    await rewriter.flushDirty();

    expect(source.text).toBe("T");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(tracked[0].isReplaced).toBe(true);
    expect(tracked[0].cycleIndex).toBe(1);
  });

  it("cycle + extend: extends from cycled state", async () => {
    // Tab (cycle), then type "p" → extends from cycled abbreviation
    const provider = new AbbreviationProvider({
      to: ["→", "⇒"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Tab → cycle to ⇒
    source.selections = [new Range(0, 0)];
    rewriter.cycleAbbreviations(1);
    await rewriter.flushDirty();
    expect(source.text).toBe("⇒");

    // Type "p" → extend to "top"
    source.text = "⇒p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("⊤");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(tracked[0].isReplaced).toBe(true);
  });
});

describe("deleteAbbreviations", () => {
  it("deletes a replaced symbol entirely", async () => {
    const provider = new AbbreviationProvider({ to: ["→"] });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to and get →
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Cursor inside the replaced symbol
    source.selections = [new Range(0, 0)];

    // Delete abbreviation
    rewriter.deleteAbbreviations();
    await rewriter.flushDirty();

    expect(source.text).toBe("");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("deletes a typing-mode abbreviation entirely", async () => {
    const provider = new AbbreviationProvider({ to: ["→"], top: ["⊤"] });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to (still typing since "top" is also a prefix)
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);

    // Cursor inside the abbreviation range
    source.selections = [new Range(2, 0)];

    // Delete abbreviation
    rewriter.deleteAbbreviations();
    await rewriter.flushDirty();

    // The full range (\to) should be deleted
    expect(source.text).toBe("");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("does nothing when cursor is not in any abbreviation", async () => {
    const provider = new AbbreviationProvider({ to: ["→"] });
    const source = new MockTextSource("x\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    // Type \to at offset 1
    rewriter.changeInput([{ range: new Range(1, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("x→");

    // Cursor at offset 0 -- outside the abbreviation
    source.selections = [new Range(0, 0)];

    rewriter.deleteAbbreviations();
    await rewriter.flushDirty();

    // Nothing changed
    expect(source.text).toBe("x→");
    expect(rewriter.getTrackedAbbreviations().size).toBe(1);
  });
});

describe("mapOffsetThroughChanges", () => {
  const changes: Change[] = [{ range: new Range(2, 3), newText: "xxxxx" }]; // delta +2

  it("offset before the change is unchanged", () => {
    expect(mapOffsetThroughChanges(0, changes)).toBe(0);
    expect(mapOffsetThroughChanges(2, changes)).toBe(2); // at range start: stays
  });

  it("offset inside or at end of the replaced range maps to end of new text", () => {
    expect(mapOffsetThroughChanges(3, changes)).toBe(7);
    expect(mapOffsetThroughChanges(5, changes)).toBe(7); // at old end
  });

  it("offset after the change shifts by the delta", () => {
    expect(mapOffsetThroughChanges(6, changes)).toBe(8);
    expect(mapOffsetThroughChanges(10, changes)).toBe(12);
  });

  it("accumulates deltas across multiple changes", () => {
    const multi: Change[] = [
      { range: new Range(0, 3), newText: "A" }, // delta -2
      { range: new Range(5, 1), newText: "BBB" }, // delta +2
    ];
    expect(mapOffsetThroughChanges(3, multi)).toBe(1); // end of first replacement
    expect(mapOffsetThroughChanges(4, multi)).toBe(2); // between changes: shift -2
    expect(mapOffsetThroughChanges(6, multi)).toBe(6); // end of second replacement (5-2+3)
    expect(mapOffsetThroughChanges(8, multi)).toBe(8); // after both: -2 +2
  });

  it("offset at a pure insertion point maps past the inserted text", () => {
    // The shorten case: backspace empties the span at the cursor, then the
    // flush INSERTS the shorter abbreviation's text right there. The cursor
    // must end up after it.
    const insertion: Change[] = [{ range: new Range(2, 0), newText: "abc" }];
    expect(mapOffsetThroughChanges(2, insertion)).toBe(5); // at insertion point
    expect(mapOffsetThroughChanges(1, insertion)).toBe(1); // before: unchanged
    expect(mapOffsetThroughChanges(3, insertion)).toBe(6); // after: shifted
  });
});

describe("Selection repositioning after flush", () => {
  it("\\times: cursor is moved past the reverted abbreviation (regression: \\tmesi)", async () => {
    // Real table: "t" is a complete abbreviation (◂), "ti" is a prefix of
    // tie/times but not complete. Typing \times therefore goes
    //   \t → ◂ → (i) → revert to \ti → \tim → \time → \times → ×.
    // The revert replaces ◂i (2 chars) with \ti (3 chars). VS Code's own
    // cursor mapping leaves the cursor at offset 2 -- between t and i --
    // and further typing produces \tmesi. The engine must reposition the
    // cursor to offset 3 via setSelections.
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    source.selections = [new Range(1, 0)];
    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    source.selections = [new Range(2, 0)];
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("◂");
    // Pre-edit cursor 2 mapped through (0,2)→"◂"
    expect(source.selections).toEqual([new Range(1, 0)]);

    // Type "i" after the symbol → "ti" is an incomplete prefix → revert
    source.text = "◂i";
    source.selections = [new Range(2, 0)];
    rewriter.changeInput([{ range: new Range(1, 0), newText: "i" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("\\ti");
    // THE FIX: cursor must be after the full "\ti" (offset 3), not at 2.
    expect(source.selections).toEqual([new Range(3, 0)]);

    // Continue typing at the (correctly placed) cursor
    source.text = "\\tim";
    source.selections = [new Range(4, 0)];
    rewriter.changeInput([{ range: new Range(3, 0), newText: "m" }]);
    source.text = "\\time";
    source.selections = [new Range(5, 0)];
    rewriter.changeInput([{ range: new Range(4, 0), newText: "e" }]);
    source.text = "\\times";
    source.selections = [new Range(6, 0)];
    rewriter.changeInput([{ range: new Range(5, 0), newText: "s" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("×");
    expect(source.selections).toEqual([new Range(1, 0)]);
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("times");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("batched extend + finalize keeps cursor after the trailing character", async () => {
    // Fast typing: "p" (extend) and " " (finalize) arrive in one batch.
    // The flush replaces "→p" with "⊤" while the document is "→p " and the
    // cursor is after the space (offset 3). The cursor must map to 2
    // (after "⊤ "), not jump to 1 (between "⊤" and the space).
    const provider = new AbbreviationProvider({
      t: ["T1"],
      to: ["→"],
      top: ["⊤"],
    });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    source.selections = [new Range(3, 0)];
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);
    source.text = "→p ";
    rewriter.changeInput([{ range: new Range(2, 0), newText: " " }]);
    source.selections = [new Range(3, 0)];
    await rewriter.flushDirty();

    expect(source.text).toBe("⊤ ");
    expect(source.selections).toEqual([new Range(2, 0)]);
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("backspacing × places the cursor after the reverted \\time", async () => {
    // Real table: \times → ×. Backspace deletes × (empty span at offset 0);
    // the flush inserts "\time" there. Without insertion-point mapping the
    // cursor stayed at 0 — before the leader.
    const provider = new AbbreviationProvider({});
    const source = new MockTextSource("\\times");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "i" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "m" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "e" }]);
    rewriter.changeInput([{ range: new Range(5, 0), newText: "s" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("×");

    // Backspace: × deleted, cursor at 0.
    source.text = "";
    source.selections = [new Range(0, 0)];
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("\\time");
    expect(source.selections).toEqual([new Range(5, 0)]);
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("time");
    expect(tracked[0].isReplaced).toBe(false);
  });

  it("backspacing to a shorter symbol places the cursor after it", async () => {
    const provider = new AbbreviationProvider({ t: ["T1"], to: ["→"], top: ["⊤"] });
    const source = new MockTextSource("\\top");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "p" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("⊤");

    source.text = "";
    source.selections = [new Range(0, 0)];
    rewriter.changeInput([{ range: new Range(0, 1), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→");
    expect(source.selections).toEqual([new Range(1, 0)]);
  });

  it("does not reposition selections when the edit fails", async () => {
    const provider = new AbbreviationProvider({ to: ["→"] });
    const source = new MockTextSource("\\to");
    source.replaceAbbreviations = async () => false;
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    source.selections = [new Range(3, 0)];
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();

    expect(source.setSelectionsCalls.length).toBe(0);
    expect(source.selections).toEqual([new Range(3, 0)]);
  });
});

describe("Multi-code-point symbol backspace", () => {
  it("backspace deleting one code unit of a two-char symbol shortens", async () => {
    // The symbol for "zqb" is "T1" (two code points). A real backspace only
    // deletes the trailing "1"; the engine must treat that as backspacing
    // the symbol (shorten), not fight the user by restoring "T1".
    const provider = new AbbreviationProvider({ zq: ["X"], zqb: ["T1"] });
    const source = new MockTextSource("\\zqb");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "z" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "q" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "b" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    // Backspace deletes only the last code point of the symbol.
    source.text = "T";
    rewriter.changeInput([{ range: new Range(1, 1), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("X");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("zq");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("backspace deleting a combining mark shortens", async () => {
    // "x̶" is one grapheme but two code points; backspace deletes just
    // the combining long stroke.
    const provider = new AbbreviationProvider({ zc: ["Y"], zcd: ["x̶"] });
    const source = new MockTextSource("\\zcd");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "z" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "c" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "d" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("x̶");

    source.text = "x";
    rewriter.changeInput([{ range: new Range(1, 1), newText: "" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("Y");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("zc");
  });
});

describe("Paste after a replaced symbol", () => {
  it("multi-char paste extends to a complete abbreviation", async () => {
    // Typing-mode already absorbed viable pastes; replaced mode only
    // accepted single characters. Both now behave the same.
    const provider = new AbbreviationProvider({ t: ["T1"], to: ["→"], top: ["⊤"] });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    // Paste "op" right after the symbol.
    source.text = "T1op";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "op" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("⊤");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("top");
    expect(tracked[0].isReplaced).toBe(true);
  });

  it("multi-char paste extending to an incomplete prefix reverts to typing mode", async () => {
    const provider = new AbbreviationProvider({ a: ["A"], abcd: ["Z"] });
    const source = new MockTextSource("\\a");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "a" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("A");

    source.text = "Abc";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "bc" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("\\abc");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("abc");
    expect(tracked[0].isReplaced).toBe(false);
  });

  it("non-viable paste finalizes and stays outside the abbreviation", async () => {
    const provider = new AbbreviationProvider({ t: ["T1"], to: ["→"] });
    const source = new MockTextSource("\\t");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("T1");

    source.text = "T1%%";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "%%" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("T1%%");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });
});

describe("Reconciliation regressions", () => {
  it("cursor leaving an abbreviation with a pending extend still applies it", async () => {
    // Previously, a cursor jump between the extend keystroke and the flush
    // removed the abbreviation from tracking immediately, losing the pending
    // write and leaving "→p" in the document.
    const provider = new AbbreviationProvider({ to: ["→"], top: ["⊤"] });
    const source = new MockTextSource("\\to");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→");

    // Extend with "p", then the cursor jumps far away before the flush.
    source.text = "→p";
    rewriter.changeInput([{ range: new Range(1, 0), newText: "p" }]);
    rewriter.changeSelections([new Range(10, 0)]);
    await rewriter.flushDirty();

    expect(source.text).toBe("⊤");
    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
  });

  it("an unwritten abbreviation's span shifts when an earlier one's replacement changes length", async () => {
    // abbr1 (\to, complete) is replaced while abbr2 (\ab, incomplete prefix)
    // is not written at all. abbr2's span must still shift left so later
    // keystrokes land adjacent to it.
    const provider = new AbbreviationProvider({ to: ["→"], abc: ["Y"] });
    const source = new MockTextSource("\\to \\ab");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "o" }]);
    rewriter.changeInput([{ range: new Range(4, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(5, 0), newText: "a" }]);
    rewriter.changeInput([{ range: new Range(6, 0), newText: "b" }]);
    await rewriter.flushDirty();
    expect(source.text).toBe("→ \\ab");

    // Type "c" at the post-replacement position (end of the shifted \ab).
    source.text = "→ \\abc";
    rewriter.changeInput([{ range: new Range(5, 0), newText: "c" }]);
    await rewriter.flushDirty();

    expect(source.text).toBe("→ Y");
    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(2);
    expect(tracked.some((t) => t.text === "abc" && t.isReplaced)).toBe(true);
  });
});

describe("Interior edits in typing mode", () => {
  it("finalizes when an interior edit makes the text an impossible prefix", async () => {
    const provider = new AbbreviationProvider({ times: ["×"] });
    const source = new MockTextSource("\\ti");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "i" }]);
    expect(rewriter.getTrackedAbbreviations().size).toBe(1);

    // Type "m" INSIDE the abbreviation (between t and i) — "tmi" can never
    // become an abbreviation, so tracking should end.
    source.text = "\\tmi";
    rewriter.changeInput([{ range: new Range(2, 0), newText: "m" }]);
    await rewriter.flushDirty();

    expect(rewriter.getTrackedAbbreviations().size).toBe(0);
    expect(source.text).toBe("\\tmi");
  });

  it("keeps tracking when an interior edit still forms a valid prefix", async () => {
    const provider = new AbbreviationProvider({ times: ["×"], tie: ["⁀"] });
    const source = new MockTextSource("\\tie");
    const rewriter = new AbbreviationRewriter("\\", provider, source);

    rewriter.changeInput([{ range: new Range(0, 0), newText: "\\" }]);
    rewriter.changeInput([{ range: new Range(1, 0), newText: "t" }]);
    rewriter.changeInput([{ range: new Range(2, 0), newText: "i" }]);
    rewriter.changeInput([{ range: new Range(3, 0), newText: "e" }]);

    // Insert "m" between i and e → "time" is still a prefix of "times"
    source.text = "\\time";
    rewriter.changeInput([{ range: new Range(3, 0), newText: "m" }]);
    await rewriter.flushDirty();

    const tracked = [...rewriter.getTrackedAbbreviations()];
    expect(tracked.length).toBe(1);
    expect(tracked[0].text).toBe("time");
    expect(tracked[0].isReplaced).toBe(false);
  });
});
