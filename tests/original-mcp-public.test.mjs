import assert from "node:assert/strict";
import { createHash, randomUUID, generateKeyPairSync, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot, rollbackOriginalMcpRoot,
  acquireOriginalMcpRootFence, validateOriginalMcpWorkspace } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest, originalMcpRequestDigest } from "../dist/original-mcp-native-host.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createNativePublicFacade } from "../dist/native-public-mcp.js";
import { verifyOriginalMcpImplementationReadiness } from "../dist/original-mcp-public.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { admitLegacyRetrievalModel, verifyLegacyRetrievalModels } from "../dist/legacy-retrieval-model.js";
import { builtinActionDefinitions, originalDefinitionValue, originalDigest, componentDigest } from "../dist/domain/action-compiler-validation.js";
import { pureComponentAdapter } from "../dist/action-pure-components.js";
import { NativeCurrentProcessDiagnosticWriter, readNativeCurrentProcessDiagnostics } from "../dist/native-current-process-diagnostics.js";
import { admitLegacyActionPackage } from "../dist/legacy-action-catalog.js";
import { admitLegacyActionArtifactPath } from "../dist/legacy-action-artifacts.js";
import { decodeLegacyActionPackage } from "../dist/legacy-action-package.js";
import { actionModuleFileBytes, nativeActionModuleSourceProtocol } from "../dist/action-module-bytes.js";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { readNativePrivateCosmosBinding } from "../dist/original-mcp-action-maintenance.js";
import { originalSkillMaintenance } from "./legacy-skill-maintenance-oracle.mjs";
import { signedActionPackageClient } from "./fixtures/original-mcp-action-package-native-client.mjs";
import { createOriginalMcpNativeRequestPolicy } from "../dist/original-mcp-native-request.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = originalPublicMcpContracts();
const target = { acceptedScope: "preserve-existing-mcp/v1", catalogSha256: source.provenance.metadataSha256,
  catalogRevision: source.provenance.producer.revision };
const actor = { id: "mcp:external", canWrite: true };
async function fixture(t, nativeAction = false, options = {}) {
  if (options.source && options.authorize)
    options = { subscriptionPolicy: { subscriptionSource: options.source, authorizeSubscriptionRead: options.authorize } };
  const directory = resolve("tests", `.original-public-${randomUUID()}`);
  const root = join(directory, "root"), cleanup = [];
  await mkdir(directory, { mode: 0o700 });
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const path of ["notes/Private", "scripts/Private", "skills/Private", ".pkm/state/actions", "packages/retrieval-models"])
    await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nReliable public evidence alpha model proof.\n", { mode: 0o600 });
  await writeFile(join(root, "notes/Private/Secret.md"), "Never publish the private note.", { mode: 0o600 });
  await writeFile(join(root, "scripts/public.py"), "print('public-code')\n", { mode: 0o600 });
  await writeFile(join(root, "scripts/Private/secret.py"), "private_code_not_published = True\n", { mode: 0o600 });
  await writeFile(join(root, "skills/Private/Secret.md"), "---\nname: Secret\n---\nPrivate Skill stays in custody.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"], scripts: ["Private"], skills: ["Private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"configured":"not inherited"}', { mode: 0o600 });
  if (options.historicalDiagnostics) {
    const directory = join(root, ".pkm/state/diagnostics/mcp");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.0000000000.jsonl"),
      JSON.stringify({ schema: "pkm.diagnostic/v1", writerId: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        pid: 1, event: "runtime.started", component: "unified-mcp", parentPid: 1,
        at: "2020-01-01T00:00:00+00:00", dropped: 0 }) + "\n", { mode: 0o600 });
  }
  const oldModels = join(root, "packages/retrieval-models/unqualified-original-state.json");
  await writeFile(oldModels, '{"preserved":"not a native model admission"}', { mode: 0o600 });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "fixture-operator", profileSha256: hash("native-profile"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  const raw = nativeAction ? builtinActionDefinitions().get("core.cast.string-to-float") : undefined;
  const action = raw ? pureComponentAdapter("action:core.cast.string-to-float", originalDigest(raw.output_schema)) : undefined;
  if (nativeAction) assert(action);
  let current = true, effectsAllowed = true;
  let registeredHost, registeredClient;
  const approvedActions = new Map(), effects = [];
  const opened = await openOriginalMcpRoot(plan, nativeAction || options.trustedPrograms || options.registeredNative ? { prepareNative: async storage => {
    if (options.registeredNative) {
      registeredClient = await signedActionPackageClient(storage, plan, target.catalogSha256);
      registeredHost = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(registeredClient.session));
      const { createOriginalMcpRegisteredActionHost } = await import("../dist/original-mcp-registered-action-host.js");
      return { hostServices: { action: await createOriginalMcpRegisteredActionHost(storage, registeredHost, registeredClient.session) } };
    }
    const workspaceId = await storage.workspaceId(), epoch = randomUUID();
    const authorized = binding => current && effectsAllowed && binding.actorId === actor.id
      && binding.workspaceId === workspaceId
      && approvedActions.get(binding.actionId) === originalDefinitionValue(binding.definition).content_hash;
    return { hostServices: { action: options.trustedPrograms ? {
      automaticTrusted: {
        current: () => ({ actorId: actor.id, workspaceId, trustedWorkspace: current, epoch }),
        revoke() { current = false; },
        async authorize(id, digest, expectedEpoch) { return current && expectedEpoch === epoch && approvedActions.get(id) === digest; },
      },
      async approveManagedArtifact(binding, artifact) { effects.push({ binding, artifact }); return authorized(binding); },
      process: { commands: [], trustedPrograms: {
        async approve(binding) { effects.push({ binding }); return authorized(binding); },
      } },
    } : { adapters: { "action:core.cast.string-to-float": action } } } };
  } } : {}); cleanup.push(() => opened.owner.close());
  if (options.registeredNative) await opened.owner.ensureFull();
  const lifetime = new AbortController(), approvals = [];
  let allowed = true, modelCalls = 0, approvalHook = () => {};
  const policy = {
    profileSha256: plan.profileSha256, sourceCatalogSha256: target.catalogSha256,
    authorityId: "fixture-native-profile", epoch: "fixture-epoch", signal: lifetime.signal,
    assertCurrent() { if (!current) throw new Error("Native public fixture epoch revoked."); }, async authorizeAdmission() { return true; },
    async authorizePublic(binding) { approvals.push(binding); approvalHook(); return allowed; },
    ...options.subscriptionPolicy,
    models: {
      configuration: { aiEndpoint: "https://native.invalid/v1", aiModel: "not-invoked" },
      registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { modelCalls++; throw new Error("No model transport selected."); } },
    },
  };
  const signed = registeredClient ?? (options.signedPackages
    ? await signedActionPackageClient(opened.storage, plan, target.catalogSha256) : undefined);
  if (signed) Object.assign(policy, createOriginalMcpNativeRequestPolicy(signed.session), { models: policy.models });
  const host = registeredHost ?? await createOriginalMcpNativeHost(opened.storage, policy);
  const principal = { ...actor, canWrite: options.canWrite ?? true };
  const backend = createNativePublicOwnerBackend(opened.owner, { actor: principal, originalMcpHost: host });
  cleanup.push(() => backend.close());
  return { directory, root, plan, opened, host, backend, approvals, cleanup, oldModels, policy, lifetime, principal, effects, signed,
    approveAction: (id, digest) => approvedActions.set(id, digest), setEffectsAllowed: value => { effectsAllowed = value; },
    builtin: raw ? originalDefinitionValue(raw) : undefined,
    setApprovalHook: value => { approvalHook = value; },
    setAllowed: value => { allowed = value; }, setCurrent: value => { current = value; }, modelCalls: () => modelCalls };
}
const original = (backend, tool, args) => backend.invoke("original_mcp_public", { tool, arguments: args });
async function controlledLocalPython(directory) {
  const path = join(directory, "python3");
  await writeFile(path, await readFile(await realpath("/usr/bin/python3")), { mode: 0o700 });
  return path;
}

test("public Skill sanitized overwrite preserves destination identity and owned resources", async t => {
  const f = await fixture(t);
  await original(f.backend, "add_skill", { name: "Skill", content: "Original Skill", category: "Folder" });
  const path = join(f.root, "skills/Folder/Skill.md");
  const before = await readFile(path, "utf8");
  await mkdir(join(f.root, "skills/Folder/Skill.assets"));
  await writeFile(join(f.root, "skills/Folder/Skill.assets/proof.bin"), Buffer.from([0, 255, 128]));
  const response = await original(f.backend, "add_skill", { name: "Skill?", content: "Sanitized successor", category: "Folder" });
  assert.deepEqual(JSON.parse(response.content[0].text), { ok: true, name: "Skill?" });
  const after = await readFile(path, "utf8");
  assert.equal(/^knowledgeId: (.+)$/m.exec(after)[1], /^knowledgeId: (.+)$/m.exec(before)[1]);
  assert.match(after, /revision: 2/);
  assert.match(after, /Sanitized successor/);
  assert.deepEqual(await readFile(join(f.root, "skills/Folder/Skill.assets/proof.bin")), Buffer.from([0, 255, 128]));
});

test("public Skill sanitized overwrite preserves private custody and ambiguous metadata identities", async t => {
  const f = await fixture(t);
  const secret = join(f.root, "skills/Private/Secret.md"), before = await readFile(secret, "utf8");
  await assert.rejects(original(f.backend, "add_skill", {
    name: "Secret?", category: "Private", content: "Never write private custody",
  }), /ACCESS_DENIED|private|archive/i);
  assert.equal(await readFile(secret, "utf8"), before);
  await writeFile(join(f.root, "skills/One.md"), "---\nname: Duplicate\n---\nFirst identity.\n", { mode: 0o600 });
  await writeFile(join(f.root, "skills/Two.md"), "---\nname: Duplicate\n---\nSecond identity.\n", { mode: 0o600 });
  await assert.rejects(original(f.backend, "add_skill", { name: "Duplicate", content: "Must not guess" }), /ambiguous/);
  assert.match(await readFile(join(f.root, "skills/One.md"), "utf8"), /First identity/);
  assert.match(await readFile(join(f.root, "skills/Two.md"), "utf8"), /Second identity/);
});

test("public Skill advisory feedback and proposals use fresh native authority without formal mutation", async t => {
  const f = await fixture(t);
  await original(f.backend, "add_skill", { name: "Evidence Skill", content: "Formal immutable evidence" });
  const path = join(f.root, "skills/Evidence Skill.md"), before = await readFile(path, "utf8");
  const feedback = { task: "Private task never retained verbatim", used_skills: ["Evidence Skill"], outcome: "success" };
  const response = await original(f.backend, "skill_feedback", feedback);
  assert.equal(JSON.parse(response.content[0].text).ok, true);
  const raw = await readFile(join(f.root, "_feedback/skill-usage.jsonl"), "utf8");
  const entry = JSON.parse(raw);
  assert.equal(entry.task_hash, hash(feedback.task));
  assert.doesNotMatch(raw, /Private task never retained verbatim/);
  const oracleRoot = join(f.directory, "independent-original");
  await mkdir(join(oracleRoot, "skills"), { recursive: true });
  await writeFile(join(oracleRoot, "skills/Evidence.md"), before);
  const oracle = originalSkillMaintenance({ root: oracleRoot, tool: "skill_feedback", args: feedback,
    uuid: entry.id, now: entry.created });
  assert.equal(response.content[0].text, oracle.text);
  assert.equal(raw, oracle.artifacts["_feedback/skill-usage.jsonl"]);
  const proposal = await original(f.backend, "propose_skill_update", {
    skill_id: "Evidence Skill", base_hash: "stale-base", reason: "Review only", proposed_content: "Advisory successor",
  });
  const value = JSON.parse(proposal.content[0].text);
  assert.equal(value.ok, true); assert.equal(value.conflict, true);
  const proposalRaw = await readFile(value.proposal_path, "utf8");
  assert.match(proposalRaw, /Advisory successor/);
  const currentHash = JSON.parse(/^current_hash: (.+)$/m.exec(proposalRaw)[1]);
  const fresh = JSON.parse((await original(f.backend, "propose_skill_update", {
    skill_id: "Evidence Skill", base_hash: currentHash, reason: "Fresh advisory",
  })).content[0].text);
  assert.equal(fresh.ok, true); assert.equal(fresh.conflict, false);
  const missing = JSON.parse((await original(f.backend, "propose_skill_update", {
    skill_id: "missing", base_hash: currentHash, reason: "No invented source",
  })).content[0].text);
  assert.equal(missing.error, "Skill not found");
  const hidden = JSON.parse((await original(f.backend, "propose_skill_update", {
    skill_id: "Secret", base_hash: "", reason: "Never borrow private source authority",
  })).content[0].text);
  assert.equal(hidden.error, "Skill not found");
  assert.equal(await readFile(path, "utf8"), before);
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "skill_feedback", feedback), { code: "ACCESS_DENIED" });
  assert.equal(await readFile(join(f.root, "_feedback/skill-usage.jsonl"), "utf8"), raw);
  assert.equal(f.modelCalls(), 0);
});

for (const race of ["source-edit", "authority-revocation"])
test(`public Skill advisory ${race} during planning publishes no receipt or proposal`, async t => {
  const f = await fixture(t);
  await original(f.backend, "add_skill", { name: "Evidence", content: "Before planning" });
  const path = join(f.root, "skills/Evidence.md"), before = await readFile(path, "utf8");
  const spawn = childProcess.spawn;
  try {
    childProcess.spawn = (...args) => {
      const child = spawn(...args);
      if (args[1].some(value => String(value).endsWith("legacy-knowledge-mcp.py")))
        child.once("close", () => {
          if (race === "source-edit") writeFileSync(path, before + "Concurrent external edit.\n");
          else f.lifetime.abort();
        });
      return child;
    };
    syncBuiltinESMExports();
    await assert.rejects(original(f.backend, "propose_skill_update", {
      skill_id: "Evidence", base_hash: "", reason: "Do not publish stale authority",
    }), race === "source-edit" ? /source changed/ : /abort|authority/i);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  await assert.rejects(lstat(join(f.root, "_proposals")), { code: "ENOENT" });
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='legacy_skill_maintenance_receipts'").get().n, 0); }
  finally { db.close(); }
  assert.equal(await readFile(path, "utf8"), race === "source-edit" ? before + "Concurrent external edit.\n" : before);
});

function subscriptionProducer(github = false) {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const repository = "https://github.com/fixture/public", branch = "main";
  const nodeId = github ? `github-${hash(repository).slice(0, 24)}` : hash(publicKey);
  const shareId = github ? `branch-${hash(`${repository}\n${branch}`).slice(0, 24)}` : "fresh-public";
  const endpoint = "http://127.0.0.1:23003";
  const payload = { protocol: "pkmshare:v1", nodeId, shareId, endpoint, publicKey,
    publisher: "Local admitted provider", publisherUser: "local-source", publisherHost: "fixture", secretProtected: false };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const magicLink = `pkmshare:v1:${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url")}`;
  const pin = (path, raw) => { const bytes = Buffer.from(raw); return { path, bytes, size: bytes.length, sha256: hash(bytes) }; };
  const prefix = `cache/${nodeId}/${shareId}`;
  const content = "Fresh authorized public subscription evidence.";
  const collectionHash = `sha256:${hash(content)}`;
  const member = { id: "fresh-member", nodeId, shareId, endpoint, publicKey, magicLink,
    alias: "Current provider", priority: "high", publisher: payload.publisher, publisherUser: payload.publisherUser,
    publisherHost: payload.publisherHost, revision: 1, collectionHash, topics: [], tags: [], counts: { notes: 1 },
    itemCount: 1, etag: "fresh", status: "current", brokerName: "Current provider" };
  let current = { head: hash("admitted-current-membership"), state: { schema: 1, nodeId: hash("local"), shares: [], subscriptions: [member] },
    directories: [], files: [
      pin(`${prefix}/_subscription.json`, JSON.stringify({ subscriptionId: member.id, nodeId, shareId, revision: 1, collectionHash })),
      pin(`${prefix}/content/notes/Public.md`, content),
      pin(`${prefix}/content/notes/Public.md.pkm-source.json`, JSON.stringify({ nodeId, shareId, revision: 1,
        sourceSha256: hash(content), privateKey: "never-project", history: "never-project" })),
    ] };
  if (github) {
    member.publicKey = "";
    member.source = { type: "github", repository: "https://github.com/fixture/public", branch: "main", commit: "a".repeat(40) };
    member.endpoint = member.source.repository; member.collectionHash = member.source.commit;
    current.files[0] = pin(`${prefix}/_subscription.json`, JSON.stringify({ id: member.id, nodeId, shareId,
      source: member.source, alias: member.alias, priority: member.priority, publisher: member.publisher, endpoint: member.endpoint, syncedAt: "fresh" }));
    current.files[2] = pin(`${prefix}/content/notes/Public.md.pkm-source.json`, JSON.stringify({
      repository: member.source.repository, branch: member.source.branch, commit: member.source.commit,
      remotePath: "Public.md", brokerName: member.brokerName, publisherUser: member.publisherUser, publisherHost: member.publisherHost }));
    current.files.push(pin(`${prefix}/summary.json`, JSON.stringify({ revision: member.revision, collectionHash: member.collectionHash })));
  }
  let revoked = false, expired = false, changeOnApproval;
  const digest = value => hash(JSON.stringify(value));
  const proof = value => sign(null, Buffer.from(digest(value)), keys.privateKey);
  let admission = proof(current);
  const check = () => {
    if (revoked || !verify(null, Buffer.from(digest(current)), publicKey, admission)) throw Error("Source revoked.");
  };
  return { nodeId, shareId,
    source: { async capture() { check(); return structuredClone(current); }, assertCurrent(_binding, head) { check(); assert.equal(head, current.head); } },
    async authorize({ request }) {
      check();
      const { originalMcpRequestDigest } = await import("../dist/original-mcp-native-host.js");
      const decision = { actorId: "mcp:external", sourceSha256: originalMcpRequestDigest(request.source),
        argumentsSha256: originalMcpRequestDigest(request.arguments), decisionId: randomUUID(),
        expiresAtMs: expired ? Date.now() - 1 : Date.now() + 60000 };
      if (changeOnApproval) { changeOnApproval(current); admission = proof(current); }
      return decision;
    },
    revoke() { revoked = true; }, expire() { expired = true; },
    mutateOnApproval(change) { changeOnApproval = change; },
  };
}

test("fresh admitted current Subscription producer reaches the actual public list search get and path facade", async t => {
  const producer = subscriptionProducer(), f = await fixture(t, false, producer);
  const facade = createNativePublicFacade(f.backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: f.directory, generation: "fixture", version: "0.1.0", components: {} }, closeBackend: async () => {} });
  await writeFile(join(f.directory, "active-generation.json"), '{"schema":"pkm.mcp.lifecycle/v1","generation":"fixture"}');
  const call = (tool, args) => facade.invoke(source.contracts.find(item => item.transportName === tool).readOnly
    ? "capability_read" : "capability_call", { operation: `mcp.tool.${tool}`, version: 1, arguments: args });
  const list = await call("list_subscriptions", {});
  assert.match(JSON.stringify(list), /Current provider/);
  const search = await call("search_subscribed_content", { query: "evidence", limit: 1 });
  assert.match(JSON.stringify(search), /Public.md/);
  const selector = { node_id: producer.nodeId, share_id: producer.shareId, content_type: "notes", path: "Public.md" };
  const direct = await call("get_subscribed_content", selector);
  assert.match(JSON.stringify(direct), /Fresh authorized public/);
  assert.doesNotMatch(JSON.stringify(direct), /never-project|privateKey|history|magicLink|endpoint/);
  assert.match(JSON.stringify(await call("get_subscribed_content_by_path", {
    pkm_path: `pkm://subscriptions/${producer.nodeId}/${producer.shareId}/notes/Public.md`,
  })), /Fresh authorized public/);
  await assert.rejects(call("get_subscribed_content", { ...selector, path: "../Public.md" }));
  await assert.rejects(call("search_subscribed_content", { query: "evidence", limit: 101 }));
  await facade.close();
});

test("current Subscription public source refuses expiry revocation and mid-call member key corpus or epoch changes", async t => {
  for (const change of ["expired", "revoked", "key", "corpus", "membership", "epoch"]) {
    await t.test(change, async st => {
      const producer = subscriptionProducer(), f = await fixture(st, false, producer);
      if (change === "expired") producer.expire();
      else if (change === "revoked") producer.revoke();
      else producer.mutateOnApproval(view => {
        if (change === "key") view.state.subscriptions[0].publicKey = "changed";
        else if (change === "corpus") view.files[1].bytes = Buffer.from("changed corpus");
        else if (change === "membership") view.state.subscriptions = [];
        else view.head = hash("changed-current-epoch");
      });
      await assert.rejects(original(f.backend, "list_subscriptions", {}));
    });
  }
});

test("current native GitHub Subscription source uses exact repository branch commit and original provenance shapes", async t => {
  const producer = subscriptionProducer(true), f = await fixture(t, false, producer);
  const response = await original(f.backend, "get_subscribed_content", {
    node_id: producer.nodeId, share_id: producer.shareId, content_type: "notes", path: "Public.md",
  });
  assert.match(JSON.stringify(response), /Fresh authorized public/);
  assert.match(JSON.stringify(response), /repository|commit/);
});

test("public native profile approval alone never admits Subscription caches or source reads", async t => {
  const f = await fixture(t);
  await assert.rejects(original(f.backend, "list_subscriptions", {}), { code: "ACCESS_DENIED" });
});

test("fresh native public diagnostics exposes the real current writer, not archived telemetry", async t => {
  const f = await fixture(t, false, { historicalDiagnostics: true });
  const facade = createNativePublicFacade(f.backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: f.directory, generation: "fixture-diagnostics", version: "0.1.0", components: {} },
    closeBackend: async () => {} });
  await writeFile(join(f.directory, "active-generation.json"),
    '{"schema":"pkm.mcp.lifecycle/v1","generation":"fixture-diagnostics"}', { mode: 0o600 });
  const response = await facade.invoke("capability_read", {
    operation: "mcp.tool.diagnostics_latest", version: 1, arguments: {},
  });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const value = response.structuredContent;
  assert.equal(value.ok, true);
  assert.match(value.writer_id, new RegExp(`^${process.pid}-[a-f0-9]{32}$`));
  assert(value.records.length > 0, "A fresh native startup must have an actual writer event.");
  assert(value.records.some(row => row.event === "runtime.started"));
  assert.deepEqual(Object.keys(value).sort(),
    ["ok", "writer_id", "directory", "max_rows", "dropped_records", "records"].sort());
  assert.equal(value.max_rows, 100_000);
  assert.equal(value.directory, "native:current-process");
  const secret = "DIAGNOSTICS_SECRET_SENTINEL:Bearer-token:user-input:path:/private/identifier";
  await original(f.backend, "get_note", { slug: secret }).catch(() => {});
  const calls = await Promise.all(Array.from({ length: 60 }, () => facade.invoke("capability_read", {
    operation: "mcp.tool.diagnostics_latest", version: 1, arguments: { limit: 1000 },
  })));
  for (const reply of calls) {
    const rows = reply.structuredContent.records;
    assert(rows.length > 0 && rows.length <= 1000);
    assert.equal(new Set(rows.map(row => row.recordIndex)).size, rows.length);
    assert(rows.every((row, index) => row.writerId === value.writer_id && row.pid === process.pid
      && (!index || row.recordIndex > rows[index - 1].recordIndex)));
    assert.doesNotMatch(JSON.stringify(reply), /DIAGNOSTICS_SECRET_SENTINEL|private\/identifier|fixture-native-profile|fixture-epoch/);
    assert.doesNotMatch(JSON.stringify(reply), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|2020-01-01/);
  }
  const bounded = await facade.invoke("capability_read", {
    operation: "mcp.tool.diagnostics_latest", version: 1, arguments: { limit: 1 },
  });
  assert.equal(bounded.structuredContent.records.length, 1);
  for (const limit of [0, 1001, 1.5, "5"]) {
    await assert.rejects(original(f.backend, "diagnostics_latest", { limit }), { code: "INVALID_ARGUMENT" });
  }
  const defaults = await original(f.backend, "diagnostics_latest", {});
  assert.equal(defaults.structuredContent.records.length, 100);
  await assert.rejects(original(f.backend, "diagnostics_latest", { limit: 1, directory: "/private" }));
  await facade.close();
});

test("current native diagnostics is read-only, exact-context authorized and revoked before publication", async t => {
  const f = await fixture(t, false, { canWrite: false });
  const read = await original(f.backend, "diagnostics_latest", { limit: 1 });
  assert.equal(read.structuredContent.ok, true);
  assert.equal(f.approvals.at(-1).request.readOnly, true);
  assert.throws(() => readNativeCurrentProcessDiagnostics(f.opened.storage, f.host, { limit: 1 }), { code: "ACCESS_DENIED" });
  assert.throws(() => readNativeCurrentProcessDiagnostics(f.opened.storage, { ...f.host }, { limit: 1 }), { code: "ACCESS_DENIED" });
  await assert.rejects(original(f.backend, "update_note", { slug: "Entry", content: "forbidden" }), { code: "ACCESS_DENIED" });
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "diagnostics_latest", {}), { code: "ACCESS_DENIED" });
  f.setAllowed(true);
  f.setApprovalHook(() => f.lifetime.abort());
  await assert.rejects(original(f.backend, "diagnostics_latest", {}), { code: "ACCESS_DENIED" });
});

test("actual public diagnostics revocation after writer snapshot never publishes the response", async t => {
  const f = await fixture(t);
  const latest = NativeCurrentProcessDiagnosticWriter.prototype.latest;
  t.mock.method(NativeCurrentProcessDiagnosticWriter.prototype, "latest", function (limit) {
    const value = latest.call(this, limit);
    assert(value.records.length > 0);
    f.lifetime.abort();
    return value;
  });
  await assert.rejects(original(f.backend, "diagnostics_latest", {}), { code: "ACCESS_DENIED" });
});

test("native diagnostics restart has a fresh writer and no retained prior writer rows", async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 4 }, () => original(f.backend, "diagnostics_latest", {})));
  const before = (await original(f.backend, "diagnostics_latest", {})).structuredContent;
  await f.backend.close(); await f.host.close();
  const host = await createOriginalMcpNativeHost(f.opened.storage, {
    ...f.policy, epoch: randomUUID(), signal: new AbortController().signal,
  });
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor: f.principal, originalMcpHost: host });
  f.cleanup.push(() => backend.close());
  const after = (await original(backend, "diagnostics_latest", {})).structuredContent;
  assert.notEqual(after.writer_id, before.writer_id);
  assert.deepEqual(after.records.map(row => row.event), ["runtime.started", "mcp.call.started"]);
  assert.deepEqual(after.records.map(row => row.recordIndex), [1, 2]);
  assert(after.records.every(row => row.writerId === after.writer_id));
  assert.throws(() => readNativeCurrentProcessDiagnostics(f.opened.storage, f.host, {}), { code: "ACCESS_DENIED" });
  const planPath = join(f.directory, "diagnostic-restart-plan.json");
  await writeFile(planPath, JSON.stringify(f.plan), { mode: 0o600 });
  await backend.close(); await host.close(); await f.opened.owner.close();
  const fresh = JSON.parse(execFileSync(process.execPath,
    [resolve("tests/native-current-process-diagnostics-child.mjs"), planPath],
    { encoding: "utf8", env: { ...process.env, TMPDIR: f.directory } }));
  assert.notEqual(fresh.records[0].pid, process.pid);
  assert.notEqual(fresh.writer_id, before.writer_id);
  assert.deepEqual(fresh.records.map(row => row.event), ["runtime.started", "mcp.call.started"]);
  assert(fresh.records.every(row => row.writerId === fresh.writer_id));
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(before.writer_id));
});

test("native diagnostic ring rollover is bounded, ordered and metadata-only under interleaved reads", async () => {
  const writer = new NativeCurrentProcessDiagnosticWriter();
  const sentinel = "DIAGNOSTICS_RAW_SENTINEL_SECRET";
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let index = 0; index < 25_001; index++) {
      writer.record("mcp.call.completed", {
        readOnly: true, outcome: "success", durationMs: 1, arguments: sentinel,
        message: sentinel, path: sentinel, ownerId: sentinel, token: sentinel,
      });
      if (index % 200 === 0) {
        const page = writer.latest(1000);
        assert(page.records.length <= 1000);
        assert(page.records.every((row, offset) => !offset || row.recordIndex > page.records[offset - 1].recordIndex));
        page.records[0].event = "caller-mutated";
        await Promise.resolve();
      }
    }
  }));
  const page = writer.latest(1000);
  assert.equal(page.records.length, 1000);
  assert.equal(page.dropped_records, 4);
  assert.equal(page.records.at(-1).recordIndex, 100_004);
  assert.doesNotMatch(JSON.stringify(page), /DIAGNOSTICS_RAW_SENTINEL_SECRET|caller-mutated/);
  assert.throws(() => writer.record(sentinel));
  writer.close();
  assert.throws(() => writer.latest(1), { code: "ACCESS_DENIED" });
});

test("native public Cosmos configuration is private, exact-authorized and revision-safe", async t => {
  const f = await fixture(t, true);
  const bindings = [{ host: "cluster.example", vc: "team", account: "account" },
    { host: "other.example", vc: "project", account: "other" }];
  const settings = await readFile(join(f.root, ".pkm/state/actions/settings.json"));
  assert.deepEqual((await original(f.backend, "action_cosmos_configure", { bindings })).structuredContent,
    { ok: true, private: true, bindings_count: 2 });
  assert.deepEqual(readNativePrivateCosmosBinding(f.opened.storage, f.host, "cluster.example", "team"), bindings[0]);
  assert.equal(readNativePrivateCosmosBinding(f.opened.storage, f.host, "unknown.example", "team"), undefined);
  assert.throws(() => readNativePrivateCosmosBinding(f.opened.storage, { ...f.host }, "cluster.example", "team"), { code: "ACCESS_DENIED" });
  for (const invalid of [[], [bindings[0], bindings[0]], [{ ...bindings[0], token: "never-store" }],
    [{ ...bindings[0], host: "https://cluster.example" }], [{ ...bindings[0], account: "UPPER" }]]) {
    await assert.rejects(original(f.backend, "action_cosmos_configure", { bindings: invalid }), { code: "INVALID_ARGUMENT" });
  }
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "action_cosmos_configure", { bindings }), { code: "ACCESS_DENIED" });
  f.setAllowed(true);
  await writeFile(join(f.root, ".pkm/state/actions/policy.json"), '{"operator":"grant sentinel, never executable"}');
  assert.deepEqual((await original(f.backend, "action_cosmos_configure", { bindings: [...bindings].reverse() })).structuredContent,
    { ok: true, private: true, bindings_count: 2 }, "Order does not reinterpret an existing account grant.");
  await assert.rejects(original(f.backend, "action_cosmos_configure", {
    bindings: [{ ...bindings[0], account: "replacement" }],
  }), { code: "ACCESS_DENIED" });
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), settings);
  f.setCurrent(false);
  assert.throws(() => readNativePrivateCosmosBinding(f.opened.storage, f.host, "cluster.example", "team"), { code: "ACCESS_DENIED" });
});

test("actual native owned artifact copy and public GC reclaim only explicitly released payloads", async t => {
  const f = await fixture(t, false, { trustedPrograms: true });
  const selected = join(f.directory, "selected"), path = join(selected, "source.bin"), destination = join(selected, "export.bin");
  await mkdir(selected, { mode: 0o700 });
  const bytes = Buffer.from([0, 9, 255, 42]);
  await writeFile(path, bytes);
  const workspaceId = await f.opened.storage.workspaceId();
  for (const [kind, targetPath] of [["source", path], ["destination", destination]])
    await admitLegacyActionArtifactPath(f.opened.storage, actor, { kind, selectedRoot: selected, path: targetPath,
      authorityId: "native-gc-fixture-path", ...(kind === "source" ? { expectedSha256: hash(bytes) } : {}),
      authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
        && binding.workspaceRoot === f.root && binding.kind === kind && binding.path === targetPath
        && binding.selectedRoot === selected && binding.expectedSha256 === (kind === "source" ? hash(bytes) : null) });
  const sourceId = (await original(f.backend, "action_artifact_import", { local_path: path })).structuredContent.artifact_id;
  const raw = originalDefinitionValue(builtinActionDefinitions().get("core.artifact.copy"));
  const definition = Object.fromEntries(Object.entries(raw).filter(([key]) => !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
  const pending = (await original(f.backend, "action_register", { definition })).structuredContent;
  assert.equal(pending.registered, false);
  f.approveAction(definition.action_id, pending.content_hash);
  assert.equal((await original(f.backend, "action_register", { definition })).structuredContent.registered, true);
  const request = { action_id: definition.action_id, content_hash: pending.content_hash,
    inputs: { source: { artifact_id: sourceId } }, idempotency_key: "gc-owned-copy" };
  f.setEffectsAllowed(false);
  await assert.rejects(original(f.backend, "action_call", request), { code: "ACCESS_DENIED" });
  f.setEffectsAllowed(true);
  let run = (await original(f.backend, "action_call", request)).structuredContent;
  for (let attempt = 0; attempt < 100 && run.state !== "succeeded"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    run = (await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent;
  }
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  const outputId = run.output.artifact_id;
  const count = () => {
    const db = f.opened.storage.connectNative();
    try { return Number(db.prepare("SELECT count(*) AS n FROM native_action_managed_blobs").get().n); }
    finally { db.close(); }
  };
  assert.equal(count(), 1, "The actual adapter stored owned bytes, not a simulated Run outcome.");
  await original(f.backend, "action_artifact_export", { artifact_id: outputId, destination });
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal((await original(f.backend, "action_run_gc", { run_id: run.run_id })).structuredContent.gc_state, "retained");
  assert.equal(count(), 1);
  const released = (await original(f.backend, "action_run_gc", { run_id: run.run_id, release_outputs: true })).structuredContent;
  assert.deepEqual(released.deleted, [outputId]);
  assert.equal(count(), 0);
  assert.equal((await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent.output, undefined);
  assert.deepEqual((await original(f.backend, "action_run_gc", { run_id: run.run_id })).structuredContent.deleted, [],
    "A later default GC cannot re-release or resurrect an already released artifact.");
  await assert.rejects(original(f.backend, "action_artifact_export", { artifact_id: outputId, destination: join(selected, "not-granted") }),
    { code: "ACCESS_DENIED" });
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(destination), bytes, "User-exported files are outside native GC ownership.");
  f.setCurrent(false);
  await assert.rejects(original(f.backend, "action_run_gc", { run_id: run.run_id }), { code: "ACCESS_DENIED" });
});

test("public Azure CLI template executes a pinned real native program after separate source and effect approval", async t => {
  const f = await fixture(t, false, { trustedPrograms: true });
  const bin = join(f.directory, "native-bin"), cli = join(bin, "az"), log = join(bin, "argv.jsonl");
  await mkdir(bin, { mode: 0o700 });
  const python = execFileSync(process.env.PKM_TEST_PYTHON ?? process.env.PYTHON ?? "python3",
    ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
  await writeFile(cli, `#!${python}
import json,sys
with open(${JSON.stringify(log)},"a") as output:output.write(json.dumps(sys.argv[1:])+"\\n")
url=sys.argv[sys.argv.index("--url")+1]
print(json.dumps({"records":[]} if "/timeline?" in url else {"id":42,"definition":{"id":7},"status":"inProgress"}))
`, { mode: 0o700 });
  await chmod(cli, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const args = { action_id: "fixture.public.azure", parameters: { template_id: "azuredevops-pipeline-status" } };
  const pending = (await original(f.backend, "action_template_create", args)).structuredContent;
  assert.equal(pending.registered, false);
  assert.equal(f.effects.length, 0);
  f.approveAction(args.action_id, pending.content_hash);
  assert.equal((await original(f.backend, "action_template_create", args)).structuredContent.registered, true);
  const inputs = { organization: "https://dev.azure.com/fixture", project: "Team Project", run_id: "42" };
  const call = { action_id: args.action_id, content_hash: pending.content_hash, inputs, idempotency_key: "native-azure-observation" };
  f.setEffectsAllowed(false);
  await assert.rejects(original(f.backend, "action_call", call), { code: "ACCESS_DENIED" });
  await assert.rejects(lstat(log), { code: "ENOENT" });
  f.setEffectsAllowed(true);
  let run = (await original(f.backend, "action_call", call)).structuredContent;
  for (let attempt = 0; attempt < 250 && ["ready", "running"].includes(run.state); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    run = (await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent;
  }
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(run.output.remote_id, "42");
  assert.equal(run.output.terminal, false, "Successful local observation is not remote completion.");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert(calls.every(argv => argv[0] === "rest" && argv[argv.indexOf("--method") + 1] === "GET"));
  await original(f.backend, "action_call", call);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, "A recorded Action call does not rerun the external CLI.");
});

test("fresh signed native registered Action source and separate process review reach one real owned child", async t => {
  const f = await fixture(t, false, { registeredNative: true });
  const definition = { schema: "pkm.action.definition/v1", action_id: "fixture.native.registered", version: 1,
    description: "Exact harmless registered local command.", effects: ["pure"], dependencies: {},
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    implementations: [{ id: "native", kind: "program", platforms: ["Linux"], program: process.execPath,
      args: ["-e", 'process.stdout.write(JSON.stringify({value:"actual-child"}))'] }] };
  const registered = (await original(f.backend, "action_register", { definition })).structuredContent;
  assert.equal(registered.registered, true);
  assert(f.signed.prompts.some(prompt => prompt.detail.request?.purpose === "source"));
  const request = { action_id: definition.action_id, content_hash: registered.content_hash,
    inputs: {}, idempotency_key: "signed-native-registered-once" };
  let run = (await original(f.backend, "action_call", request)).structuredContent;
  for (let attempt = 0; attempt < 200 && ["ready", "running"].includes(run.state); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    run = (await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent;
  }
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.deepEqual(run.output, { value: "actual-child" });
  assert.equal(f.signed.prompts.filter(prompt => prompt.detail.request?.purpose === "effect").length, 1);
  const again = (await original(f.backend, "action_call", request)).structuredContent;
  assert.equal(again.run_id, run.run_id);
  assert.equal(f.signed.prompts.filter(prompt => prompt.detail.request?.purpose === "effect").length, 1);
  f.signed.revoke();
  await assert.rejects(original(f.backend, "action_call", { ...request, idempotency_key: "after-native-revoke" }));
  const { verifyOriginalMcpActionAuthoringReadSchema } = await import("../dist/original-mcp-action-historical-schema.js");
  const { readOriginalMcpJournal } = await import("../dist/original-mcp-root-custody.js");
  const db = f.opened.storage.connectNative();
  try {
    db.exec("BEGIN DEFERRED");
    const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const journal = readOriginalMcpJournal(f.root);
    assert(verifyOriginalMcpActionAuthoringReadSchema(f.root, db, schema(), journal).has("native_action_automatic_calls"));
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='native_action_automatic_calls_no_update'").get().sql;
    db.exec("DROP TRIGGER native_action_automatic_calls_no_update");
    db.prepare("UPDATE native_action_automatic_calls SET request_sha256=?").run("f".repeat(64));
    db.exec(trigger);
    assert.throws(() => verifyOriginalMcpActionAuthoringReadSchema(f.root, db, schema(), journal),
      /RECOVERY_REQUIRED|binding|custody/i);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  await f.backend.close(); await f.opened.owner.close();
  const fence = await acquireOriginalMcpRootFence(f.root);
  try {
    const { withOriginalMcpColdSqliteRead } = await import("../dist/original-mcp-cold-sqlite-read.js");
    await withOriginalMcpColdSqliteRead(f.plan, fence, async () =>
      assert.equal(await validateOriginalMcpWorkspace(f.root, undefined, fence), f.root));
  } finally { await fence.release(); }
});

test("signed native reconciliation accepts only an exact observed durable process completion without replay", async t => {
  const f = await fixture(t, false, { registeredNative: true });
  const { runtime } = await f.opened.owner.ensureFull(), engine = runtime.services.hostServices.actionRuntime;
  const log = join(f.directory, "observed-calls.txt");
  const definition = { schema: "pkm.action.definition/v1", action_id: "fixture.native.observed", version: 1,
    description: "Controlled real child with one deliberately interrupted Action result commit.",
    effects: ["local-write"], dependencies: {},
    input_schema: { type: "object", properties: { mode: { type: "string", enum: ["ok", "ambiguous"] } },
      required: ["mode"], additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    implementations: [{ id: "local", kind: "program", platforms: ["Linux"], program: process.execPath,
      args: ["-e", `const fs=require("fs");const input=JSON.parse(fs.readFileSync(0,"utf8"));fs.appendFileSync(${JSON.stringify(log)},"child\\n");process.stdout.write(input.mode==="ok"?JSON.stringify({value:"observed-child"}):"unprovable-output")`] }] };
  const registered = (await original(f.backend, "action_register", { definition })).structuredContent;
  const create = async (key, mode = "ok") => {
    const finish = engine.finishNode;
    if (mode === "ok") engine.finishNode = function (...args) {
      if (args[3] === "succeeded") { this.finishNode = finish; throw new Error("Controlled lost Action result commit after actual process completion."); }
      return finish.apply(this, args);
    };
    try {
      let run = (await original(f.backend, "action_call", { action_id: definition.action_id, content_hash: registered.content_hash,
        inputs: { mode }, idempotency_key: key })).structuredContent;
      for (let attempt = 0; attempt < 200 && ["ready", "running"].includes(run.state); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        run = (await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent;
      }
      assert.equal(run.state, "outcome_unknown", JSON.stringify(run));
      return run;
    } finally { engine.finishNode = finish; }
  };
  const uncertain = await create("observed-commit-lost");
  const request = { run_id: uncertain.run_id, expected_version: uncertain.version, kind: "manual", outcome: "succeeded",
    evidence: { reason: "Review the exact already observed owned process receipt.", output: { value: "observed-child" } } };
  await assert.rejects(original(f.backend, "action_run_reconcile", { ...request, expected_version: uncertain.version - 1 }), { code: "CONFLICT" });
  await assert.rejects(original(f.backend, "action_run_reconcile", { ...request,
    evidence: { ...request.evidence, output: { value: "user-invented" } } }), { code: "CONFLICT" });
  const ambiguous = await create("observed-ambiguous", "ambiguous");
  await assert.rejects(original(f.backend, "action_run_reconcile", { ...request,
    run_id: ambiguous.run_id, expected_version: ambiguous.version }), { code: "NOT_AVAILABLE" });
  const db = f.opened.storage.connectNative();
  try {
    const row = db.prepare("SELECT job_id,fingerprint FROM runtime_process_jobs WHERE actor_id=? AND state='SUCCEEDED' ORDER BY rowid LIMIT 1").get(actor.id);
    db.prepare("UPDATE runtime_process_jobs SET fingerprint=? WHERE job_id=?").run("f".repeat(64), row.job_id);
    try { await assert.rejects(original(f.backend, "action_run_reconcile", request), { code: "NOT_AVAILABLE" }); }
    finally { db.prepare("UPDATE runtime_process_jobs SET fingerprint=? WHERE job_id=?").run(row.fingerprint, row.job_id); }
    const rowRun = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actor.id, uncertain.run_id);
    const changed = JSON.parse(rowRun.snapshot);
    changed.adapters.action.authorizationDigest = "f".repeat(64);
    db.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE actor_id=? AND run_id=?").run(JSON.stringify(changed), actor.id, uncertain.run_id);
    try { await assert.rejects(original(f.backend, "action_run_reconcile", request), { code: "CONFLICT" }); }
    finally { db.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE actor_id=? AND run_id=?").run(rowRun.snapshot, actor.id, uncertain.run_id); }
  } finally { db.close(); }
  f.signed.ui.approve = false;
  await assert.rejects(original(f.backend, "action_run_reconcile", request), { code: "ACCESS_DENIED" });
  f.signed.ui.approve = true;
  const [first, concurrent] = await Promise.all([original(f.backend, "action_run_reconcile", request),
    original(f.backend, "action_run_reconcile", request)]);
  const accepted = first.structuredContent;
  assert.equal(concurrent.structuredContent.version, accepted.version, "Concurrent exact reviews share one version-CAS transition.");
  assert.equal(accepted.state, "succeeded"); assert.equal(accepted.version, uncertain.version + 1);
  assert.deepEqual(accepted.output, { value: "observed-child" });
  const replay = (await original(f.backend, "action_run_reconcile", request)).structuredContent;
  assert.equal(replay.version, accepted.version, "A repeated exact review is an idempotent CAS, not another execution.");
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  const events = (await original(f.backend, "action_run_events", { run_id: uncertain.run_id, after_sequence: 0 })).structuredContent;
  assert.equal(events.events.filter(event => event.kind === "run-reconciled").length, 1);
  const wait = (await original(f.backend, "action_run_wait", { run_id: uncertain.run_id, wait_seconds: 0 })).structuredContent;
  assert.equal(wait.state, "succeeded"); assert(wait.event_delivery.events.length > 0);
  const reviewed = f.signed.prompts.find(prompt => prompt.detail.request?.purpose === "reconcile").detail.request;
  assert.equal(reviewed.reconciliation.expectedVersion, uncertain.version);
  assert.deepEqual(reviewed.reconciliation.output, { value: "observed-child" });
  const revoked = await create("observed-revoked");
  f.signed.ui.beforeApprove = prompt => { if (prompt.detail.request?.purpose === "reconcile") f.signed.revoke(); };
  await assert.rejects(original(f.backend, "action_run_reconcile", { ...request,
    run_id: revoked.run_id, expected_version: revoked.version }));
  assert.equal(engine.get(actor.id, revoked.run_id).state, "unknown");
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 3);
  await f.backend.close(); await f.host.close(); await f.opened.owner.close();
  let reopenedHost;
  const reopened = await openOriginalMcpRoot(f.plan, { prepareNative: async storage => {
    const signed = await signedActionPackageClient(storage, f.plan, target.catalogSha256);
    reopenedHost = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(signed.session));
    const { createOriginalMcpRegisteredActionHost } = await import("../dist/original-mcp-registered-action-host.js");
    return { hostServices: { action: await createOriginalMcpRegisteredActionHost(storage, reopenedHost, signed.session) } };
  } });
  f.cleanup.push(() => reopened.owner.close());
  await reopened.owner.ensureFull();
  const reopenedBackend = createNativePublicOwnerBackend(reopened.owner, { actor, originalMcpHost: reopenedHost });
  f.cleanup.push(() => reopenedBackend.close());
  await assert.rejects(original(reopenedBackend, "action_run_reconcile", { ...request,
    run_id: revoked.run_id, expected_version: revoked.version }), { code: "NOT_AVAILABLE" });
  assert.equal((await original(reopenedBackend, "action_run_get", { run_id: revoked.run_id })).structuredContent.state, "outcome_unknown");
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 3, "Restart cannot fabricate lost output or replay an unknown effect.");
});

test("default signed native bootstrap composes registered local execution without injected Action host services", async t => {
  const f = await fixture(t);
  await f.backend.close(); await f.host.close(); await f.opened.owner.close();
  const { bootstrapOriginalMcpNativeRuntime } = await import("../dist/original-mcp-native-bootstrap.js");
  const { originalMcpNativeIdentity } = await import("../dist/original-mcp-native-identity.js");
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), f.plan.profileSha256);
  const directory = resolve("tests", `.d-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { mode: 0o700 });
  f.cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fence = await acquireOriginalMcpRootFence(f.root);
  const bootstrap = await bootstrapOriginalMcpNativeRuntime({ plan: f.plan, writerFence: fence,
    attachment: { directory, identity, identitySha256: identity.sha256,
      payloadBuildId: "b".repeat(64), hostEntrySha256: "c".repeat(64) } });
  f.cleanup.push(() => bootstrap.close());
  const descriptor = JSON.parse(await readFile(bootstrap.attachmentDescriptorPath, "utf8"));
  const signed = await signedActionPackageClient(bootstrap.storage, f.plan, descriptor.binding.catalogSha256,
    { descriptor, keys, identity });
  const host = await bootstrap.complete();
  const backend = createNativePublicOwnerBackend(bootstrap.owner, { actor, originalMcpHost: host });
  f.cleanup.push(() => backend.close());
  const python = await controlledLocalPython(f.directory);
  const definition = { schema: "pkm.action.definition/v1", action_id: "fixture.default.registered", version: 1,
    effects: ["pure"], dependencies: {}, description: "Actual harmless direct Python child from default composition.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    implementations: [{ id: "native-python", kind: "program", platforms: ["Linux"], program: python,
      args: ["-c", 'import json;print(json.dumps({"value":"default-bootstrap"}))'] }] };
  const registered = (await original(backend, "action_register", { definition })).structuredContent;
  assert.equal(registered.registered, true);
  let run = (await original(backend, "action_call", { action_id: definition.action_id, content_hash: registered.content_hash,
    inputs: {}, idempotency_key: "default-bootstrap-child" })).structuredContent;
  for (let attempt = 0; attempt < 200 && ["ready", "running"].includes(run.state); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    run = (await original(backend, "action_run_get", { run_id: run.run_id })).structuredContent;
  }
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.deepEqual(run.output, { value: "default-bootstrap" });
  assert.equal(signed.prompts.filter(prompt => prompt.detail.request?.purpose === "effect").length, 1);
});

test("signed native Cosmos calls use private current configuration and closed actual az argv for list upload download", async t => {
  const f = await fixture(t, false, { registeredNative: true });
  const bin = join(f.directory, "cosmos-bin"), cli = join(bin, "az"), log = join(bin, "calls.jsonl");
  await mkdir(bin, { mode: 0o700 });
  const python = await controlledLocalPython(f.directory);
  await writeFile(cli, `#!${python}
import json,sys,pathlib,time
args=sys.argv[1:]
with open(${JSON.stringify(log)},"a") as out:out.write(json.dumps(args)+"\\n")
if "download" in args:
 destination=pathlib.Path(args[args.index("--destination-path")+1])
 if destination.is_dir():destination=destination/"remote.txt"
 destination.write_text("downloaded")
print(json.dumps({"actual":args[2]}))
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  await original(f.backend, "action_cosmos_configure", { bindings: [{ host: "cosmos.example", vc: "team", account: "account" }] });
  const invoke = async (id, inputs, key) => {
    const definition = (await original(f.backend, "action_get", { action_id: id })).structuredContent;
    const request = { action_id: id, content_hash: definition.content_hash, inputs, idempotency_key: key };
    let run = (await original(f.backend, "action_call", request)).structuredContent;
    for (let attempt = 0; attempt < 200 && ["ready", "running"].includes(run.state); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      run = (await original(f.backend, "action_run_get", { run_id: run.run_id })).structuredContent;
    }
    assert.equal(run.state, "succeeded", JSON.stringify(run));
    assert.equal((await original(f.backend, "action_call", request)).structuredContent.run_id, run.run_id);
    return run;
  };
  const uri = "https://cosmos.example/cosmos/team/shares/shared/folder";
  assert.deepEqual((await invoke("cosmos.directory.list", { uri }, "cosmos-list-once")).output, { actual: "list" });
  assert.deepEqual((await invoke("cosmos.artifact.upload", { uri, local_path: "notes/Entry.md",
    thread_count: 2, overwrite: true }, "cosmos-upload-once")).output, { actual: "upload" });
  assert.deepEqual((await invoke("cosmos.artifact.download", { uri, local_path: "notes/download.txt" },
    "cosmos-download-once")).output, { actual: "download" });
  assert.equal(await readFile(join(f.root, "notes/download.txt"), "utf8"), "downloaded");
  await mkdir(join(f.root, "notes/upload-dir"));
  await writeFile(join(f.root, "notes/upload-dir/child.txt"), "pinned directory");
  await invoke("cosmos.artifact.upload", { uri, local_path: "notes/upload-dir" }, "cosmos-upload-directory");
  await invoke("cosmos.artifact.download", { uri, local_path: "notes/download.txt", overwrite: true }, "cosmos-overwrite-file");
  await invoke("cosmos.artifact.download", { uri, local_path: "notes/upload-dir", overwrite: true }, "cosmos-overwrite-directory");
  assert.equal(await readFile(join(f.root, "notes/upload-dir/remote.txt"), "utf8"), "downloaded");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], ["dls", "fs", "list", "--account", "account", "--path", "/shares/shared/folder",
    "--output", "json", "--only-show-errors"]);
  assert(calls[1].includes("--overwrite"));
  const reviews = f.signed.prompts.filter(prompt => prompt.detail.request?.purpose === "effect");
  assert.equal(reviews.length, 6);
  assert(reviews.every(prompt => /^[a-f0-9]{64}$/.test(prompt.detail.request.configurationSha256)));
  assert(reviews[1].detail.request.localPath.sha256);
  assert.equal(reviews[2].detail.request.localPath.kind, "destination");
  const priorDefinition = (await original(f.backend, "action_get", { action_id: "cosmos.directory.list" })).structuredContent;
  for (const [index, invalidUri] of [uri + "/../folder", uri + "/%2e%2e/folder", uri.replace("/cosmos/team/", "/cosmos/unconfigured/"),
    uri.replace("https://", "https:\\\\"), uri + "\n"].entries()) {
    try {
      const denied = await original(f.backend, "action_call", { action_id: "cosmos.directory.list",
        content_hash: priorDefinition.content_hash, idempotency_key: `invalid-raw-uri-${index}`, inputs: { uri: invalidUri } });
      assert.equal(denied.isError, true, JSON.stringify({ invalidUri, denied }));
    } catch (error) { if (error.code === "ERR_ASSERTION") throw error; }
  }
  const shared = join(f.root, "notes/shared");
  await mkdir(shared, { mode: 0o700 }); await chmod(shared, 0o777);
  const download = (await original(f.backend, "action_get", { action_id: "cosmos.artifact.download" })).structuredContent;
  await assert.rejects(original(f.backend, "action_call", { action_id: "cosmos.artifact.download",
    content_hash: download.content_hash, idempotency_key: "unsafe-download-parent",
    inputs: { uri, local_path: "notes/shared/output.txt" } }));
  await chmod(shared, 0o700);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 6, "Invalid raw URI or mutable parent never reaches the CLI.");
  await original(f.backend, "action_cosmos_configure", { bindings: [{ host: "cosmos.example", vc: "team", account: "replacement" }] });
  await assert.rejects(original(f.backend, "action_call", { action_id: "cosmos.directory.list",
    content_hash: priorDefinition.content_hash, idempotency_key: "stale-config-new", inputs: { uri } }), /CONFLICT|changed/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 6);
});

test("signed native Cosmos preserves uncertain mutation outcomes and cancellation without replay or stale configuration grants", async t => {
  const f = await fixture(t, false, { registeredNative: true });
  const bin = join(f.directory, "cosmos-bin"), cli = join(bin, "az"), log = join(bin, "calls.jsonl");
  await mkdir(bin, { mode: 0o700 });
  const python = await controlledLocalPython(f.directory);
  await writeFile(cli, `#!${python}
import json,sys,time
args=sys.argv[1:]
with open(${JSON.stringify(log)},"a") as out:out.write(json.dumps(args)+"\\n")
if any(arg.endswith("/error") for arg in args):sys.exit(7)
if any(arg.endswith("/invalid") for arg in args):
 print("not-json")
 sys.exit(0)
time.sleep(30)
print("{}")
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  await original(f.backend, "action_cosmos_configure", { bindings: [{ host: "cosmos.example", vc: "team", account: "account" }] });
  const id = "cosmos.artifact.upload", definition = (await original(f.backend, "action_get", { action_id: id })).structuredContent;
  const request = suffix => ({ action_id: id, content_hash: definition.content_hash, idempotency_key: `unknown-${suffix}`,
    inputs: { uri: `https://cosmos.example/cosmos/team/shares/team/${suffix}`, local_path: "notes/Entry.md" } });
  const wait = async (id, states) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const run = (await original(f.backend, "action_run_get", { run_id: id })).structuredContent;
      if (states.includes(run.state)) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Native controlled transfer did not reach its bounded expected state.");
  };
  const first = (await original(f.backend, "action_call", request("error"))).structuredContent;
  assert.equal((await wait(first.run_id, ["outcome_unknown", "failed"])).state, "outcome_unknown");
  assert.equal((await original(f.backend, "action_call", request("error"))).structuredContent.run_id, first.run_id);
  const second = (await original(f.backend, "action_call", request("slow"))).structuredContent;
  await wait(second.run_id, ["running"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(log, "utf8")).trim().split("\n").length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await original(f.backend, "action_run_cancel", { run_id: second.run_id });
  assert.equal((await wait(second.run_id, ["outcome_unknown", "cancelled"])).state, "outcome_unknown");
  assert.equal((await original(f.backend, "action_call", request("slow"))).structuredContent.run_id, second.run_id);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  const timed = request("timeout"); timed.inputs.timeout_seconds = 1;
  const third = (await original(f.backend, "action_call", timed)).structuredContent;
  assert.equal((await wait(third.run_id, ["outcome_unknown", "failed"])).state, "outcome_unknown");
  assert.equal((await original(f.backend, "action_call", timed)).structuredContent.run_id, third.run_id);
  const invalid = (await original(f.backend, "action_call", request("invalid"))).structuredContent;
  assert.equal((await wait(invalid.run_id, ["outcome_unknown", "failed"])).state, "outcome_unknown");
  assert.equal((await original(f.backend, "action_call", request("invalid"))).structuredContent.run_id, invalid.run_id);
  await assert.rejects(original(f.backend, "action_cosmos_configure", {
    bindings: [{ host: "cosmos.example", vc: "team", account: "replacement" }] }), /ACCESS_DENIED|Revoke/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4);
});

test("signed native Cosmos rejects unselected paths, source replacement, executable replacement and revoked effects before any launch", async t => {
  const f = await fixture(t, false, { registeredNative: true }), bin = join(f.directory, "cosmos-bin");
  await mkdir(bin, { mode: 0o700 });
  const cli = join(bin, "az"), log = join(bin, "calls.jsonl");
  const code = `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)},"launched\\n");process.stdout.write("{}");\n`;
  await writeFile(cli, code, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  await original(f.backend, "action_cosmos_configure", { bindings: [{ host: "cosmos.example", vc: "team", account: "account" }] });
  const id = "cosmos.artifact.upload", definition = (await original(f.backend, "action_get", { action_id: id })).structuredContent;
  const request = key => ({ action_id: id, content_hash: definition.content_hash, idempotency_key: key,
    inputs: { uri: "https://cosmos.example/cosmos/team/shares/team/folder", local_path: "notes/Entry.md" } });
  f.signed.ui.open = join(f.root, "notes/Private/Secret.md");
  await assert.rejects(original(f.backend, "action_call", request("wrong-picker")), { code: "ACCESS_DENIED" });
  f.signed.ui.open = undefined;
  const source = await readFile(join(f.root, "notes/Entry.md"));
  f.signed.ui.beforeApprove = async prompt => {
    if (prompt.detail.request?.purpose === "effect") await writeFile(join(f.root, "notes/Entry.md"), "changed selected bytes");
  };
  await assert.rejects(original(f.backend, "action_call", request("changed-source")), /ACCESS_DENIED|NATIVE_DENIED/);
  await writeFile(join(f.root, "notes/Entry.md"), source);
  f.signed.ui.beforeApprove = async prompt => {
    if (prompt.detail.request?.purpose === "effect") await writeFile(cli, code + "// replaced\n");
  };
  await assert.rejects(original(f.backend, "action_call", request("changed-executable")), /ACCESS_DENIED|NATIVE_DENIED/);
  await writeFile(cli, code);
  f.signed.ui.beforeApprove = prompt => {
    if (prompt.detail.request?.purpose === "effect") f.signed.revoke();
  };
  await assert.rejects(original(f.backend, "action_call", request("revoked-review")), /ACCESS_DENIED|NATIVE_DENIED/);
  await assert.rejects(readFile(log), { code: "ENOENT" });
});

test("fresh public Recipe capabilities describe bounded implementations without source or process grants", async t => {
  const f = await fixture(t);
  const caps = (await original(f.backend, "recipe_capabilities", {})).structuredContent;
  assert.equal(caps.controlledLazy.fullRecipeParity, false);
  assert.equal(caps.controlledLazy.availableImplementationsNotExecutionGrants, true);
  assert.equal(caps.controlledLazy.sourceRequiresIndependentNativeDecision, true);
  assert.equal(caps.controlledLazy.eachProcessRequiresSeparateNativeDecision, true);
  assert.equal(caps.controlledLazy.autonomousLoops, false);
  assert(!caps.legacyRecipeToolsNotProvided.includes("recipe_capabilities"));
  assert(!caps.legacyRecipeToolsNotProvided.includes("recipe_run_start_adhoc"));
  const { originalMcpRecipeCapabilities } = await import("../dist/original-mcp-recipe-execution.js");
  await assert.rejects(originalMcpRecipeCapabilities(f.opened.owner, f.host, {}), { code: "ACCESS_DENIED" });
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "recipe_capabilities", {}), { code: "ACCESS_DENIED" });
  f.setAllowed(true);
  f.setCurrent(false);
  await assert.rejects(original(f.backend, "recipe_capabilities", {}), { code: "ACCESS_DENIED" });
  assert.equal(f.effects.length, 0);
});

test("fresh authenticated public Action authoring creates a real immutable proposal", async t => {
  const f = await fixture(t, true);
  const definition = {
    schema: "pkm.action.definition/v1", action_id: "fixture.public.authoring", version: 1,
    description: "Public authoring without execution authority.", effects: ["pure"], dependencies: {},
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    implementations: [{ id: "native", kind: "pipeline", platforms: ["Linux"],
      steps: [{ id: "value", component: "core.constant", inputs: { value: "authored" } }],
      output: { value: { $step: "value.value" } } }],
    examples: [{ inputs: {}, output: { value: "authored" } }],
  };
  const created = await original(f.backend, "action_register", { definition });
  assert.equal(created.structuredContent.state, "pending_operator_approval");
  const proposals = await original(f.backend, "action_proposals", {});
  assert.equal(proposals.structuredContent.proposals[0].action_id, definition.action_id);
  assert.equal(f.approvals.at(-1).request.operation, "mcp.tool.action_proposals");
  const checked = await original(f.backend, "action_definition_check", { definition });
  assert.equal(checked.structuredContent.ok, true);
  assert.equal(checked.structuredContent.persisted, false);
  assert.equal((await original(f.backend, "action_register", { definition })).structuredContent.proposal_id,
    created.structuredContent.proposal_id, "An identical pending revision is not duplicated.");
  const graph = { action_id: "fixture.public.graph", version: 1,
    nodes: [{ id: "value", action_id: "core.constant", value_type: "string",
      content_hash: componentDigest((await import("../dist/domain/action-compiler-validation.js")).actionComponents()["core.constant"]),
      parameters: { value: "graph" } }] };
  const graphSaved = await original(f.backend, "action_graph_save", { graph });
  assert.equal(graphSaved.structuredContent.state, "pending_operator_approval");
  await assert.rejects(original(f.backend, "action_graph_save", { graph: {
    ...graph, nodes: [{ ...graph.nodes[0], content_hash: hash("conflicting-component") }] } }), { code: "INVALID_ARGUMENT" });
  const template = await original(f.backend, "action_template_create", { action_id: "fixture.public.poll",
    parameters: { query_action_id: f.builtin.action_id, query_revision: f.builtin.content_hash,
      query_inputs: { value: "2.5" }, field: "value", expected: 2.5,
      interval_seconds: 0.01, timeout_seconds: 1, max_iterations: 1 } });
  assert.equal(template.structuredContent.state, "pending_operator_approval");
  await assert.rejects(original(f.backend, "action_template_create", { action_id: "fixture.public.invalid",
    parameters: { query_action_id: f.builtin.action_id, query_revision: hash("wrong") } }), { code: "INVALID_ARGUMENT" });
  const retrieved = await original(f.backend, "action_retrieve", { task: "cast", limit: 2 });
  assert(retrieved.structuredContent.candidates.length > 0);
  const capabilities = await original(f.backend, "action_capabilities", {});
  assert.equal(capabilities.structuredContent.schema, "pkm.action.capabilities/v1");
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "action_register", { definition: { ...definition, version: 2 } }), { code: "ACCESS_DENIED" });
  f.setAllowed(true);
  assert.equal((await original(f.backend, "action_proposals", {})).structuredContent.proposals.length, 3);
  f.setCurrent(false);
  await assert.rejects(original(f.backend, "action_proposals", {}), { code: "ACCESS_DENIED" });
  f.setCurrent(true);
  assert.equal(f.modelCalls(), 0);
});

test("public ModuleSet and artifact lifecycle uses independent exact native source and destination custody", async t => {
  const f = await fixture(t), storage = f.opened.storage, selectedRoot = join(f.directory, "selected");
  await mkdir(selectedRoot, { mode: 0o700 });
  const path = join(selectedRoot, "source.pkm-actions"), bytes = portableActionArchive();
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), { code: "ACCESS_DENIED" });
  await admitLegacyActionPackage(storage, actor, { sourceRoot: selectedRoot, sourcePath: path,
    expectedPackageSha256: hash(bytes), authorityId: "independent-native-package-fixture",
    authorize: binding => binding.sourcePath === path && binding.packageSha256 === hash(bytes) });
  const installed = await original(f.backend, "action_module_set_import", { local_path: path });
  assert.equal(installed.structuredContent.enabled, false);
  assert.equal((await original(f.backend, "action_module_sets", {})).structuredContent.module_sets.length, 1);
  const selection = { module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version };
  assert.equal((await original(f.backend, "action_module_set_load", selection)).structuredContent.enabled, true);
  const destination = join(selectedRoot, "exported.pkm-actions");
  await assert.rejects(original(f.backend, "action_module_set_export", { ...selection,
    action_ids: portableActionManifest.actions, destination }), { code: "ACCESS_DENIED" });
  await admitLegacyActionArtifactPath(storage, actor, { kind: "destination", selectedRoot, path: destination,
    authorityId: "independent-native-package-destination", authorize: binding => binding.path === destination });
  const exported = await original(f.backend, "action_module_set_export", { ...selection,
    action_ids: portableActionManifest.actions, destination });
  assert.equal(exported.structuredContent.host_state_exported, false);
  assert.deepEqual(decodeLegacyActionPackage(await readFile(destination)).manifest.actions, portableActionManifest.actions);
  await assert.rejects(original(f.backend, "action_module_set_export", { ...selection,
    action_ids: portableActionManifest.actions, destination }), { code: "CONFLICT" });
  const input = join(selectedRoot, "artifact.txt"), output = join(selectedRoot, "artifact-copy.txt");
  await writeFile(input, "Explicit artifact source.", { mode: 0o600 });
  await assert.rejects(original(f.backend, "action_artifact_import", { local_path: input }), { code: "ACCESS_DENIED" });
  await admitLegacyActionArtifactPath(storage, actor, { kind: "source", selectedRoot, path: input,
    expectedSha256: hash("Explicit artifact source."), authorityId: "independent-native-artifact-source",
    authorize: binding => binding.path === input });
  const artifact = await original(f.backend, "action_artifact_import", { local_path: input });
  await admitLegacyActionArtifactPath(storage, actor, { kind: "destination", selectedRoot, path: output,
    authorityId: "independent-native-artifact-destination", authorize: binding => binding.path === output });
  await original(f.backend, "action_artifact_export", { artifact_id: artifact.structuredContent.artifact_id, destination: output });
  assert.equal(await readFile(output, "utf8"), "Explicit artifact source.");
  await writeFile(path, Buffer.concat([bytes, Buffer.from("changed")]), { mode: 0o600 });
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), { code: "CONFLICT" });
  await original(f.backend, "action_module_set_load", { ...selection, enabled: false });
  assert.equal((await original(f.backend, "action_module_set_remove", selection)).structuredContent.runs_deleted, false);
});

test("public binary ModuleSet export preserves only exact declared byte resources and executable metadata", async t => {
  const f = await fixture(t), selectedRoot = join(f.directory, "binary-selected");
  await mkdir(selectedRoot, { mode: 0o700 });
  const actionId = portableActionManifest.actions[0], member = `definitions/${actionId}.json`,
    prefix = `assets/${actionId}/`, binary = Buffer.from([0, 255, 9, 42]),
    tool = Buffer.from("#!/usr/bin/env python3\nprint('declared')\n"), secret = Buffer.from("not-declared-secret");
  const definition = JSON.parse(decodeLegacyActionPackage(portableActionArchive()).files[member]);
  definition.implementations[0].files = [`\${module_assets}/${actionId}/data.bin`, `\${module_assets}/${actionId}/tool.py`];
  const text = JSON.stringify(definition), manifest = structuredClone(portableActionManifest);
  manifest.files = { [member]: hash(text), [`${prefix}data.bin`]: hash(binary),
    [`${prefix}tool.py`]: hash(tool), [`${prefix}unused.txt`]: hash(secret) };
  manifest.executables = [`${prefix}tool.py`];
  delete manifest.package_hash; manifest.package_hash = originalDigest(manifest);
  const bytes = portableActionArchive(manifest, { files: { [member]: text }, binary: {
    [`${prefix}data.bin`]: binary.toString("base64"), [`${prefix}tool.py`]: tool.toString("base64"),
    [`${prefix}unused.txt`]: secret.toString("base64") } }), path = join(selectedRoot, "reviewed.zip");
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(admitLegacyActionPackage(f.opened.storage, actor, { sourceRoot: selectedRoot,
    sourcePath: path, expectedPackageSha256: hash(bytes), authorityId: "binary-native-source",
    authorize: () => true }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await admitLegacyActionPackage(f.opened.storage, actor, { sourceRoot: selectedRoot,
    sourcePath: path, expectedPackageSha256: hash(bytes), authorityId: "binary-native-source",
    sourceProtocol: nativeActionModuleSourceProtocol, authorize: binding => binding.sourcePath === path
      && binding.packageSha256 === hash(bytes) && binding.sourceProtocol === nativeActionModuleSourceProtocol });
  await original(f.backend, "action_module_set_import", { local_path: path });
  await original(f.backend, "action_module_set_load", { module_set_id: manifest.module_set_id, version: manifest.version });
  const destination = join(selectedRoot, "exported.zip");
  await admitLegacyActionArtifactPath(f.opened.storage, actor, { kind: "destination", selectedRoot, path: destination,
    authorityId: "binary-native-destination", authorize: binding => binding.path === destination });
  const request = { module_set_id: "fixture.public.binary", version: 1, action_ids: [actionId], destination };
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "action_module_set_export", request), { code: "ACCESS_DENIED" });
  assert.equal(await lstat(destination).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error)), undefined);
  f.setAllowed(true);
  await original(f.backend, "action_module_set_export", request);
  const exported = decodeLegacyActionPackage(await readFile(destination));
  assert.deepEqual(actionModuleFileBytes(exported.files[`${prefix}data.bin`]), binary);
  assert.deepEqual(exported.manifest.executables, [`${prefix}tool.py`]);
  assert.equal(exported.files[`${prefix}unused.txt`], undefined, "Package export must not scan an Action asset directory.");
  f.setCurrent(false);
  await assert.rejects(original(f.backend, "action_module_set_export", { ...request, destination: join(selectedRoot, "revoked.zip") }),
    { code: "ACCESS_DENIED" });
});

test("public signed native package source and separate destination preserve actual binary bytes without execution", async t => {
  const f = await fixture(t, false, { signedPackages: true });
  const selected = join(f.directory, "selected"); await mkdir(selected, { mode: 0o700 });
  const actionId = portableActionManifest.actions[0], member = `definitions/${actionId}.json`,
    binaryMember = `assets/${actionId}/data.bin`, binary = Buffer.from([255, 0, 7, 128]);
  const definition = JSON.parse(decodeLegacyActionPackage(portableActionArchive()).files[member]);
  definition.implementations[0].files = [`\${module_assets}/${actionId}/data.bin`];
  const text = JSON.stringify(definition), manifest = structuredClone(portableActionManifest);
  manifest.files = { [member]: hash(text), [binaryMember]: hash(binary) };
  delete manifest.package_hash; manifest.package_hash = originalDigest(manifest);
  const bytes = portableActionArchive(manifest, { files: { [member]: text },
    binary: { [binaryMember]: binary.toString("base64") } }), sourcePath = join(selected, "source.zip");
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  await original(f.backend, "action_module_set_import", { local_path: relative(process.cwd(), sourcePath) });
  await original(f.backend, "action_module_set_load", { module_set_id: manifest.module_set_id, version: manifest.version });
  const destination = join(selected, "out.zip");
  await original(f.backend, "action_module_set_export", { module_set_id: "fixture.signed.bytes", version: 1,
    action_ids: [actionId], destination: relative(process.cwd(), destination) });
  assert.deepEqual(actionModuleFileBytes(decodeLegacyActionPackage(await readFile(destination)).files[binaryMember]), binary);
  assert(f.signed.requests.some(request => request.method === "action.package.source.approve"));
  assert(f.signed.requests.some(request => request.method === "action.package.destination.approve"));
  assert(f.signed.requests.filter(request => request.method === "action.package.decision.current").length >= 3);
  assert(f.signed.prompts.some(prompt => /without execution/.test(prompt.title)));
  assert(f.signed.prompts.some(prompt => /this one new destination/.test(prompt.detail.purpose ?? "")
    || /One native package file write/.test(prompt.detail.purpose ?? "")));
  const db = f.opened.storage.connectNative();
  const { readOriginalMcpJournal } = await import("../dist/original-mcp-root-custody.js");
  const { verifyOriginalMcpActionAuthoringReadSchema } = await import("../dist/original-mcp-action-historical-schema.js");
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 0);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_footprints'").get(), undefined);
    db.exec("BEGIN DEFERRED");
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const journal = readOriginalMcpJournal(f.root);
    const verified = verifyOriginalMcpActionAuthoringReadSchema(f.root, db, schema, journal);
    assert(verified.has("legacy_action_catalog_admissions"));
    assert(verified.has("legacy_action_package_publications"));
    assert.throws(() => verifyOriginalMcpActionAuthoringReadSchema(f.root, db, schema,
      { ...journal, workspaceId: randomUUID() }), { code: "RECOVERY_REQUIRED" });
    db.exec("ROLLBACK; BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM legacy_action_catalog_admissions LIMIT 1").get();
    const foreign = JSON.parse(row.payload), foreignStat = await lstat(f.directory);
    foreign.binding.workspaceRoot = f.directory;
    foreign.binding.workspaceRootPin = `${foreignStat.dev}:${foreignStat.ino}`;
    const payload = JSON.stringify(foreign), sha = hash(payload);
    db.prepare("INSERT INTO legacy_action_catalog_admissions VALUES(?,?,?)").run(sha, payload, sha);
    assert.throws(() => verifyOriginalMcpActionAuthoringReadSchema(f.root, db, schema, journal),
      { code: "RECOVERY_REQUIRED" });
    db.exec("ROLLBACK");
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  await f.backend.close(); await f.opened.owner.close();
  const fence = await acquireOriginalMcpRootFence(f.root);
  try {
    const { withOriginalMcpColdSqliteRead } = await import("../dist/original-mcp-cold-sqlite-read.js");
    await withOriginalMcpColdSqliteRead(f.plan, fence, async () =>
      assert.equal(await validateOriginalMcpWorkspace(f.root, undefined, fence), f.root));
  } finally { await fence.release(); }
});

test("public signed package selection and same-byte descriptor replacement fail before admission", async t => {
  const f = await fixture(t, false, { signedPackages: true });
  const path = join(f.directory, "source.zip"), bytes = portableActionArchive();
  await writeFile(path, bytes, { mode: 0o600 });
  f.signed.ui.open = join(f.directory, "wrong.zip");
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), /ACCESS_DENIED|NATIVE_DENIED/);
  f.signed.ui.open = undefined;
  f.signed.ui.beforeApprove = async prompt => {
    if (/without execution/.test(prompt.title)) await writeFile(path, bytes, { mode: 0o600 });
  };
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), /ACCESS_DENIED|NATIVE_DENIED/);
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_action_catalog_admissions'").get(), undefined); }
  finally { db.close(); }
});

test("public signed package picker cancellation and revocation do not grant catalog writes", async t => {
  const f = await fixture(t, false, { signedPackages: true }), path = join(f.directory, "source.zip");
  await writeFile(path, portableActionArchive(), { mode: 0o600 });
  f.signed.ui.open = null;
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), { code: "ACCESS_DENIED" });
  f.signed.ui.open = undefined;
  f.signed.ui.beforeApprove = prompt => {
    if (/without execution/.test(prompt.title)) f.signed.revoke();
  };
  await assert.rejects(original(f.backend, "action_module_set_import", { local_path: path }), /ACCESS_DENIED|NATIVE_DENIED/);
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_action_catalog_admissions'").get(), undefined); }
  finally { db.close(); }
});

test("signed package decisions reject cloned objects and reuse in another freshly approved public request", async t => {
  const f = await fixture(t, false, { signedPackages: true }), path = join(f.directory, "source.zip");
  await writeFile(path, portableActionArchive(), { mode: 0o600 });
  const args = { local_path: path }, request = { operation: "mcp.tool.action_module_set_import", version: 1,
    tool: "action_module_set_import", readOnly: false, arguments: args, argumentsDigest: originalMcpRequestDigest(args) };
  let decision;
  await withOriginalMcpPublicRequest(f.opened.storage, f.host, request, async () => {
    decision = await f.host.approveActionPackageSource(path);
    await f.host.assertActionPackageDecisionCurrent(decision);
    await assert.rejects(f.host.assertActionPackageDecisionCurrent(structuredClone(decision)), { code: "ACCESS_DENIED" });
  });
  await withOriginalMcpPublicRequest(f.opened.storage, f.host, request, async () => {
    await assert.rejects(f.host.assertActionPackageDecisionCurrent(decision), { code: "ACCESS_DENIED" });
  });
});

test("full-target readiness binds all actual151 IDs and refuses metadata-count or callback-based promotion", () => {
  const report = verifyOriginalMcpImplementationReadiness(target);
  assert.equal(report.ready, false);
  assert.equal(report.requiredOperationIds.length, 151);
  for (const id of ["mcp.tool.api_chat_send", "mcp.tool.chat_standby"])
    assert(report.missingImplementations.some(item => item.operationId === id), id);
  assert.deepEqual(report.canonicalCompatibilityOperations, ["todo.*", "memory.*"]);
  assert.throws(() => verifyOriginalMcpImplementationReadiness({ ...target, catalogSha256: hash("wrong") }), { code: "ACCESS_DENIED" });
  assert.throws(() => verifyOriginalMcpImplementationReadiness({ ...target, ready: true, authorize: () => true }));
  assert.throws(() => verifyOriginalMcpImplementationReadiness({ ...target, acceptedScope: "knowledge-content-only/v1" }));
});

test("actual old protocol calls use the same canonical owner and a fresh per-call native profile grant, without blanket legacy authority", async t => {
  const f = await fixture(t);
  const lease = { ...f.opened.owner.workspaceLease() };
  const facade = createNativePublicFacade(f.backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: f.directory, generation: "fixture", version: "0.1.0", components: {} },
    closeBackend: async () => {} });
  await writeFile(join(f.directory, "active-generation.json"),
    '{"schema":"pkm.mcp.lifecycle/v1","generation":"fixture"}', { mode: 0o600 });
  const response = await facade.invoke("capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } });
  assert.match(JSON.stringify(response), /Reliable public evidence/);
  assert.equal(f.approvals.at(-1).request.operation, "mcp.tool.get_note");
  const beforeAlias = f.approvals.length;
  assert.match(JSON.stringify(await facade.invoke("note_read", { slug: "Entry" })), /Reliable public evidence/);
  assert.equal(f.approvals.length, beforeAlias + 1, "The module alias traverses the same exact native approval once.");
  const hidden = await original(f.backend, "get_note", { slug: "Private/Secret" });
  assert.doesNotMatch(JSON.stringify(hidden), /Never publish/);
  await original(f.backend, "update_note", { slug: "Entry", content: "Updated through the real native Core." });
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /real native Core/);
  f.setAllowed(false);
  await assert.rejects(original(f.backend, "update_note", { slug: "Entry", content: "Not approved." }), { code: "ACCESS_DENIED" });
  assert.doesNotMatch(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Not approved/);
  f.setAllowed(true);
  for (const [tool, args, reason] of [
    ["api_chat_send", { host_id: randomUUID(), chat_id: randomUUID(), prompt: "Not sent", command_id: "one" }, /API_CHAT_CONTROL_ADAPTER_REQUIRED/],
    ["chat_post", { text: "Not sent" }, /ROOM_MCP_SESSION_ADAPTER_REQUIRED/],
    ["knowledge_snapshot_create", {}, /LARGE_ROOT_PRIVATE_DOMAIN_ADMISSION_REQUIRED/],
  ]) await assert.rejects(original(f.backend, tool, args), reason);
  await assert.rejects(original(f.backend, "action_validation_status", {}), /ACTION_NATIVE_ENGINE_REQUIRED/);
  await assert.rejects(f.backend.invoke("legacy_capability_read", {
    action: "read", args: { operation: "memory.record.search", version: 1, arguments: {} },
  }), /ORIGINAL_MEMORY_SCOPE_ADMISSION_REQUIRED/);
  assert.deepEqual(f.opened.owner.workspaceLease(), lease);
  assert.equal(f.modelCalls(), 0);
  assert.equal(await readFile(join(f.root, ".pkm/state/actions/settings.json"), "utf8"), '{"configured":"not inherited"}');
  await facade.close();
});

test("unified native lexical retrieval retains private Script denials rather than exposing archived private sources", async t => {
  const f = await fixture(t);
  const found = await original(f.backend, "search_scripts", { query: "public-code", limit: 10, route: "lexical", detail: "legacy" });
  assert.match(JSON.stringify(found), /public\.py/);
  const hidden = await original(f.backend, "search_scripts", { query: "private_code_not_published", limit: 10, route: "lexical", detail: "legacy" });
  assert.doesNotMatch(JSON.stringify(hidden), /secret\.py/);
  assert.equal(f.modelCalls(), 0);
});

test("original business args remain the exact approved snapshot across native UI await", async t => {
  const f = await fixture(t), args = { slug: "Entry", tags: ["native-approved-tag"] };
  f.setApprovalHook(() => args.tags.push("caller-mutation-not-approved"));
  await original(f.backend, "update_note", args);
  const markdown = await readFile(join(f.root, "notes/Entry.md"), "utf8");
  assert.match(markdown, /native-approved-tag/);
  assert.doesNotMatch(markdown, /caller-mutation-not-approved/);
});

test("full facade executes qualified intrinsic Action validation once while original Action source readiness stays blocked", async t => {
  const f = await fixture(t, true);
  const facade = createNativePublicFacade(f.backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: f.directory, generation: "fixture-action", version: "0.1.0", components: {} },
    closeBackend: async () => {} });
  await writeFile(join(f.directory, "active-generation.json"),
    '{"schema":"pkm.mcp.lifecycle/v1","generation":"fixture-action"}', { mode: 0o600 });
  const before = f.approvals.length;
  const response = await facade.invoke("capability_call", { operation: "mcp.tool.action_validate", version: 1,
    arguments: { action_id: f.builtin.action_id, content_hash: f.builtin.content_hash } });
  assert.equal(f.approvals.length, before + 1);
  const value = response.structuredContent ?? JSON.parse(response.content[0].text);
  assert.equal(value.schema, "pkm.action.validation/v1");
  assert.equal(value.status, "passed");
  assert.equal(value.ok, true);
  assert(value.evidence.length > 0);
  assert.equal(verifyOriginalMcpImplementationReadiness(target).ready, false);
  assert.equal(await readFile(join(f.root, ".pkm/state/actions/settings.json"), "utf8"), '{"configured":"not inherited"}');
  await facade.close();
});

test("original-layout semantic model admission uses a separate private receipt namespace and never trusts old package state", { timeout: 120_000 }, async t => {
  const f = await fixture(t), before = await readFile(f.oldModels);
  const model = JSON.parse(execFileSync("python3",
    [resolve("tests/legacy-retrieval-tiny-model.py"), join(f.directory, "source")],
    { encoding: "utf8", env: { ...process.env, TMPDIR: f.directory, PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: "1" } }));
  const current = f.opened.storage.connectNative();
  try { assert(!verifyLegacyRetrievalModels(current, f.root).active); } finally { current.close(); }
  const admitted = await admitLegacyRetrievalModel(f.opened.storage, actor, { sourceRoot: model.root, packageId: model.packageId,
    authorityId: "independent-native-model-fixture", authorize: () => true });
  assert.equal(admitted.root, join(f.root, ".pkm-next-retrieval-models", model.packageId));
  assert.deepEqual(await readFile(f.oldModels), before);
  const found = await original(f.backend, "search_knowledge",
    { query: "public evidence model", route: "semantic", debug: true });
  const semantic = found.structuredContent ?? JSON.parse(found.content[0].text);
  assert.equal(semantic.model_invoked, true);
  assert.equal(semantic.semantic_status, "ready");
  await f.backend.close(); await f.opened.owner.close();
  const restarted = await openOriginalMcpRoot(f.plan); f.cleanup.push(() => restarted.owner.close());
  const database = restarted.storage.connectNative();
  try { assert.equal(verifyLegacyRetrievalModels(database, f.root).active.packageId, model.packageId); }
  finally { database.close(); }
  await restarted.owner.close();
  await assert.rejects(rollbackOriginalMcpRoot(f.plan, { root: f.root, workspaceId: f.opened.workspaceId,
    planSha256: f.opened.planSha256, journalSha256: f.opened.journalSha256 }), /independent B1 preservation/);
  assert((await lstat(join(f.root, ".pkm-next-retrieval-models", model.packageId))).isDirectory());
});
