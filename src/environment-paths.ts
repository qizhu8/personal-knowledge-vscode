import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { isAbsoluteForPlatform, isForeignAbsolutePath } from "./store-path";

export function managedEnvironmentsRoot(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("environmentsPath", "").trim();
  return configured && isAbsoluteForPlatform(configured) && !isForeignAbsolutePath(configured)
    ? path.normalize(configured)
    : path.join(os.homedir(), "pkm-envs");
}