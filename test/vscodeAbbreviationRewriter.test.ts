/**
 * Editor-level tests for VSCodeAbbreviationRewriter using a cursor-faithful
 * fake of VS Code's text editor.
 *
 * The fake reproduces two crucial details of `workspace.applyEdit`:
 *
 * 1. **Minimized change events.** When a workspace edit targets the active
 *    editor's document, VS Code rewrites it before applying: bulkEditService
 *    defaults the editor to the active one, bulkTextEdits sets `makeMinimal`
 *    and runs `computeMoreMinimalEdits`, which merges adjacent edits and
 *    re-emits one edit per `stringDiff` hunk. The content-change events
 *    mirror the applied (minimized) edits: replacing `◂i` with `\ti` is
 *    delivered as replacing `◂` with `\t` (the `i` is unchanged). When the
 *    adapter submitted unminimized edits, the revert step (`◂i` → `\ti`
 *    while typing `\times`) came back unrecognized, was replayed into the
 *    engine as a bogus user edit, and killed tracking — `\times` stayed
 *    literal. The adapter now submits pre-minimized edits and falls back to
 *    comparing the resulting document text when VS Code merges or splits
 *    them further.
 *
 * 2. **Cursor mapping.** A cursor at (or inside) a replaced range is left at
 *    its old offset, clamped to the end of the new text
 *    (`newCursor = min(oldCursor, rangeStart + newText.length)`); a cursor
 *    after the range shifts by the length delta. With minimized edits the
 *    typing cursor sits after the edit and maps correctly; the engine's
 *    explicit repositioning (setSelections) remains as a safety net for
 *    cursors inside a replaced region.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Position, Selection, Uri, commands, window, workspace } from "vscode";
import { MockTextDocument } from "./__mocks__/vscode.js";
import type * as vscode from "vscode";
import {
  VSCodeAbbreviationRewriter,
  minimizeChange,
} from "../src/unicode/VSCodeAbbreviationRewriter";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";
import { Range } from "../src/unicode/engine/Range";
import { commonPrefixSuffix } from "../src/util/editAdjust";

/** Minimal status bar item for the adapter. */
class MockStatusBarItem {
  text = "";
  show(): void {}
  hide(): void {}
  dispose(): void {}
}

type ChangeHandler = (e: {
  document: unknown;
  contentChanges: { rangeOffset: number; rangeLength: number; text: string }[];
}) => void;

type SelectionHandler = (e: { textEditor: unknown; selections: vscode.Selection[] }) => void;

/**
 * Cursor-faithful fake of a VS Code text editor + the workspace.applyEdit
 * pipeline. Fires document/selection change events exactly like VS Code:
 * change events for both user typing and applyEdit, selection events after
 * user typing and after programmatic `selections` assignment.
 */
class FakeVSCodeEditor {
  readonly document: MockTextDocument;
  private _selections: vscode.Selection[];

  changeHandlers: ChangeHandler[] = [];
  selectionHandlers: SelectionHandler[] = [];

  /** Number of event-loop turns applyEdit defers before applying (0 = synchronous). */
  applyEditDelayTicks = 0;

  /**
   * Report each applied edit as TWO content changes (delete + insert).
   * VS Code's `$computeMoreMinimalEdits` re-emits one edit per `stringDiff`
   * hunk, so a single submitted edit may legally come back split; this flag
   * models that worst case.
   */
  splitOwnEditEvents = false;

  private holdGates: { pre: Promise<void>; post: Promise<void> } | null = null;

  /**
   * Make the next applyEdit wait for explicit gates: `applyNow()` lets it
   * apply the edit and fire events; `finish()` lets the promise resolve.
   * Keystrokes between the two land AFTER our edit but DURING the await —
   * the window where replay ordering matters.
   */
  holdNextApplyEdit(): { applyNow: () => void; finish: () => void } {
    let applyNow!: () => void;
    let finish!: () => void;
    const pre = new Promise<void>((r) => (applyNow = r));
    const post = new Promise<void>((r) => (finish = r));
    this.holdGates = { pre, post };
    return { applyNow, finish };
  }

  constructor(content: string) {
    this.document = MockTextDocument.create(Uri.file("/test/Fake.agda"), content, "agda");
    const origin = new Position(0, 0);
    this._selections = [new Selection(origin, origin) as unknown as vscode.Selection];
  }

  get selections(): vscode.Selection[] {
    return this._selections;
  }

  /** Programmatic selection assignment fires a selection event, like VS Code. */
  set selections(value: vscode.Selection[]) {
    this._selections = value;
    this.fireSelectionEvent();
  }

  setDecorations(): void {}

  cursorOffset(): number {
    return this.document.offsetAt(this._selections[0].active);
  }

  private setCursorSilently(offset: number): void {
    const pos = this.document.positionAt(offset);
    this._selections = [new Selection(pos, pos) as unknown as vscode.Selection];
  }

  fireSelectionEvent(): void {
    for (const h of [...this.selectionHandlers]) {
      h({ textEditor: this, selections: this._selections });
    }
  }

  private fireChangeEvent(
    changes: { rangeOffset: number; rangeLength: number; text: string }[],
  ): void {
    for (const h of [...this.changeHandlers]) {
      h({ document: this.document, contentChanges: changes });
    }
  }

  /** Simulate the user typing a character at the cursor. */
  type(ch: string): void {
    const off = this.cursorOffset();
    const content = this.document.getText();
    MockTextDocument.setContents(this.document, content.slice(0, off) + ch + content.slice(off));
    this.setCursorSilently(off + ch.length);
    this.fireChangeEvent([{ rangeOffset: off, rangeLength: 0, text: ch }]);
    this.fireSelectionEvent();
  }

  /** Simulate the user pressing backspace (deletes one code unit). */
  backspace(): void {
    const off = this.cursorOffset();
    if (off === 0) return;
    const content = this.document.getText();
    MockTextDocument.setContents(this.document, content.slice(0, off - 1) + content.slice(off));
    this.setCursorSilently(off - 1);
    this.fireChangeEvent([{ rangeOffset: off - 1, rangeLength: 1, text: "" }]);
    this.fireSelectionEvent();
  }

  /**
   * workspace.applyEdit replacement: applies the WorkspaceEdit to the
   * document, remaps cursors with VS Code's (flawed-for-growth) semantics,
   * and fires the change + selection events.
   */
  async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    const gates = this.holdGates;
    this.holdGates = null;
    if (gates) await gates.pre;
    for (let i = 0; i < this.applyEditDelayTicks; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    const textEdits: vscode.TextEdit[] = (
      edit as unknown as {
        get(uri: vscode.Uri): vscode.TextEdit[];
      }
    ).get(this.document.uri);
    if (!textEdits || textEdits.length === 0) return true;

    // Convert to offset-based changes against the current document, and
    // MINIMIZE each one (trim common prefix/suffix with the replaced text)
    // -- real VS Code delivers minimized content-change events, e.g.
    // replacing "◂i" with "\ti" is reported as replacing "◂" with "\t".
    const preText = this.document.getText();
    const changes = textEdits
      .map((te) => ({
        start: this.document.offsetAt(te.range.start),
        oldLength: this.document.offsetAt(te.range.end) - this.document.offsetAt(te.range.start),
        text: te.newText,
      }))
      .map((c) => {
        const oldText = preText.slice(c.start, c.start + c.oldLength);
        const { prefix, suffix } = commonPrefixSuffix(oldText, c.text);
        return {
          start: c.start + prefix,
          oldLength: c.oldLength - prefix - suffix,
          text: c.text.slice(prefix, c.text.length - suffix),
        };
      })
      .filter((c) => c.oldLength > 0 || c.text.length > 0)
      .sort((a, b) => a.start - b.start);
    if (changes.length === 0) return true;

    const oldCursors = this._selections.map((s) => this.document.offsetAt(s.active));

    // Apply bottom-up so offsets stay valid.
    let content = this.document.getText();
    for (const c of [...changes].reverse()) {
      content = content.slice(0, c.start) + c.text + content.slice(c.start + c.oldLength);
    }
    MockTextDocument.setContents(this.document, content);

    // VS Code cursor mapping: min(oldOffset, end of new text) inside a
    // replaced range; shift by the cumulative delta after it.
    const mapOffset = (p: number): number => {
      let shift = 0;
      for (const c of changes) {
        if (p < c.start) break;
        if (p <= c.start + c.oldLength) {
          return Math.min(p + shift, c.start + shift + c.text.length);
        }
        shift += c.text.length - c.oldLength;
      }
      return p + shift;
    };
    this.setCursorSilently(mapOffset(oldCursors[0]));

    // All ranges within one event are in PRE-change coordinates.
    let eventChanges = changes.map((c) => ({
      rangeOffset: c.start,
      rangeLength: c.oldLength,
      text: c.text,
    }));
    if (this.splitOwnEditEvents) {
      eventChanges = eventChanges.flatMap((c) =>
        c.rangeLength > 0 && c.text.length > 0
          ? [
              { rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: "" },
              { rangeOffset: c.rangeOffset + c.rangeLength, rangeLength: 0, text: c.text },
            ]
          : [c],
      );
    }
    this.fireChangeEvent(eventChanges);
    this.fireSelectionEvent();
    if (gates) await gates.post;
    return true;
  }
}

/** Wait for the rewriter's op queue and any follow-up drains to settle. */
async function settle(rw: VSCodeAbbreviationRewriter): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await rw.flush();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

function setup(applyEditDelayTicks = 0): {
  editor: FakeVSCodeEditor;
  rewriter: VSCodeAbbreviationRewriter;
} {
  const editor = new FakeVSCodeEditor("");
  editor.applyEditDelayTicks = applyEditDelayTicks;

  vi.mocked(workspace.onDidChangeTextDocument).mockImplementation(((handler: ChangeHandler) => {
    editor.changeHandlers.push(handler);
    return { dispose: () => {} };
  }) as never);
  vi.mocked(window.onDidChangeTextEditorSelection).mockImplementation(((
    handler: SelectionHandler,
  ) => {
    editor.selectionHandlers.push(handler);
    return { dispose: () => {} };
  }) as never);
  vi.mocked(workspace.applyEdit).mockImplementation(((edit: vscode.WorkspaceEdit) =>
    editor.applyEdit(edit)) as never);
  vi.mocked(commands.executeCommand).mockResolvedValue(undefined as never);

  const rewriter = new VSCodeAbbreviationRewriter(
    "\\",
    new AbbreviationProvider({}),
    editor as unknown as vscode.TextEditor,
    new MockStatusBarItem() as unknown as vscode.StatusBarItem,
  );
  return { editor, rewriter };
}

async function typeString(
  editor: FakeVSCodeEditor,
  rewriter: VSCodeAbbreviationRewriter,
  s: string,
): Promise<void> {
  for (const ch of s) {
    editor.type(ch);
    await settle(rewriter);
  }
}

describe("VSCodeAbbreviationRewriter (cursor-faithful editor)", () => {
  beforeEach(() => {
    vi.mocked(workspace.onDidChangeTextDocument).mockReset();
    vi.mocked(window.onDidChangeTextEditorSelection).mockReset();
    vi.mocked(workspace.applyEdit).mockReset();
  });

  it("minimized own edits keep \\times working even without selection repositioning", async () => {
    // Historical regression (\tmesi): with UNminimized submitted edits, the
    // revert `◂i` → `\ti` left the cursor mid-abbreviation, garbling input;
    // worse, the minimized event VS Code echoes back went unrecognized and
    // killed tracking entirely. With minimized submissions, VS Code's own
    // cursor mapping is correct for the revert step, so even with the
    // setSelections safety net disabled, \times must work end to end.
    const { editor, rewriter } = setup();
    (rewriter as unknown as { setSelections: () => void }).setSelections = () => {};

    await typeString(editor, rewriter, "\\times");

    expect(editor.document.getText()).toBe("×");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("typing \\times yields × with the cursor after it", async () => {
    const { editor, rewriter } = setup();

    await typeString(editor, rewriter, "\\times");

    expect(editor.document.getText()).toBe("×");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("intermediate revert step positions the cursor after \\ti", async () => {
    const { editor, rewriter } = setup();

    await typeString(editor, rewriter, "\\ti");

    // "t" was eagerly replaced with ◂; "i" reverted it to typing mode.
    expect(editor.document.getText()).toBe("\\ti");
    expect(editor.cursorOffset()).toBe(3);

    rewriter.dispose();
  });

  it("prefix commands still complete: \\to → →, then extension to \\top → ⊤", async () => {
    const { editor, rewriter } = setup();

    await typeString(editor, rewriter, "\\to");
    expect(editor.document.getText()).toBe("→");
    expect(editor.cursorOffset()).toBe(1);

    await typeString(editor, rewriter, "p");
    expect(editor.document.getText()).toBe("⊤");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("keystroke racing with applyEdit is replayed and converges", async () => {
    const { editor, rewriter } = setup(2);

    // Type \t and, without waiting for the (delayed) eager replacement,
    // type o. The o event arrives while pendingOwnChanges is set and goes
    // through the pre-flush buffer + offset adjustment.
    editor.type("\\");
    editor.type("t");
    editor.type("o");
    await settle(rewriter);
    await settle(rewriter);

    expect(editor.document.getText()).toBe("→");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("backspace after \\times reverts to \\time with the cursor after the e", async () => {
    // Regression: the shorten flush INSERTS "\time" into the span emptied by
    // the backspace; the cursor was left at offset 0, before the leader.
    const { editor, rewriter } = setup();

    await typeString(editor, rewriter, "\\times");
    expect(editor.document.getText()).toBe("×");

    editor.backspace();
    await settle(rewriter);

    expect(editor.document.getText()).toBe("\\time");
    expect(editor.cursorOffset()).toBe(5);

    // Round trip: retyping "s" completes the abbreviation again.
    await typeString(editor, rewriter, "s");
    expect(editor.document.getText()).toBe("×");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("a keystroke landing after our edit does not overtake one buffered before it", async () => {
    // Fast typing: while the eager \t → ◂ replacement is in flight, "i"
    // lands BEFORE the edit applies (buffered for replay) and "m" lands
    // AFTER it (enqueued directly). The buffered "i" is causally earlier —
    // if it is replayed behind "m", offsets are interpreted against the
    // wrong document state and keystrokes are orphaned outside the
    // abbreviation (the '\times' → '⁀ms'-style garbling).
    const { editor, rewriter } = setup();
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const hold = editor.holdNextApplyEdit();
    editor.type("\\");
    editor.type("t"); // starts the eager flush; applyEdit is gated
    await tick();
    editor.type("i"); // applies before our edit → pre-flush buffer
    hold.applyNow(); // ◂ replaces \t; own event fires
    await tick();
    editor.type("m"); // applies after our edit, while applyEdit is unresolved
    hold.finish();
    await settle(rewriter);

    await typeString(editor, rewriter, "es");

    expect(editor.document.getText()).toBe("×");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("a desynced abbreviation is dropped instead of overwriting document text", async () => {
    // If a change event is ever lost or mis-sequenced beyond repair, the
    // engine's picture of its span no longer matches the document. Writing
    // through it would clobber user text; the abbreviation must be dropped.
    const { editor, rewriter } = setup();

    await typeString(editor, rewriter, "\\t");
    expect(editor.document.getText()).toBe("◂");

    // Simulate a document mutation whose event never reached the adapter.
    MockTextDocument.setContents(editor.document, "Z");

    editor.type("o");
    await settle(rewriter);

    // Without pruning, the engine "extends" the abbreviation it thinks is
    // at [0,2) and overwrites "Zo" with →.
    expect(editor.document.getText()).toBe("Zo");

    rewriter.dispose();
  });

  it("own edits split into multiple diff hunks are still recognized", async () => {
    // $computeMoreMinimalEdits re-emits one edit per stringDiff hunk, so our
    // single submitted replacement can come back as several content changes.
    // Exact list-matching fails then; the expected-text fallback must
    // recognize the edit as ours.
    const { editor, rewriter } = setup();
    editor.splitOwnEditEvents = true;

    await typeString(editor, rewriter, "\\times");

    expect(editor.document.getText()).toBe("×");
    expect(editor.cursorOffset()).toBe(1);

    rewriter.dispose();
  });

  it("cursor stays put when replacement happens because the cursor left", async () => {
    const { editor, rewriter } = setup();

    // \alp is incomplete (alpha exists); move the cursor away to finalize.
    await typeString(editor, rewriter, "\\alpha");
    expect(editor.document.getText()).toBe("α");

    // Type an ordinary character after the symbol — finalizes tracking.
    await typeString(editor, rewriter, " x");
    expect(editor.document.getText()).toBe("α x");
    expect(editor.cursorOffset()).toBe(3);
    expect(rewriter).toBeDefined();

    rewriter.dispose();
  });
});

describe("minimizeChange", () => {
  it("trims a shared suffix (the \\ti revert case)", () => {
    const m = minimizeChange("◂i", { range: new Range(0, 2), newText: "\\ti" });
    expect(m).toEqual({ range: new Range(0, 1), newText: "\\t" });
  });

  it("trims a shared prefix", () => {
    const m = minimizeChange("abX", { range: new Range(5, 3), newText: "abY" });
    expect(m).toEqual({ range: new Range(7, 1), newText: "Y" });
  });

  it("leaves disjoint replacements unchanged", () => {
    const m = minimizeChange("\\to", { range: new Range(0, 3), newText: "→" });
    expect(m).toEqual({ range: new Range(0, 3), newText: "→" });
  });

  it("returns null for a no-op change", () => {
    expect(minimizeChange("abc", { range: new Range(2, 3), newText: "abc" })).toBeNull();
  });

  it("does not split a surrogate pair in a shared prefix", () => {
    // 𝐀 (D835 DC00) → 𝐁 (D835 DC01): the high surrogate is a common prefix,
    // but trimming it would submit an edit range starting mid-code-point.
    const m = minimizeChange("𝐀", {
      range: new Range(0, 2),
      newText: "𝐁",
    });
    expect(m).toEqual({ range: new Range(0, 2), newText: "𝐁" });
  });

  it("does not split a surrogate pair in a shared suffix", () => {
    // U+1D400 (D835 DC00) → U+1D800 (D836 DC00): the low surrogate is a
    // common suffix.
    const m = minimizeChange("𝐀", {
      range: new Range(0, 2),
      newText: "𝠀",
    });
    expect(m).toEqual({ range: new Range(0, 2), newText: "𝠀" });
  });
});
