// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/VSCodeAbbreviationConfig.ts)
// Modified for Agda

import { AbbreviationConfig, SymbolsByAbbreviation } from "./engine/AbbreviationConfig";
import { Disposable, workspace } from "vscode";

export class VSCodeAbbreviationConfig implements AbbreviationConfig, Disposable {
  abbreviationCharacter: string;
  customTranslations: SymbolsByAbbreviation;
  inputModeEnabled: boolean;
  languages: string[];

  private subscriptions: Disposable[] = [];

  constructor() {
    this.abbreviationCharacter = "\\";
    this.customTranslations = {};
    this.inputModeEnabled = true;
    this.languages = ["agda"];
    this.reloadConfig();
    this.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agda.input")) {
          this.reloadConfig();
        }
      }),
    );
  }

  private reloadConfig() {
    this.inputModeEnabled = workspace.getConfiguration("agda.input").get("enabled", true);
    this.abbreviationCharacter = workspace.getConfiguration("agda.input").get("leader", "\\");
    this.languages = workspace.getConfiguration("agda.input").get("languages", ["agda"]);
    // customTranslations from settings may have string or string[] values;
    // AbbreviationProvider normalizes to string[] on construction.
    const raw: Record<string, string | string[]> = workspace
      .getConfiguration("agda.input")
      .get("customTranslations", {});
    const normalized: SymbolsByAbbreviation = {};
    for (const [k, v] of Object.entries(raw)) {
      normalized[k] = Array.isArray(v) ? v : [v];
    }
    this.customTranslations = normalized;
  }

  dispose() {
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}
