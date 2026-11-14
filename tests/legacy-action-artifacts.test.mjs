import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup } from "../dist/workspace-backup.js";
import {
  admitLegacyActionArtifactPath, legacyActionArtifact, reconcileLegacyActionArtifact, verifyLegacyActionArtifacts,
} from "../dist/legacy-action-artifacts.js";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const actor = { id: "mcp:external", canWrite: true };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const parent = join(root, "tests", `.legacy-action-artifacts-${randomUUID()}`);
  const selectedRoot = join(parent, "selected");
  await mkdir(selectedRoot, { recursive: true });
  const workspace = await initialize(join(parent, "workspace"));
  const source = join(selectedRoot, "source.bin"), destination = join(selectedRoot, "export.bin");
  const bytes = Buffer.from([0, 255, 13, 10, 4, 8, 63]);
  await writeFile(source, bytes);
  const storage = await Storage.open(workspace);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  return { parent, selectedRoot, workspace, source, destination, bytes, storage };
}
async function admit(f, kind, path, extra = {}) {
  const workspaceId = await f.storage.workspaceId(), rootStat = await lstat(f.workspace);
  const expectedSha256 = kind === "source" ? sha(f.bytes) : undefined;
  return admitLegacyActionArtifactPath(f.storage, actor, {
    kind, selectedRoot: f.selectedRoot, path, authorityId: "explicit-artifact-owner", expectedSha256,
    authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
      && binding.workspaceRoot === f.workspace && binding.workspaceRootPin === `${rootStat.dev}:${rootStat.ino}`
      && binding.kind === kind && binding.selectedRoot === f.selectedRoot && binding.path === path
      && binding.expectedSha256 === (expectedSha256 ?? null) && binding.authorityId === "explicit-artifact-owner",
    ...extra,
  });
}
const call = (f, input, host) => legacyActionArtifact(f.storage, actor, input, host);
function original(f) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json,sys
sys.path.insert(0,sys.argv[1])
from action_modules import ModuleRuntime
r=ModuleRuntime(sys.argv[2],proposal_mode=True)
r.configure_workspace(sys.argv[3])
value=r.import_artifact(sys.argv[4])
exported=r.export_artifact(value["artifact_id"],sys.argv[5])
print(json.dumps({"imported":value,"exported":exported}))
`, join(repository, "resources"), join(f.parent, "original"), f.selectedRoot, f.source,
    join(f.selectedRoot, "original-export.bin")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
}

test("Action artifact import and export match the actual original ModuleRuntime after exact native path grants", async t => {
  const f = await fixture(t), oracle = original(f);
  await assert.rejects(call(f, { tool: "action_artifact_import", local_path: f.source }), /native host admission/);
  await admit(f, "source", f.source);
  await admit(f, "destination", f.destination);
  const database = f.storage.connectNative();
  try { assert.equal(Number(database.prepare("PRAGMA user_version").get().user_version), 27); }
  finally { database.close(); }
  const imported = await call(f, { tool: "action_artifact_import", local_path: f.source });
  assert.match(imported.artifact_id, /^artifact_[a-f0-9]{32}$/);
  assert.match(oracle.imported.artifact_id, /^artifact_[a-f0-9]{32}$/);
  const exported = await call(f, { tool: "action_artifact_export", artifact_id: imported.artifact_id, destination: f.destination });
  assert.deepEqual({ ...exported, path: "<destination>" }, { ...oracle.exported, path: "<destination>" });
  assert.deepEqual(await readFile(f.destination), f.bytes);
  assert.equal((await lstat(f.destination)).mode & 0o777, 0o600);
  await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id: imported.artifact_id, destination: f.destination }), /already exists/);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test("native path approval precedes external access and never grants another actor, source, destination or selected root", async t => {
  const f = await fixture(t);
  const nonexistent = join(f.selectedRoot, "not-present");
  await assert.rejects(admit(f, "source", nonexistent, { authorize: () => false }), /explicit exact native/i);
  await assert.rejects(admit(f, "source", f.source, { expectedSha256: "0".repeat(64), authorize: () => true }), /digest differs/);
  const linked = join(f.selectedRoot, "link");
  await symlink(f.source, linked);
  await assert.rejects(admit(f, "source", linked), /regular file/);
  await admit(f, "source", f.source);
  const imported = await call(f, { tool: "action_artifact_import", local_path: f.source });
  await assert.rejects(legacyActionArtifact(f.storage, { id: "user:local", canWrite: true },
    { tool: "action_artifact_import", local_path: f.source }), /fixed writable external actor/);
  await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id: imported.artifact_id, destination: f.destination }), /host admission/);
  const secondRoot = join(f.parent, "second-root"), secondDestination = join(secondRoot, "export.bin");
  await mkdir(secondRoot);
  await admitLegacyActionArtifactPath(f.storage, actor, { kind: "destination", selectedRoot: secondRoot, path: secondDestination,
    authorityId: "other-approved-root", authorize: binding => binding.selectedRoot === secondRoot && binding.path === secondDestination });
  await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id: imported.artifact_id, destination: secondDestination }),
    /same approved selected workspace/);
  await assert.rejects(lstat(secondDestination), { code: "ENOENT" });
  await admit(f, "destination", f.destination);
  await writeFile(f.source, "mutated");
  await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id: imported.artifact_id, destination: f.destination }), /exact bounded single-link regular file/);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

for (const stage of ["prepared", "pinned", "written"]) test(`uncertain artifact ${stage} is fenced and never replayed automatically`, async t => {
  const f = await fixture(t);
  await admit(f, "source", f.source);
  await admit(f, "destination", f.destination);
  const { artifact_id } = await call(f, { tool: "action_artifact_import", local_path: f.source });
  const runtime = stage === "written" ? await createNativeRuntime({ storage: f.storage }) : undefined;
  await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id, destination: f.destination },
    { checkpoint(value) { if (value === stage) throw new Error("injected crash"); } }), /injected crash/);
  const workspaceId = await f.storage.workspaceId(), database = f.storage.connectNative();
  try { assert.throws(() => verifyLegacyActionArtifacts(database, workspaceId), /reconciliation/); }
  finally { database.close(); }
  await assert.rejects(call(f, { tool: "action_artifact_import", local_path: f.source }), /reconciliation/);
  await assert.rejects(reconcileLegacyActionArtifact(f.storage, actor, () => false), /approval/);
  if (stage === "written") {
    assert.deepEqual(await readFile(f.destination), f.bytes);
    try {
      await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "blocked-backup"),
        { acquireQuiescence: runtime.acquireWorkspaceQuiescence }), /reconciliation/);
    } finally { await runtime.close(); }
    await f.storage.close();
    await assert.rejects(Storage.open(f.workspace), /reconciliation/);
    f.storage = await Storage.open(f.workspace, { deferRecovery: true });
    const approved = await reconcileLegacyActionArtifact(f.storage, actor, binding =>
      binding.workspaceRoot === f.workspace && binding.destination === f.destination
      && binding.artifactId === artifact_id && binding.digest === sha(f.bytes) && !!binding.filePin);
    assert.deepEqual(approved, { reconciled: true });
    await assert.rejects(call(f, { tool: "action_artifact_export", artifact_id, destination: f.destination }), /already exists/);
    await f.storage.close();
  } else {
    await assert.rejects(reconcileLegacyActionArtifact(f.storage, actor, () => true), /Unpinned|do not match/);
  }
});

test("actual process death after artifact publication fences normal restart until exact native reconciliation", { timeout: 55_000 }, async t => {
  const f = await fixture(t);
  await admit(f, "source", f.source);
  await admit(f, "destination", f.destination);
  const { artifact_id } = await call(f, { tool: "action_artifact_import", local_path: f.source });
  await f.storage.close();
  const storageUrl = pathToFileURL(join(root, "dist/storage.js")).href;
  const adapterUrl = pathToFileURL(join(root, "dist/legacy-action-artifacts.js")).href;
  execFileSync(process.execPath, ["--eval", `(async()=>{
const {Storage}=await import(${JSON.stringify(storageUrl)});
const {legacyActionArtifact}=await import(${JSON.stringify(adapterUrl)});
const storage=await Storage.open(process.argv[1]);
await legacyActionArtifact(storage,{id:"mcp:external",canWrite:true},
 {tool:"action_artifact_export",artifact_id:process.argv[2],destination:process.argv[3]},
 {checkpoint(stage){if(stage==="written") process.exit(0)}});
process.exit(2);
})().catch(error=>{console.error(error);process.exit(1)});
`, f.workspace, artifact_id, f.destination], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.deepEqual(await readFile(f.destination), f.bytes);
  const database = new DatabaseSync(join(f.workspace, "core.sqlite"), { readOnly: true });
  let expires;
  try { expires = Number(database.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until); }
  finally { database.close(); }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 50)));
  await assert.rejects(Storage.open(f.workspace), /reconciliation/);
  const recovered = await Storage.open(f.workspace, { deferRecovery: true });
  try {
    assert.deepEqual(await reconcileLegacyActionArtifact(recovered, actor, binding =>
      binding.workspaceRoot === f.workspace && binding.destination === f.destination
      && binding.artifactId === artifact_id && binding.digest === sha(f.bytes) && !!binding.filePin),
    { reconciled: true });
    await recovered.recover();
  } finally { await recovered.close(); }
});
