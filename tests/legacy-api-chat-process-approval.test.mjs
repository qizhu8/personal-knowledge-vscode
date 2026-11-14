import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import { createLegacyChatProcessApprovalBridge } from "../dist/legacy-api-chat-process-approval.js";
import { LegacyChatProcessApprovalUi } from "../dist/legacy-api-chat-process-approval-ui.js";

const binding = { root: "/fixture", workspaceId: randomUUID(), actorId: randomUUID(), sourceFingerprint: "a".repeat(64),
  namespace: "0123456789abcdef", chatId: randomUUID() };
const spec = { program: "/fixture/program", arguments: ["test"], cwd: "/fixture", timeoutSeconds: 86400, background: true };
const toolScope = (source, name) => `tool:${createHash("sha256").update(JSON.stringify([source, name])).digest("hex")}`;

test("Chat process approval matches old one-shot, scoped grant and read-only semantics", async () => {
  let policy = { available: true, trusted: true, permissionMode: "allow-all", localControls: true };
  const prompts = [], confirmations = [];
  const approve = createLegacyChatProcessApprovalBridge({
    assertOwner(scope) { assert.deepEqual(scope, binding); },
    policy: async () => structuredClone(policy),
    requestPermission: async prompt => { prompts.push(prompt); return true; },
    confirmLocalStop: async request => { confirmations.push(request); return true; },
  });
  assert.equal(await approve(binding, "run_process", spec), true);
  assert.equal(prompts.length, 1, "Background execution always requires fresh approval, including allow-all.");
  assert.equal(prompts[0].scope, toolScope("builtin", "run_process_background"));
  assert.equal(prompts[0].once, true);
  assert.equal(prompts[0].binding.chatId, binding.chatId);
  assert.match(prompts[0].detail, /86400s/);
  assert.match(prompts[0].detail, /not a content digest.*interpreters, scripts and dependencies can change/);
  assert.equal(await approve(binding, "run_process", { ...spec, timeoutSeconds: 30, background: false }), true);
  assert.equal(prompts.length, 1, "Allow-all skips only the non-one-shot foreground request.");
  policy.permissionMode = "protective";
  assert.equal(await approve(binding, "process_cancel", { handle: `process_${"b".repeat(64)}`, record: { spec: { program: "/fixture/program" } } }), true);
  assert.equal(prompts.at(-1).scope, toolScope("boundary", "outside-workspace"));
  policy.permissionGrants = [toolScope("boundary", "outside-workspace")];
  assert.equal(await approve(binding, "process_cancel", { handle: `process_${"b".repeat(64)}`, record: {} }), true);
  assert.equal(prompts.length, 2);
  policy.permissionMode = "read-only";
  assert.equal(await approve(binding, "run_process", spec), false);
  assert.equal(await approve(binding, "process_output", {}), true);
  assert.equal(await approve(binding, "stop-ui", { handle: `process_${"b".repeat(64)}`, record: {} }), true);
  assert.equal(confirmations.length, 1);
  policy.localControls = false;
  assert.equal(await approve(binding, "pause", {}), false);
  assert.equal(await approve(binding, "stop-ui", { handle: `process_${"b".repeat(64)}`, record: {} }), false);
  assert.equal(confirmations.length, 1);
});

test("content limitation remains visible even when command detail is truncated", async () => {
  let prompt;
  const approve = createLegacyChatProcessApprovalBridge({
    assertOwner() {}, policy: async () => ({ available: true, trusted: true, permissionMode: "ask", localControls: true }),
    requestPermission: async value => { prompt = value; return true; }, confirmLocalStop: async () => false,
  });
  assert.equal(await approve(binding, "run_process", { ...spec, arguments: ["x".repeat(9000)] }), true);
  assert.equal(prompt.detail.length, 8000);
  assert.match(prompt.detail, /not a content digest/);
});

test("denial, cancellation and authority changes while waiting cannot approve a launch", async () => {
  let policy = { available: true, trusted: true, permissionMode: "ask", localControls: true };
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const approve = createLegacyChatProcessApprovalBridge({
    assertOwner() {},
    policy: async () => structuredClone(policy),
    requestPermission: () => { entered(); return new Promise(resolve => { finish = resolve; }); },
    confirmLocalStop: async () => false,
  });
  const denied = approve(binding, "run_process", spec);
  await waiting; finish(false); assert.equal(await denied, false);
  const abort = new AbortController();
  const cancelled = approve(binding, "run_process", spec, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  finish(true);
  const changed = approve(binding, "run_process", spec);
  await new Promise(resolve => setImmediate(resolve));
  policy = { ...policy, permissionMode: "read-only" };
  finish(true); assert.equal(await changed, false);
  policy.trusted = false;
  await assert.rejects(approve(binding, "process_get", {}), /trusted workspace/);
});

test("interactive approvals remain bound to the live Chat and reject stale, cancelled or cross-Chat decisions", async () => {
    let live = true;
    const policy = { available: true, trusted: true, permissionMode: "ask", localControls: true };
    const remembered = [];
    const owner = {
      assertOwner: scope => { if (!live || scope.root !== binding.root) throw new Error("owner lost"); },
      policy: async () => structuredClone(policy),
      remember: async (scope, grant, choice) => { remembered.push({ chatId: scope.chatId, grant, choice }); },
    };
    const ui = new LegacyChatProcessApprovalUi(owner);
    const approve = createLegacyChatProcessApprovalBridge({
      ...owner, requestPermission: ui.requestPermission, confirmLocalStop: ui.confirmLocalStop,
    });

    const next = async () => {
      for (let n = 0; n < 100; n++) {
        const entries = await ui.list(binding);
        if (entries.length) return entries[0];
        await new Promise(resolve => setImmediate(resolve));
      }
      throw new Error("Approval was not queued.");
    };
    const run = approve(binding, "run_process", spec);
    let item = await next();
    assert.equal(item.once, true);
    assert.deepEqual(await ui.list({ ...binding, chatId: randomUUID() }), []);
    await assert.rejects(ui.decide({ ...binding, chatId: randomUUID() }, item.id, "approve"), /no longer pending/);
    await assert.rejects(ui.decide(binding, item.id, "allow-all"), /Invalid/);
    await ui.decide(binding, item.id, "approve"); assert.equal(await run, true);
    assert.deepEqual(remembered, []);
    await assert.rejects(ui.decide(binding, item.id, "approve"), /no longer pending/);

    const foreground = approve(binding, "run_process", { ...spec, timeoutSeconds: 30, background: false });
    item = await next();
    await ui.decide(binding, item.id, "approve"); assert.equal(await foreground, true);
    assert.equal(remembered[0].chatId, binding.chatId);
    assert.equal(remembered[0].grant, toolScope("builtin", "run_process"));

    const abort = new AbortController();
    const cancelled = approve(binding, "run_process", spec, abort.signal);
    item = await next(); abort.abort();
    await assert.rejects(cancelled, /cancelled/);
    await assert.rejects(ui.decide(binding, item.id, "approve"), /no longer pending/);

    const stopping = approve(binding, "stop-ui", { handle: `process_${"b".repeat(64)}`, record: {} });
    item = await next(); assert.equal(item.kind, "stop");
    policy.localControls = false;
    await assert.rejects(ui.decide(binding, item.id, "approve"), /authority changed/);
    await ui.decide(binding, item.id, "deny"); assert.equal(await stopping, false);

    policy.localControls = true;
    const fenced = approve(binding, "run_process", spec);
    item = await next(); live = false;
    await assert.rejects(ui.decide(binding, item.id, "approve"), /owner lost/);
    ui.close();
    await assert.rejects(fenced, /owner lost/);
});

test("pending decisions cannot race or survive broker closure while owner approval awaits persistence", async () => {
  let release, entered;
  const persistenceStarted = new Promise(resolve => { entered = resolve; });
  const ui = new LegacyChatProcessApprovalUi({
    assertOwner() {},
    policy: async () => ({ available: true, trusted: true, permissionMode: "ask", localControls: true }),
    remember: async () => { entered(); await new Promise(resolve => { release = resolve; }); },
  });
  const request = ui.requestPermission({ binding, scope: "tool:test", title: "Test", detail: "", once: false });
  let item;
  for (let n = 0; n < 100 && !item; n++) {
    item = (await ui.list(binding))[0];
    if (!item) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(item);
  const decision = ui.decide(binding, item.id, "approve");
  await persistenceStarted;
  await assert.rejects(ui.decide(binding, item.id, "approve"), /no longer pending/);
  ui.close();
  assert.equal(await request, false);
  release();
  await assert.rejects(decision, /closed/);
});
