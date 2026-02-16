/**
 * VS Code mock for unit/integration testing.
 *
 * Uses jest-mock-vscode for battle-tested implementations of Position,
 * Range, Selection, Uri, WorkspaceEdit, MockTextDocument, etc.
 *
 * Singleton mocks (workspace, window, commands) are created lazily via
 * createVSCodeMock(vi) on first access so that the globalSetup (which
 * doesn't have vitest's vi available) can still import this module for
 * type-only / non-runtime vscode references.
 */

// Re-export all pure classes from jest-mock-vscode (no vi dependency)
export {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CodeActionKind,
  CodeLens,
  Color,
  ColorInformation,
  ColorPresentation,
  ColorThemeKind,
  CommentMode,
  CommentThreadCollapsibleState,
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  CompletionList,
  CompletionTriggerKind,
  ConfigurationTarget,
  DecorationRangeBehavior,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  DiagnosticTag,
  Disposable,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentLink,
  DocumentSymbol,
  EndOfLine,
  EnvironmentVariableMutatorType,
  EvaluatableExpression,
  EventEmitter,
  ExtensionKind,
  ExtensionMode,
  FileChangeType,
  FoldingRange,
  FoldingRangeKind,
  Location,
  LogLevel,
  MarkdownString,
  NotebookCellStatusBarAlignment,
  NotebookEditorRevealType,
  Position,
  ProgressLocation,
  Range,
  Selection,
  SelectionRange,
  SemanticTokens,
  SemanticTokensEdit,
  SemanticTokensEdits,
  SemanticTokensLegend,
  ShellQuoting,
  SignatureHelpTriggerKind,
  SnippetString,
  StatusBarAlignment,
  SymbolInformation,
  SymbolKind,
  SymbolTag,
  TextDocumentSaveReason,
  TextEdit,
  TextEditorLineNumbersStyle,
  TextEditorRevealType,
  TextEditorSelectionChangeKind,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  ViewColumn,
} from "jest-mock-vscode/dist/vscode/index.js";

export { WorkspaceEdit } from "jest-mock-vscode/dist/vscode/WorkspaceEdit.js";
export { MockTextDocument } from "jest-mock-vscode/dist/vscode/TextDocument.js";
export { createMockTextEditor } from "jest-mock-vscode/dist/vscode/TextEditor.js";

// ---------------------------------------------------------------------------
// Lazy singleton mocks (need vi from vitest)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mock: any;

// We import vi at the top level -- this file is only loaded via the
// vitest resolve alias, so vi is always available.
import { vi } from "vitest";
import { createVSCodeMock } from "jest-mock-vscode";

function getMock() {
  if (!_mock) {
    _mock = createVSCodeMock(vi);
    // createTextEditorDecorationType is vi.fn() which returns undefined.
    // GoalManager needs it to return an object with dispose().
    _mock.window.createTextEditorDecorationType = vi.fn(() => ({
      key: "mock-decoration",
      dispose: vi.fn(),
    }));
  }
  return _mock;
}

// Proxy objects that lazily delegate to the full mock
export const workspace = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    return (getMock().workspace as Record<string, unknown>)[prop as string];
  },
});

export const window = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    return (getMock().window as Record<string, unknown>)[prop as string];
  },
});

export const commands = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    return (getMock().commands as Record<string, unknown>)[prop as string];
  },
});

export const languages = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    return (getMock().languages as Record<string, unknown>)[prop as string];
  },
});

export const env = {
  openExternal: () => Promise.resolve(true),
};

// SemanticTokensBuilder isn't in extHostTypes -- provide a minimal one
export class SemanticTokensBuilder {
  private _data: number[] = [];
  constructor(_legend?: unknown) {}
  push(
    line: number,
    char: number,
    length: number,
    tokenType: number,
    tokenModifiers: number,
  ): void {
    this._data.push(line, char, length, tokenType, tokenModifiers);
  }
  build(): { resultId: string | undefined; data: Uint32Array } {
    return { resultId: undefined, data: new Uint32Array(this._data) };
  }
}

// Hover is used by our hover provider
export { Position as _Position } from "jest-mock-vscode/dist/vscode/index.js";
import { MarkdownString as _MS, Range as _Range } from "jest-mock-vscode/dist/vscode/index.js";
export class Hover {
  contents: _MS[];
  range?: _Range;
  constructor(contents: _MS | _MS[], range?: _Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}
