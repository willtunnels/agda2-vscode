/**
 * Editor Test Harness
 *
 * Combines a MockDocumentEditor + a real Agda process + a real GoalManager +
 * the REAL processBatchedResponses to test the full give/load flow end-to-end
 * -- document mutations, goal tracking, and decoration placement -- without a
 * running VS Code instance.
 *
 * Unlike the previous version, this does NOT reimplement any logic from
 * commands.ts. It calls the extracted processBatchedResponses from
 * src/core/responseProcessor.ts with minimal callbacks.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MockDocumentEditor } from "./mockDocumentEditor.js";
import { spawnAgda, haskellStringQuote, type AgdaSession } from "./agdaSession.js";
import { GoalManager, type Goal } from "../../src/core/goals.js";
import { processBatchedResponses, noopCallbacks } from "../../src/core/responseProcessor.js";
import type { AgdaResponse } from "../../src/agda/responses.js";

// Re-export for convenience in tests
export { MockDocumentEditor, type Goal };

export interface HarnessGoal {
  id: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

export class EditorTestHarness {
  readonly editor: MockDocumentEditor;
  readonly goals: GoalManager;
  private session: AgdaSession | null = null;
  private readonly binaryPath: string;
  private readonly tmpDir: string;
  private readonly tmpFile: string;

  constructor(binaryPath: string, fixtureContent: string, filename = "Test.agda") {
    this.binaryPath = binaryPath;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agda-harness-"));
    this.tmpFile = path.join(this.tmpDir, filename);
    fs.writeFileSync(this.tmpFile, fixtureContent);

    this.editor = new MockDocumentEditor(fixtureContent);
    this.goals = new GoalManager();
  }

  /** Start Agda and load the file. Populates goals. */
  async load(): Promise<AgdaResponse[]> {
    if (!this.session) {
      this.session = await spawnAgda(this.binaryPath);
    }

    // Sync the tmp file with the mock document content
    fs.writeFileSync(this.tmpFile, this.editor.document.getText());

    const quoted = haskellStringQuote(this.tmpFile);
    const responses = await this.session.sendCommand(
      `IOTCM ${quoted} NonInteractive Direct (Cmd_load ${quoted} [])`,
    );

    await this.processResponses(responses);
    return responses;
  }

  /**
   * Give an expression to a goal.
   * Performs the full flow: send Cmd_give, process GiveAction + InteractionPoints
   * through the REAL processBatchedResponses.
   */
  async give(goalId: number, expr: string): Promise<AgdaResponse[]> {
    if (!this.session) throw new Error("Must call load() before give()");

    // Sync file to disk (Agda reads from disk)
    fs.writeFileSync(this.tmpFile, this.editor.document.getText());

    const quoted = haskellStringQuote(this.tmpFile);
    const responses = await this.session.sendCommand(
      `IOTCM ${quoted} NonInteractive Direct (Cmd_give WithoutForce ${goalId} noRange ${JSON.stringify(expr)})`,
    );

    await this.processResponses(responses);
    return responses;
  }

  /** Get all current goals with their text content. */
  getGoals(): HarnessGoal[] {
    const uri = this.editor.document.uri.toString();
    const allGoals = this.goals.getAll(uri);
    return allGoals.map((g) => ({
      id: g.id,
      range: g.range,
      text: this.editor.document.getText(g.range),
    }));
  }

  /** Get the current document content. */
  getContent(): string {
    return this.editor.document.getText();
  }

  /** Clean up: kill Agda and remove temp files. */
  close(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    try {
      for (const f of fs.readdirSync(this.tmpDir)) {
        fs.unlinkSync(path.join(this.tmpDir, f));
      }
      fs.rmdirSync(this.tmpDir);
    } catch {
      /* best effort */
    }
    this.goals.dispose();
  }

  // ---------------------------------------------------------------------------
  // Delegates to the REAL processBatchedResponses
  // ---------------------------------------------------------------------------

  private async processResponses(responses: AgdaResponse[]): Promise<void> {
    await processBatchedResponses(this.editor, responses, this.goals, noopCallbacks);
  }
}
