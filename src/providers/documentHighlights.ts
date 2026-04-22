import * as vscode from "vscode";

// Word pattern mirrors language-configuration.json wordPattern.
const WORD_RE = /[^\s(){}\"@;.]+/;
const WORD_BOUNDARY = String.raw`[\s(){}"@;.]|^|$`;

/**
 * Regex-based document highlights (all occurrences of the word under the cursor).
 *
 * This is regex based (whereas renaming is semantic token based). Advantage: cheap,
 * doesn't require the file to have been freshly loaded by Agda. Disadvantage: not
 * quite as accurate because some Agda kinds reside in disjoint namespaces (e.g.,
 * modules and functions).
 */
export class AgdaDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.DocumentHighlight[] | undefined {
    const wordRange = document.getWordRangeAtPosition(position, WORD_RE);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);

    // Escape regex special characters (https://github.com/tc39/proposal-regex-escaping)
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<=${WORD_BOUNDARY})${escaped}(?=${WORD_BOUNDARY})`, "g");

    const text = document.getText();
    const results: vscode.DocumentHighlight[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = document.positionAt(m.index);
      const end = document.positionAt(m.index + m[0].length);
      results.push(new vscode.DocumentHighlight(new vscode.Range(start, end)));
    }

    return results;
  }
}
