/**
 * Quote a string as a Haskell string literal.
 * Non-ASCII characters are escaped as \xNNNN.
 */
export function haskellStringQuote(s: string): string {
  let result = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") {
      result += "\\\\";
    } else if (ch === '"') {
      result += '\\"';
    } else if (ch === "\n") {
      result += "\\n";
    } else if (ch === "\r") {
      result += "\\r";
    } else if (ch === "\t") {
      result += "\\t";
    } else if (code >= 0x20 && code <= 0x7e) {
      result += ch;
    } else {
      // Escape non-ASCII as decimal (Haskell uses \NNNN decimal escapes)
      result += "\\" + code.toString(10);
    }
  }
  result += '"';
  return result;
}

export type HlLevel = "None" | "NonInteractive" | "Interactive";

/**
 * Build the IOTCM envelope for a command.
 *
 * @param filepath  Absolute path to the Agda file
 * @param cmd       The inner command string, e.g. 'Cmd_load "/path" []'
 */
export function iotcm(filepath: string, hlLevel: HlLevel, cmd: string): string {
  return `IOTCM ${haskellStringQuote(filepath)} ${hlLevel} Direct (${cmd})`;
}

/**
 * Quote a list of strings as a Haskell list literal.
 * e.g. haskellListQuote(["a", "b"]) => '["a","b"]'
 */
export function haskellListQuote(items: string[]): string {
  return "[" + items.map(haskellStringQuote).join(",") + "]";
}
