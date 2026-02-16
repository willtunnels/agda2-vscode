// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationFeature.ts)
// Modified for Agda

import { AbbreviationProvider } from "./engine/AbbreviationProvider";
import { Disposable, languages } from "vscode";
import { AbbreviationHoverProvider } from "./AbbreviationHoverProvider";
import { AbbreviationRewriterFeature } from "./AbbreviationRewriterFeature";
import { VSCodeAbbreviationConfig } from "./VSCodeAbbreviationConfig";

export class AbbreviationFeature {
  private readonly disposables = new Array<Disposable>();
  readonly abbreviations: AbbreviationProvider;

  constructor() {
    const config = new VSCodeAbbreviationConfig();
    this.disposables.push(config);
    this.abbreviations = new AbbreviationProvider(config);

    this.disposables.push(
      languages.registerHoverProvider(
        config.languages,
        new AbbreviationHoverProvider(config, this.abbreviations),
      ),
      new AbbreviationRewriterFeature(config, this.abbreviations),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
