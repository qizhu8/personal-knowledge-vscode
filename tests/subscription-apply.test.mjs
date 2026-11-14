import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionApplyHost, deserializeSubscriptionApplyPlan, serializeSubscriptionApplyPlan } from "../dist/subscription-apply.js";
import { scanMarkdown } from "../dist/markdown.js";
import { forkSubscriptionContent } from "../dist/domain/subscription-apply-original-fork.js";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const actorId = "fixture:reader";
const authority = { actorId, sourceIp: "192.0.2.10", subscriptionId: "fixture-sub", capabilityId: "fixture-local-copy" };
const here = dirname(fileURLToPath(import.meta.url));
const raw = "---\r\ndocumentId: source-old\r\nknowledgeId: knowledge_0123456789abcdef01234567\r\naliases: [note:historical/path]\r\ncustom: 'keep exactly' # comment\r\n---\r\n# Original\r\n\r\n![image](A.assets/image.bin)\r\n";
function input(contents = raw) {
  const image = Buffer.from([0, 255, 13, 10]);
  const snapshot = JSON.stringify({
    notes: [{ slug: "Team/A", content: contents }, { slug: "Team/B", content: "# Implicit\n" }],
    assets: [{ type: "notes", path: "Team/A.assets/image.bin", data: image.toString("base64"), digest: `sha256:${hash(image)}` }],
  });
  return {
    source: { subscriptionId: "fixture-sub", nodeId: "fixture-remote", shareId: "fixture-share", capabilityId: "fixture-local-copy",
      brokerName: "Fixture broker", publisherUser: "fixture-user", publisherHost: "fixture-host", revision: 1, collectionHash: `sha256:${hash(snapshot)}` },
    snapshot, area: "notes", paths: ["Team/A.md", "Team/B.md"],
  };
}
function durableWrite(path, content) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
// Synthetic stand-in for the parent's GLOBAL durable journal, not a production private DB.
function journal(root) {
  const directory = join(root, "fixture-global-journal");
  mkdirSync(directory, { recursive: true });
  return {
    async runExclusive(work) {
      const lock = join(directory, "writer.lock");
      const fd = openSync(lock, "wx");
      try {
        return await work({
          async load(id) {
            const intent = join(directory, `${id}.intent`), receipt = join(directory, `${id}.receipt`);
            return existsSync(intent) ? { intent: readFileSync(intent, "utf8"), receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null } : undefined;
          },
          async persistIntent(id, intent) { durableWrite(join(directory, `${id}.intent`), intent); },
          async commit(id, receipt) {
            assert.equal(deserializeSubscriptionApplyPlan(readFileSync(join(directory, `${id}.intent`), "utf8")).planSha256, receipt.planSha256);
            durableWrite(join(directory, `${id}.receipt`), JSON.stringify(receipt));
          },
        });
      } finally { closeSync(fd); rmSync(lock); }
    },
  };
}
function fixture(t, value = input()) {
  const root = resolve(here, `subscription-apply-work-${randomUUID()}`);
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "subscriptions"));
  writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2" }));
  const state = structuredClone(subscriptionReadSourceFiles["subscriptions.json"]);
  state.subscriptions[0].collectionHash = value.source.collectionHash;
  for (const [file, content] of Object.entries({ ...subscriptionReadSourceFiles, "subscriptions.json": state })) {
    writeFileSync(join(root, "subscriptions", file), JSON.stringify(content));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeHost = (binding = authority) => new SubscriptionApplyHost(root, journal(root), binding);
  return { root, value, makeHost, host: makeHost(), state };
}
function changeState(f, mutate) {
  const path = join(f.root, "subscriptions", "subscriptions.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  mutate(state); writeFileSync(path, JSON.stringify(state));
}
function interruption(event) {
  return seen => { if (seen === event) throw new Error("fixture interruption"); };
}

test("actual exclusive application preserves original fork bytes, old identities and path-derived identities; exact replay", async t => {
  const f = fixture(t), preview = await f.host.preview(f.value), id = randomUUID();
  const receipt = await f.host.apply(f.value, id, preview.workspaceRevision);
  const documents = scanMarkdown(f.root);
  assert.equal(documents.length, 2);
  assert.equal(documents.find(doc => doc.record.id === "source-old").raw, raw);
  const implicit = documents.find(doc => doc.record.path.endsWith("/B.md"));
  assert.equal(implicit.record.id, `legacy_${hash(implicit.record.path).slice(0, 32)}`);
  assert.equal(receipt.identities.find(item => item.documentId === "source-old").knowledgeId, "knowledge_0123456789abcdef01234567");
  assert.deepEqual(receipt.identities.find(item => item.documentId === "source-old").aliases, ["note:historical/path", preview.mappings[0].destinationAlias]);
  assert.deepEqual(await f.makeHost().recover(id), receipt);
  assert.deepEqual(await f.makeHost().apply(f.value, id, preview.workspaceRevision), receipt);
  await assert.rejects(f.host.apply({ ...f.value, paths: ["Team/A.md"] }, id, preview.workspaceRevision), { code: "RECOVERY_CONFLICT" });
  const originalRoot = join(f.root, "fixture-original");
  mkdirSync(originalRoot);
  const target = forkSubscriptionContent(originalRoot, {
    type: "notes", brokerName: f.value.source.brokerName, publisherUser: f.value.source.publisherUser,
    publisherHost: f.value.source.publisherHost, remotePath: "Team/A.md", content: raw,
    assets: [{ path: "Team/A.assets/image.bin", content: Buffer.from([0, 255, 13, 10]) }],
  });
  assert.deepEqual(readFileSync(join(originalRoot, target)), readFileSync(join(f.root, "notes", preview.mappings[0].destinationPath)));
  assert.deepEqual(readFileSync(join(originalRoot, "notes", preview.assets[0].destinationPath)), readFileSync(join(f.root, "notes", preview.assets[0].destinationPath)));
});

test("every observable interruption boundary restarts from durable intent and returns exactly one receipt", async t => {
  const reference = fixture(t), preview = await reference.host.preview(reference.value), events = [];
  const expected = await reference.host.apply(reference.value, randomUUID(), preview.workspaceRevision, event => events.push(event));
  assert(events.includes("intent") && events.includes("stage-write:0") && events.includes("publish:0") && events.includes("before-commit") && events.includes("commit"));
  for (let stop = 0; stop < events.length; stop++) {
    const event = `${stop}:${events[stop]}`;
    const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
    let position = 0;
    await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, () => {
      if (position++ === stop) throw new Error("fixture interruption");
    }), /fixture interruption/, event);
    const receipt = await f.makeHost().recover(id);
    assert.deepEqual(receipt.identities, expected.identities, event);
    assert.equal(scanMarkdown(f.root).length, 2, event);
    assert.deepEqual(await f.makeHost().recover(id), receipt, event);
    assert.equal(readdirSync(join(f.root, "fixture-global-journal")).filter(name => name.endsWith(".receipt")).length, 1, event);
  }
});

test("strict plans reject unknown fields, duplicate aliases, semantic forgery and noncanonical journals", async t => {
  const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
  await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, interruption("intent")));
  const path = join(f.root, "fixture-global-journal", `${id}.intent`), serialized = readFileSync(path, "utf8");
  assert.equal(serializeSubscriptionApplyPlan(deserializeSubscriptionApplyPlan(serialized)), serialized);
  assert.throws(() => deserializeSubscriptionApplyPlan(serialized + "\n"), { code: "RECOVERY_CONFLICT" });
  assert.throws(() => deserializeSubscriptionApplyPlan(serialized.replace('{"kind":', '{"unknown":true,"kind":')), { code: "RECOVERY_CONFLICT" });
  assert.throws(() => deserializeSubscriptionApplyPlan(serialized.replace('{"kind":', '{"kind":"duplicate","kind":')), { code: "RECOVERY_CONFLICT" });
  const invalid = JSON.parse(serialized);
  invalid.material.result.mappings[0].identity = "forged";
  assert.throws(() => serializeSubscriptionApplyPlan(invalid), { code: "RECOVERY_CONFLICT" });
  const duplicate = fixture(t, input(raw.replace("note:historical/path", "note:historical/path, note:historical/path")));
  const preview = await duplicate.host.preview(duplicate.value);
  await assert.rejects(duplicate.host.apply(duplicate.value, randomUUID(), preview.workspaceRevision), { code: "RECOVERY_CONFLICT" });
  assert.equal(readdirSync(join(duplicate.root, "fixture-global-journal")).length, 0);
});

test("native ACL revocation and stale native source are rechecked before recovery, even receipt replay", async t => {
  for (const committed of [false, true]) {
    const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
    if (committed) await f.host.apply(f.value, id, p.workspaceRevision);
    else await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, interruption("intent")));
    changeState(f, state => { state.shares[0].accountMode = "white-list"; state.shares[0].accountRules = ["somebody-else"]; });
    await assert.rejects(f.makeHost().recover(id), { code: "ACCESS_DENIED" });
  }
  const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
  await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, interruption("intent")));
  changeState(f, state => state.subscriptions[0].revision++);
  await assert.rejects(f.makeHost().recover(id), { code: "REVISION_CONFLICT" });
  await assert.rejects(f.makeHost({ ...authority, capabilityId: "forged" }).preview(f.value), { code: "ACCESS_DENIED" });
});

test("stale workspace, unknown destination/stage, symlinks and portable identity/alias collisions fail closed", async t => {
  for (const mode of ["baseline", "destination", "stage", "symlink"]) {
    const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
    await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, interruption("intent")));
    const intent = deserializeSubscriptionApplyPlan(readFileSync(join(f.root, "fixture-global-journal", `${id}.intent`), "utf8"));
    const first = intent.material.changes[0], parent = join(f.root, first.area, dirname(first.path));
    if (mode === "baseline") writeFileSync(join(f.root, "notes", "outside.md"), "# outside\n");
    else if (mode === "symlink") symlinkSync(join(f.root, "subscriptions"), join(f.root, "notes", p.forkRoot));
    else {
      mkdirSync(parent, { recursive: true });
      writeFileSync(mode === "stage" ? join(parent, `.pkm-write-${id}-0`) : join(f.root, first.area, first.path), "unknown");
    }
    await assert.rejects(f.makeHost().recover(id));
    assert(!existsSync(join(f.root, "fixture-global-journal", `${id}.receipt`)));
  }
  for (const metadata of ["documentId: source-old", "aliases: [NOTE:historical/PATH]", "knowledgeId: knowledge_0123456789abcdef01234567"]) {
    const f = fixture(t);
    writeFileSync(join(f.root, "notes", "local.md"), `---\n${metadata}\n---\n# Local\n`);
    await assert.rejects(async () => { const p = await f.host.preview(f.value); await f.host.apply(f.value, randomUUID(), p.workspaceRevision); });
  }
});

test("exclusive publication cannot overwrite a destination created after staging; source revocation between files stops effects", async t => {
  const f = fixture(t), id = randomUUID(), p = await f.host.preview(f.value);
  await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, event => {
    if (event === "stage-sync:0") {
      const intent = deserializeSubscriptionApplyPlan(readFileSync(join(f.root, "fixture-global-journal", `${id}.intent`), "utf8"));
      writeFileSync(join(f.root, intent.material.changes[0].area, intent.material.changes[0].path), "racing external writer", { flag: "wx" });
    }
  }));
  assert.equal(readFileSync(join(f.root, "notes", p.assets[0].destinationPath), "utf8"), "racing external writer");
  const revoked = fixture(t), id2 = randomUUID(), p2 = await revoked.host.preview(revoked.value);
  await assert.rejects(revoked.host.apply(revoked.value, id2, p2.workspaceRevision, event => {
    if (event === "cleanup-sync:0") changeState(revoked, state => { state.shares[0].published = false; });
  }));
  assert(!existsSync(join(revoked.root, "notes", p2.mappings[1].destinationPath)));
});

test("prototype and modern original fork identities are retained without metadata reserialization", async t => {
  for (const [metadata, expected] of [
    ["schema: pkm.knowledge/v1\nrevision: 2\ndeleted: false\naliases: [note:prototype-id]", "prototype-id"],
    ["knowledgeId: knowledge_abcdef0123456789abcdef01\naliases: [note:old/modern]", "knowledge_abcdef0123456789abcdef01"],
    ["documentId: explicit-id\naliases: []", "explicit-id"],
  ]) {
    const text = `---\n${metadata}\n# untouched YAML comment\n---\n# Body\n`;
    const f = fixture(t, input(text)), p = await f.host.preview(f.value);
    const receipt = await f.host.apply(f.value, randomUUID(), p.workspaceRevision);
    assert.equal(receipt.identities.find(item => item.path.endsWith("/A.md")).documentId, expected);
    assert.equal(scanMarkdown(f.root).find(item => item.record.id === expected).raw, text);
  }
});

test("unknown non-Markdown baseline bytes and out-of-order exact after states are not guessed", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, "notes", "_assets"));
  writeFileSync(join(f.root, "notes", "_assets", "local.bin"), "original");
  const p = await f.host.preview(f.value), id = randomUUID();
  await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, interruption("intent")));
  writeFileSync(join(f.root, "notes", "_assets", "local.bin"), "changed");
  await assert.rejects(f.makeHost().recover(id), { code: "RECOVERY_CONFLICT" });
  const second = fixture(t), p2 = await second.host.preview(second.value), id2 = randomUUID();
  await assert.rejects(second.host.apply(second.value, id2, p2.workspaceRevision, interruption("intent")));
  const intent = deserializeSubscriptionApplyPlan(readFileSync(join(second.root, "fixture-global-journal", `${id2}.intent`), "utf8"));
  const later = intent.material.changes.at(-1), full = join(second.root, later.area, later.path);
  mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, Buffer.from(later.afterBase64, "base64"));
  await assert.rejects(second.makeHost().recover(id2), { code: "RECOVERY_CONFLICT" });
});

test("revocation at staging and before commit cannot publish or commit additional effects", async t => {
  for (const event of ["stage-sync:0", "before-commit"]) {
    const f = fixture(t), p = await f.host.preview(f.value), id = randomUUID();
    await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, seen => {
      if (seen === event) changeState(f, state => { state.shares[0].accountMode = "white-list"; state.shares[0].accountRules = []; });
    }), { code: "ACCESS_DENIED" });
    assert(!existsSync(join(f.root, "fixture-global-journal", `${id}.receipt`)));
    if (event === "stage-sync:0") assert(!existsSync(join(f.root, "notes", p.assets[0].destinationPath)));
  }
});

test("capture hashes pin the actual original root and are repeatable", () => {
  const nextRoot = resolve(here, ".."), originalRoot = resolve(nextRoot, "..");
  const provenance = JSON.parse(readFileSync(join(nextRoot, "migration", "subscription-apply-provenance.json"), "utf8"));
  for (const record of provenance.files) {
    assert.equal(hash(readFileSync(join(originalRoot, record.source))), record.sourceSha256);
    assert.equal(hash(readFileSync(join(nextRoot, record.captured))), record.capturedSha256);
  }
});

test("portable parent spellings are rejected before intent or filesystem effects", async t => {
  const value = input("# Safe\n");
  value.snapshot = JSON.stringify({ notes: [
    { slug: "Team/A", content: "# A\n" }, { slug: "team/B", content: "# B\n" },
  ] });
  value.source.collectionHash = `sha256:${hash(value.snapshot)}`;
  value.paths = ["Team/A.md", "team/B.md"];
  const f = fixture(t, value), p = await f.host.preview(value);
  await assert.rejects(f.host.apply(value, randomUUID(), p.workspaceRevision), { code: "RECOVERY_CONFLICT" });
  assert.deepEqual(readdirSync(join(f.root, "notes")), []);
  assert.deepEqual(readdirSync(join(f.root, "fixture-global-journal")), []);
});

test("unknown bytes introduced at the staging cleanup boundary are preserved for reconciliation", async t => {
  const f = fixture(t), p = await f.host.preview(f.value), id = randomUUID();
  let stage;
  await assert.rejects(f.host.apply(f.value, id, p.workspaceRevision, event => {
    if (event === "publish:0") {
      const intent = deserializeSubscriptionApplyPlan(readFileSync(join(f.root, "fixture-global-journal", `${id}.intent`), "utf8"));
      const first = intent.material.changes[0];
      stage = join(f.root, first.area, dirname(first.path), `.pkm-write-${id}-0`);
      rmSync(stage); writeFileSync(stage, "unknown replacement");
    }
  }), { code: "RECOVERY_CONFLICT" });
  assert.equal(readFileSync(stage, "utf8"), "unknown replacement");
  await assert.rejects(f.makeHost().recover(id), { code: "RECOVERY_CONFLICT" });
});
