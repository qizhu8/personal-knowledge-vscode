const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { captureExecutionContext } = require("../dist/chat/execution-context");
const plan = require("../dist/chat/chat-plan");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const body = () => ({ objective:"Fix the endpoint without widening scope", scope:["Endpoint and focused regression"], nonGoals:["Other endpoints"],
  facts:["Reproduction verified in the focused test"], openQuestions:[], risks:["Existing callers"],
  steps:[{ id:"inspect", title:"Inspect callers", dependsOn:[], verification:"Record call sites and the failing assertion" },
    { id:"fix", title:"Fix and verify", dependsOn:["inspect"], verification:"Run the focused endpoint regression; assert HTTP 200 and exact body" }] });
const context = (host = randomUUID(), mode = "allow-all") => captureExecutionContext(host, [], process.cwd(), true, mode);
const fixture = () => ({ id:randomUUID(), messages:[{ id:randomUUID(), role:"user", content:"Fix the endpoint", status:"complete" }], workflowMode:"plan" });

test("Plan validation requires bounded concrete verification, unique dependencies and an acyclic graph", () => {
  assert(plan.validChatPlanBody(body()));
  for (const mutate of [
    b => b.steps.push(b.steps[0]), b => b.steps[0].dependsOn.push("fix"),
    b => b.steps[1].dependsOn.push("missing"), b => b.steps[1].dependsOn.push("inspect"),
    b => b.steps[0].verification = "", b => b.scope = [], b => b.objective = "x".repeat(2001),
    b => b.steps = [null], b => b.openQuestions = ["x".repeat(601)],
  ]) { const invalid = body(); mutate(invalid); assert.equal(plan.validChatPlanBody(invalid), false); }
  for (const invalid of [null, [], {}, "plan"]) assert.equal(plan.validChatPlanBody(invalid), false);
});
test("Plan versions are content-bound, persisted and cannot approve open questions or stale requirements", () => {
  const chat = fixture(), execution = context(), first = plan.submitChatPlan(chat, body(), execution, "Initial plan");
  assert(plan.validChatPlans(chat.plans, chat.id));
  assert.throws(() => plan.approveChatPlan(chat, first.id, "0".repeat(64), execution), /changed/);
  chat.messages.push({ id:randomUUID(), role:"user", content:"Also change the output contract", status:"complete" });
  assert.throws(() => plan.approveChatPlan(chat, first.id, first.contentHash, execution), /Requirements changed/);
  const unresolved = body(); unresolved.openQuestions.push("Which output contract?");
  const second = plan.submitChatPlan(chat, unresolved, execution, "New requirement");
  assert.equal(second.revision, 2); assert.equal(first.approval, undefined);
  assert.throws(() => plan.approveChatPlan(chat, second.id, second.contentHash, execution), /open questions/);
  const corrupt = structuredClone(chat.plans); corrupt[0].steps[0].title += "changed";
  assert.equal(plan.validChatPlans(corrupt, chat.id), false);
  assert.equal(plan.validChatPlans([null], chat.id), false);
  const malformed = structuredClone(chat.plans); malformed[0].approval = null;
  assert.equal(plan.validChatPlans(malformed, chat.id), false);
});
test("Host reload preserves Plan but requires explicit reapproval in the same stable environment", () => {
  const chat = fixture(), execution = context(), proposal = plan.submitChatPlan(chat, body(), execution, "Initial");
  plan.approveChatPlan(chat, proposal.id, proposal.contentHash, execution);
  plan.assertChatPlanExecution(chat, execution);
  chat.messages.push({ id:randomUUID(), role:"user", content:"Implement approved plan", planExecution:proposal.id });
  plan.assertChatPlanExecution(chat, execution);
  const restored = JSON.parse(JSON.stringify(chat)), restarted = context();
  assert.throws(() => plan.assertChatPlanExecution(restored, restarted), /local approval/);
  plan.approveChatPlan(restored, proposal.id, proposal.contentHash, restarted);
  plan.assertChatPlanExecution(restored, restarted);
  assert.throws(() => plan.assertChatPlanExecution(restored, context(restarted.hostId, "ask")), /local approval/);
  const changed = JSON.parse(JSON.stringify(restarted)); changed.knowledgeRoot = os.tmpdir();
  assert.throws(() => plan.approveChatPlan(restored, proposal.id, proposal.contentHash, changed), /environment/);
  const other = { ...restored, id:randomUUID() };
  assert.throws(() => plan.approveChatPlan(other, proposal.id, proposal.contentHash, restarted), /changed/);
});
test("Plan approval and execution bind attached reference contents and pending images", () => {
  for (const change of [
    chat => chat.context[0].content = "A different output contract",
    chat => chat.context.push({ id:"new", label:"Extra scope", content:"Change another endpoint" }),
    chat => chat.agentContext.skills[0].content = "A revised implementation requirement",
    chat => chat.images.push({ id:"draft", label:"New requirements", mimeType:"image/png", dataBase64:"eA==" }),
  ]) {
    const chat = fixture(), execution = context();
    chat.context = [{ id:"requirements", label:"Requirements", content:"Existing output contract" }];
    chat.agentContext = { skills:[{ id:"skill", label:"Implementation guidance", content:"Existing requirement" }] };
    chat.images = [];
    const proposal = plan.submitChatPlan(chat, body(), execution, "Initial");
    plan.approveChatPlan(chat, proposal.id, proposal.contentHash, execution);
    change(chat);
    assert.throws(() => plan.assertChatPlanExecution(chat, execution), /local approval/);
    assert.throws(() => plan.approveChatPlan(chat, proposal.id, proposal.contentHash, execution), /Requirements changed/);
  }
});
test("Submitting a Plan ends every queued tool, including a read-only question", async () => {
  const chat = fixture(), execution = context();
  let questions = 0;
  const tools = plan.gatePlanTools(chat, "plan", execution, [
    { name:"submit_plan", execute:async () => { plan.submitChatPlan(chat, body(), execution, "Initial"); return "submitted"; } },
    { name:"ask_user", execute:async () => { questions++; return "answered"; } },
  ]);
  const signal = new AbortController().signal;
  await tools[0].execute({}, signal);
  await assert.rejects(tools[1].execute({}, signal), /Plan.*submitted/);
  assert.equal(questions, 0);
});
test("A Plan cannot be submitted against attachments that changed during research", async () => {
  const chat = fixture(), execution = context();
  chat.context = [];
  const tools = plan.gatePlanTools(chat, "plan", execution, [
    { name:"submit_plan", execute:async () => { plan.submitChatPlan(chat, body(), execution, "Initial"); return "submitted"; } },
  ]);
  chat.context.push({ id:"new", label:"New requirements", content:"Expand the scope" });
  await assert.rejects(tools[0].execute({}, new AbortController().signal), /Requirements changed/);
  assert.equal(chat.plans, undefined);
});
test("All-provider tool gate blocks actual writes, processes, Actions and delegation even under Allow All", async () => {
  const chat = fixture(), execution = context(); let calls = 0;
  const tools = ["read_file", "run_process", "replace_in_file", "save_message", "run_action", "foreign_read_tool", "record_harness", "spawn_workers", "ask_chat", "ask_session", "mcp_pkm_api_chat_send", "mcp__pkm__portal_control"]
    .map(name => ({ name, description:name, parameters:{}, execute:async () => { calls++; return "executed"; } }));
  const gated = plan.gatePlanTools(chat, "plan", execution, tools);
  assert.deepEqual(gated.map(tool => tool.name), ["read_file"]);
  for (const tool of tools.filter(tool => tool.name !== "read_file")) assert.throws(() => plan.assertPlanTool(chat, "plan", execution, tool.name), /cannot execute/);
  assert.equal(calls, 0);
  await gated[0].execute({}, new AbortController().signal); assert.equal(calls, 1);
  const proposal = plan.submitChatPlan(chat, body(), execution, "Initial");
  plan.approveChatPlan(chat, proposal.id, proposal.contentHash, execution);
  const running = plan.gatePlanTools(chat, "execute", execution, tools), write = running.find(tool => tool.name === "replace_in_file");
  assert(!running.some(tool => tool.name === "spawn_workers"));
  assert(!running.some(tool => ["ask_chat", "ask_session", "mcp_pkm_api_chat_send", "mcp__pkm__portal_control"].includes(tool.name)));
  await write.execute({}, new AbortController().signal); assert.equal(calls, 2);
  plan.submitChatPlan(chat, body(), execution, "Approach changed");
  await assert.rejects(write.execute({}, new AbortController().signal), /local approval/);
  assert.equal(calls, 2, "a previously assembled mutating tool must not execute after a same-round revision");
});
test("Plan storage round-trips version history and rejects corrupted persisted proposals", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-plan-test-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const store = new ApiChatStore(root, "a".repeat(16)), chat = store.create(), execution = context();
  chat.messages.push({ id:randomUUID(), role:"user", content:"Fix this endpoint", status:"complete" });
  const proposal = plan.submitChatPlan(chat, body(), execution, "Initial");
  plan.approveChatPlan(chat, proposal.id, proposal.contentHash, execution); store.save(chat);
  const restored = store.load(chat.id);
  assert.deepEqual(restored.plans, chat.plans); assert.equal(restored.workflowMode, "execute");
  const recovered = store.recoverAgentSnapshot({ snapshotId:randomUUID(), magicCode:"fixture", sourceSessionId:randomUUID(), name:"Plan recovery", task:"Fix endpoint" },
    { session:{ origin:"pkm-native", nativeChat:chat }, recipeRuns:[] });
  assert.equal(recovered.workflowMode, "plan");
  assert.equal(recovered.plans.at(-1).approval, undefined);
  assert.equal(recovered.plans.at(-1).chatId, recovered.id);
  assert.notEqual(recovered.plans.at(-1).contentHash, proposal.contentHash);
  restored.plans[0].objective = "tampered";
  assert.equal(plan.validChatPlans(restored.plans, restored.id), false);
  const filename = store.file(chat.id), persisted = JSON.parse(fs.readFileSync(filename, "utf8"));
  persisted.plans[0].objective = "tampered";
  fs.writeFileSync(filename, JSON.stringify(persisted));
  assert.throws(() => store.load(chat.id), /Unsupported|Invalid|corrupt|valid/i);
});
test("Incoming file writes recheck Plan policy after batch approval, not only before the chooser", async t => {
  const { PortalFiles } = require("../dist/chatroom/portal-files");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-plan-file-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  let planning = false; const statuses = [];
  const engine = new PortalFiles({ controlled:true, destination:root, approve:async () => true, send:async () => {},
    assertActive:() => { if (planning) throw new Error("Plan cannot write files."); }, onStatus:status => statuses.push(status) });
  t.after(() => engine.dispose());
  const id = randomUUID();
  await engine.handle({ kind:"portal-file", op:"manifest", transferId:id, files:[{
    name:"business.txt", size:1, sha256:require("node:crypto").createHash("sha256").update("a").digest("hex"),
  }], totalBytes:1 });
  assert.equal(statuses.at(-1).state, "transferring");
  assert.equal(fs.statSync(path.join(root, fs.readdirSync(root)[0])).size, 0);
  planning = true;
  await engine.handle({ kind:"portal-file", op:"chunk", transferId:id, index:0, offset:0, data:Buffer.from("a").toString("base64") });
  assert.equal(statuses.at(-1).state, "failed"); assert.match(statuses.at(-1).reason, /Plan cannot/);
  assert.deepEqual(fs.readdirSync(root), [], "no byte is written and the empty temporary file is cleaned up");
});
