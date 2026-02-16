// Serial command queue with busy state.
// Only one command runs at a time. Uses streaming + batched hybrid:
// - onStream callback fires for each response (for progressive highlighting)
// - Promise resolves with all responses after the JSON> prompt

import * as vscode from "vscode";
import type { AgdaProcess } from "../agda/process.js";
import type { AgdaResponse } from "../agda/responses.js";
import { getErrorMessage } from "../util/errorMessage.js";

export interface CommandResult {
  responses: AgdaResponse[];
}

interface QueuedCommand {
  iotcm: string;
  onStream?: (response: AgdaResponse) => void;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
}

export class CommandQueue implements vscode.Disposable {
  private busy = false;
  private queue: QueuedCommand[] = [];
  private activeSubscriptions: vscode.Disposable[] = [];

  private readonly _onBusyChange = new vscode.EventEmitter<boolean>();
  readonly onBusyChange = this._onBusyChange.event;

  constructor(private readonly process: AgdaProcess) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Enqueue a command to send to Agda.
   *
   * @param iotcm     The IOTCM command string
   * @param onStream  Optional callback invoked for each response as it arrives.
   *                  Use for HighlightingInfo, RunningInfo (progressive feedback).
   * @returns         Promise resolving with all responses after prompt.
   */
  enqueue(iotcm: string, onStream?: (response: AgdaResponse) => void): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      this.queue.push({ iotcm, onStream, resolve, reject });
      this.processNext();
    });
  }

  /**
   * Abort the current command and drain the queue.
   */
  abort(): void {
    for (const cmd of this.queue) {
      cmd.reject(new Error("Aborted"));
    }
    this.queue = [];
    this.disposeSubscriptions();
    this.setBusy(false);
  }

  private disposeSubscriptions(): void {
    for (const d of this.activeSubscriptions) {
      d.dispose();
    }
    this.activeSubscriptions = [];
  }

  private processNext(): void {
    if (this.busy || this.queue.length === 0) {
      return;
    }

    const cmd = this.queue.shift()!;
    this.setBusy(true);

    const collector = new ResponseCollector(cmd.onStream);

    const responseDisposable = this.process.onResponse((response) => {
      collector.handleResponse(response);
    });

    const promptDisposable = this.process.onPrompt(() => {
      this.disposeSubscriptions();
      this.setBusy(false);
      cmd.resolve(collector.finish());
      this.processNext();
    });

    this.activeSubscriptions = [responseDisposable, promptDisposable];

    try {
      this.process.send(cmd.iotcm);
    } catch (e) {
      this.disposeSubscriptions();
      this.setBusy(false);
      cmd.reject(e instanceof Error ? e : new Error(getErrorMessage(e)));
      this.processNext();
    }
  }

  private setBusy(busy: boolean): void {
    if (this.busy !== busy) {
      this.busy = busy;
      this._onBusyChange.fire(busy);
      vscode.commands.executeCommand("setContext", "agda.busy", busy);
    }
  }

  dispose(): void {
    this.abort();
    this._onBusyChange.dispose();
  }
}

class ResponseCollector {
  readonly responses: AgdaResponse[] = [];
  private onStream?: (response: AgdaResponse) => void;

  constructor(onStream?: (response: AgdaResponse) => void) {
    this.onStream = onStream;
  }

  handleResponse(response: AgdaResponse): void {
    this.responses.push(response);
    this.onStream?.(response);
  }

  finish(): CommandResult {
    return { responses: this.responses };
  }
}
