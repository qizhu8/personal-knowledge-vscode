import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { verifyBoundLegacyStateBytes, readLegacySkillMaintenanceGenesis } from "../dist/host-composition-legacy-state.js";
import { verifyLegacySkillMaintenance } from "../dist/legacy-skill-maintenance.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const feedbackPath = "_feedback/skill-usage.jsonl";
const proposalPath = "_proposals/skills/20260102T030405Z-1234abcd-example.md";
const feedback = JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", created: "2026-01-02T03:04:05.123456",
  task_hash: hash("task-not-persisted"), used_skills: ["Example"], outcome: "success",
  observations: ["Original observation"], evidence: ["Original evidence"] }) + "\n";
const proposal = [
  "---", "proposal_id: 20260102T030405Z-1234abcd", 'skill_id: "Example"', `base_hash: "${hash("base")}"`,
  `current_hash: "${hash("current")}"`, "conflict: true", "confidence: 0.8", "created: 2026-01-02T03:04:05.123456",
  "---", "", "# Skill Update Proposal", "", "## Reason", "", "Original reason.", "", "## Evidence", "",
  "- Original evidence", "", "## Proposed Content", "", "Original proposed content.", "",
].join("\n");
async function fixture(t) {
  const root = resolve(`.skill-maintenance-import-${randomUUID()}`), source = join(root, "original"), target = join(root, "target");
  await mkdir(join(source, "notes"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, raw) => {
    const path = join(source, relative); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, raw);
  };
  await put(feedbackPath, feedback); await put(proposalPath, proposal);
  const pythonExecutable = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  return { root, source, target, put, pythonExecutable };
}

test("original Skill advisory artifacts import with immutable genesis pins and survive native restart and relocated backup without formal Skill authority", async t => {
  const f = await fixture(t);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.entries.some(entry => entry.destination?.startsWith("skills/")), false);
  await importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable });
  const storage = await Storage.open(f.target);
  const native = await createNativeRuntime({ storage });
  const backup = join(f.root, "backup"), relocated = join(f.root, "relocated");
  try {
    const db = storage.connectNative();
    try {
      const genesis = readLegacySkillMaintenanceGenesis(db, await storage.workspaceId());
      assert.equal(genesis.files.length, 2);
      assert.equal(verifyLegacySkillMaintenance(db, f.target, genesis).receiptCount, 0);
      await verifyBoundLegacyStateBytes(db, f.target, await storage.workspaceId());
    } finally { db.close(); }
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  } finally { await native.close(); await storage.close(); }
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await Storage.open(relocated);
  const restoredNative = await createNativeRuntime({ storage: restored });
  try {
    for (const [path, raw] of [[feedbackPath, feedback], [proposalPath, proposal]]) {
      assert.equal(await readFile(join(relocated, path), "utf8"), raw);
      assert.equal(await readFile(join(f.source, path), "utf8"), raw);
    }
    assert.equal((await readFile(join(relocated, feedbackPath), "utf8")).includes("task-not-persisted"), false);
  } finally { await restoredNative.close(); await restored.close(); }
});

for (const attack of ["unknown-feedback", "unknown-proposal", "nested", "raw-task", "truncated-jsonl", "proposal-prefix", "proposal-identity", "symlink", "hardlink"]) {
  test(`original advisory artifact importer rejects ${attack} without source changes or target publication`, async t => {
    const f = await fixture(t);
    if (attack === "unknown-feedback") await f.put("_feedback/unknown.json", "{}");
    if (attack === "unknown-proposal") await f.put("_proposals/unknown.md", "unknown");
    if (attack === "nested") await f.put("_proposals/skills/nested/unknown.md", "unknown");
    if (attack === "raw-task") await f.put(feedbackPath, JSON.stringify({ ...JSON.parse(feedback), task: "must-not-persist" }) + "\n");
    if (attack === "truncated-jsonl") await f.put(feedbackPath, feedback.trimEnd());
    if (attack === "proposal-prefix") await f.put(proposalPath, "unparsed prefix\n" + proposal);
    if (attack === "proposal-identity") await f.put(proposalPath, proposal.replace("proposal_id: 20260102T030405Z-1234abcd", "proposal_id: 20260102T030405Z-aaaaaaaa"));
    if (attack === "symlink") { await rm(join(f.source, feedbackPath)); await symlink("../notes", join(f.source, feedbackPath)); }
    if (attack === "hardlink") await link(join(f.source, feedbackPath), join(f.source, "notes/linked.jsonl"));
    const before = await readFile(join(f.source, proposalPath), "utf8");
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false);
    assert.equal(await readFile(join(f.source, proposalPath), "utf8"), before);
    await assert.rejects(readdir(f.target), { code: "ENOENT" });
  });
}

test("source race, unreceipted native artifacts and changed imported genesis fail closed", async t => {
  const f = await fixture(t);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true);
  await f.put(feedbackPath, feedback + feedback);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable }));
  await f.put(feedbackPath, feedback);
  await importLegacyWorkspace(await planLegacyImport(f.source), f.target, { pythonExecutable: f.pythonExecutable });
  await writeFile(join(f.target, proposalPath), proposal + "tampered");
  await assert.rejects(Storage.open(f.target));
  const unowned = join(f.root, "unowned");
  await initialize(unowned);
  await mkdir(join(unowned, "_feedback"));
  await writeFile(join(unowned, feedbackPath), feedback);
  await assert.rejects(Storage.open(unowned));
});

test("backup rejects unreceipted advisory artifacts added after native startup", async t => {
  const f = await fixture(t);
  const unowned = join(f.root, "unowned-backup");
  await initialize(unowned);
  const storage = await Storage.open(unowned);
  const native = await createNativeRuntime({ storage });
  try {
    await mkdir(join(unowned, "_feedback"));
    await writeFile(join(unowned, feedbackPath), feedback);
    await assert.rejects(createWorkspaceBackup(storage, join(f.root, "must-not-publish"),
      { acquireQuiescence: native.acquireWorkspaceQuiescence }), /Unreceipted Skill maintenance artifact/);
    await assert.rejects(readdir(join(f.root, "must-not-publish")), { code: "ENOENT" });
  } finally { await native.close(); await storage.close(); }
});

test("actual original advisory corpus imports more than 512 proposals and more than 2MiB JSONL without control-state caps", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    id: randomUUID(), created: "2026-01-02T03:04:05.123456", task_hash: hash(`private-task-${index}`),
    used_skills: ["Example"], outcome: "success",
    observations: [`Boundary ${index}: ${"Evidence ".repeat(512)}`], evidence: [`original-${index}`],
  }));
  const largeFeedback = rows.join("\n") + "\n";
  assert(Buffer.byteLength(largeFeedback) > 2 * 1024 * 1024);
  await f.put(feedbackPath, largeFeedback);
  const proposals = [];
  for (let index = 0; index < 520; index++) {
    const id = `20260102T030405Z-${index.toString(16).padStart(8, "0")}`;
    const path = `_proposals/skills/${id}-example.md`;
    const raw = proposal.replace("proposal_id: 20260102T030405Z-1234abcd", `proposal_id: ${id}`);
    await f.put(path, raw);
    proposals.push({ path, raw });
  }
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert(plan.statePlan.entries.filter(entry => entry.destination.startsWith("_proposals/skills/")).length > 512);
  await importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable });
  const storage = await Storage.open(f.target);
  const native = await createNativeRuntime({ storage });
  try {
    const db = storage.connectNative();
    try {
      const genesis = readLegacySkillMaintenanceGenesis(db, await storage.workspaceId());
      assert.equal(genesis.files.length, proposals.length + 2);
      await verifyBoundLegacyStateBytes(db, f.target, await storage.workspaceId());
    } finally { db.close(); }
    assert.equal(hash(await readFile(join(f.target, feedbackPath))), hash(largeFeedback));
    for (const { path, raw } of proposals) assert.equal(hash(await readFile(join(f.target, path))), hash(raw));
    assert.equal((await readFile(join(f.target, feedbackPath), "utf8")).trimEnd().split("\n").length, rows.length);
    assert.equal((await readFile(join(f.target, feedbackPath), "utf8")).includes("private-task-"), false);
    assert.equal(hash(await readFile(join(f.source, feedbackPath))), hash(largeFeedback));
    assert.equal(await readFile(join(f.target, proposals.at(-1).path), "utf8"), proposals.at(-1).raw);
  } finally { await native.close(); await storage.close(); }
});
