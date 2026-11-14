import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { planSync, syncPlanHash } from "../dist/sync-plan.js";
import { projectSkillsOnlySyncInput } from "../dist/sync-skills-only.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { applySyncPlan, initializeSyncApplyJournal } from "../dist/sync-apply.js";
import { prepareSyncTransportPublication, syncTransportApplyStaging } from "../dist/sync-transport-plan.js";
import { fixture } from "./sync-transport-fixture.mjs";

const makeFile = (type, itemId, text) => {
  const content = Buffer.from(text);
  return {
    path: `${type}/${itemId}.md`, type, itemId, member: "", category: "", privacy: "public",
    digest: createHash("sha256").update(content).digest("hex"), contentBase64: content.toString("base64"),
  };
};
const manifest = (files, deletions = []) => ({
  schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
  files, deletions,
});
const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });

test("Skills-only projection preserves the remote Note, Prompt and tombstone regardless of local changes", () => {
  const base = manifest([makeFile("skills", "one", "base"), makeFile("notes", "note", "base note")]);
  const local = manifest([makeFile("skills", "one", "local"), makeFile("notes", "note", "local note")]);
  const tombstone = { type: "prompts", itemId: "deleted", deletedAt: "2026-01-01T00:00:00Z" };
  const remote = manifest([makeFile("skills", "one", "base"), makeFile("notes", "note", "remote note"),
    makeFile("prompts", "prompt", "remote prompt")], [tombstone]);
  const original = { base: snapshot(base), local: snapshot(local), remote: snapshot(remote) };
  const before = JSON.stringify(original);
  const projected = projectSkillsOnlySyncInput(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(projected.sourcePins, { base: original.base.sha256, local: original.local.sha256, remote: original.remote.sha256 });
  assert.deepEqual(projected.input.remote, original.remote);
  assert.deepEqual(projected.input.base.manifest.files.filter(file => file.type !== "skills"),
    remote.files.filter(file => file.type !== "skills"));
  assert.deepEqual(projected.input.local.manifest.deletions, [tombstone]);
  const plan = planSync(projected.input);
  assert.deepEqual(plan.proposals.map(item => [item.type, item.itemId, item.source]), [["skills", "one", "local"]]);
  assert.deepEqual(plan.conflicts, []);
});

test("Skills conflicts remain explicit and invalid original pins cannot be laundered", () => {
  const original = {
    base: snapshot(manifest([makeFile("skills", "one", "base")])),
    local: snapshot(manifest([makeFile("skills", "one", "local")])),
    remote: snapshot(manifest([makeFile("skills", "one", "remote")])),
  };
  const plan = planSync(projectSkillsOnlySyncInput(original).input);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "concurrent-change");
  assert.throws(() => projectSkillsOnlySyncInput({ ...original, local: { ...original.local, sha256: "0".repeat(64) } }),
    /manifest pin mismatch/);
});

test("selection preserves unselected remote Skills and rejects changing scope across versions", () => {
  const chosen = makeFile("skills", "chosen", "chosen base");
  const retained = makeFile("skills", "retained", "remote retained");
  const original = {
    base: snapshot(manifest([chosen, makeFile("skills", "retained", "old retained")])),
    local: snapshot(manifest([makeFile("skills", "chosen", "local chosen"), makeFile("skills", "retained", "local retained"),
      makeFile("skills", "local-only", "unselected local")])),
    remote: snapshot(manifest([chosen, retained])),
  };
  const project = projectSkillsOnlySyncInput(original, member => member.itemId === "chosen").input;
  assert.deepEqual(project.local.manifest.files.find(file => file.itemId === "retained"), retained);
  assert.equal(project.local.manifest.files.some(file => file.itemId === "local-only"), false);
  assert.deepEqual(planSync(project).proposals.map(item => item.itemId), ["chosen"]);
  const changedScope = {
    ...original,
    local: snapshot(manifest([{ ...chosen, category: "Private", privacy: "private" }])),
  };
  assert.throws(() => projectSkillsOnlySyncInput(changedScope, member => member.privacy === "private"), /selection changed/);
});

test("native staged Skills publication retains unselected remote blobs and leaves local files untouched", async () => {
  const skill = makeFile("skills", "one", "base");
  const note = makeFile("notes", "note", "remote note");
  const prompt = makeFile("prompts", "prompt", "remote prompt");
  const f = await fixture({ manifest: manifest([skill, note, prompt]) });
  const directory = resolve("next-server", "tests", `.skills-sync-${randomUUID()}`);
  try {
    mkdirSync(resolve(directory, "skills"), { recursive: true });
    mkdirSync(resolve(directory, "notes"));
    mkdirSync(resolve(directory, "prompts"));
    writeFileSync(resolve(directory, "skills/one.md"), "local skill");
    writeFileSync(resolve(directory, "notes/note.md"), "local note");
    writeFileSync(resolve(directory, "prompts/prompt.md"), "local prompt");
    initializeSyncPlanStore(f.db);
    initializeSyncApplyJournal(f.db);
    const store = new SyncPlanStore(f.db);
    const pin = await f.pin();
    const local = manifest([makeFile("skills", "one", "local skill"), makeFile("notes", "note", "local note"),
      makeFile("prompts", "prompt", "local prompt")]);
    const projected = projectSkillsOnlySyncInput({ base: snapshot(pin.manifest), local: snapshot(local), remote: snapshot(pin.manifest) });
    const request = { sessionId: randomUUID(), actorId: "native-actor", input: projected.input };
    store.create({ ...request, operationId: randomUUID() });
    f.db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(request.sessionId, request.actorId);
    const receipt = applySyncPlan(store, request, directory);
    assert.deepEqual(receipt.operations, []);
    const publication = prepareSyncTransportPublication(f.db, store, { ...request, stagedReceiptId: receipt.applyId },
      pin, syncTransportApplyStaging(f.db, store, request), new Date("2026-11-07T05:59:20.314Z"));
    const result = await f.transport.publish(publication);
    assert.equal(result.state, "published");
    const entries = f.trees.get(result.tree);
    for (const [path, content] of [["notes/note.md", "remote note"], ["prompts/prompt.md", "remote prompt"],
      ["skills/one.md", "local skill"]]) {
      assert.equal(f.blobs.get(entries.find(entry => entry.path === path).sha).toString(), content);
    }
    assert.equal(readFileSync(resolve(directory, "notes/note.md"), "utf8"), "local note");
    assert.equal(readFileSync(resolve(directory, "prompts/prompt.md"), "utf8"), "local prompt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await f.close();
  }
});
