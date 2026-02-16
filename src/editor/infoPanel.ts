// Agda Info Panel — WebviewPanel that displays goal info, errors, and other
// DisplayInfo responses in a persistent, richly-formatted side panel
// (equivalent to Emacs's *Agda Information* buffer).

import * as vscode from "vscode";
import type {
  ConstraintObj,
  GoalInfo,
  GoalTypeAux,
  NameTypePair,
  OutputConstraint,
  ResponseContextEntry,
} from "../agda/responses.js";
import type { AgdaVersion } from "../agda/version.js";
import {
  displaySegment,
  isResolvedLocation,
  type DisplayInfoVSCode,
  type LinkedText,
} from "../util/agdaLocation.js";
import { getErrorMessage } from "../util/errorMessage.js";

// --- Message types exchanged with the webview ---

type ToWebview = { kind: "displayInfo"; html: string } | { kind: "clear" };

type FromWebview = { kind: "openFile"; filepath: string; line: number; col: number };

// --- InfoPanel class ---

export class InfoPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly extensionUri: vscode.Uri;

  constructor(outputChannel: vscode.OutputChannel, extensionUri: vscode.Uri) {
    this.outputChannel = outputChannel;
    this.extensionUri = extensionUri;
  }

  /**
   * Open (or reveal) the info panel.
   */
  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.createPanel();
  }

  /**
   * Toggle the info panel open/closed.
   */
  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
      // onDidDispose handler will clear this.panel
    } else {
      this.open();
    }
  }

  /**
   * Show one or more DisplayInfo responses in the panel.
   * Their HTML is concatenated.
   */
  showDisplayInfo(infos: DisplayInfoVSCode[], version: AgdaVersion): void {
    if (infos.length === 0) return;
    if (!this.panel) this.open();
    const html = infos.map((info) => renderDisplayInfo(info, version).__html).join("");
    this.postMessage({ kind: "displayInfo", html });

    // Copy helper function signature to clipboard (matching Emacs agda2-info-action-and-copy)
    for (const info of infos) {
      if (info.kind === "GoalSpecific" && info.goalInfo.kind === "HelperFunction") {
        vscode.env.clipboard.writeText(info.goalInfo.signature);
      }
    }
  }

  /**
   * Show a short plain-text message in the panel.
   */
  showMessage(text: string): void {
    if (!this.panel) this.open();
    const html = section("", "", h("span", { class: "info-text" }, text));
    this.postMessage({ kind: "displayInfo", html: html.__html });
  }

  /**
   * Clear the panel contents.
   */
  clear(): void {
    if (!this.panel) return;
    this.postMessage({ kind: "clear" });
  }

  get visible(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // --- Private ---

  private createPanel(): void {
    this.panel = vscode.window.createWebviewPanel(
      "agda.infoPanel",
      "Agda Info",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "icons", "agda-light.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "icons", "agda-dark.png"),
    };
    this.panel.webview.html = getWebviewHtml();

    // Handle messages from the webview (e.g. clicking a file location link).
    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebview) => this.handleWebviewMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );
  }

  private async handleWebviewMessage(msg: FromWebview): Promise<void> {
    if (msg.kind === "openFile") {
      try {
        const uri = vscode.Uri.file(msg.filepath);
        const doc = await vscode.workspace.openTextDocument(uri);
        // Agda uses 1-based line/col
        const pos = new vscode.Position(msg.line - 1, msg.col - 1);
        const editor = await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(pos, pos),
          preserveFocus: false,
        });
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      } catch (e) {
        this.outputChannel.appendLine(
          `[warn] Failed to open ${msg.filepath}: ${getErrorMessage(e)}`,
        );
      }
    }
  }

  private postMessage(msg: ToWebview): void {
    this.panel?.webview.postMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// HTML builder helpers
// ---------------------------------------------------------------------------

/** Escaped HTML string — safe to embed in the document. */
interface RawHtml {
  readonly __html: string;
}

/** Mark a string as pre-escaped HTML. Explicit opt-in — grep for raw() to audit. */
function raw(html: string): RawHtml {
  return { __html: html };
}

function joinHtml(...parts: RawHtml[]): RawHtml {
  return raw(parts.map((p) => p.__html).join(""));
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Attrs = Record<string, string>;
type Child = string | RawHtml;

/**
 * HTML element builder. String children are auto-escaped; RawHtml children
 * (from h(), pre(), section(), raw()) are passed through. Attribute values
 * are always escaped.
 */
function h(tag: string, attrs: Attrs, ...children: Child[]): RawHtml {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  const inner = children.map((c) => (typeof c === "string" ? esc(c) : c.__html)).join("");
  return raw(`<${tag}${attrStr}>${inner}</${tag}>`);
}

/** Wrap text in a <pre class="expr">. Text is auto-escaped. */
function pre(text: string): RawHtml {
  return h("pre", { class: "expr" }, text);
}

/** Wrap content in a titled section div. Title is auto-escaped. */
function section(title: string, cls: string, ...body: Child[]): RawHtml {
  return h("div", { class: `section ${cls}`.trim() }, h("h2", {}, title), ...body);
}

// ---------------------------------------------------------------------------
// Clickable error locations
// ---------------------------------------------------------------------------

/**
 * Render a LinkedText as HTML with clickable file location links.
 * Plain text segments are escaped; resolved location segments become `<a>`
 * tags; unresolved locations (file couldn't be opened) render as dimmed
 * non-clickable text via displaySegment (which shows "filepath:?").
 */
function renderLinkedText(lt: LinkedText, version: AgdaVersion): RawHtml {
  return raw(
    lt
      .map((seg) => {
        if (seg.kind === "location" && isResolvedLocation(seg)) {
          const data = esc(
            JSON.stringify({ filepath: seg.filepath, line: seg.line, col: seg.col }),
          );
          return `<a class="file-link" data-loc="${data}">${esc(displaySegment(seg, version))}</a>`;
        }
        return esc(displaySegment(seg, version));
      })
      .join(""),
  );
}

/** Wrap a LinkedText in a <pre class="expr"> with clickable file locations. */
function preLinked(lt: LinkedText, version: AgdaVersion): RawHtml {
  return raw(`<pre class="expr">${renderLinkedText(lt, version).__html}</pre>`);
}

/** Join multiple LinkedTexts with a plain-text separator. */
function joinLinkedTexts(lts: LinkedText[], separator: string): LinkedText {
  const result: LinkedText = [];
  for (let i = 0; i < lts.length; i++) {
    if (i > 0) result.push({ kind: "text", text: separator });
    result.push(...lts[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Goal ID extraction
// ---------------------------------------------------------------------------

function goalId(obj: ConstraintObj): string {
  if (typeof obj === "string") return obj;
  if ("id" in obj) return `?${obj.id}`;
  if ("name" in obj) return obj.name;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// DisplayInfo rendering
// ---------------------------------------------------------------------------

export function renderDisplayInfo(info: DisplayInfoVSCode, version: AgdaVersion): RawHtml {
  switch (info.kind) {
    case "AllGoalsWarnings":
      return renderAllGoalsWarnings(info, version);
    case "GoalSpecific":
      return renderGoalSpecific(info.goalInfo);
    case "Error":
      return renderError(info, version);
    case "CompilationOk":
      return renderCompilationOk(info, version);
    case "Constraints":
      return renderConstraints(info.constraints);
    case "InferredType":
      return section("Inferred Type", "", pre(info.expr));
    case "NormalForm": {
      const nfTitle = info.computeMode === "HeadCompute" ? "Head Normal Form" : "Normal Form";
      return section(nfTitle, "", pre(info.expr));
    }
    case "Version":
      return section("Version", "", h("span", { class: "info-text" }, info.version));
    case "Context":
      return info.context.length > 0
        ? section("Context", "", renderContext(info.context))
        : section("Context", "", h("span", { class: "info-text" }, "No context"));
    case "WhyInScope":
      return section("Why In Scope", "", preLinked(info.message, version));
    case "ModuleContents":
      return renderModuleContents(info);
    case "SearchAbout":
      return renderSearchAbout(info);
    case "Auto":
      return section("Auto", "", pre(info.info));
    case "Time":
      return section("Time", "", pre(info.time));
    case "IntroNotFound":
      return section(
        "Intro",
        "",
        h("span", { class: "warning-text" }, "No introduction forms found."),
      );
    case "IntroConstructorUnknown": {
      const cs = info.constructors;
      const list =
        cs.length <= 1 ? cs.join("") : cs.slice(0, -1).join(", ") + " or " + cs[cs.length - 1];
      return section(
        "Intro",
        "",
        h(
          "span",
          { class: "info-text" },
          `Don\u2019t know which constructor to introduce of ${list}`,
        ),
      );
    }
    default:
      return section("Info", "", pre(JSON.stringify(info, null, 2)));
  }
}

// --- AllGoalsWarnings ---

function renderAllGoalsWarnings(
  info: Extract<DisplayInfoVSCode, { kind: "AllGoalsWarnings" }>,
  version: AgdaVersion,
): RawHtml {
  const parts: RawHtml[] = [];

  if (info.visibleGoals.length > 0) {
    parts.push(section("Goals", "", renderGoalList(info.visibleGoals)));
  }
  if (info.invisibleGoals.length > 0) {
    parts.push(section("Unsolved Metas (not in scope)", "", renderGoalList(info.invisibleGoals)));
  }
  if (info.errors.length > 0) {
    parts.push(
      section("Errors", "error", preLinked(joinLinkedTexts(info.errors, "\n\n"), version)),
    );
  }
  if (info.warnings.length > 0) {
    parts.push(
      section("Warnings", "warning", preLinked(joinLinkedTexts(info.warnings, "\n\n"), version)),
    );
  }
  if (parts.length === 0) {
    parts.push(section("All Goals", "success", h("span", { class: "info-text" }, "All done!")));
  }

  return joinHtml(...parts);
}

// --- Goal list (table of ?id : type) ---

function renderGoalList(constraints: OutputConstraint[]): RawHtml {
  const rows = constraints.map((g): RawHtml => {
    switch (g.kind) {
      case "OfType":
        return h(
          "tr",
          {},
          h("td", { class: "goal-id" }, goalId(g.constraintObj)),
          h("td", { class: "goal-sep" }, raw("&nbsp;:&nbsp;")),
          h("td", { class: "goal-type" }, pre(g.type)),
        );
      case "JustType":
      case "JustSort": {
        const desc = g.kind === "JustSort" ? "Sort" : "Type";
        return h(
          "tr",
          {},
          h("td", { class: "goal-id" }, goalId(g.constraintObj)),
          h("td", { class: "goal-sep" }, raw("&nbsp;:&nbsp;")),
          h("td", { class: "goal-type" }, h("span", { class: "info-text" }, desc)),
        );
      }
    }
  });
  return h("table", { class: "goal-table" }, ...rows);
}

// --- GoalSpecific ---

function renderGoalSpecific(goalInfo: GoalInfo): RawHtml {
  switch (goalInfo.kind) {
    case "GoalType":
      return renderGoalType(goalInfo);
    case "CurrentGoal":
      return section("Current Goal", "", pre(goalInfo.type));
    case "InferredType":
      return section("Inferred Type", "", pre(goalInfo.expr));
    case "NormalForm": {
      const nfTitle = goalInfo.computeMode === "HeadCompute" ? "Head Normal Form" : "Normal Form";
      return section(nfTitle, "", pre(goalInfo.expr));
    }
    case "HelperFunction":
      return section("Helper Function", "", pre(goalInfo.signature));
    default:
      return section("Goal Info", "", pre(JSON.stringify(goalInfo, null, 2)));
  }
}

function renderGoalType(gi: Extract<GoalInfo, { kind: "GoalType" }>): RawHtml {
  const parts: RawHtml[] = [];
  parts.push(section("Goal", "", pre(gi.type)));

  const aux = renderGoalTypeAux(gi.typeAux);
  if (aux) parts.push(aux);

  if (gi.entries.length > 0) {
    parts.push(section("Context", "", renderContext(gi.entries)));
  }
  if (gi.boundary.length > 0) {
    parts.push(section("Boundary", "", pre(gi.boundary.join("\n"))));
  }
  if (gi.outputForms.length > 0) {
    parts.push(section("Constraints", "", renderSplitTable(gi.outputForms, " := ")));
  }

  return joinHtml(...parts);
}

function renderGoalTypeAux(aux: GoalTypeAux): RawHtml | null {
  switch (aux.kind) {
    case "GoalOnly":
      return null;
    case "GoalAndHave":
      return section("Have", "", pre(aux.expr));
    case "GoalAndElaboration":
      return section("Elaboration", "", pre(aux.term));
  }
}

// --- Context ---

function renderContext(entries: ResponseContextEntry[]): RawHtml {
  const rows = entries.map((e) => {
    // Name cell: show reifiedName, with (originalName) if it differs
    const nameParts: RawHtml[] = [raw(esc(e.reifiedName))];
    if (e.originalName !== e.reifiedName) {
      nameParts.push(raw(" "), h("span", { class: "ctx-original" }, `(${e.originalName})`));
    }
    const nameCell = h("td", { class: "ctx-name" }, ...nameParts);

    // Type cell, with "(not in scope)" suffix matching Agda's Emacs mode
    const typeContent = e.inScope
      ? pre(e.binding)
      : h(
          "pre",
          { class: "expr" },
          e.binding,
          h("span", { class: "ctx-not-in-scope" }, "  (not in scope)"),
        );
    return h(
      "tr",
      {},
      nameCell,
      h("td", { class: "ctx-sep" }, raw("&nbsp;:&nbsp;")),
      h("td", { class: "ctx-type" }, typeContent),
    );
  });
  return h("table", { class: "ctx-table" }, ...rows);
}

// --- Split table (boundary, constraints) ---

/**
 * Render lines as a table by splitting on a separator (e.g. " ⊢ " or " := ").
 * The LHS is highlighted like context variable names; the RHS is a pre block.
 * Lines that don't contain the separator are rendered as full-width pre blocks.
 */
function renderSplitTable(lines: string[], separator: string): RawHtml {
  const rows = lines.map((line) => {
    const idx = line.indexOf(separator);
    if (idx < 0) {
      // No separator — render as a full-width pre
      return h("tr", {}, h("td", { colspan: "3" }, pre(line)));
    }
    const lhs = line.slice(0, idx);
    const rhs = line.slice(idx + separator.length);
    return h(
      "tr",
      {},
      h("td", { class: "ctx-name" }, lhs),
      h("td", { class: "ctx-sep" }, raw(`&nbsp;${esc(separator.trim())}&nbsp;`)),
      h("td", { class: "ctx-type" }, pre(rhs)),
    );
  });
  return h("table", { class: "ctx-table" }, ...rows);
}

// --- Error ---

function renderError(
  info: Extract<DisplayInfoVSCode, { kind: "Error" }>,
  version: AgdaVersion,
): RawHtml {
  const parts: RawHtml[] = [];
  parts.push(section("Error", "error", preLinked(info.message, version)));
  if (info.warnings && info.warnings.length > 0) {
    parts.push(
      section("Warnings", "warning", preLinked(joinLinkedTexts(info.warnings, "\n\n"), version)),
    );
  }
  return joinHtml(...parts);
}

// --- Constraints ---

function renderConstraints(constraints: string[]): RawHtml {
  if (constraints.length === 0) {
    return section("Constraints", "", h("span", { class: "info-text" }, "No constraints."));
  }
  return section("Constraints", "", pre(constraints.join("\n\n")));
}

// --- CompilationOk ---

function renderCompilationOk(
  info: Extract<DisplayInfoVSCode, { kind: "CompilationOk" }>,
  version: AgdaVersion,
): RawHtml {
  const parts: RawHtml[] = [];
  const msg = info.backend
    ? `The module was successfully compiled with backend ${info.backend}.`
    : "The module was successfully compiled.";
  parts.push(section("Compilation Result", "success", h("span", { class: "info-text" }, msg)));
  if (info.errors.length > 0) {
    parts.push(
      section("Errors", "error", preLinked(joinLinkedTexts(info.errors, "\n\n"), version)),
    );
  }
  if (info.warnings.length > 0) {
    parts.push(
      section("Warnings", "warning", preLinked(joinLinkedTexts(info.warnings, "\n\n"), version)),
    );
  }
  return joinHtml(...parts);
}

// --- ModuleContents ---

function renderModuleContents(
  info: Extract<DisplayInfoVSCode, { kind: "ModuleContents" }>,
): RawHtml {
  const parts: RawHtml[] = [];

  if (info.telescope.length > 0) {
    parts.push(section("Telescope", "", pre(info.telescope.join("\n"))));
  }
  if (info.names.length > 0) {
    parts.push(section("Modules", "", pre(info.names.join("\n"))));
  }
  if (info.contents.length > 0) {
    parts.push(section("Names", "", renderNameTypeTable(info.contents)));
  }
  if (parts.length === 0) {
    parts.push(section("Module Contents", "", h("span", { class: "info-text" }, "Empty module.")));
  }

  return joinHtml(...parts);
}

// --- SearchAbout ---

function renderSearchAbout(info: Extract<DisplayInfoVSCode, { kind: "SearchAbout" }>): RawHtml {
  if (info.results.length === 0) {
    return section(`Search: ${info.search}`, "", h("span", { class: "info-text" }, "No results."));
  }
  return section(`Search: ${info.search}`, "", renderNameTypeTable(info.results));
}

// --- Shared name:type table (ModuleContents, SearchAbout) ---

function renderNameTypeTable(entries: NameTypePair[]): RawHtml {
  const rows = entries.map((e) =>
    h(
      "tr",
      {},
      h("td", { class: "ctx-name" }, e.name),
      h("td", { class: "ctx-sep" }, raw("&nbsp;:&nbsp;")),
      h("td", { class: "ctx-type" }, pre(e.term)),
    ),
  );
  return h("table", { class: "ctx-table" }, ...rows);
}

// ---------------------------------------------------------------------------
// Webview HTML shell
// ---------------------------------------------------------------------------

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    font-family: var(--vscode-editor-font-family), 'Fira Code', 'Consolas', monospace;
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background-color: var(--vscode-editor-background);
  }
  body {
    margin: 0;
    padding: 8px 12px;
    line-height: 1.5;
  }
  .placeholder {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 16px 0;
  }

  /* --- Sections --- */
  .section {
    padding: 8px 10px;
    border-left: 3px solid transparent;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.15)));
  }
  .section:last-child {
    border-bottom: none;
  }
  .section.error,
  .section.warning,
  .section.success {
    margin: 6px 0;
    border-radius: 3px;
  }
  .section.error {
    border-left-color: var(--vscode-errorForeground, #f44747);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 6%, transparent);
  }
  .section.warning {
    border-left-color: var(--vscode-editorWarning-foreground, #cca700);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 6%, transparent);
  }
  .section.success {
    border-left-color: var(--vscode-testing-iconPassed, #73c991);
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 6%, transparent);
  }
  h2 {
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 4px 0;
  }
  .section.error h2 {
    color: var(--vscode-errorForeground, #f44747);
  }
  .section.warning h2 {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .section.success h2 {
    color: var(--vscode-testing-iconPassed, #73c991);
  }

  /* --- Expressions --- */
  pre.expr {
    margin: 0;
    padding: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: inherit;
    font-size: inherit;
  }
  .info-text {
    color: var(--vscode-descriptionForeground);
  }
  .warning-text {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  /* --- Tables (goals, context, name:type) --- */
  .goal-table, .ctx-table {
    border-collapse: collapse;
    width: 100%;
  }
  .goal-table td, .ctx-table td {
    padding: 1px 0;
    vertical-align: top;
  }
  .goal-id, .ctx-name {
    white-space: nowrap;
    width: 1px;
    color: var(--vscode-symbolIcon-variableForeground, #75beff);
    font-weight: 600;
  }
  .goal-sep, .ctx-sep {
    white-space: nowrap;
    width: 1px;
    color: var(--vscode-descriptionForeground);
  }
  .goal-type pre, .ctx-type pre {
    margin: 0;
  }
  .ctx-not-in-scope {
    color: var(--vscode-descriptionForeground);
  }
  .ctx-original {
    font-weight: normal;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }

  /* --- Clickable file locations --- */
  .file-link {
    color: var(--vscode-textLink-foreground, #3794ff);
    text-decoration: underline;
    text-decoration-style: dotted;
    cursor: pointer;
  }
  .file-link:hover {
    color: var(--vscode-textLink-activeForeground, #3794ff);
    text-decoration-style: solid;
  }

</style>
</head>
<body>
  <div id="content">
    <div class="placeholder">Load an Agda file to see goals and info here.</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');

    // Handle file location link clicks
    content.addEventListener('click', (e) => {
      const link = e.target.closest('.file-link');
      if (!link) return;
      e.preventDefault();
      try {
        const loc = JSON.parse(link.dataset.loc);
        vscode.postMessage({ kind: 'openFile', filepath: loc.filepath, line: loc.line, col: loc.col });
      } catch {}
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.kind) {
        case 'displayInfo':
          content.innerHTML = msg.html;
          break;
        case 'clear':
          content.innerHTML = '<div class="placeholder">Load an Agda file to see goals and info here.</div>';
          break;
      }
    });
  </script>
</body>
</html>`;
}
