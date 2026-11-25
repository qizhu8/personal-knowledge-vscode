import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { activateOriginalMcpDomain, hydrateOriginalMcpMemory } from "../dist/original-mcp-domains.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { readOriginalMcpMemoryContext } from "../dist/original-mcp-memory-context.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const sources = [{ id: "fixture-source", chat: "fixture-chat", revision: "turn-1", locator: "message/1" }];

async function fixture(t) {
  const directory = resolve("tests", `.original-memory-context-${randomUUID()}`), root = join(directory, "root");
  let opened, host, lifetime;
  t.after(async () => { await opened?.owner.close(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal fixture.\n");
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const scope = JSON.stringify({ account: "local-owner", project: hash(root), repository: hash(root) });
  const id = `explicit-${hash(`${scope}\0old-proposal`)}`, source = join(directory, "original-memory.sqlite3");
  execFileSync("python3", ["-B", "-c", `
import sys
from pkm_memory_engine import Engine
e=Engine(sys.argv[1],"original-memory-context-fixture")
e.mutate("old-proposal","explicit_propose",{"id":sys.argv[3],"scope":sys.argv[2],
  "content":"Remember SQLite and durable source pins.","sources":[{"id":"fixture-source","chat":"fixture-chat",
    "revision":"turn-1","locator":"message/1"}]})
e.mutate("old-confirm","explicit_confirm",{"id":sys.argv[3],"scope":sys.argv[2],"expected_revision":1,
  "host_authorization":{"decision_id":"historical-human-decision","actor_id":"human:old-profile"}})
e.close()
`, source, scope, id], { env: { ...process.env, PYTHONPATH: resolve("compute"), PYTHONDONTWRITEBYTECODE: "1" } });
  await chmod(source, 0o600);
  const before = await readFile(source);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "memory-context-fixture", profileSha256: hash("nonproduction-separate-profile"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  const open = async () => {
    lifetime = new AbortController();
    opened = await openOriginalMcpRoot(plan, { prepareNative: async storage => {
      // A trusted embedding fixture exercises real Core, not installed native UI/signing acceptance.
      host = await createOriginalMcpNativeHost(storage, {
        profileSha256: plan.profileSha256,
        sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
        authorityId: "trusted-embedding-memory-context-fixture", epoch: randomUUID(), signal: lifetime.signal,
        assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
        async authorizeMemoryDecision() { return { actorId: "human:fresh-fixture", decisionId: randomUUID() }; },
        models: { configuration: { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" },
          registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
          transport: { supports: () => false, async open() { throw new Error("No provider calls are allowed."); } } },
      });
      return { authorizeMemoryDecision: host.options.authorizeMemoryDecision };
    } });
    await opened.owner.ensureFull();
  };
  let expiresAtMs;
  const policy = { async authorize() {
    return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: expiresAtMs ?? Date.now() + 60_000 };
  } };
  const call = async (verb, args) => {
    const { runtime } = await opened.owner.ensureFull();
    return runtime.core.dispatch(["get", "search", "audit"].includes(verb) ? "capability_read" : "capability_call",
      { operation: `memory.record.${verb}`, version: 1, arguments: args }, actor);
  };
  const recall = options => readOriginalMcpMemoryContext(opened.owner, host, { query: "SQLite", ...options });
  await open();
  const admit = async () => {
    const stagingDirectory = join(directory, "private-stage");
    await mkdir(stagingDirectory, { mode: 0o700 });
    await hydrateOriginalMcpMemory(opened.storage, host,
      { sourceSnapshot: source, sourceScopeSha256: hash(scope), stagingDirectory }, policy);
  };
  return { directory, root, scope, id, source, before, call, recall, admit,
    get opened() { return opened; }, get host() { return host; }, policy,
    setExpiry(value) { expiresAtMs = value; },
    async restart() { await opened.owner.close(); await open(); },
    revokeHost() { lifetime.abort(); } };
}

test("same-owner Memory context requires fresh source consent and returns exact canonical confirmed records", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.recall(), /ORIGINAL_MEMORY_SCOPE/);
  await f.admit();
  const snapshot = await f.recall();
  assert.equal(snapshot.scope, f.scope);
  assert.deepEqual(snapshot.records, [(await f.call("get", { id: f.id })).result]);
  snapshot.assertCurrent();
  const empty = await f.recall({ query: "does-not-match-any-record" });
  assert.deepEqual(empty.records, []);
  empty.assertCurrent();
  await assert.rejects(f.recall({ query: "x".repeat(513) }));
  await assert.rejects(f.recall({ signal: AbortSignal.abort() }), { code: "NOT_AVAILABLE" });
  snapshot.records[0].sources[0].locator = "changed-after-recall";
  assert.throws(snapshot.assertCurrent, /recalled content changed/);
  assert.equal((await f.call("get", { id: f.id })).result.sources[0].locator, "message/1");
  assert.deepEqual(await readFile(f.source), f.before, "The retained Engine is an unchanged source oracle, not a native writer.");
});

test("native Memory revocation invalidates prepared context, excludes future recall and retains exact historical receipts", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await f.admit();
  const initial = await f.recall(), old = (await f.call("get", { id: f.id })).result;
  const revised = await f.call("revise", { id: f.id, expected_revision: old.revision,
    operation_id: "fresh-revise", content: "SQLite revised fact awaits new confirmation.", sources });
  assert.equal(revised.result.status, "pending");
  assert.throws(initial.assertCurrent, /source, consent or recalled content changed/);
  assert.deepEqual((await f.recall()).records, []);
  const confirmed = await f.call("confirm", { id: f.id, expected_revision: revised.result.revision, operation_id: "fresh-confirm" });
  assert.equal(confirmed.result.status, "confirmed");
  const active = await f.recall();
  assert.equal(active.records[0].content, revised.result.content);
  const revoked = await f.call("revoke", { id: f.id, expected_revision: confirmed.result.revision, operation_id: "fresh-revoke" });
  assert.equal(revoked.result.status, "revoked");
  assert.throws(active.assertCurrent, /source, consent or recalled content changed/);
  assert.deepEqual((await f.recall()).records, []);
  assert.deepEqual((await f.call("confirm", { id: f.id, expected_revision: revised.result.revision,
    operation_id: "fresh-confirm" })).result, confirmed.result, "Historical receipt replay is not current recall.");
  assert.equal((await f.call("get", { id: f.id, revision: confirmed.result.revision })).result.status, "superseded");
  const audit = (await f.call("audit", { id: f.id })).result.events;
  assert.deepEqual(audit.map(event => event.action), ["proposed", "confirmed", "revised", "confirmed", "revoked"]);
  assert.equal(audit.at(-1).actor, "human:fresh-fixture");
  assert.match(await readFile(join(f.root, ".pkm-next-memory", `${f.id}.md`), "utf8"), /Remember SQLite and durable source pins/);
  await f.restart();
  await assert.rejects(f.recall(), /ORIGINAL_MEMORY_SCOPE/);
  await activateOriginalMcpDomain(f.opened.storage, f.host, "memory", f.policy);
  assert.deepEqual((await f.recall()).records, []);
  assert.deepEqual(await readFile(f.source), f.before);
});

test("Memory context never revives a prior consent epoch after readoption or host revocation", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await f.admit();
  const beforeReadoption = await f.recall(), lease = f.opened.owner.workspaceLease();
  await activateOriginalMcpDomain(f.opened.storage, f.host, "memory", f.policy);
  assert.deepEqual(f.opened.owner.workspaceLease(), lease);
  assert.throws(beforeReadoption.assertCurrent, /source, consent or recalled content changed/);
  const current = await f.recall(), cancelled = new AbortController(), bounded = await f.recall({ signal: cancelled.signal });
  cancelled.abort();
  assert.throws(bounded.assertCurrent, { code: "NOT_AVAILABLE" });
  current.assertCurrent();
  f.revokeHost();
  assert.throws(current.assertCurrent);
  await assert.rejects(f.recall());
  assert((await f.call("get", { id: f.id })).error, "Revocation reaches the real canonical Storage worker.");
});

test("Memory source consent expiry invalidates prepared recall while its actual RootOwner lease remains valid", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  f.setExpiry(Date.now() + 10_000);
  await f.admit();
  const snapshot = await f.recall();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(10_001);
  f.opened.owner.assertWorkspaceLease();
  assert.throws(snapshot.assertCurrent, /ORIGINAL_MEMORY_SCOPE/);
  await assert.rejects(f.recall(), /ORIGINAL_MEMORY_SCOPE/);
});
