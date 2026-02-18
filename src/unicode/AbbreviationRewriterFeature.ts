// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationRewriterFeature.ts)
// Modified for Agda

import { AbbreviationProvider } from "./engine/AbbreviationProvider";
import * as config from "../util/config";
import {
  commands,
  Disposable,
  languages,
  StatusBarItem,
  TextEditor,
  window,
  workspace,
} from "vscode";
import { VSCodeAbbreviationRewriter } from "./VSCodeAbbreviationRewriter";

/**
 * Sets up everything required for the abbreviation rewriter feature.
 * Creates a rewriter for the active editor.
 */
export class AbbreviationRewriterFeature {
  private readonly disposables = new Array<Disposable>();

  private activeAbbreviationRewriter: VSCodeAbbreviationRewriter | undefined;

  constructor(
    private readonly abbreviationProvider: AbbreviationProvider,
    private readonly statusBarItem: StatusBarItem,
  ) {
    void this.changedActiveTextEditor(window.activeTextEditor);

    this.disposables.push(
      commands.registerTextEditorCommand("agda.input.cycleForward", () => {
        this.activeAbbreviationRewriter?.cycleAbbreviations(1);
      }),

      commands.registerTextEditorCommand("agda.input.cycleBackward", () => {
        this.activeAbbreviationRewriter?.cycleAbbreviations(-1);
      }),

      commands.registerTextEditorCommand("agda.input.deleteAbbreviation", () => {
        this.activeAbbreviationRewriter?.deleteAbbreviations();
      }),

      window.onDidChangeActiveTextEditor((editor) => this.changedActiveTextEditor(editor)),

      workspace.onDidOpenTextDocument(async (doc) => {
        // Ensure that we create/remove abbreviation rewriters when the language ID changes
        if (window.activeTextEditor === undefined) {
          return;
        }
        const editorUri = window.activeTextEditor.document.uri.toString();
        const docUri = doc.uri.toString();
        if (editorUri !== docUri) {
          return;
        }
        if (
          this.activeAbbreviationRewriter === undefined &&
          this.shouldEnableRewriterForEditor(window.activeTextEditor)
        ) {
          this.activeAbbreviationRewriter = new VSCodeAbbreviationRewriter(
            config.getInputLeader(),
            this.abbreviationProvider,
            window.activeTextEditor,
            this.statusBarItem,
          );
        } else if (
          this.activeAbbreviationRewriter !== undefined &&
          !this.shouldEnableRewriterForEditor(window.activeTextEditor)
        ) {
          await this.disposeActiveAbbreviationRewriter();
        }
      }),

      config.onInputEnabledChanged(() => this.changedActiveTextEditor(window.activeTextEditor)),
      config.onInputLeaderChanged(() => this.changedActiveTextEditor(window.activeTextEditor)),
      config.onInputLanguagesChanged(() => this.changedActiveTextEditor(window.activeTextEditor)),
    );
  }

  private async disposeActiveAbbreviationRewriter() {
    const abbreviationRewriterToDispose = this.activeAbbreviationRewriter;
    this.activeAbbreviationRewriter = undefined;
    if (abbreviationRewriterToDispose === undefined) {
      return;
    }

    abbreviationRewriterToDispose.replaceAllTrackedAbbreviations();
    await abbreviationRewriterToDispose.flush();
    abbreviationRewriterToDispose.dispose();
  }

  private async changedActiveTextEditor(activeTextEditor: TextEditor | undefined) {
    await this.disposeActiveAbbreviationRewriter();
    if (activeTextEditor === undefined) {
      return;
    }
    if (!this.shouldEnableRewriterForEditor(activeTextEditor)) {
      return;
    }
    this.activeAbbreviationRewriter = new VSCodeAbbreviationRewriter(
      config.getInputLeader(),
      this.abbreviationProvider,
      activeTextEditor,
      this.statusBarItem,
    );
  }

  private shouldEnableRewriterForEditor(editor: TextEditor): boolean {
    if (!config.getInputEnabled()) {
      return false;
    }
    if (!languages.match(config.getInputLanguages(), editor.document)) {
      return false;
    }
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.activeAbbreviationRewriter?.dispose();
  }
}
