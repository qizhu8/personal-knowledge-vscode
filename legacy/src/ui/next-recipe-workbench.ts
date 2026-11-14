import * as vscode from "vscode";
import { randomUUID } from "crypto";
import type { NextManagedClient } from "../runtime/next-managed-client";
import type { RecipeRecord } from "../workflows/project-model";
import { recipeBrowserEditorDocument } from "./recipe-browser";

const editable = ["name", "category", "description", "definition", "metadata", "methodology", "editorLayout", "nodeBindings"];
export async function openManagedRecipeWorkbench(context: vscode.ExtensionContext, client: NextManagedClient,
  active: () => boolean, recipeId?: string): Promise<void> {
  const initial = await client.recipeCommand({ operation: "state" }), binding = initial.binding;
  const identity = { namespace: binding.namespace, chatId: binding.chatId };
  let recipe: any, digest = initial.state.digest, busy = false, disposed = false, response: any;
  if (recipeId) {
    const opened = await client.recipeCommand({ operation: "editor", input: { ...identity, recipeId } });
    recipe = opened.recipe; digest = opened.digest;
  } else {
    recipe = { recipeId: `recipe_${randomUUID()}`, revision: 0, name: "Untitled Recipe", category: "", description: "",
      scope: "global", metadata: { applicableFunctions: [], solution: "", requiredInputs: [], expectedOutputs: [] },
      definition: { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
        nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
          generalInstruction: "Perform the reviewed work using your own permissions, then report its actual result." }],
        completion: { requiredNodes: ["work"] } } } };
  }
  const savedRunKey = `pkm.nextRecipe.lastRun.v1:${binding.workspaceId}:${recipe.recipeId}`;
  let runId = await context.secrets.get(savedRunKey);
  const panel = vscode.window.createWebviewPanel("pkm.managedRecipeWorkbench", `Recipe · ${recipe.name}`,
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  panel.webview.html = recipeBrowserEditorDocument(recipe as RecipeRecord, [], { nativeTransport: true, nativeLifecycle: true });
  const assertActive = () => {
    if (disposed || !active() || !vscode.workspace.isTrusted || client.isStopped()) throw new Error("Recipe workspace or trust changed; no retry is performed.");
  };
  const review = async (request: { binding: Record<string, unknown>; operation: string; approval: any }) => {
    assertActive();
    const button = "Approve exact Recipe request";
    const answer = await vscode.window.showWarningMessage("Approve this exact Recipe request?",
      { modal: true, detail: `Independent native workspace only. No original Root takeover; no automatic agent, model, command or Knowledge authority.\nGet/next/progress may mutate. Cancellation is a cooperative request, not proof of stopping work. UNKNOWN effects are never replayed.\n${JSON.stringify(request, null, 2)}` }, button);
    assertActive();
    return answer === button;
  };
  const execute = async (name: string, args: Record<string, unknown>) => {
    assertActive();
    const result = await client.recipeCommand({ operation: "execute",
      input: { operation: `mcp.tool.recipe_run_${name}`, args } }, review);
    if (result?.error) throw new Error(`${result.error.code}: ${result.error.message ?? "Recipe execution unavailable."}`);
    if (!result?.result?.ok) throw new Error(JSON.stringify(result?.result ?? result));
    response = result.result;
    runId = response.run_id;
    if (runId) await context.secrets.store(savedRunKey, runId);
    return response;
  };
  const run = async (action: string) => {
    if (recipe.revision < 1) throw new Error("Save the definition before creating a run.");
    if (action === "start") {
      const inputs = await vscode.window.showInputBox({ title: "Inputs for a distinct controlled Recipe run", value: "{}",
        validateInput: value => {
          try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "JSON object required."; }
          catch { return "JSON object required."; }
        } });
      if (inputs === undefined) throw new Error("Run creation cancelled.");
      return execute("start", { recipe_id: recipe.recipeId, command_id: randomUUID(), inputs_json: inputs,
        expected_revision: recipe.revision, expected_digest: recipe.executableDigest, detail: "full" });
    }
    if (!runId) runId = await vscode.window.showInputBox({ title: "Existing controlled Recipe run ID" });
    if (!runId) throw new Error("No run selected.");
    if (action === "refresh") return execute("get", { run_id: runId, detail: "full" });
    if (action === "next") return execute("next", { run_id: runId, command_id: randomUUID(), detail: "full" });
    const next = response?.next_action;
    if (!next?.node_id || next.run_id !== runId) throw new Error("Inspect this run, then explicitly claim its next node before deciding.");
    if (action === "cancel") return execute("progress", { run_id: runId, node_id: next.node_id,
      command_id: randomUUID(), progress_json: '{"cancellationRequested":true}', detail: "full" });
    if (action === "progress") {
      const progress = await vscode.window.showInputBox({ title: "Actual Recipe progress (JSON object)", value: '{"progressed":true}',
        validateInput: value => {
          try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "JSON object required."; }
          catch { return "JSON object required."; }
        } });
      if (progress === undefined) throw new Error("Progress report cancelled.");
      return execute("progress", { run_id: runId, node_id: next.node_id,
        command_id: randomUUID(), progress_json: progress, detail: "full" });
    }
    if (action === "input") {
      if (next.kind !== "request_user_input") throw new Error("This node is not a waiting Human Gate.");
      let value: unknown;
      if (next.input_kind === "approval") {
        const answer = await vscode.window.showWarningMessage(String(next.prompt), { modal: true }, "Approve", "Reject");
        if (!answer) throw new Error("Human input cancelled.");
        value = { approved: answer === "Approve" };
      } else if (next.input_kind === "choice") {
        const choice = await vscode.window.showQuickPick(next.choices as string[], { placeHolder: next.prompt });
        if (choice === undefined) throw new Error("Human input cancelled.");
        value = { choice };
      } else {
        const text = await vscode.window.showInputBox({ prompt: next.prompt });
        if (!text?.trim()) throw new Error("Human input cancelled.");
        value = { text };
      }
      return execute("submit_input", { run_id: runId, node_id: next.node_id, challenge_id: next.challenge_id,
        response_json: JSON.stringify(value), command_id: randomUUID(), detail: "full" });
    }
    if (action === "report") {
      if (next.kind === "request_user_input") throw new Error("Use Human input: an ordinary report cannot approve a Gate.");
      const outcome = await vscode.window.showQuickPick(next.accepted_outcomes as string[], { placeHolder: "Report the actual outcome; this does not execute the work." });
      if (!outcome) throw new Error("Report cancelled.");
      const result = await vscode.window.showInputBox({ title: "Actual caller-reported result (JSON)", value: "null",
        validateInput: value => { try { JSON.parse(value); return undefined; } catch { return "Valid JSON required."; } } });
      if (result === undefined) throw new Error("Report cancelled.");
      return execute("report", { run_id: runId, node_id: next.node_id, outcome, result_json: result,
        command_id: randomUUID(), detail: "full" });
    }
    throw new Error("Unknown Recipe action.");
  };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (message?.type !== "nativeRecipeEditor" || typeof message.requestId !== "string"
      || message.requestId.length > 128) return;
    if (busy) {
      await panel.webview.postMessage({ type: "nativeRecipeEditorResult", requestId: message.requestId,
        error: "Another exact Recipe request is pending; no additional work was admitted." });
      return;
    }
    busy = true;
    try {
      assertActive();
      if (Buffer.byteLength(JSON.stringify(message)) > 1_000_000) throw new Error("Recipe request exceeds the bounded UI budget.");
      const body = JSON.parse(message.options?.body ?? "{}");
      let value: unknown;
      if (message.path === "/api/validate" && message.options?.method === "POST")
        value = await client.recipeCommand({ operation: "validate", definition: body.definition });
      else if (message.path === "/api/recipe" && message.options?.method === "PUT") {
        if (body.recipeId !== recipe.recipeId || body.revision !== recipe.revision) throw new Error("Recipe editor identity changed.");
        const fields = Object.fromEntries(editable.filter(key => Object.prototype.hasOwnProperty.call(body, key)
          && body[key] !== undefined).map(key => [key, body[key]]));
        const saved = await client.recipeCommand({ operation: "save", input: { ...identity, operationId: randomUUID(),
          expectedDigest: digest, recipeId: recipe.recipeId, expectedRevision: recipe.revision, fields } }, review);
        recipe = saved.recipe; digest = saved.digest; value = { recipe };
        panel.title = `Recipe · ${recipe.name}`;
      } else if (message.path === "/api/run" && message.options?.method === "POST") value = await run(body.action);
      else throw new Error("Recipe endpoint not allowed.");
      await panel.webview.postMessage({ type: "nativeRecipeEditorResult", requestId: message.requestId, value });
    } catch (error) {
      await panel.webview.postMessage({ type: "nativeRecipeEditorResult", requestId: message.requestId,
        error: error instanceof Error ? error.message : "Recipe outcome unknown; do not retry automatically." });
    } finally { busy = false; }
  });
  panel.onDidDispose(() => { disposed = true; listener.dispose(); });
}
