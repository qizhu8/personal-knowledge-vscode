import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { originalDigest } from "../../dist/domain/action-compiler-validation.js";

const require = createRequire(import.meta.url), { build } = require("esbuild");
const built = await build({ entryPoints: [resolve("clients/vscode-host/original-mcp-native-action-program.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-native-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "program-signer-double", external: true }));
  } }] });
// UI/signer doubles exercise the concrete native leaf, not installed qualification.
async function fixture() {
  const choices = [], prompts = [], controller = new AbortController(), epoch = randomUUID();
  const session = { brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "1".repeat(64),
    binding: { root: "/isolated/program-fixture", workspaceId: randomUUID(), planSha256: "2".repeat(64),
      profileSha256: "3".repeat(64), catalogSha256: "4".repeat(64), payloadBuildId: "5".repeat(64), hostEntrySha256: "6".repeat(64) } };
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256,
    signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } };
  let admission = { decision: { root: session.binding.root, workspaceId: session.binding.workspaceId, actorId: "mcp:external",
    profileSha256: session.binding.profileSha256, epoch, capsuleSha256: "7".repeat(64), expiresAtMs: Date.now() + 120000, noExecution: true },
    sources: new Map([["fixture.program", { actionId: "fixture.program", contentHash: "8".repeat(64),
      implementationSha256: "9".repeat(64), effects: ["pure"] }]]) };
  const request = { schema: "pkm.original-mcp-local-program-request/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, actorId: "mcp:external", profileSha256: session.binding.profileSha256,
    epoch, capsuleSha256: "7".repeat(64), sourceReceiptSha256: "a".repeat(64), nativeHostReceiptSha256: "b".repeat(64),
    runId: `action_run_${randomUUID().replaceAll("-", "")}`, request: { action_id: "fixture.program", content_hash: "8".repeat(64),
      inputs: { value: "exact fixture" }, idempotency_key: "program", trigger: null, project_id: null },
    implementationSha256: "9".repeat(64), inputSha256: originalDigest({ value: "exact fixture" }), deadline: Date.now() + 60000,
    executable: { path: "/pinned/runtime", sha256: "c".repeat(64), bytes: 42, identity: "independent-executable-pin" },
    cwd: { path: "/isolated/program-fixture/action-sources", device: "1", inode: "2" }, arguments: ["exact-program.mjs"],
    sources: [{ path: "action-sources/exact-program.mjs", sha256: "d".repeat(64), bytes: 123 }],
    effects: ["pure"], authority: { scope: "exact-local-direct-child/v1", shell: false, inheritedEnvironment: false,
      credentials: false, network: false, descendants: false, build: false, automaticReplay: false } };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`, epoch,
    actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "e".repeat(64) };
  const load = Module._load;
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "program-signer-double") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return { workspace: { isTrusted: true }, window: {
        async showWarningMessage(title, options) { prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift(); },
      } };
      return load.call(this, id, ...args);
    };
    const filename = resolve("clients/vscode-host", `.program-memory-${randomUUID()}.cjs`), module = new Module(filename);
    module.filename = filename; module.paths = Module._nodeModulePaths(resolve("clients/vscode-host"));
    module._compile(built.outputFiles[0].text, filename); api = module.exports;
  } finally { Module._load = load; }
  const approver = await api.createOriginalMcpNativeActionProgramApprover({}, {
    session, signal: controller.signal, assertCurrent() {}, sourceAdmission: () => admission,
  });
  return { request, binding, choices, prompts, controller, revokeSource() { admission = undefined; },
    handle: (payload = { binding, request }, id = randomUUID()) => approver.handle(payload, id, new AbortController().signal) };
}

test("noExecution source admission alone cannot synthesize local process consent; exact program approval creates only its typed bound decision", async () => {
  const f = await fixture();
  f.choices.push("Deny"); assert.equal(await f.handle(), null);
  f.choices.push("Run this exact local program");
  const decision = await f.handle();
  assert.equal(decision.requestSha256, originalDigest(f.request));
  assert.equal(decision.executableSha256, f.request.executable.sha256);
  assert.equal(decision.runId, f.request.runId); assert.equal(decision.scope, "exact-local-direct-child/v1");
  assert.deepEqual(f.prompts.at(-1).detail.request, f.request);
  assert.match(f.prompts.at(-1).detail.limitation, /not an OS filesystem\/network sandbox/);
  const id = randomUUID(); f.choices.push("Run this exact local program"); await f.handle(undefined, id);
  await assert.rejects(f.handle(undefined, id), /REQUEST_REPLAY/);
});

test("program input/epoch mismatches, native revocation and changed source discard consent before any usable typed program decision", async () => {
  const f = await fixture(), changed = structuredClone(f.request);
  changed.request.inputs.value = "not the approved exact input";
  await assert.rejects(f.handle({ binding: f.binding, request: changed }));
  await assert.rejects(f.handle({ binding: f.binding, request: { ...f.request, epoch: randomUUID() } }), /BINDING_MISMATCH/);
  assert.equal(f.prompts.length, 0);
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = f.handle(); f.revokeSource(); answer("Run this exact local program");
  await assert.rejects(pending, /SOURCE_CHANGED/);
  const other = await fixture(); let late;
  other.choices.push(new Promise(resolve => { late = resolve; }));
  const revoked = other.handle(); other.controller.abort();
  await assert.rejects(revoked, /CANCELLED|aborted/i); late("Run this exact local program");
});
