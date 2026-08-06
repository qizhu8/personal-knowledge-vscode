import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

export function managedEnvironmentsRoot(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("environmentsPath", "").trim();
  return configured || path.join(os.homedir(), "pkm-envs");
}