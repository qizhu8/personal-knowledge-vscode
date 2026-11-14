import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("VS Code NodeService utilities cannot be treated as harmless helpers", async () => {
  const dist = process.env.PKM_TEST_NEXT_DIST;
  assert.ok(dist);
  const { isLinuxVscodeUtilityPotentialExtensionHost: isHost } =
    await import(pathToFileURL(resolve(dist, "linux-legacy-writer-quiescence.js")));
  const utility = ["code", "--type=utility", "--utility-sub-type=node.mojom.NodeService",
    "--standard-schemes=vscode-webview,vscode-file"];
  assert.equal(isHost([...utility, "--inspect-port=0"]), true);
  assert.equal(isHost(utility), true);
  assert.equal(isHost(["code", "--type=renderer", "--standard-schemes=vscode-webview"]), false);
  assert.equal(isHost(["other", "--type=utility", "--utility-sub-type=node.mojom.NodeService"]), false);
});

test("a caller-created permit cannot exempt any process or authorize adoption", async t => {
  const dist = process.env.PKM_TEST_NEXT_DIST;
  assert.ok(dist);
  const { inspectLinuxLegacyWriterQuiescence, assertLinuxManagedSnapshotHostPermit } =
    await import(pathToFileURL(resolve(dist, "linux-legacy-writer-quiescence.js")));
  const root = resolve(".migration-test-work", `managed-snapshot-gate-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const forged = { kind: "pkm.linux-managed-snapshot-host/v1" };
  await assert.rejects(inspectLinuxLegacyWriterQuiescence(root, forged), { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
  assert.throws(() => assertLinuxManagedSnapshotHostPermit(root, forged, {
    authorityId: randomUUID(), allowedTools: ["knowledge_snapshot_status"], authorize() { return true; },
  }), { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
});
