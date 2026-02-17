// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (vscode-lean4/src/abbreviation/AbbreviationFeature.ts)
// Modified for Agda

import { AbbreviationProvider } from "./engine/AbbreviationProvider";
import * as config from "../util/config";
import { Disposable, StatusBarItem, languages } from "vscode";
import { AbbreviationHoverProvider } from "./AbbreviationHoverProvider";
import { AbbreviationRewriterFeature } from "./AbbreviationRewriterFeature";

export class AbbreviationFeature {
  private readonly disposables = new Array<Disposable>();
  private hoverRegistration: Disposable;

  constructor(
    private readonly abbreviationProvider: AbbreviationProvider,
    statusBarItem: StatusBarItem,
  ) {
    this.hoverRegistration = this.registerHover();

    this.disposables.push(
      new AbbreviationRewriterFeature(abbreviationProvider, statusBarItem),

      config.onInputLanguagesChanged(() => {
        this.hoverRegistration.dispose();
        this.hoverRegistration = this.registerHover();
      }),
    );
  }

  private registerHover(): Disposable {
    return languages.registerHoverProvider(
      config.getInputLanguages(),
      new AbbreviationHoverProvider(this.abbreviationProvider),
    );
  }

  dispose(): void {
    this.hoverRegistration.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
