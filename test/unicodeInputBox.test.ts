import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";
import { computeChanges, showUnicodeInputBox } from "../src/editor/unicodeInputBox";
import { Range } from "../src/unicode/engine/Range";
import { workspace, window, commands } from "vscode";

/** Minimal mock of vscode.StatusBarItem. */
class MockStatusBarItem {
  text = "";
  private _visible = false;

  show() {
    this._visible = true;
  }
  hide() {
    this._visible = false;
  }
  get isVisible() {
    return this._visible;
  }
  dispose() {}
}

/** Minimal mock of vscode.InputBox that captures callbacks. */
class MockInputBox {
  value = "";
  prompt = "";
  valueSelection: [number, number] | undefined;

  private _onChangeCallbacks: ((value: string) => void)[] = [];
  private _onAcceptCallbacks: (() => void)[] = [];
  private _onHideCallbacks: (() => void)[] = [];

  onDidChangeValue(cb: (value: string) => void) {
    this._onChangeCallbacks.push(cb);
    return { dispose: () => {} };
  }
  onDidAccept(cb: () => void) {
    this._onAcceptCallbacks.push(cb);
    return { dispose: () => {} };
  }
  onDidHide(cb: () => void) {
    this._onHideCallbacks.push(cb);
    return { dispose: () => {} };
  }
  show() {}
  dispose() {}

  // --- Test drivers ---

  /** Simulate typing a single character at the end. */
  type(ch: string) {
    this.value += ch;
    for (const cb of this._onChangeCallbacks) cb(this.value);
  }

  /** Simulate typing a string one character at a time. */
  typeString(s: string) {
    for (const ch of s) this.type(ch);
  }

  /** Simulate pressing backspace (delete last character). */
  backspace() {
    if (this.value.length === 0) return;
    this.value = this.value.slice(0, -1);
    for (const cb of this._onChangeCallbacks) cb(this.value);
  }

  /** Simulate pressing Enter. */
  accept() {
    for (const cb of this._onAcceptCallbacks) cb();
  }

  /** Simulate pressing Escape / hiding the input box. */
  hide() {
    for (const cb of this._onHideCallbacks) cb();
  }
}

// ---------------------------------------------------------------------------
// computeChanges
// ---------------------------------------------------------------------------

describe("computeChanges", () => {
  it("detects single character appended at end", () => {
    const changes = computeChanges("abc", "abcd");
    expect(changes).toEqual([{ range: new Range(3, 0), newText: "d" }]);
  });

  it("detects single character inserted at beginning", () => {
    const changes = computeChanges("abc", "xabc");
    expect(changes).toEqual([{ range: new Range(0, 0), newText: "x" }]);
  });

  it("detects single character inserted in middle", () => {
    const changes = computeChanges("abc", "axbc");
    expect(changes).toEqual([{ range: new Range(1, 0), newText: "x" }]);
  });

  it("detects single character deleted from end", () => {
    const changes = computeChanges("abcd", "abc");
    expect(changes).toEqual([{ range: new Range(3, 1), newText: "" }]);
  });

  it("detects replacement", () => {
    const changes = computeChanges("abc", "axc");
    expect(changes).toEqual([{ range: new Range(1, 1), newText: "x" }]);
  });

  it("detects paste (multi-char insertion)", () => {
    const changes = computeChanges("ac", "abbc");
    expect(changes).toEqual([{ range: new Range(1, 0), newText: "bb" }]);
  });

  it("returns empty for identical strings", () => {
    expect(computeChanges("abc", "abc")).toEqual([]);
  });

  it("handles empty to non-empty", () => {
    const changes = computeChanges("", "abc");
    expect(changes).toEqual([{ range: new Range(0, 0), newText: "abc" }]);
  });

  it("handles non-empty to empty", () => {
    const changes = computeChanges("abc", "");
    expect(changes).toEqual([{ range: new Range(0, 3), newText: "" }]);
  });
});

// ---------------------------------------------------------------------------
// showUnicodeInputBox
// ---------------------------------------------------------------------------

describe("showUnicodeInputBox", () => {
  let mockInputBox: MockInputBox;
  let mockStatusBar: MockStatusBarItem;

  beforeEach(() => {
    mockInputBox = new MockInputBox();
    mockStatusBar = new MockStatusBarItem();

    vi.mocked(window.createInputBox).mockReturnValue(mockInputBox as any);

    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: (key: string, defaultValue?: unknown) => {
        if (key === "agda.input.enabled") return true;
        if (key === "agda.input.leader") return "\\";
        return defaultValue;
      },
    } as any);

    // Mock commands for context variable and cycle command registration
    vi.mocked(commands.executeCommand).mockResolvedValue(undefined);
    vi.mocked(commands.registerCommand).mockReturnValue({ dispose: () => {} } as any);
  });

  it("eagerly replaces abbreviation when complete", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    // \to is a complete abbreviation — should be eagerly replaced
    mockInputBox.typeString("\\to");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("→");
  });

  it("replaces abbreviation and keeps trailing character", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    // Type \to then space
    mockInputBox.typeString("\\to ");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("→ ");
  });

  it("returns undefined on hide (Escape)", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\to");
    mockInputBox.hide();

    const result = await promise;
    expect(result).toBeUndefined();
  });

  it("leaves non-matching abbreviation as-is", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\zzz ");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("\\zzz ");
  });

  it("leaves non-matching abbreviation as-is on accept", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\zzz");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("\\zzz");
  });

  it("handles text before the abbreviation", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("foo \\to ");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("foo → ");
  });

  it("handles multiple abbreviations in sequence", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\to \\all ");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("→ ∀ ");
  });

  it("replaces \\all with forall symbol", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\all");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("∀");
  });

  it("replaces \\Gl with lambda symbol", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\Gl ");
    mockInputBox.accept();

    const result = await promise;
    expect(result).toBe("λ ");
  });

  it("falls back to showInputBox when input disabled", async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: (key: string, defaultValue?: unknown) => {
        if (key === "agda.input.enabled") return false;
        return defaultValue;
      },
    } as any);

    vi.mocked(window.showInputBox).mockResolvedValue("fallback");

    const provider = new AbbreviationProvider({});
    const result = await showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });
    expect(result).toBe("fallback");
    expect(window.showInputBox).toHaveBeenCalledWith({ prompt: "test" });
  });

  it("sets cursor position after replacement", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    // \to triggers eager replacement — cursor should be after "→"
    mockInputBox.typeString("\\to");
    // Wait for async drain
    await new Promise((r) => setTimeout(r, 0));
    expect(mockInputBox.valueSelection).toEqual([1, 1]);

    mockInputBox.accept();
    await promise;
  });

  // -------------------------------------------------------------------------
  // Backspace handling
  // -------------------------------------------------------------------------

  it("handles backspace then retype: \\alph <bs> ha", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\alph");
    mockInputBox.backspace(); // → \alp (shorten)
    mockInputBox.typeString("ha"); // → \alpha (eager replacement)

    mockInputBox.accept();
    const result = await promise;
    expect(result).toBe("α");
  });

  it("handles backspace to empty abbreviation text then retype", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\t");
    mockInputBox.backspace(); // → just "\"
    mockInputBox.typeString("to"); // → \to (eager replacement)

    mockInputBox.accept();
    const result = await promise;
    expect(result).toBe("→");
  });

  it("abandons abbreviation when leader is backspaced", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\t");
    mockInputBox.backspace(); // → "\"
    mockInputBox.backspace(); // → "" — leader deleted
    mockInputBox.typeString("to "); // no leader, just literal text

    mockInputBox.accept();
    const result = await promise;
    expect(result).toBe("to ");
  });

  it("handles multiple backspaces within abbreviation", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\alph");
    mockInputBox.backspace(); // \alp
    mockInputBox.backspace(); // \al
    mockInputBox.backspace(); // \a
    mockInputBox.typeString("ll"); // \all (eager replacement)

    mockInputBox.accept();
    const result = await promise;
    expect(result).toBe("∀");
  });

  // -------------------------------------------------------------------------
  // Status bar feedback
  // -------------------------------------------------------------------------

  it("shows abbreviation info in status bar while typing", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\t");
    // Wait for drain to update status bar
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStatusBar.text).toContain("\\t");
    expect(mockStatusBar.isVisible).toBe(true);

    mockInputBox.hide();
    await promise;
  });

  it("hides status bar when abbreviation is finalized", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\to ");
    // After finalization, status bar should be hidden
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStatusBar.isVisible).toBe(false);

    mockInputBox.accept();
    await promise;
  });

  it("hides status bar on resolve", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    mockInputBox.typeString("\\to");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStatusBar.isVisible).toBe(true);

    mockInputBox.accept();
    await promise;
    expect(mockStatusBar.isVisible).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Context variable and lifecycle
  // -------------------------------------------------------------------------

  it("sets context variable on show and clears on accept", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    // Context should be set to true on show
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "agda.inputBox.isActive",
      true,
    );

    mockInputBox.accept();
    await promise;

    // Context should be set to false on accept
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "agda.inputBox.isActive",
      false,
    );
  });

  it("registers cycle commands", async () => {
    const provider = new AbbreviationProvider({});
    const promise = showUnicodeInputBox(provider, mockStatusBar as any, { prompt: "test" });

    expect(commands.registerCommand).toHaveBeenCalledWith(
      "agda.inputBox.cycleForward",
      expect.any(Function),
    );
    expect(commands.registerCommand).toHaveBeenCalledWith(
      "agda.inputBox.cycleBackward",
      expect.any(Function),
    );

    mockInputBox.hide();
    await promise;
  });
});
