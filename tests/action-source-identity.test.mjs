import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const worker = join(import.meta.dirname, "action-source-identity-worker.mjs");
const invoke = (identity, request) => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  if (identity === undefined) delete env.PKM_ACTION_SOURCE_IDENTITY;
  else env.PKM_ACTION_SOURCE_IDENTITY = identity;
  return JSON.parse(execFileSync(process.execPath, [worker], {
    input: JSON.stringify(request), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env,
  }));
};
async function fixture(t) {
  const directory = join(root, "tests", `.action-source-identity-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("unset identity selects authentic historical v1 and rejects regenerated-v1 pins, receipts and persisted runs", async t => {
  const directory = await fixture(t);
  const result = invoke(undefined, {
    mode: "reject-regenerated-v1", directory,
    // Independent values from captures 3d9241d… and 432371f8…, respectively.
    historicalDigest: "5059f7f0b9739cdf77aa492cb58e649996e7d7e7ec2da80d9bd4574ecf109b9f",
    regeneratedDigest: "aa60284f767a6a6d488338a9d6dc1a81e13358e69cbfa9a4d0c17182a6986d20",
    regeneratedImplementationHash: "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
  });
  assert.deepEqual(result, {
    sourceIdentity: { id: "compiler-capture-v1", evidence: "historical" }, rejected: true, executions: 0,
  });
});

test("explicit v2 matches current frozen ModuleRuntime for packages, get/retrieve, graph pins and pending proposals without qualification", async t => {
  execFileSync(process.execPath, [join(root, "scripts/check-action-source-v2.mjs"), "--check"],
    { stdio: ["ignore", "pipe", "pipe"] });
  const directory = await fixture(t);
  const historical = invoke("compiler-capture-v1", { mode: "package-hash", directory });
  const current = invoke("frozen-original-v2", {
    mode: "parity", directory, historicalPackageHash: historical.contentHash,
  });
  assert.notEqual(current.definitionHash, historical.contentHash);
  assert.deepEqual(current.capabilities.sourceIdentity, { id: "frozen-original-v2", evidence: "fixture-only" });
  assert.deepEqual(invoke("compiler-capture-v1", {
    mode: "reject-proposals", directory, data: current.data, proposal: current.proposal,
  }), { rejected: true });
});

for (const [oldIdentity, newIdentity] of [
  ["compiler-capture-v1", "frozen-original-v2"],
  ["frozen-original-v2", "compiler-capture-v1"],
]) test(`Action admission pins and operation receipts cannot cross ${oldIdentity} into ${newIdentity}`, async t => {
  const directory = await fixture(t);
  const created = invoke(oldIdentity, { mode: "create", directory });
  assert.deepEqual(invoke(newIdentity, { mode: "reject", directory, args: created.args }), { rejected: true });
  assert.deepEqual(invoke(oldIdentity, { mode: "execute", directory, args: created.args }), { executions: 1 });
});

test("unknown Action source identity fails closed at process startup", async t => {
  const directory = await fixture(t);
  const result = spawnSync(process.execPath, [worker], {
    input: JSON.stringify({ mode: "package-hash", directory }), encoding: "utf8",
    env: { ...process.env, PKM_ACTION_SOURCE_IDENTITY: "caller-forged-version" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown PKM_ACTION_SOURCE_IDENTITY/);
});
