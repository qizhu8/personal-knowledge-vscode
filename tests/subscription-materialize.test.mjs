import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanMarkdown } from "../dist/markdown.js";
import { readNotes } from "../dist/notes.js";
import { readSkills } from "../dist/skills.js";
import { previewSubscriptionMaterialize, planSubscriptionMaterialize, recoverSubscriptionMaterialize } from "../dist/subscription-materialize.js";
import { subscriptionMaterializeDefinitions } from "../dist/subscription-materialize-contracts.js";

const hash = data => createHash("sha256").update(data).digest("hex");
const allow = (actor, source, action) => actor === "reader:alice" && source.capabilityId === "cap-verified" && action === "fork";
const actor = "reader:alice";
async function fixture(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), `subscription-materialize-work-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function input(bundle, area, paths) {
  const snapshot = JSON.stringify(bundle);
  return {
    source: { subscriptionId: "sub-1", nodeId: "node-1", shareId: "share-1", capabilityId: "cap-verified",
      brokerName: "Creative", publisherUser: "alice", publisherHost: "host", revision: 3, collectionHash: `sha256:${hash(snapshot)}` },
    snapshot, area, paths,
  };
}
function asset(area, path, data) {
  const bytes = Buffer.from(data);
  return { type: area, path, data: bytes.toString("base64"), digest: `sha256:${hash(bytes)}` };
}
function plan(root, value) {
  const preview = previewSubscriptionMaterialize(root, value, actor, allow);
  return planSubscriptionMaterialize(root, value, actor, allow, randomUUID(), preview.workspaceRevision);
}
async function applyFixture(root, changes) {
  for (const change of changes) {
    const full = join(root, change.area, change.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(change.afterBase64, "base64"), { flag: "wx" });
  }
}
const note = "---\ndocumentId: source-note\ntitle: Source\ncustom:\n  keep: yes\n---\n# Source\n\n[Next](Next.md)\n![image](Source.assets/image.png)\n";
const next = "---\ndocumentId: source-next\ntitle: Next\n---\n# Next\n";

test("exact snapshot fork plan preserves Markdown, references, paired assets and note projections", async t => {
  const root = await fixture(t);
  const value = input({ notes: [{ slug: "Team/Source", content: note }, { slug: "Team/Next", content: next }],
    assets: [asset("notes", "Team/Source.assets/image.png", "image"), asset("notes", "Team/Source.assets/unreferenced.bin", "extra")] }, "notes", ["Team/Source.md", "Team/Next.md"]);
  const preview = previewSubscriptionMaterialize(root, value, actor, allow);
  assert.equal(preview.assets.length, 2);
  assert.equal(preview.mappings.find(x => x.sourcePath.endsWith("Source.md")).sourceAlias, "note:Team/Source");
  assert.match(preview.mappings[0].destinationAlias, /^note:_folk_Creative/);
  assert.deepEqual(subscriptionMaterializeDefinitions[0].output.parse(preview), preview);
  const intent = plan(root, value);
  assert.deepEqual(subscriptionMaterializeDefinitions[1].output.parse(intent.result), intent.result);
  assert.equal(recoverSubscriptionMaterialize(JSON.parse(JSON.stringify(intent)), actor, intent.operationId, intent.changes.map(() => null)).completed, 0);
  await applyFixture(root, intent.changes);
  assert.equal(recoverSubscriptionMaterialize(intent, actor, intent.operationId, intent.changes.map(x => x.afterSha256)).completed, intent.changes.length);
  assert.equal(await readFile(join(root, "notes", preview.mappings.find(x => x.identity === "source-note").destinationPath), "utf8"), note);
  const documents = scanMarkdown(root);
  const list = readNotes(root, documents, { operation: "knowledge.note.list", args: { offset: 0, limit: 20 }, actorId: actor });
  assert.equal(list.total, 2);
  assert(list.items.some(x => x.title === "Source" && x.documentId === "source-note"));
  assert.equal(documents.find(x => x.record.id === "source-note").metadata.toJS().custom.keep, "yes");
  assert.throws(() => plan(root, value), { code: "CONFLICT" });
});

test("skills fork is consumed by skill projection and does not invent an identity", async t => {
  const root = await fixture(t);
  const raw = "---\nname: Source Skill\ntags: [test]\n---\nSkill body\n";
  const value = input({ skills: [{ name: "Skill", metadata: { category: "Group" }, content: raw }] }, "skills", ["Group/Skill.md"]);
  const intent = plan(root, value);
  assert.equal(intent.result.mappings[0].identity, null);
  await applyFixture(root, intent.changes);
  const docs = scanMarkdown(root);
  assert.equal(readSkills(root, docs, { operation: "knowledge.skill.list", args: { offset: 0, limit: 10 }, actorId: actor }).items[0].name, "Source Skill");
  assert.match(docs[0].record.id, /^legacy_/);
});

test("Note subscription snapshots and workspace scans exceed former count and byte limits", async t => {
  const root = await fixture(t);
  const notes = Array.from({ length: 513 }, (_, index) => ({
    slug: `Note-${index}`,
    content: index === 0 ? "x".repeat(1_100_000) : "x".repeat(33_000),
  }));
  const value = input({ notes }, "notes", notes.map(item => `${item.slug}.md`));
  const preview = previewSubscriptionMaterialize(root, value, actor, allow);
  assert.equal(preview.mappings.length, 513);
  assert(preview.totalBytes > 16 * 1024 * 1024);

  const assets = join(root, "notes", ".trash", "Existing");
  await mkdir(assets, { recursive: true });
  for (let index = 0; index < 8193; index++) {
    await writeFile(join(assets, `file-${index}.bin`), "");
  }
  assert.doesNotThrow(() => previewSubscriptionMaterialize(root, value, actor, allow));
});

test("subscription snapshots retain the existing Skills limits", async t => {
  const root = await fixture(t);
  const largeSkill = input({ skills: [{ name: "Large", content: "x".repeat(1_048_577) }] }, "skills", ["Large.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, largeSkill, actor, allow), { code: "INVALID_DOCUMENT" });

  const skills = Array.from({ length: 4097 }, (_, index) => ({ name: `Skill-${index}`, content: "x" }));
  const tooMany = input({ skills }, "skills", skills.map(item => `${item.name}.md`));
  assert.equal(subscriptionMaterializeDefinitions[0].input.safeParse(tooMany).success, false);
});

test("reject denied, changed, incomplete and unsafe snapshots", async t => {
  const root = await fixture(t);
  const value = input({ notes: [{ slug: "Team/Source", content: note }] }, "notes", ["Team/Source.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, value, actor, () => false), { code: "ACCESS_DENIED" });
  assert.throws(() => previewSubscriptionMaterialize(root, { ...value, source: { ...value.source, capabilityId: "forged" } }, actor, allow), { code: "ACCESS_DENIED" });
  assert.throws(() => previewSubscriptionMaterialize(root, { ...value, snapshot: value.snapshot + " " }, actor, allow), { code: "CONFLICT" });
  assert.throws(() => previewSubscriptionMaterialize(root, value, actor, allow), { code: "INCOMPLETE" });
  const bad = input({ notes: [{ slug: "../escape", content: "x" }] }, "notes", ["safe.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, bad, actor, allow), { code: "INVALID_DOCUMENT" });
  const badAsset = input({ notes: [{ slug: "A", content: "![x](A.assets/x)" }], assets: [{ ...asset("notes", "A.assets/x", "x"), digest: `sha256:${"0".repeat(64)}` }] }, "notes", ["A.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, badAsset, actor, allow), { code: "CONFLICT" });
  const missingOwner = input({ notes: [{ slug: "A", content: "![x](B.assets/x)" }],
    assets: [asset("notes", "B.assets/x", "x")] }, "notes", ["A.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, missingOwner, actor, allow), { code: "INCOMPLETE" });
  const fileParent = input({ notes: [{ slug: "A", content: "A" }, { slug: "A.md/B", content: "B" }] }, "notes", ["A.md", "A.md/B.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, fileParent, actor, allow), { code: "CONFLICT" });
  const cycle = input({ notes: [{ slug: "A", content: "[B](B.md)" }, { slug: "B", content: "[A](A.md)" }] }, "notes", ["A.md", "B.md"]);
  assert.equal(plan(root, cycle).changes.length, 2, "cyclic document references are finite and preserved");
});

test("identity conflicts, destination symlinks, stale scans and interrupted ordered states fail closed", async t => {
  const root = await fixture(t);
  const value = input({ notes: [{ slug: "A", content: "---\ndocumentId: existing\n---\nBody\n" }] }, "notes", ["A.md"]);
  await writeFile(join(root, "notes", "existing.md"), "---\ndocumentId: existing\n---\nLocal\n");
  assert.throws(() => previewSubscriptionMaterialize(root, value, actor, allow), { code: "CONFLICT" });
  await rm(join(root, "notes", "existing.md"));
  await writeFile(join(root, "notes", "local.md"), "---\naliases: [note:shared]\n---\nLocal\n");
  const alias = input({ notes: [{ slug: "A", content: "---\naliases: [note:shared]\n---\nSource\n" }] }, "notes", ["A.md"]);
  assert.throws(() => previewSubscriptionMaterialize(root, alias, actor, allow), { code: "CONFLICT" });
  await rm(join(root, "notes", "local.md"));
  const p = previewSubscriptionMaterialize(root, value, actor, allow);
  await writeFile(join(root, "notes", "other.md"), "# Change\n");
  assert.throws(() => planSubscriptionMaterialize(root, value, actor, allow, randomUUID(), p.workspaceRevision), { code: "CONFLICT" });
  await rm(join(root, "notes", "other.md"));
  await symlink(root, join(root, "notes", p.forkRoot));
  assert.throws(() => previewSubscriptionMaterialize(root, value, actor, allow));
  await rm(join(root, "notes", p.forkRoot));
  const two = input({ notes: [{ slug: "A", content: "A" }, { slug: "B", content: "B" }] }, "notes", ["A.md", "B.md"]);
  const intent = plan(root, two);
  const first = intent.changes[0], second = intent.changes[1];
  assert.equal(recoverSubscriptionMaterialize(JSON.parse(JSON.stringify(intent)), actor, intent.operationId, [first.afterSha256, null]).completed, 1);
  assert.throws(() => recoverSubscriptionMaterialize(intent, actor, intent.operationId, [null, second.afterSha256]), { code: "RECOVERY_CONFLICT" });
  assert.throws(() => recoverSubscriptionMaterialize(intent, actor, intent.operationId, ["0".repeat(64), null]), { code: "RECOVERY_CONFLICT" });
  assert.throws(() => recoverSubscriptionMaterialize(intent, "other", intent.operationId, [null, null]), { code: "RECOVERY_CONFLICT" });
  assert.throws(() => recoverSubscriptionMaterialize({ ...intent, changes: intent.changes.slice(0, 1) }, actor, intent.operationId, [null]), { code: "RECOVERY_CONFLICT" });
});
