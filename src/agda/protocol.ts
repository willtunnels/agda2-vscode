// Line-buffered stdout parser for Agda's --interaction-json mode.
// Accumulates partial lines, parses complete JSON lines, detects the "JSON> " prompt.

import * as vscode from "vscode";
import { getErrorMessage } from "../util/errorMessage.js";
import { type AgdaResponse, normalizeResponse } from "./responses.js";

const PROMPT = "JSON> ";

export class AgdaProtocol implements vscode.Disposable {
  private buffer = "";
  private readonly _onResponse = new vscode.EventEmitter<AgdaResponse>();
  private readonly _onPrompt = new vscode.EventEmitter<void>();
  private readonly _onError = new vscode.EventEmitter<Error>();

  /** Fires for each parsed JSON response. */
  readonly onResponse = this._onResponse.event;

  /** Fires when the "JSON> " prompt is detected (command complete). */
  readonly onPrompt = this._onPrompt.event;

  /** Fires on parse errors (non-fatal, logged and skipped). */
  readonly onError = this._onError.event;

  /**
   * Feed raw stdout data from the Agda process.
   * Call this from the process stdout 'data' handler.
   */
  feed(chunk: string): void {
    this.buffer += chunk;
    this.processBuffer();
  }

  /** Reset the buffer (e.g. on process restart). */
  reset(): void {
    this.buffer = "";
  }

  private processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.processLine(line);
    }

    // Check if the remaining buffer is (or starts with) the prompt.
    // The prompt "JSON> " appears without a trailing newline.
    if (this.buffer === PROMPT || this.buffer.startsWith(PROMPT)) {
      this.buffer = this.buffer.slice(PROMPT.length);
      this._onPrompt.fire();
      // There might be more data after the prompt (unlikely but handle it)
      if (this.buffer.length > 0) {
        this.processBuffer();
      }
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      const raw = JSON.parse(trimmed) as AgdaResponse;
      const parsed = normalizeResponse(raw);
      this._onResponse.fire(parsed);
    } catch (e) {
      this._onError.fire(
        new Error(
          `Failed to parse Agda response: ${getErrorMessage(e)}\nLine: ${trimmed.slice(0, 1000)}`,
        ),
      );
    }
  }

  dispose(): void {
    this._onResponse.dispose();
    this._onPrompt.dispose();
    this._onError.dispose();
  }
}
