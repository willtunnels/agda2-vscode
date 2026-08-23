/**
 * Editor-level tests for VSCodeAbbreviationRewriter using a cursor-faithful
 * fake of VS Code's text editor.
 *
 * The crucial detail the fake reproduces is `workspace.applyEdit`'s cursor
 * mapping: a cursor at (or inside) a replaced range is left at its old
 * offset, clamped to the end of the new text — i.e.
 *
 *     newCursor = min(oldCursor, rangeStart + newText.length)
 *
 * When a replacement SHRINKS the text (`\t` → `◂`) this clamps to the end of
 * the new text, which happens to be correct. When a replacement GROWS the
 * text (`◂i` → `\ti`, the "revert to typing mode" step) the cursor stays at
 * its old offset — in the middle of the new text. Without explicit
 * repositioning, typing `\times` then continues between `t` and `i`:
 *
 *     \t → ◂ → ◂i → \ti (cursor between t and i!) → \tmi → \tmei → \tmesi
 *
 * which is the exact garbled output this regression suite pins down.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Position, Selection, Uri, commands, window, workspace } from "vscode";
import { MockTextDocument } from "./__mocks__/vscode.js";
import type * as vscode from "vscode";
import { VSCodeAbbreviationRewriter } from "../src/unicode/VSCodeAbbreviationRewriter";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";

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

  /**
   * workspace.applyEdit replacement: applies the WorkspaceEdit to the
   * document, remaps cursors with VS Code's (flawed-for-growth) semantics,
   * and fires the change + selection events.
   */
  async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    for (let i = 0; i < this.applyEditDelayTicks; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    const textEdits: vscode.TextEdit[] = (
      edit as unknown as {
        get(uri: vscode.Uri): vscode.TextEdit[];
      }
    ).get(this.document.uri);
    if (!textEdits || textEdits.length === 0) return true;

    // Convert to offset-based changes against the current document.
    const changes = textEdits
      .map((te) => ({
        start: this.document.offsetAt(te.range.start),
        oldLength: this.document.offsetAt(te.range.end) - this.document.offsetAt(te.range.start),
        text: te.newText,
      }))
      .sort((a, b) => a.start - b.start);

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

    this.fireChangeEvent(
      changes.map((c) => ({ rangeOffset: c.start, rangeLength: c.oldLength, text: c.text })),
    );
    this.fireSelectionEvent();
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

  it("REPRODUCTION: without selection repositioning, \\times degenerates to \\tmesi", async () => {
    const { editor, rewriter } = setup();
    // Disable the fix on this instance to demonstrate the underlying
    // VS Code behavior this suite guards against.
    (rewriter as unknown as { setSelections: () => void }).setSelections = () => {};

    await typeString(editor, rewriter, "\\times");

    // \t eagerly became ◂; typing i reverted ◂i → \ti but the cursor was
    // left at offset 2 (between t and i); m, e, s then landed there.
    expect(editor.document.getText()).toBe("\\tmesi");
    expect(editor.cursorOffset()).toBe(5); // between "s" and "i"

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
