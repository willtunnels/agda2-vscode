// Manages a single long-lived Agda child process per workspace.
// Spawns `agda --interaction-json` with pipe stdio.

import { ChildProcess, execFile, spawn } from "child_process";
import * as vscode from "vscode";
import { getErrorMessage } from "../util/errorMessage.js";
import { detectAgdaDatadir } from "./installations.js";
import { AgdaProtocol } from "./protocol.js";
import type { AgdaResponse } from "./responses.js";
import {
  type AgdaVersion,
  parseAgdaVersion,
  versionGte,
  formatVersion,
  MIN_AGDA_VERSION,
} from "./version.js";

export class AgdaProcess implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private _version: AgdaVersion | undefined;
  private protocol = new AgdaProtocol();
  private readonly outputChannel: vscode.OutputChannel;

  private readonly _onResponse = new vscode.EventEmitter<AgdaResponse>();
  private readonly _onPrompt = new vscode.EventEmitter<void>();
  private readonly _onError = new vscode.EventEmitter<Error>();
  private readonly _onExit = new vscode.EventEmitter<number | null>();

  /** Fires for each parsed JSON response. */
  readonly onResponse = this._onResponse.event;

  /** Fires when prompt detected (command complete). */
  readonly onPrompt = this._onPrompt.event;

  /** Fires on errors (process spawn failure, parse errors). */
  readonly onError = this._onError.event;

  /** Fires when the process exits. */
  readonly onExit = this._onExit.event;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;

    this.protocol.onResponse((r) => this._onResponse.fire(r));
    this.protocol.onPrompt(() => this._onPrompt.fire());
    this.protocol.onError((e) => {
      this.outputChannel.appendLine(`[parse error] ${e.message}`);
      this._onError.fire(e);
    });
  }

  /** Whether the Agda process is currently running. */
  get running(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** The detected Agda version. Only available after spawn() resolves. */
  get version(): AgdaVersion {
    if (!this._version) throw new Error("Agda version not yet detected (spawn not called)");
    return this._version;
  }

  /**
   * Run `agda --version`, parse the output, and check the minimum version.
   */
  private detectVersion(agdaPath: string): Promise<AgdaVersion> {
    return new Promise<AgdaVersion>((resolve, reject) => {
      execFile(agdaPath, ["--version"], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          const detail = stderr?.trim() || err.message;
          const suffix = err.code != null ? ` (exit code ${err.code})` : "";
          reject(new Error(`Failed to run '${agdaPath} --version': ${detail}${suffix}`));
          return;
        }

        let version: AgdaVersion;
        try {
          version = parseAgdaVersion(stdout);
        } catch (e) {
          reject(new Error(`Could not determine Agda version from: ${stdout.trim()}`));
          return;
        }

        if (!versionGte(version, MIN_AGDA_VERSION)) {
          reject(
            new Error(
              `Agda >= ${formatVersion(MIN_AGDA_VERSION)} required for --interaction-json` +
                ` (found ${formatVersion(version)})`,
            ),
          );
          return;
        }

        this.outputChannel.appendLine(`[version] Agda ${formatVersion(version)}`);
        resolve(version);
      });
    });
  }

  /**
   * Spawn the Agda process. Resolves once the initial prompt is received.
   * Detects and validates the Agda version before starting --interaction-json.
   */
  async spawn(agdaPath: string, extraArgs: string[] = []): Promise<void> {
    if (this.running) {
      await this.kill();
    }

    this._version = await this.detectVersion(agdaPath);

    this.protocol.reset();

    const args = ["--interaction-json", ...extraArgs];
    this.outputChannel.appendLine(`[spawn] ${agdaPath} ${args.join(" ")}`);

    const env = { ...process.env };
    const dataDir = detectAgdaDatadir(agdaPath);
    if (dataDir) {
      env.Agda_datadir = dataDir;
      this.outputChannel.appendLine(`[datadir] ${dataDir}`);
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this.process = spawn(agdaPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
      } catch (e) {
        const err = new Error(`Failed to spawn Agda: ${getErrorMessage(e)}`);
        this._onError.fire(err);
        reject(err);
        return;
      }

      let settled = false;
      const stderrChunks: string[] = [];

      const promptDisposable = this.protocol.onPrompt(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        promptDisposable.dispose();

        this.outputChannel.appendLine("[ready] Initial prompt received");
        resolve();
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        promptDisposable.dispose();

        reject(new Error("Timeout waiting for initial Agda prompt"));
      }, 10000);

      this.process.stdout!.setEncoding("utf-8");
      this.process.stdout!.on("data", (chunk: string) => {
        this.protocol.feed(chunk);
      });

      this.process.stderr!.setEncoding("utf-8");
      this.process.stderr!.on("data", (data: string) => {
        stderrChunks.push(data);
        this.outputChannel.appendLine(`[stderr] ${data.trimEnd()}`);
      });

      this.process.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        promptDisposable.dispose();

        this.process = null;
        this._version = undefined;

        this.outputChannel.appendLine(`[error] ${err.message}`);
        this._onError.fire(err);
        reject(err);
      });

      this.process.on("exit", (code, _signal) => {
        clearTimeout(timeout);
        promptDisposable.dispose();
        this.outputChannel.appendLine(`[exit] code=${code}`);
        this._onExit.fire(code);

        this.process = null;
        this._version = undefined;

        // If the process exits before the initial prompt, reject immediately.
        // This handles: old Agda without --interaction-json, wrong binary, crashes, etc.
        if (!settled) {
          settled = true;
          const stderr = stderrChunks.join("").trim();
          const detail = stderr ? `:\n${stderr}` : ` (exit code ${code})`;
          const err = new Error(`Agda process exited before initial prompt${detail}`);
          this._onError.fire(err);
          reject(err);
        }
      });
    });
  }

  /**
   * Send an IOTCM command string to Agda via stdin.
   */
  send(command: string): void {
    if (!this.process || this.process.killed) {
      throw new Error("Agda process is not running");
    }
    this.outputChannel.appendLine(`[send] ${command}`);
    this.process.stdin!.write(command + "\n");
  }

  /**
   * Kill the Agda process.
   */
  async kill(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.outputChannel.appendLine("[kill] Stopping Agda process");
      const exitPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);
        this.process!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.process.stdin!.end();
      this.process.kill("SIGTERM");
      await exitPromise;
    }
    this.process = null;
    this._version = undefined;
  }

  /**
   * Restart the Agda process.
   */
  async restart(agdaPath: string, extraArgs: string[] = []): Promise<void> {
    await this.kill();
    await this.spawn(agdaPath, extraArgs);
  }

  dispose(): void {
    this.process?.kill();
    this.process = null;
    this._version = undefined;
    this.protocol.dispose();
    this._onResponse.dispose();
    this._onPrompt.dispose();
    this._onError.dispose();
    this._onExit.dispose();
  }
}
