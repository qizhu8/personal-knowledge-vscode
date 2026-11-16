import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, link, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Storage, initialize } from "../dist/storage.js";
import {
  LEGACY_ACTION_RUNTIME_UNAVAILABLE, admitLegacyActionPackage, legacyActionCatalog,
} from "../dist/legacy-action-catalog.js";
import { legacyActionRead, legacyActionWrite } from "../dist/legacy-action-mcp.js";
import { decodeLegacyActionPackage } from "../dist/legacy-action-package.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { originalActionFixture } from "./legacy-action-original-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const definitionFile = JSON.stringify({ dependencies: {}, casts: {}, examples: [],
  ...JSON.parse(original.moduleSetFile) }, null, 2) + "\n";
const portableManifest = structuredClone(original.moduleSet);
portableManifest.files[`definitions/${original.example.action_id}.json`] = sha(definitionFile);
delete portableManifest.package_hash;
portableManifest.package_hash = originalDigest(portableManifest);
const invoke = (storage, tool, args = {}) => legacyActionCatalog(storage, actor, { tool, arguments: args });
function archive(manifest = portableManifest, options = {}) {
  return execFileSync("python3", ["-c", `
import io,json,sys,zipfile
request=json.load(sys.stdin)
result=io.BytesIO()
with zipfile.ZipFile(result,"w",compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr("manifest.json",json.dumps(request["manifest"]))
 for path,content in request["files"].items(): z.writestr(path,content)
 if request["options"].get("duplicate"): z.writestr("manifest.json","{}")
 if request["options"].get("traversal"): z.writestr("../outside","bad")
sys.stdout.buffer.write(result.getvalue())
`], { input: JSON.stringify({ manifest, files: {
    [`definitions/${original.example.action_id}.json`]: definitionFile,
  }, options }), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
}
const originalCall = (directory, sourceRoot, operation, args = {}) => originalActionFixture(dirname(directory)).json(`
import json,sys
sys.path.insert(0,sys.argv[1])
from action_modules import ModuleRuntime
runtime=ModuleRuntime(sys.argv[2],proposal_mode=True)
runtime.configure_workspace(sys.argv[3])
request=json.load(sys.stdin)
if request["operation"] not in {"module_set_import","module_set_list","module_set_load","module_set_remove","definition","definition_check","register"}:
 raise ValueError("Operation outside original Action fixture scope")
print(json.dumps(getattr(runtime,request["operation"])(**request["arguments"])))
`, [directory, sourceRoot], JSON.stringify({ operation, arguments: args }));
async function fixture(t) {
  const parent = join(root, "tests", `.legacy-action-catalog-${randomUUID()}`);
  const sourceRoot = join(parent, "explicit-source"), sourcePath = join(sourceRoot, "reviewed.zip");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(parent, "original"));
  const data = await initialize(join(parent, "workspace")), bytes = archive();
  await writeFile(sourcePath, bytes);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, data, sourceRoot, sourcePath, bytes, original: join(parent, "original") };
}
async function admit(storage, f, extra = {}) {
  const workspaceId = await storage.workspaceId(), stat = await lstat(f.data);
  return admitLegacyActionPackage(storage, actor, {
    sourceRoot: f.sourceRoot, sourcePath: f.sourcePath, expectedPackageSha256: sha(f.bytes), authorityId: "native-package-owner",
    authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
      && binding.workspaceRoot === f.data && binding.workspaceRootPin === `${stat.dev}:${stat.ino}`
      && binding.sourceRoot === f.sourceRoot && binding.sourcePath === f.sourcePath
      && binding.packageSha256 === sha(f.bytes) && binding.authorityId === "native-package-owner", ...extra,
  });
}

test("native bounded ZIP decoding agrees with independent zipfile and rejects ambiguous or damaged package bytes", () => {
  const bytes = archive(), native = decodeLegacyActionPackage(bytes);
  const independent = JSON.parse(execFileSync("python3", [join(root, "compat/legacy-action-package.py")], {
    input: JSON.stringify({ package: bytes.toString("base64") }), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  assert.deepEqual(native, independent);
  for (const invalid of [archive(portableManifest, { duplicate: true }),
    archive(portableManifest, { traversal: true }), bytes.subarray(0, bytes.length - 1), Buffer.from(bytes)]) {
    if (invalid.length === bytes.length) invalid[45] ^= 0x80;
    assert.throws(() => decodeLegacyActionPackage(invalid));
  }
});

test("original ModuleSet import/list/enable/disable/remove results use real original source and never acquire execution authority", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  const args = { module_set_id: original.moduleSet.module_set_id, version: original.moduleSet.version };
  try {
    await assert.rejects(invoke(storage, "action_module_set_import", { local_path: f.sourcePath }), /host-admitted/);
    await admit(storage, f);
    for (const [tool, method, arguments_] of [
      ["action_module_set_import", "module_set_import", { local_path: f.sourcePath }],
      ["action_module_set_import", "module_set_import", { local_path: f.sourcePath }],
      ["action_module_sets", "module_set_list", {}],
      ["action_module_set_load", "module_set_load", { ...args, enabled: true }],
      ["action_module_sets", "module_set_list", {}],
    ]) {
      const expected = originalCall(f.original, f.sourceRoot, method, arguments_);
      const actual = await invoke(storage, tool, arguments_);
      if (tool === "action_module_set_load" && arguments_.enabled === true) {
        for (const actionId of Object.keys(expected.readiness)) {
          expected.readiness[actionId].reason = LEGACY_ACTION_RUNTIME_UNAVAILABLE;
        }
      }
      assert.deepEqual(actual, expected, tool);
    }
    const installed = originalCall(f.original, f.sourceRoot, "definition", { action_id: original.example.action_id });
    const definition = { ...original.example, action_id: "example.wrapper",
      dependencies: { [original.example.action_id]: installed.content_hash } };
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_definition_check", arguments: { definition } }),
      originalCall(f.original, f.sourceRoot, "definition_check", { definition }));
    await assert.rejects(legacyActionWrite(storage, actor, {
      tool: "action_register", arguments: { definition: original.example },
    }), /Unload the packaged provider/);
    for (const [tool, method, arguments_] of [
      ["action_module_set_load", "module_set_load", { ...args, enabled: false }],
      ["action_module_set_remove", "module_set_remove", args],
      ["action_module_sets", "module_set_list", {}],
    ]) assert.deepEqual(await invoke(storage, tool, arguments_), originalCall(f.original, f.sourceRoot, method, arguments_), tool);
    await assert.rejects(readFile(join(f.data, ".pkm/state/actions/policy.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.data, ".pkm/state/actions/admissions", `${original.example.action_id}.json`)), { code: "ENOENT" });
  } finally { await storage.close(); }
});

test("Action package host approval precedes source access; actor, links, source mutation and runtime identity never grant admission", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  try {
    let approved = false;
    await assert.rejects(admit(storage, { ...f, sourcePath: join(f.sourceRoot, "does-not-exist") }, {
      authorize: () => { approved = true; return false; },
    }), /Native host denied/);
    assert.equal(approved, true);
    await assert.rejects(admitLegacyActionPackage(storage, { ...actor, id: "user:local" }, {
      sourceRoot: f.sourceRoot, sourcePath: f.sourcePath, expectedPackageSha256: sha(f.bytes), authorityId: "spoof",
      authorize: () => true,
    }), /fixed external actor/);
    await link(f.sourcePath, join(f.sourceRoot, "hardlink.zip"));
    await assert.rejects(admit(storage, f), /single-link/);
    await rm(join(f.sourceRoot, "hardlink.zip"));
    await admit(storage, f);
    await writeFile(f.sourcePath, Buffer.concat([f.bytes, Buffer.from("changed")]));
    await assert.rejects(invoke(storage, "action_module_set_import", { local_path: f.sourcePath }), /source changed/);
    await assert.rejects(legacyActionCatalog(storage, { ...actor, canWrite: false }, {
      tool: "action_module_set_import", arguments: { local_path: f.sourcePath },
    }), /write permission/);
    assert.deepEqual(await invoke(storage, "action_module_sets"), { ok: true, module_sets: [] });
  } finally { await storage.close(); }
});

test("immutable native Action package catalog survives restart and relocated backup after the external source is removed", async t => {
  const f = await fixture(t);
  let storage = await Storage.open(f.data);
  try {
    await admit(storage, f);
    await invoke(storage, "action_module_set_import", { local_path: f.sourcePath });
    await invoke(storage, "action_module_set_load", { module_set_id: original.moduleSet.module_set_id, version: original.moduleSet.version });
    const before = await invoke(storage, "action_module_sets");
    await storage.close(); storage = await Storage.open(f.data);
    assert.deepEqual(await invoke(storage, "action_module_sets"), before);
    await rm(f.sourceRoot, { recursive: true });
    const native = await createNativeRuntime({ storage }), backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); }
    await storage.close();
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    storage = await Storage.open(relocated);
    assert.deepEqual(await invoke(storage, "action_module_sets"), before);
    const db = storage.connectNative();
    try { assert.throws(() => db.prepare("DELETE FROM legacy_action_catalog_events").run(), /immutable/); }
    finally { db.close(); }
    await assert.rejects(invoke(storage, "action_module_set_import", { local_path: f.sourcePath }));
  } finally { await storage.close(); }
});

test("rehashed Action catalog metadata cannot replace the ZIP-derived host-admitted package", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  try {
    await admit(storage, f);
    await invoke(storage, "action_module_set_import", { local_path: f.sourcePath });
    const db = storage.connectNative();
    try {
      const admission = db.prepare("SELECT admission_id,payload FROM legacy_action_catalog_admissions").get();
      const value = JSON.parse(admission.payload);
      value.source.manifest.name = "Forged package name";
      const unsigned = { ...value.source.manifest };
      delete unsigned.package_hash;
      value.source.manifest.package_hash = originalDigest(unsigned);
      const payload = JSON.stringify(value), id = sha(payload);
      const triggerNames = ["legacy_action_catalog_admissions_no_update", "legacy_action_catalog_events_no_update"];
      const triggers = triggerNames.map(name => db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql);
      for (const name of triggerNames) db.exec(`DROP TRIGGER ${name}`);
      db.prepare("UPDATE legacy_action_catalog_admissions SET admission_id=?,payload=?,payload_sha256=?")
        .run(id, payload, id);
      const prior = db.prepare("SELECT payload FROM legacy_action_catalog_events WHERE sequence=1").get();
      const changed = JSON.stringify({ ...JSON.parse(prior.payload), admissionId: id });
      db.prepare("UPDATE legacy_action_catalog_events SET payload=?,payload_sha256=? WHERE sequence=1").run(changed, sha(changed));
      for (const trigger of triggers) db.exec(trigger);
    } finally { db.close(); }
    await assert.rejects(invoke(storage, "action_module_sets"), /admission binding changed/);
  } finally { await storage.close(); }
});
