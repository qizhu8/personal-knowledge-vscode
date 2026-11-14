import * as vscode from "vscode";
import * as path from "path";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import { PythonRecipeAuthority, readProfilePythonRegistry, type PythonRecipeBinding } from "../runtime/python-recipe-authority";

/** Separate from the public Recipe-start modal; only the private native UI invokes this. */
export async function reviewSqlPythonRecipe(options: {
  profileStorage: string; binding: PythonRecipeBinding; cwd: string; preview: unknown; check(): void;
  approve(input: ReturnType<PythonRecipeAuthority["consume"]>): Promise<unknown>;
}): Promise<boolean> {
  const check = () => {
    options.check();
    if (!vscode.workspace.isTrusted
      || vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) !== true)
      throw new Error("Trusted explicitly enabled private Python host required.");
    return true;
  };
  check();
  const registry = path.join(options.profileStorage, "environments", "registry.json");
  const environments = new PythonEnvironmentAuthority(() => { try { return check(); } catch { return false; } },
    () => readProfilePythonRegistry(registry));
  const authority = new PythonRecipeAuthority({ trusted: () => { try { return check(); } catch { return false; } },
    environments, binding: options.binding, cwd: options.cwd });
  try {
    const grant = authority.select(options.preview), handle = grant.program.handle;
    const answer = await vscode.window.showWarningMessage("Approve Python execution for this exact SQL Recipe run?",
      { modal: true, detail: `Actor: ${handle.actorId}\nWorkspace: ${handle.workspaceId}\nRun: ${grant.manifest.runId}`
        + `\nSource: ${JSON.stringify(grant.program.source)}\nExecutable digest: ${grant.program.executableDigest}`
        + `\nReview manifest digest: ${grant.manifestDigest}\nEnvironment: ${handle.environmentId}`
        + `\nOriginal root: ${handle.root}\nInterpreter: ${handle.executable}\nTarget: ${handle.target}\nCWD: ${grant.program.cwd}`
        + `\nInputs: ${JSON.stringify(grant.program.inputs)}\nExact script hashes and literal argv:\n${JSON.stringify(grant.manifest.steps, null, 2)}`
        + `\nFull compiled definition/scripts:\n${JSON.stringify(grant.program.definition, null, 2)}`
        + "\nSEPARATE from public Recipe-start permission. One exact run, three minutes; source/registry/runtime are rechecked."
        + "\nPython has your OS permissions; this is not a sandbox. No automatic installation/download."
        + "\nDefinition, inputs and bounded output persist in the private native journal. Cancellation/restart never rolls back or replays effects." },
      "Approve exact SQL Recipe Python run");
    check();
    if (answer !== "Approve exact SQL Recipe Python run") return false;
    authority.approve(grant);
    await options.approve(authority.consume(grant));
    return true;
  } finally { authority.revoke(); environments.revoke(); }
}
