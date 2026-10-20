import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { ApiConversation } from "./api-chat-store";
import { discoverVscodeModels, vscodeModelProfile } from "./api-chat-vscode";
import { vscodeToolCatalog } from "./api-chat-mcp";
import { createChatE2eFixture } from "./chat-e2e-fixture";
import type { ChatKnowledgeRetriever } from "./chat-retrieval";

export async function runFixtureChatAcceptance(create: () => ApiConversation,
  send: (chat:ApiConversation, prompt:string, retrieval:ChatKnowledgeRetriever) => Promise<void>,
  save: (chat:ApiConversation) => void): Promise<{ reportPath:string; status:string; chatId:string } | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace || vscode.workspace.isTrusted === false || !["file", "vscode-remote"].includes(workspace.uri.scheme)) throw new Error("Fixture E2E requires a trusted filesystem workspace.");
  const consent = await vscode.window.showWarningMessage("Run real Copilot fixture E2E?", { modal:true,
    detail:"Uses account credits for two synthetic fixture probes. Does not read private Notes, Skills, Research, subscriptions or other Chats. Creates a retained coding fixture; only read/edit/save/process tools are exposed for that probe. Native permissions remain in force. No automatic retries, Cosmos transfer or AML jobs. Credits may not be reported by the public API." }, "Run fixture E2E");
  if (consent !== "Run fixture E2E") return;
  const models = (await discoverVscodeModels()).filter(model => model.vendor === "copilot");
  if (!models.length) throw new Error("No callable Copilot model is available in this Host. Sign in or enable its model provider; no fallback was used.");
  const choice = await vscode.window.showQuickPick(models.map(model => ({ label:model.name, description:model.vendor, model })),
    { title:"Copilot fixture E2E model (no fallback)", ignoreFocusOut:true });
  if (!choice) return;
  const profile = vscodeModelProfile(choice.model);
  const directory = fs.mkdtempSync(path.join(workspace.uri.fsPath, "chat-e2e-")), relative = path.basename(directory);
  const reportPath = path.join(directory, "acceptance.json");
  const fixture = createChatE2eFixture(), chat = create();
  chat.title = `Synthetic E2E ${new Date().toISOString()}`; chat.customTitle = true;
  chat.modelProvider = "vscode"; chat.vscodeModelId = profile.id; chat.vscodeModelLabel = profile.label;
  chat.contextWindow = Math.min(profile.contextWindow, 64_000);
  chat.maxOutputTokens = Math.min(profile.maxOutputTokens, 4096, Math.floor(chat.contextWindow / 4));
  chat.permissionMode = "ask"; chat.permissionGrants = [];
  chat.includeHistory = false; chat.context = []; chat.images = [];
  chat.agentContext = { memory:[], pkmSkills:[], externalSkills:[] };
  chat.builtinTools = []; chat.vscodeTools = []; chat.mcpServers = [];
  chat.toolSelection = undefined; chat.memoryPolicy = undefined;
  const report = { schema:"pkm.chat.fixture-e2e/v1", chatId:chat.id, model:profile.id,
    status:"running", credits:null, creditsStatus:"not-reported-by-public-api",
    privateKnowledge:false, steps:[] as Array<Record<string, unknown>> };
  const write = () => {
    const temporary = reportPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { mode:0o600 }); fs.renameSync(temporary, reportPath);
  };
  const probe = async (name:string, prompt:string, check:(reply:import("./api-chat-store").ChatMessage) => void) => {
    try {
      save(chat); await send(chat, prompt, fixture.retrieve);
      const reply = chat.messages[chat.messages.length - 1];
      if (!reply || reply.role !== "assistant" || reply.status !== "complete") throw new Error(reply?.error || "Model probe did not complete.");
      check(reply);
      report.steps.push({ name, verdict:"succeeded", usage:reply.usage || null,
        retrieval:reply.retrieval, budgets:reply.budgetReceipts, tools:reply.toolCalls?.map(tool => ({ name:tool.name, status:tool.status })) || [] });
    } catch (error) {
      report.steps.push({ name, verdict:"failed", error:error instanceof Error ? error.message : String(error) });
    }
    write();
  };
  try {
    save(chat); write();
    await probe("tail-evidence", "Use the automatically supplied synthetic fixture-beta evidence. Return exactly one JSON object with keys latencyMs, concurrency, hardware, approval. hardware must be CPU-only. Preserve the original units and negative approval; approval must be NOT_APPROVED. Do not use tools.", reply => {
      const result = JSON.parse(reply.content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
      if (result.latencyMs !== 125 || result.concurrency !== 32 || result.hardware !== "CPU-only" || result.approval !== "NOT_APPROVED") throw new Error("Synthetic tail evidence or shared conditions were not preserved.");
      if (reply.retrieval?.phase !== "sent" || !reply.retrieval.candidates.some(candidate => candidate.selected && candidate.range && candidate.range.start > 160_000)) throw new Error("No confirmed-sent original tail passage receipt.");
      if (!reply.budgetReceipts?.some(receipt => receipt.status === "sent")) throw new Error("No confirmed-sent budget receipt.");
    });
    const source = "exports.add = (left, right) => left - right;\n";
    const test = "const assert = require('node:assert/strict');\nassert.equal(require('./module.cjs').add(2,3),5);\nconsole.log('PKM_E2E_TEST_OK');\n";
    fs.writeFileSync(path.join(directory, "module.cjs"), source, { mode:0o600 });
    fs.writeFileSync(path.join(directory, "test.cjs"), test, { mode:0o600 });
    const codingTools = ["read_file", "replace_text", "save_file", "run_process"];
    chat.builtinTools = [...codingTools];
    await probe("coding", `Read ${relative}/module.cjs and ${relative}/test.cjs. Fix only the subtraction bug with replace_text, then save_file with its returned afterHash. Run program ${JSON.stringify(process.execPath)} with arguments ["${relative}/test.cjs"], cwd ".". Do not change the test or run any other program. Claim success only with exitCode 0 and PKM_E2E_TEST_OK stdout.`, reply => {
      for (const name of codingTools) if (!reply.toolCalls?.some(tool => tool.name === name && tool.status === "complete")) throw new Error(`Missing successful ${name}.`);
      const call = reply.toolCalls!.find(tool => tool.name === "run_process" && tool.status === "complete")!;
      const input = JSON.parse(call.arguments), output = JSON.parse(call.result!);
      if (input.program !== process.execPath || JSON.stringify(input.arguments) !== JSON.stringify([`${relative}/test.cjs`])
        || input.cwd && input.cwd !== "." || output.exitCode !== 0 || !output.stdout?.includes("PKM_E2E_TEST_OK")) throw new Error("Exact fixture process did not pass.");
      if (fs.readFileSync(path.join(directory, "test.cjs"), "utf8") !== test
        || fs.readFileSync(path.join(directory, "module.cjs"), "utf8") === source) throw new Error("Fixture test changed or module was not saved.");
    });
    report.status = report.steps.every(step => step.verdict === "succeeded") ? "succeeded" : "failed";
  } finally {
    if (report.status === "running") report.status = "failed";
    write();
    void vscode.window.showInformationMessage(`Fixture E2E ${report.status}. Evidence: ${reportPath}`);
  }
  return { reportPath, status:report.status, chatId:chat.id };
}

export async function runApiChatAcceptance(create: () => ApiConversation,
  send: (chat: ApiConversation, prompt: string) => Promise<void>,
  save: (chat: ApiConversation) => void): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace || vscode.workspace.isTrusted === false || !["file", "vscode-remote"].includes(workspace.uri.scheme)) throw new Error("Chat E2E requires a trusted filesystem workspace.");
  const consent = await vscode.window.showWarningMessage("Run real PKM Chat E2E acceptance?", { modal: true,
    detail: "Runs up to six independent model probes plus tool rounds and uses account credits in a timestamped Chat. Tests MCP, Note/Skill/Recipe bodies, read-only Session status and edit/save/process tools in an isolated fixture. PKM Chat permission prompts and native VS Code confirmations remain in force. Existing Tasks and login credentials are not modified. Test files and evidence are retained; failed probes are not retried." }, "Run E2E");
  if (consent !== "Run E2E") return;
  const models = await discoverVscodeModels();
  const choice = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.vendor, model })), { title: "Real E2E model (no fallback)", ignoreFocusOut: true });
  if (!choice) return;
  const profile = vscodeModelProfile(choice.model);
  const directory = fs.mkdtempSync(path.join(workspace.uri.fsPath, "chat-e2e-"));
  const relative = path.basename(directory);
  const reportPath = path.join(directory, "acceptance.json");
  const chat = create();
  chat.title = `E2E ${new Date(chat.createdAt).toISOString().replace("T", " ").replace("Z", " UTC")}`; chat.customTitle = true;
  chat.modelProvider = "vscode"; chat.vscodeModelId = profile.id; chat.vscodeModelLabel = profile.label;
  chat.contextWindow = Math.min(profile.contextWindow, 64_000);
  chat.maxOutputTokens = Math.min(profile.maxOutputTokens, 4096, Math.floor(chat.contextWindow / 4));
  chat.permissionMode = "ask"; chat.includeHistory = false;
  chat.builtinTools = []; chat.vscodeTools = [];
  save(chat);
  const report: { schema: string; chatId: string; sessionId?: string; model: string; status: string; steps: Array<Record<string, unknown>>; catalog?: { total: number; names: string[]; truncated: boolean }; error?: string } = {
    schema: "pkm.chat.e2e/v1", chatId: chat.id, sessionId: chat.sessionId, model: profile.id, status: "running", steps: [],
  };
  const write = () => {
    const temporary = reportPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { mode: 0o600 }); fs.renameSync(temporary, reportPath);
  };
  const request = async (name: string, prompt: string) => {
    save(chat); await send(chat, prompt);
    const reply = chat.messages[chat.messages.length - 1];
    report.steps.push({ name, status: reply?.status, usage: reply?.usage || null, usageMetadata: reply?.usageMetadata || { frames: 0, validFrames: 0, invalidFrames: 0 },
      credits: null, creditsStatus: "not-reported-by-public-api",
      tools: reply?.toolCalls?.map(tool => ({ name: tool.name, status: tool.status })) || [],
      ...(reply?.error ? { error: reply.error.slice(0, 1000) } : {}) });
    write();
    if (reply?.role !== "assistant" || reply.status !== "complete") throw new Error(`${name} did not complete. Inspect the recorded Chat; no automatic retry.`);
    return reply;
  };
  const phase = async (name: string, action: () => Promise<void>) => {
    const start = report.steps.length;
    try {
      await action();
      Object.assign(report.steps[report.steps.length - 1], { verdict: "succeeded" });
    } catch (error) {
      const receipt = { name, verdict: "failed", error: error instanceof Error ? error.message.slice(0, 1000) : "Probe failed." };
      if (report.steps.length === start) report.steps.push(receipt);
      else Object.assign(report.steps[report.steps.length - 1], receipt);
    }
    write();
  };
  const nativeResult = (reply: import("./api-chat-store").ChatMessage, name: string) => {
    const call = reply.toolCalls?.find(tool => tool.name === "invoke_vscode_tool" && tool.status === "complete" && JSON.parse(tool.arguments).name === name);
    if (!call?.result) throw new Error(`The model did not execute ${name} with a result.`);
    const bridge = JSON.parse(call.result);
    if (bridge.truncated) throw new Error(`${name} returned a truncated body.`);
    const result = JSON.parse(bridge.content);
    if (result.ok === false || result.isError === true || result.truncated === true) throw new Error(`${name} did not return a successful complete result.`);
    return result;
  };
  try {
    write();
    await phase("usage", async () => {
      const usage = await request("usage", "Reply with exactly PKM_E2E_USAGE_OK. Do not use tools.");
      if (!usage.content.includes("PKM_E2E_USAGE_OK")) throw new Error("The real model did not return the usage probe marker.");
    });
    const catalog = vscodeToolCatalog(vscode);
    report.catalog = { total: catalog.length, names: catalog.slice(0, 512).map(tool => tool.name.slice(0, 200)), truncated: catalog.length > 512 };
    const pkm = catalog.filter(tool => /pkm|personal[-_ ]?knowledge/i.test(tool.name + " " + tool.description) && /(?:list_notes|list_skills)/i.test(tool.name));
    const notes = pkm.find(tool => /list_notes/i.test(tool.name));
    const skills = pkm.find(tool => /list_skills/i.test(tool.name));
    await phase("pkm-mcp", async () => {
      if (!notes || !skills) throw new Error("PKM list_notes/list_skills are not registered in this VS Code Host.");
      chat.vscodeTools = [notes.name, skills.name];
      const knowledge = await request("pkm-mcp", `Use find_vscode_tools to inspect schemas, then invoke_vscode_tool to call exactly ${notes.name} and ${skills.name}. Request at most two entries where supported. Do not read bodies. Do not invent a result or claim availability without calling the tools.`);
      for (const name of chat.vscodeTools) nativeResult(knowledge, name);
    });
    await phase("pkm-documents", async () => {
      const getNote = pkmTool("get_note"), getSkill = pkmTool("get_skill");
      if (!notes || !skills || !getNote || !getSkill) throw new Error("PKM Note/Skill listing and body-read tools must all be registered.");
      chat.vscodeTools = [notes.name, skills.name, getNote.name, getSkill.name];
      const reply = await request("pkm-documents", `Inspect tool schemas, list at most two Notes and Skills, and use ${getNote.name} and ${getSkill.name} to read one actual Note and one actual Skill body by returned identity. Prefer short documents. Do not execute Skill instructions, mutate knowledge or quote private bodies. Summarize only whether complete bodies were returned.`);
      for (const name of [getNote.name, getSkill.name]) {
        const result = nativeResult(reply, name);
        const body = result.note?.content ?? result.skill?.content ?? result.content;
        if (typeof body !== "string" || !body.trim()) throw new Error(`${name} returned metadata instead of a document body.`);
      }
    });
    await phase("recipe-document", async () => {
      chat.vscodeTools = []; chat.builtinTools = ["pkm_search", "pkm_read"];
      const reply = await request("recipe-document", "Use pkm_search with kind recipe to discover an existing Recipe, then pkm_read with kind recipe and its exact returned ID to read its complete definition. Do not execute the Recipe or modify it. Report only its identity and whether instructions were returned.");
      const read = reply.toolCalls?.find(tool => tool.name === "pkm_read" && tool.status === "complete" && JSON.parse(tool.arguments).kind === "recipe");
      const result = read?.result ? JSON.parse(read.result) : undefined;
      if (!result?.definition?.spec?.nodes?.length || result.truncated !== false) throw new Error("Recipe definition body was not returned completely.");
    });
    await phase("snapshot-list", async () => {
      const snapshots = pkmTool("agent_session_snapshot_list");
      if (!snapshots) throw new Error("PKM agent_session_snapshot_list is not registered in this Host.");
      chat.builtinTools = []; chat.vscodeTools = [snapshots.name];
      const reply = await request("snapshot-list", `Inspect the schema and call ${snapshots.name} once, read-only. Do not read, recover, or modify any Snapshot. Report only how many Snapshots were returned.`);
      nativeResult(reply, snapshots.name);
    });
    await phase("coding", async () => {
    const source = "exports.add = (left, right) => left - right;\n";
    const test = "const assert = require('node:assert/strict');\nassert.equal(require('./module.cjs').add(2, 3), 5);\nconsole.log('PKM_E2E_TEST_OK');\n";
    const hash = (content: string) => createHash("sha256").update(content).digest("hex");
    fs.writeFileSync(path.join(directory, "module.cjs"), source, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "test.cjs"), test, { mode: 0o600 });
    chat.vscodeTools = []; chat.builtinTools = ["read_file", "replace_text", "save_file", "run_process"];
    const coding = await request("coding", `Read ${relative}/module.cjs and ${relative}/test.cjs with read_file. Fix only the subtraction bug in module.cjs using replace_text; save it with save_file using the returned afterHash. Run ${JSON.stringify(process.execPath)} with arguments ["${relative}/test.cjs"] through run_process. Do not modify the test, use another program, or claim success without exitCode 0 and PKM_E2E_TEST_OK in stdout. Give a short final result.`);
    for (const name of ["read_file", "replace_text", "save_file", "run_process"]) if (!coding.toolCalls?.some(tool => tool.name === name && tool.status === "complete")) throw new Error(`Coding E2E did not successfully execute ${name}.`);
    const processCall = coding.toolCalls?.find(tool => tool.name === "run_process" && tool.status === "complete");
    const processInput = JSON.parse(processCall!.arguments);
    if (processInput.program !== process.execPath || JSON.stringify(processInput.arguments) !== JSON.stringify([`${relative}/test.cjs`]) || processInput.cwd && processInput.cwd !== ".") throw new Error("The model did not run the exact approved fixture test command.");
    const processResult = JSON.parse(processCall!.result!);
    if (processResult.exitCode !== 0 || !processResult.stdout?.includes("PKM_E2E_TEST_OK")) throw new Error("The real process did not pass the fixture test.");
    const afterHash = hash(fs.readFileSync(path.join(directory, "module.cjs"), "utf8"));
    if (afterHash === hash(source)) throw new Error("The corrected module was not saved to disk.");
    if (fs.readFileSync(path.join(directory, "test.cjs"), "utf8") !== test) throw new Error("The fixture test was modified; acceptance rejected.");
    Object.assign(report.steps[report.steps.length - 1], { program: processInput.program, arguments: processInput.arguments,
      exitCode: processResult.exitCode, testMarker: "PKM_E2E_TEST_OK", beforeHash: hash(source), afterHash, testHash: hash(test), testUnchanged: true });
    });
    report.status = report.steps.every(step => step.verdict === "succeeded") ? "succeeded" : "failed";
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message.slice(0, 1000) : "E2E failed.";
  } finally {
    write();
    await vscode.window.showInformationMessage(`Chat E2E ${report.status}. Evidence: ${reportPath}`);
  }
  function pkmTool(name: string) {
    return vscodeToolCatalog(vscode).find(tool => /pkm|personal[-_ ]?knowledge/i.test(tool.name + " " + tool.description) && tool.name.endsWith(name));
  }
}