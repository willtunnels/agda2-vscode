/**
 * Shared test helpers for spawning Agda processes and communicating
 * with them via the --interaction-json protocol.
 *
 * Used by all integration tests. The binary path comes from the global
 * setup (downloaded Agda binaries) via vitest's inject().
 */

import { spawn } from "child_process";
import * as fs from "fs";
import { detectAgdaDatadir } from "../../src/agda/installations.js";
import {
  normalizeResponse,
  type AgdaResponse,
  type DisplayInfo,
} from "../../src/agda/responses.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgdaSession {
  /** Send a command and collect all responses until the next prompt. */
  sendCommand(cmd: string): Promise<AgdaResponse[]>;
  /** Kill the process. */
  close(): void;
}

export interface TestAgdaBinary {
  version: string;
  binaryPath: string;
}

// ---------------------------------------------------------------------------
// Haskell string quoting (needed for IOTCM commands)
// ---------------------------------------------------------------------------

export function haskellStringQuote(s: string): string {
  let result = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") result += "\\\\";
    else if (ch === '"') result += '\\"';
    else if (code >= 0x20 && code <= 0x7e) result += ch;
    else result += "\\" + code.toString(10);
  }
  return result + '"';
}

// ---------------------------------------------------------------------------
// Spawn Agda
// ---------------------------------------------------------------------------

/**
 * Spawn an Agda process at the given binary path and return a session interface.
 * The first prompt (startup) is consumed automatically.
 *
 * Auto-detects Agda_datadir for pre-2.8 bundled installs (same logic
 * as process.ts, via detectAgdaDatadir from download.ts).
 */
export function spawnAgda(binaryPath: string): Promise<AgdaSession> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const dataDir = detectAgdaDatadir(binaryPath);
    if (dataDir) {
      env.Agda_datadir = dataDir;
    }

    const proc = spawn(binaryPath, ["--interaction-json"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    proc.stdout!.setEncoding("utf-8");
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", () => {});

    let buffer = "";
    let currentResponses: AgdaResponse[] = [];
    let promptResolve: (() => void) | undefined;

    function processBuffer(): void {
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, idx).trim();
        buffer = buffer.substring(idx + 1);

        if (line.length === 0 || line === "JSON>") continue;

        try {
          const parsed = normalizeResponse(JSON.parse(line) as AgdaResponse);

          // Handle indirect highlighting (read temp file)
          if (parsed.kind === "HighlightingInfo" && !parsed.direct) {
            try {
              const payload = JSON.parse(fs.readFileSync(parsed.filepath, "utf-8"));
              currentResponses.push({
                kind: "HighlightingInfo",
                direct: true,
                info: payload,
              } as AgdaResponse);
            } catch {
              /* ignore */
            }
          } else {
            currentResponses.push(parsed);
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }

      if (buffer.includes("JSON> ")) {
        buffer = buffer.replace("JSON> ", "");
        if (promptResolve) {
          const cb = promptResolve;
          promptResolve = undefined;
          cb();
        }
      }
    }

    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      processBuffer();
    });

    proc.on("error", reject);

    const session: AgdaSession = {
      sendCommand(cmd: string): Promise<AgdaResponse[]> {
        return new Promise((res) => {
          currentResponses = [];
          promptResolve = () => res(currentResponses);
          proc.stdin!.write(cmd + "\n");
        });
      },
      close() {
        proc.stdin!.end();
        proc.kill("SIGTERM");
      },
    };

    // Wait for initial startup prompt
    promptResolve = () => resolve(session);

    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Timeout waiting for Agda startup"));
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function findDisplayInfo(responses: AgdaResponse[]): DisplayInfo | undefined {
  for (const r of responses) {
    if (r.kind === "DisplayInfo") return r.info;
  }
  return undefined;
}

export function findInteractionPoints(responses: AgdaResponse[]): number[] {
  for (const r of responses) {
    if (r.kind === "InteractionPoints") {
      return r.interactionPoints.map((ip) => ip.id);
    }
  }
  return [];
}
