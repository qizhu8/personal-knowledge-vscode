import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initialize, Storage } from "../dist/storage.js";
import { legacyRetrievalModelAdmissionDdl, selectLegacyRetrievalModel,
  verifyLegacyRetrievalModels, recoverLegacyRetrievalModels } from "../dist/legacy-retrieval-model.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "test:model-owner", canWrite: true };

test("selection retires model bytes but preserves admissions and recovers interrupted retirement without historical binaries", async t => {
  const parent = resolve("tests", `.asset-retirement-${randomUUID()}`);
  const root = join(parent, "workspace");
  await mkdir(parent); await initialize(root);
  const storage = await Storage.open(root);
  t.after(async () => { await storage.close(); await rm(parent, { recursive: true, force: true }); });
  const identity = await storage.workspaceId();
  const ids = [hash("first"), hash("second")];
  const db = storage.connectNative();
  try {
    db.exec(legacyRetrievalModelAdmissionDdl);
    for (const id of ids) {
      const directory = join(root, "packages/retrieval-models", id);
      await mkdir(join(directory, "model"), { recursive: true });
      const manifest = JSON.stringify({ architecture: "dense-document", files: { "weights.bin": hash(id) } });
      await writeFile(join(directory, "manifest.json"), manifest);
      await writeFile(join(directory, "model/weights.bin"), id);
      const inventory = [
        { path: "manifest.json", size: Buffer.byteLength(manifest), sha256: hash(manifest) },
        { path: "model", size: 0, sha256: hash("directory"), directory: true },
        { path: "model/weights.bin", size: id.length, sha256: hash(id) },
      ];
      const receipt = { package_id: id, actor_id: actor.id, workspace_id: identity,
        authority_id: "offline-fixture", operation_id: randomUUID(), manifest_json: manifest,
        inventory_json: JSON.stringify(inventory) };
      db.prepare("INSERT INTO legacy_retrieval_models VALUES(?,?,?,?,?,?,?,?)")
        .run(...Object.values(receipt), hash(JSON.stringify(receipt)));
    }
    const durable = db.prepare("SELECT * FROM legacy_retrieval_models ORDER BY package_id").all();
    const selected = await selectLegacyRetrievalModel(storage, actor, {
      packageId: ids[0], authorityId: "explicit-test-owner", authorize: () => true,
    });
    assert.equal(selected.active.packageId, ids[0]);
    assert.deepEqual(await readdir(join(root, "packages/retrieval-models")), [ids[0]]);
    assert.deepEqual(db.prepare("SELECT * FROM legacy_retrieval_models ORDER BY package_id").all(), durable);
    await assert.rejects(selectLegacyRetrievalModel(storage, actor, {
      packageId: ids[1], authorityId: "explicit-test-owner", authorize: () => true,
    }), /readmission/);
    const retired = join(root, "packages/retrieval-models", ids[1]);
    await mkdir(retired);
    await writeFile(join(retired, "partial-old-file"), "interrupted cleanup");
    assert.equal(verifyLegacyRetrievalModels(db, root).pendingCleanup.length, 1);
    await storage.withWorkspaceExclusive(async () => {
      recoverLegacyRetrievalModels(db, root, { assertWorkspaceLease: () => storage.assertWorkspaceLease() });
    });
    assert.deepEqual(await readdir(join(root, "packages/retrieval-models")), [ids[0]]);
    assert.equal(verifyLegacyRetrievalModels(db, root).active.packageId, ids[0]);
    assert.equal(await readFile(join(root, "packages/retrieval-models", ids[0], "model/weights.bin"), "utf8"), ids[0]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_retrieval_model_lifecycle").get().n, 1);
    await t.test("retirement UUID shared with a new admission does not claim that package's pending stage", async () => {
      const id = "f".repeat(64), operation = db.prepare("SELECT operation_id FROM legacy_retrieval_model_lifecycle").get().operation_id;
      const parent = join(root, "packages/retrieval-models", `.stage-${operation}`), directory = join(parent, id);
      await mkdir(join(directory, "model"), { recursive: true });
      const manifest = JSON.stringify({ architecture: "dense-document", files: { "weights.bin": hash(id) } });
      await writeFile(join(directory, "manifest.json"), manifest);
      await writeFile(join(directory, "model/weights.bin"), id);
      const inventory = [
        { path: "manifest.json", size: Buffer.byteLength(manifest), sha256: hash(manifest) },
        { path: "model", size: 0, sha256: hash("directory"), directory: true },
        { path: "model/weights.bin", size: id.length, sha256: hash(id) },
      ];
      const receipt = { package_id: id, actor_id: actor.id, workspace_id: identity,
        authority_id: "offline-fixture", operation_id: operation, manifest_json: manifest,
        inventory_json: JSON.stringify(inventory) };
      db.prepare("INSERT INTO legacy_retrieval_models VALUES(?,?,?,?,?,?,?,?)")
        .run(...Object.values(receipt), hash(JSON.stringify(receipt)));
      await storage.withWorkspaceExclusive(async () => {
        recoverLegacyRetrievalModels(db, root, { assertWorkspaceLease: () => storage.assertWorkspaceLease() });
      });
      assert.deepEqual((await readdir(join(root, "packages/retrieval-models"))).sort(), [ids[0], id].sort());
      assert.equal(verifyLegacyRetrievalModels(db, root).active.packageId, ids[0]);
      assert.equal(await readFile(join(root, "packages/retrieval-models", id, "model/weights.bin"), "utf8"), id);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM legacy_retrieval_model_lifecycle").get().n, 1);
    });
  } finally { db.close(); }
});
