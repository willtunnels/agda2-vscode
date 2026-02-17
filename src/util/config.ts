import * as vscode from "vscode";
import type { SymbolsByAbbreviation } from "../unicode/engine/AbbreviationProvider";

const INPUT_ENABLED = "agda.input.enabled";
const INPUT_LEADER = "agda.input.leader";
const INPUT_LANGUAGES = "agda.input.languages";
const INPUT_CUSTOM_TRANSLATIONS = "agda.input.customTranslations";
const PATH = "agda.path";
const EXTRA_ARGS = "agda.extraArgs";
const BACKEND = "agda.backend";
const ADDITIONAL_PATHS = "agda.additionalPaths";
const GOAL_LABELS = "agda.goalLabels";
const RELOAD_ON_GIVE = "agda.reloadOnGive";

function get<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration().get<T>(key, fallback);
}

/** Returns the most specific scope where a setting is currently defined. */
function mostSpecificTarget(
  inspected: { workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined,
): vscode.ConfigurationTarget {
  return inspected?.workspaceFolderValue !== undefined
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

// Getters

export function getInputEnabled(): boolean {
  return get<boolean>(INPUT_ENABLED, true);
}

export function getInputLeader(): string {
  return get<string>(INPUT_LEADER, "\\");
}

export function getInputLanguages(): string[] {
  return get<string[]>(INPUT_LANGUAGES, ["agda"]);
}

export function getCustomTranslations(): SymbolsByAbbreviation {
  const raw = get<Record<string, string | string[]>>(INPUT_CUSTOM_TRANSLATIONS, {});
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
  );
}

export function getAgdaPath(): string {
  return get<string>(PATH, "agda");
}

export function getExtraArgs(): string[] {
  return get<string[]>(EXTRA_ARGS, []);
}

export function getBackend(): string {
  return get<string>(BACKEND, "");
}

export function getAdditionalPaths(): string[] {
  return get<string[]>(ADDITIONAL_PATHS, []);
}

export function getGoalLabels(): boolean {
  return get<boolean>(GOAL_LABELS, true);
}

export function getReloadOnGive(): boolean {
  return get<boolean>(RELOAD_ON_GIVE, false);
}

// Setters

export async function setAgdaPath(newPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  await config.update(PATH, newPath, mostSpecificTarget(config.inspect(PATH)));
}

// Change events

const inputEnabledEmitter = new vscode.EventEmitter<void>();
const inputLeaderEmitter = new vscode.EventEmitter<void>();
const inputLanguagesEmitter = new vscode.EventEmitter<void>();
const customTranslationsEmitter = new vscode.EventEmitter<void>();
const goalLabelsEmitter = new vscode.EventEmitter<void>();

export const onInputEnabledChanged = inputEnabledEmitter.event;
export const onInputLeaderChanged = inputLeaderEmitter.event;
export const onInputLanguagesChanged = inputLanguagesEmitter.event;
export const onCustomTranslationsChanged = customTranslationsEmitter.event;
export const onGoalLabelsChanged = goalLabelsEmitter.event;

/** Register the single onDidChangeConfiguration listener. Call once from activate(). */
export function init(): vscode.Disposable {
  const sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(INPUT_ENABLED)) inputEnabledEmitter.fire();
    if (e.affectsConfiguration(INPUT_LEADER)) inputLeaderEmitter.fire();
    if (e.affectsConfiguration(INPUT_LANGUAGES)) inputLanguagesEmitter.fire();
    if (e.affectsConfiguration(INPUT_CUSTOM_TRANSLATIONS)) customTranslationsEmitter.fire();
    if (e.affectsConfiguration(GOAL_LABELS)) goalLabelsEmitter.fire();
  });
  return vscode.Disposable.from(
    sub,
    inputEnabledEmitter,
    inputLeaderEmitter,
    inputLanguagesEmitter,
    customTranslationsEmitter,
    goalLabelsEmitter,
  );
}
