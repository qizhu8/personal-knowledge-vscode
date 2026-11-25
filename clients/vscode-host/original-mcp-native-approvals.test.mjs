import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { privateResourcePublicationDigest as digest } from "../../dist/private-resource-publication-contracts.js";

const require = createRequire(import.meta.url), { build } = require("esbuild");
const built = await build({
  entryPoints: [fileURLToPath(new URL("original-mcp-native-approvals.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-native-approval-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ },
      () => ({ path: "native-approval-test-signer", external: true }));
  } }],
});

// UI/signer doubles exercise the production consent handler, not installed authority.
async function fixture() {
  const epoch = randomUUID(), prompts = [], choices = [];
  const signer = { activationId: epoch, identity: { sha256: "a".repeat(64), profileSha256: "b".repeat(64) },
    assertCurrent() {} };
  const vscode = { window: { async showWarningMessage(title, options, ...buttons) {
    prompts.push({ title, detail: JSON.parse(options.detail), buttons });
    return choices.shift();
  } } };
  const module = new Module("native-approvals-test.cjs");
  module.filename = "native-approvals-test.cjs"; module.paths = [];
  module.require = name => name === "vscode" ? vscode : name === "native-approval-test-signer"
    ? { originalMcpNativeSigner: async () => signer } : require(name);
  module._compile(built.outputFiles[0].text, module.filename);
  const approvals = await module.exports.originalMcpNativeApprovals({});
  const brokerId = randomUUID();
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1",
    root: "/isolated-approval-fixture", workspaceId: randomUUID(), epoch,
    profileSha256: signer.identity.profileSha256, planSha256: "c".repeat(64),
    sourceCatalogSha256: "d".repeat(64), configurationSha256: "e".repeat(64),
    authorityId: `native-rpc:${brokerId}`, actorId: "mcp:external", domains: ["mcp-public"] };
  const session = { brokerId, activationId: epoch, epoch, identitySha256: signer.identity.sha256,
    binding: { root: binding.root, workspaceId: binding.workspaceId, planSha256: binding.planSha256,
      catalogSha256: binding.sourceCatalogSha256, profileSha256: binding.profileSha256,
      payloadBuildId: "f".repeat(64), hostEntrySha256: "a".repeat(64) } };
  const handle = (method, request) => approvals.handle({
    method, session, payload: { binding, ...(request ? { request } : {}) },
  }, new AbortController().signal);
  choices.push("Approve this request");
  assert.deepEqual(await handle("admission.approve"), { decision: "approve" });
  return { handle, prompts, choices, binding, session,
    handlePayload: (payload, signal = new AbortController().signal, method = "knowledge.asset.publish") =>
      approvals.handle({ method, session, payload }, signal) };
}

test("nominally read-only Recipe inspection needs exact native consent because it can synchronize execution state", async () => {
  const f = await fixture();
  const request = { operation: "mcp.tool.recipe_run_get", version: 1, tool: "recipe_run_get",
    readOnly: true, arguments: { run_id: "recipe_run_fixture" }, argumentsDigest: "c".repeat(64) };
  f.choices.push("Deny");
  assert.deepEqual(await f.handle("public.approve", request), { decision: "deny" });
  assert.match(f.prompts.at(-1).detail.permission, /synchronize durable execution state/);
  assert.deepEqual(f.prompts.at(-1).detail.arguments, request.arguments);
  f.choices.push("Approve this request");
  assert.deepEqual(await f.handle("public.approve", request), { decision: "approve" });
  assert.equal(f.prompts.length, 3, "Read admission is not a permanent mutation grant.");
});

test("ordinary public reads keep their admitted behavior without adding a mutation-consent dialog", async () => {
  const f = await fixture();
  assert.deepEqual(await f.handle("public.approve", {
    operation: "mcp.tool.get_note", version: 1, tool: "get_note", readOnly: true,
    arguments: { slug: "Entry" }, argumentsDigest: "c".repeat(64),
  }), { decision: "approve" });
  assert.equal(f.prompts.length, 1);
});

function publication(f, resource = "a") {
  const sha256 = resource.repeat(64), subject = {
    root: f.binding.root, workspaceId: f.binding.workspaceId, custodyPlanSha256: f.binding.planSha256,
    catalogSha256: f.binding.sourceCatalogSha256, profileSha256: f.binding.profileSha256,
    actorId: "mcp:external", operationId: randomUUID(), operation: "knowledge.note.update",
    publicRequest: { tool: "update_note", version: 1, argumentsDigest: "a".repeat(64) },
    canonicalArgumentsDigest: "b".repeat(64),
    owner: { area: "notes", id: "synthetic-note", beforePath: "Old/Before.md", afterPath: "New/After.md",
      revision: 1, sha256: "c".repeat(64) },
    resource: { sourcePath: `Private/_assets/${resource}.PNG`, sourceIdentity: "synthetic-source-identity",
      sha256, size: 4, targetPath: `New/After.assets/${sha256.slice(0, 16)}.png` },
    privacySha256: "d".repeat(64), preservePrivateSource: true, oneResourceOneOperation: true,
  };
  const request = { schema: "pkm.private-resource-publication/v1", phase: "publish", subject,
    nativeHostReceiptSha256: digest(f.binding), nativeEpoch: f.session.epoch };
  return { binding: f.binding, defaultDecision: "deny", request, requestSha256: digest(request) };
}

test("private publication always requires its own Deny-first native choice; generic approval and prior resource choices grant nothing", async () => {
  const f = await fixture(), payload = publication(f);
  f.choices.push("Approve this request");
  assert.equal(await f.handlePayload(payload), null);
  assert.deepEqual(f.prompts.at(-1).buttons, ["Deny", "Publish this exact resource once"]);
  assert.equal(f.prompts.at(-1).detail.defaultDecision, "deny");
  f.choices.push("Publish this exact resource once");
  const decision = await f.handlePayload(payload);
  assert.equal(decision.requestSha256, payload.requestSha256);
  assert.equal(decision.operationId, payload.request.subject.operationId);
  assert.equal(decision.epoch, f.session.epoch);
  assert(decision.expiresAtMs > Date.now() && decision.expiresAtMs <= Date.now() + 120000);
  f.choices.push("Deny");
  assert.equal(await f.handlePayload(publication(f, "b")), null);
  assert.equal(f.prompts.length, 4, "Each publication is separate from read admission and previous resource approval.");
});

test("private publication rejects a changed native binding and a late cancelled choice before issuing any decision", async () => {
  const f = await fixture(), payload = publication(f), before = f.prompts.length;
  const changed = structuredClone(payload);
  changed.request.nativeEpoch = randomUUID();
  changed.requestSha256 = digest(changed.request);
  await assert.rejects(f.handlePayload(changed), /PRIVATE_RESOURCE_PUBLICATION_BINDING_MISMATCH/);
  assert.equal(f.prompts.length, before);
  let release;
  f.choices.push(new Promise(resolve => { release = resolve; }));
  const cancelled = new AbortController(), pending = f.handlePayload(payload, cancelled.signal);
  const refused = assert.rejects(pending, /NATIVE_REQUEST_CANCELLED/);
  cancelled.abort(); release("Publish this exact resource once");
  await refused;
});

function trash(f, action) {
  const inventory = [{
    path: "Public/Entry.md", kind: "file", device: "1", inode: "2", mode: 0o600, uid: "1", gid: "1",
    size: "10", mtime: "1", ctime: "1", sha256: "a".repeat(64),
  }];
  const deletedAt = "2026-11-21T00:00:00.000Z", entryId = `${Date.parse(deletedAt)}-0123456789`;
  const subject = {
    root: f.binding.root, workspaceId: f.binding.workspaceId, custodyPlanSha256: f.binding.planSha256,
    catalogSha256: f.binding.sourceCatalogSha256, profileSha256: f.binding.profileSha256,
    actorId: "mcp:external", operationId: randomUUID(), canonicalArgumentsDigest: "a".repeat(64),
    privacySha256: "b".repeat(64), sourceOriginalSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    custodyPredecessorSha256: "c".repeat(64), transitionSha256: "d".repeat(64),
    historyBeforeSha256: null, historyAfterSha256: null, action, operation: `knowledge.trash.${action}`,
    selection: [{
      area: "notes", path: "Public/Entry.md", document: {
        id: "synthetic-note", knowledgeId: "synthetic-note", revision: 1, sha256: "a".repeat(64),
      }, entryId, metadata: { id: entryId, kind: "item", name: "Entry.md", originalPath: "Public/Entry.md", deletedAt },
      metadataSha256: "e".repeat(64), inventory, treeSha256: digest(inventory), scanRevision: "f".repeat(64),
      readOnlyOriginalBucket: false,
    }],
  };
  const request = { schema: "pkm.original-native-trash-request/v1", phase: "execute", subject,
    nativeHostReceiptSha256: digest(f.binding), nativeEpoch: f.session.epoch };
  return { binding: f.binding, defaultDecision: "deny", request, requestSha256: digest(request) };
}

test("Trash list/move/restore require action-specific Deny-first decisions, not ordinary approval or prior permission", async () => {
  const f = await fixture();
  for (const [action, affirmative] of [
    ["list", "Read these exact Trash entries once"],
    ["move", "Move this exact Note to Trash once"],
    ["restore", "Restore this exact Note once"],
  ]) {
    const payload = trash(f, action);
    f.choices.push("Approve this request");
    assert.equal(await f.handlePayload(payload, undefined, "knowledge.trash.approve"), null);
    assert.deepEqual(f.prompts.at(-1).buttons, ["Deny", affirmative]);
    f.choices.push(affirmative);
    const decision = await f.handlePayload(payload, undefined, "knowledge.trash.approve");
    assert.equal(decision.requestSha256, payload.requestSha256);
    assert.equal(decision.operationId, payload.request.subject.operationId);
    assert.equal(decision.epoch, f.session.epoch);
    assert(decision.expiresAtMs > Date.now() && decision.expiresAtMs <= Date.now() + 120000);
    f.choices.push("Deny");
    assert.equal(await f.handlePayload(trash(f, action), undefined, "knowledge.trash.approve"), null);
  }
});

test("Trash rejects changed native epoch and late cancellation before returning a decision", async () => {
  const f = await fixture(), payload = trash(f, "move"), before = f.prompts.length;
  const changed = structuredClone(payload);
  changed.request.nativeEpoch = randomUUID();
  changed.requestSha256 = digest(changed.request);
  await assert.rejects(f.handlePayload(changed, undefined, "knowledge.trash.approve"), /ORIGINAL_TRASH_BINDING_MISMATCH/);
  assert.equal(f.prompts.length, before);
  let release;
  f.choices.push(new Promise(resolve => { release = resolve; }));
  const signal = new AbortController();
  const pending = f.handlePayload(payload, signal.signal, "knowledge.trash.approve");
  const denied = assert.rejects(pending, /NATIVE_REQUEST_CANCELLED/);
  signal.abort();
  release("Move this exact Note to Trash once");
  await denied;
});

function trashV2(f, action, area, phase = "execute") {
  const payload = trash(f, action), subject = payload.request.subject, item = subject.selection[0];
  payload.request.schema = "pkm.original-native-trash-request/v2"; payload.request.phase = phase;
  subject.area = area; item.area = area;
  item.inventory[0].path = `${area}/Public/Entry.md`; item.treeSha256 = digest(item.inventory);
  if (area === "skills") { item.metadata.kind = "skill"; item.metadata.name = "Entry"; }
  if (action === "move") subject.publicRequest = {
    tool: area === "skills" ? "delete_skill" : "delete_paper", version: 1, argumentsDigest: "a".repeat(64),
  };
  payload.requestSha256 = digest(payload.request);
  return payload;
}
test("opaque Script/Prompt v3 producer requires exact area/byte consent and never accepts Markdown identity reinterpretation", async () => {
  const f = await fixture();
  for (const area of ["scripts", "prompts"]) {
    const payload = trashV2(f, "move", area), item = payload.request.subject.selection[0];
    payload.request.schema = "pkm.original-native-trash-request/v3";
    payload.request.subject.publicRequest.tool = "knowledge_file_trash";
    delete item.document;
    item.file = { sha256: "a".repeat(64), size: 10 };
    payload.requestSha256 = digest(payload.request);
    const label = area === "scripts" ? "Script" : "Prompt";
    f.choices.push(`Move this exact ${label} to Trash once`);
    const decision = await f.handlePayload(payload, undefined, "knowledge.trash.approve");
    assert.equal(decision.requestSha256, payload.requestSha256);
    assert.match(f.prompts.at(-1).title, new RegExp(`public ${label}`));
    const changed = structuredClone(payload);
    changed.request.schema = "pkm.original-native-trash-request/v2";
    changed.requestSha256 = digest(changed.request);
    await assert.rejects(f.handlePayload(changed, undefined, "knowledge.trash.approve"));
  }
});
test("Skill/Paper v2 uses separate exact paired-effects choices and phase-specific recovery, never generic approval", async () => {
  const f = await fixture();
  for (const area of ["skills", "papers"]) {
    const name = area === "skills" ? "Skill" : "Paper";
    for (const [action, phase, affirmative] of [
      ["move", "execute", `Move this exact ${name} to Trash once`],
      ["list", "execute", `Read these exact ${name} Trash entries once`],
      ["restore", "execute", `Restore this exact ${name} once`],
      ["move", "recover", `Recover this exact ${name} move once`],
      ["restore", "recover", `Recover this exact ${name} restore once`],
    ]) {
      const payload = trashV2(f, action, area, phase);
      f.choices.push("Approve this request");
      assert.equal(await f.handlePayload(payload, undefined, "knowledge.trash.approve"), null);
      assert.deepEqual(f.prompts.at(-1).buttons, ["Deny", affirmative]);
      assert.match(f.prompts.at(-1).title, new RegExp(`public ${name}`));
      assert.match(f.prompts.at(-1).detail.permission, /paired-resource/);
      assert.equal(f.prompts.at(-1).detail.defaultDecision, "deny");
      f.choices.push(affirmative);
      const decision = await f.handlePayload(payload, undefined, "knowledge.trash.approve");
      assert.equal(decision.requestSha256, payload.requestSha256);
      assert.equal(decision.operationId, payload.request.subject.operationId);
    }
  }
});
test("Skill/Paper v2 unknown schemas, areas, mixed selections, v1 reinterpretation and late cancellation fail before authority", async () => {
  const f = await fixture(), payload = trashV2(f, "move", "skills"), before = f.prompts.length;
  const changes = [
    value => { value.request.schema = "pkm.original-native-trash-request/v9"; },
    value => { value.request.schema = "pkm.original-native-trash-request/v1"; },
    value => { value.request.subject.area = "notes"; },
    value => { value.request.subject.selection[0].area = "papers"; },
    value => { value.request.subject.selection[0].metadata.kind = "item"; },
    value => { value.request.subject.publicRequest.tool = "delete_paper"; },
    value => { value.request.subject.selection[0].readOnlyOriginalBucket = true; },
  ];
  for (const change of changes) {
    const changed = structuredClone(payload); change(changed); changed.requestSha256 = digest(changed.request);
    await assert.rejects(f.handlePayload(changed, undefined, "knowledge.trash.approve"));
    assert.equal(f.prompts.length, before);
  }
  let release;
  f.choices.push(new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const pending = f.handlePayload(payload, controller.signal, "knowledge.trash.approve");
  const rejected = assert.rejects(pending, /NATIVE_REQUEST_CANCELLED/);
  controller.abort(); release("Move this exact Skill to Trash once"); await rejected;
});

function genesis(f, phase) {
  const operationId = randomUUID(), descriptorSha256 = "c".repeat(64), backingSha256 = "d".repeat(64);
  const target = sha256 => phase === "activate-source" ? { state: "present", sha256 } : { state: "absent" };
  const request = {
    schema: "pkm.original-mcp-todo-genesis-request/v1", phase, operation: "mcp.tool.todo_board_create",
    operationId, actorId: "mcp:external", root: f.binding.root, workspaceId: f.binding.workspaceId,
    profileSha256: f.binding.profileSha256, custodyPlanSha256: f.binding.planSha256,
    catalogSha256: f.binding.sourceCatalogSha256, nativeHostReceiptSha256: digest(f.binding), nativeEpoch: f.session.epoch,
    arguments: { title: "Board", category: "" }, argumentsSha256: digest({ title: "Board", category: "" }),
    privacySha256: "b".repeat(64),
    selection: {
      boardSlug: "Board", sourceId: randomUUID(), documentId: `board-${operationId}`,
      knowledgeId: `knowledge_${"a".repeat(24)}`, notePath: "notes/Board.md", pairPath: "notes/Board.assets",
      backingPath: "notes/Board.assets/pkm-todo-board.json", canonicalBoardPath: ".pkm-next-todo/Board/pkm-todo-board.json",
      descriptorSha256, backingSha256, layout: "pkm.original-todo-genesis/v1",
      expectedBefore: {
        note: target(descriptorSha256), pair: target("e".repeat(64)), backing: target(backingSha256),
        canonicalBoard: target("e".repeat(64)), canonicalDirectory: target("e".repeat(64)),
        sourceIndex: phase === "activate-source" ? "present" : "absent",
      },
      ancestors: [".", "notes"].map(path => ({ path, device: "1", inode: "2", uid: "1", mode: 0o700 })),
      managedAncestors: [phase === "create" ? { path: ".pkm-next-todo", state: "absent" } : {
        path: ".pkm-next-todo", state: "present",
        identity: { path: ".pkm-next-todo", device: "1", inode: "3", uid: "1", mode: 0o700 },
      }],
    },
    noExecution: true, noWorkerEnrollment: true, noReviewerDelegation: true,
  };
  return { binding: f.binding, defaultDecision: "deny", request, requestSha256: digest(request) };
}

test("Board genesis requires fresh phase-specific Deny-first consent without granting workers, execution or overwrite", async () => {
  const f = await fixture();
  for (const [phase, affirmative] of [
    ["create", "Create this exact Board once"],
    ["recover", "Recover this exact Board once"],
    ["activate-source", "Activate this exact Board source"],
  ]) {
    const payload = genesis(f, phase);
    f.choices.push("Approve this request");
    assert.equal(await f.handlePayload(payload, undefined, "todo.board.create.approve"), null);
    assert.deepEqual(f.prompts.at(-1).buttons, ["Deny", affirmative]);
    f.choices.push(affirmative);
    const decision = await f.handlePayload(payload, undefined, "todo.board.create.approve");
    assert.equal(decision.requestSha256, payload.requestSha256);
    assert.equal(decision.operationId, payload.request.operationId);
    assert.equal(decision.epoch, f.session.epoch);
    assert(decision.expiresAtMs > Date.now() && decision.expiresAtMs <= Date.now() + 120000);
    f.choices.push("Deny");
    assert.equal(await f.handlePayload(genesis(f, phase), undefined, "todo.board.create.approve"), null);
  }
});

test("Board genesis rejects changed selection and late cancellation before issuing a decision", async () => {
  const f = await fixture(), payload = genesis(f, "create"), before = f.prompts.length;
  const changed = structuredClone(payload);
  changed.request.selection.notePath = "notes/Other.md";
  changed.requestSha256 = digest(changed.request);
  await assert.rejects(f.handlePayload(changed, undefined, "todo.board.create.approve"), /TODO_GENESIS_SELECTION_MISMATCH/);
  assert.equal(f.prompts.length, before);
  let release;
  f.choices.push(new Promise(resolve => { release = resolve; }));
  const signal = new AbortController();
  const pending = f.handlePayload(payload, signal.signal, "todo.board.create.approve");
  const denied = assert.rejects(pending, /NATIVE_REQUEST_CANCELLED/);
  signal.abort();
  release("Create this exact Board once");
  await denied;
});
