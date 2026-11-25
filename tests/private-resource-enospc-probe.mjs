import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createOriginalMcpColdComponentFixture, assertOriginalMcpColdComponentFixture, captureOriginalMcpComponentB0,
} from "../dist/original-mcp-component-recovery.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { atomicFileCreateNoReplace } from "../dist/file-write.js";

// OS/custody probe only. Generic sibling copies never represent private publication/grants/intents.
assert(process.env.PKM_TEST_WORKSPACE, "Run only through the actual private fixture framework.");
const parentNamespaces = JSON.parse(process.argv[2]);
assert.equal(process.pid, 1); assert.equal(process.getuid(), 0);
const namespaces = Object.fromEntries(await Promise.all(["user", "mnt", "net", "pid"].map(async name => {
  const value = await readlink(`/proc/self/ns/${name}`); assert.notEqual(value, parentNamespaces[name]); return [name, value];
})));
const status = await readFile("/proc/self/status", "utf8");
assert(BigInt(`0x${/^CapEff:\s+([a-f0-9]+)$/m.exec(status)[1]}`) & (1n << 21n), "Own namespace CAP_SYS_ADMIN required.");
execFileSync("mount", ["--make-rprivate", "/"], { stdio: "pipe" });
const base = join(homedir(), ".local/state/pkm-v5-recovery");
await mkdir(base, { recursive: true, mode: 0o700 });
const parent = join(base, `enospc-mount-${randomUUID()}`);
await mkdir(parent, { mode: 0o700 });
let mounted = false, opened, fence;
const mount = size => execFileSync("mount", ["-t", "tmpfs", "-o",
  `${mounted ? "remount," : ""}size=${size},mode=0700,nosuid,nodev`, "tmpfs", parent], { stdio: "pipe" });
const pin = stat => [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
const hash = value => createHash("sha256").update(value).digest("hex");
function databaseProof(root) {
  const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(Object.values(database.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.equal(database.prepare("SELECT count(*) AS n FROM migration_runtime_intents").get().n, 0);
    return { integrity: "ok", nativePrivateIntents: 0 };
  } finally { database.close(); }
}
try {
  mount(67108864); mounted = true;
  assert.equal(statfsSync(parent).type, 0x01021994);
  // Mount precedes both fixture identity capture and B0/custody.
  const fixture = await createOriginalMcpColdComponentFixture(join(parent, "fixture"));
  const originalPin = pin(await lstat(fixture.root));
  for (const name of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(fixture.root, name), { mode: 0o700 });
  const source = Buffer.from("---\ntitle: Namespace probe\n---\nSynthetic read-only original fixture.\n");
  await writeFile(join(fixture.root, "notes/Entry.md"), source, { mode: 0o600 });
  await writeFile(join(fixture.root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"], skills: ["Private"], papers: ["Private"] } }), { mode: 0o600 });
  const limits = { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 16777216 };
  fence = await acquireLinuxRootWriterFence(fixture.root);
  const b0 = await captureOriginalMcpComponentB0(fixture, limits, fence);
  await fence.release(); fence = undefined;
  assert.equal(typeof b0.sha256, "string");
  const plan = await captureOriginalMcpCustody({ root: fixture.root, backup: join(fixture.directory, "custody"),
    operatorId: "namespace-enospc-fixture", profileSha256: hash("OS capability probe only"), limits });
  opened = await openOriginalMcpRoot(plan); await opened.owner.ensureFull();
  await assertOriginalMcpColdComponentFixture(fixture);
  await opened.owner.close(); opened = undefined;
  const beforeDatabase = databaseProof(fixture.root);
  const info = statfsSync(parent), used = (info.blocks - info.bfree) * info.bsize;
  mount(used + 1572864);
  assert.equal(pin(await lstat(fixture.root)), originalPin);
  await assertOriginalMcpColdComponentFixture(fixture);
  const copies = join(parent, "os-only-copies"); await mkdir(copies, { mode: 0o700 });
  const first = Buffer.alloc(1048576, 0x5a), second = Buffer.alloc(1048576, 0x6b);
  atomicFileCreateNoReplace(join(copies, "first.bin"), first, randomUUID());
  let physicalError;
  try { atomicFileCreateNoReplace(join(copies, "second.bin"), second, randomUUID()); }
  catch (error) { physicalError = error; }
  assert.equal(physicalError?.code, "ENOSPC", "No simulated error or other filesystem failure qualifies.");
  assert.deepEqual(await readFile(join(copies, "first.bin")), first);
  await assert.rejects(readFile(join(copies, "second.bin")), { code: "ENOENT" });
  assert.deepEqual(databaseProof(fixture.root), beforeDatabase);
  assert.deepEqual(await readFile(join(fixture.root, "notes/Entry.md")), source);
  mount(67108864);
  assert.equal(pin(await lstat(fixture.root)), originalPin);
  await assertOriginalMcpColdComponentFixture(fixture);
  atomicFileCreateNoReplace(join(copies, "second.bin"), second, randomUUID());
  assert.deepEqual(await readFile(join(copies, "second.bin")), second);
  opened = await openOriginalMcpRoot(plan); await opened.owner.ensureFull();
  assert.deepEqual(databaseProof(fixture.root), beforeDatabase);
  await opened.owner.close(); opened = undefined;
  console.log(JSON.stringify({
    scope: "owned namespace OS/tmpfs/custody feasibility only", namespaces,
    tmpfsMountedBeforeBrandAndB0: true, actualColdB0AndCustodyAccepted: true, actualRootOwnerAdmissionAndReopenAccepted: true,
    physicalEnospcObserved: true, exactFirstSiblingCopyCompletedSecondMissing: true, capacityIncreasedWithoutRootIdentityChange: true,
    nativeDatabaseIntegrityPreserved: true, originalSourceBytesUnchanged: true,
    environmentFaultInjection: true, sourceFsMonkeypatch: false, grantMocked: false,
    nativePrivatePendingIntentProduced: false, newEpochPrivateRecoveryQualified: false, installedPublicationQualified: false,
  }));
} finally {
  await opened?.owner.close(); await fence?.release();
  if (mounted) execFileSync("umount", [parent], { stdio: "pipe" });
  await rm(parent, { recursive: true, force: true });
}
