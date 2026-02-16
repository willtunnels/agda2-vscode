import * as vscode from "vscode";

export function agdaConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("agda");
}

export function getAgdaPath(): string {
  return agdaConfig().get<string>("path", "agda");
}

export function getExtraArgs(): string[] {
  return agdaConfig().get<string[]>("extraArgs", []);
}

export function getBackend(): string {
  return agdaConfig().get<string>("backend", "");
}

export function getAdditionalPaths(): string[] {
  return agdaConfig().get<string[]>("additionalPaths", []);
}

export function getGoalLabels(): boolean {
  return agdaConfig().get<boolean>("goalLabels", true);
}

export function getReloadOnGive(): boolean {
  return agdaConfig().get<boolean>("reloadOnGive", false);
}
