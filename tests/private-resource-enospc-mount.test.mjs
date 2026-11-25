import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readlink } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

assert(process.env.PKM_TEST_WORKSPACE, "Use the actual isolated test framework; no fake isolation.");
test("owned USER/MOUNT/NET/PID tmpfs can preserve branded B0/custody/native DB across real sibling-copy ENOSPC and capacity growth", { timeout: 90000 }, async () => {
  const namespaces = Object.fromEntries(await Promise.all(["user", "mnt", "net", "pid"].map(async name =>
    [name, await readlink(`/proc/self/ns/${name}`)])));
  const output = execFileSync("unshare", ["--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--mount-proc",
    process.execPath, resolve("tests/private-resource-enospc-probe.mjs"), JSON.stringify(namespaces)],
  { encoding: "utf8", timeout: 90000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] });
  const proof = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(proof.physicalEnospcObserved, true); assert.equal(proof.actualColdB0AndCustodyAccepted, true);
  assert.equal(proof.actualRootOwnerAdmissionAndReopenAccepted, true); assert.equal(proof.nativeDatabaseIntegrityPreserved, true);
  assert.equal(proof.exactFirstSiblingCopyCompletedSecondMissing, true); assert.equal(proof.nativePrivatePendingIntentProduced, false);
  assert.equal(proof.newEpochPrivateRecoveryQualified, false); assert.equal(proof.installedPublicationQualified, false);
});
