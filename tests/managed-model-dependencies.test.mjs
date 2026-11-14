import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planIsolatedPythonDependencies, stageIsolatedManagedGeneration,
  verifyIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";
import { initialize } from "../dist/storage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "legacy");
const script = join(root, "experimental", "python-dependencies.py");
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const parent = join(root, "tests", `.model-dependencies-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

test("default real dependency plan remains FastMCP-only and refuses copy before explicit size-budget approval", async t => {
  const plan = await planIsolatedPythonDependencies();
  assert.equal(plan.ready, true, plan.issues.join("; "));
  assert.equal(plan.profile, "fastmcp");
  assert(!plan.distributions.includes("torch"));
  assert(plan.totalBytes > 0);
  assert(plan.distributionPins.fastmcp.version);
  assert(Object.keys(plan.fileSizes).some(name => name.endsWith(".so") || name.endsWith(".pyd")));
  const rejected = await planIsolatedPythonDependencies({ maxPythonDependencyBytes: 1 });
  assert.equal(rejected.ready, false);
  assert(rejected.issues.some(issue => issue.includes("exceeding explicit budget")));
  const parent = await fixture(t), data = await initialize(join(parent, "data"));
  const managedRoot = join(parent, "managed");
  await assert.rejects(stageIsolatedManagedGeneration({ managedRoot, data, maxPythonDependencyBytes: 1 }), /exceeding explicit budget/);
  await assert.rejects(readdir(managedRoot), { code: "ENOENT" }, "Refused provisioning must not start copying");
});

test("model-enabled real plan inventories complete native closure and refuses unsupported installed requirements without copying", async t => {
  const plan = await planIsolatedPythonDependencies({ modelDependencies: true, maxPythonDependencyBytes: 16 * 1024 ** 3 });
  assert.equal(plan.profile, "local-model");
  assert.equal(plan.requirementsSha256, sha(await readFile(join(repositoryRoot, "resources", "retrieval-model-requirements.txt"))));
  // This is a provisioning assessment, not an installed-runtime compatibility waiver.
  if (plan.distributionPins.torch) {
    assert(plan.distributionPins.torch.version);
    assert(Object.keys(plan.distributionPins.torch.files).some(name => /torch\/lib\/.*\.(so|dll|dylib)/.test(name)));
    assert(plan.distributions.includes("transformers"));
    assert(plan.distributions.includes("sentence-transformers"));
  }
  if (!plan.ready) {
    const parent = await fixture(t), data = await initialize(join(parent, "data"));
    const managedRoot = join(parent, "managed");
    await assert.rejects(stageIsolatedManagedGeneration({
      managedRoot, data, modelDependencies: true, maxPythonDependencyBytes: 16 * 1024 ** 3,
    }), /provisioning refused/);
    await assert.rejects(readdir(managedRoot), { code: "ENOENT" });
    assert(plan.issues.some(issue => /Unsupported|Missing|Unsatisfied/.test(issue)));
  }
});

test("dependency collector traverses enabled extras and native resources, pins versions/content, and rejects missing declarations", async t => {
  const parent = await fixture(t);
  const requirements = join(parent, "model-requirements.txt");
  await writeFile(requirements, "torch==2.6.0\ntransformers>=4.36,<5\n");
  for (const [name, bytes] of [["fastmcp.py", "pass\n"], ["torch/lib/libtorch.so", "fixture native bytes"],
    ["transformers.py", "pass\n"], ["nvidia/lib/libfixture.so", "transitive native bytes"], ["extra.py", "pass\n"]]) {
    await mkdir(dirname(join(parent, name)), { recursive: true });
    await writeFile(join(parent, name), bytes);
  }
  const harness = `
import importlib.metadata as metadata, json, runpy, sys
from pathlib import Path
root, script, requirements, missing = sys.argv[1:5]
definitions = {
 "fastmcp": ("3.4.3", ["native[fixture]>=1"], ["fastmcp.py"]),
 "torch": ("2.6.0", ["native>=1"], ["torch/lib/libtorch.so"]),
 "transformers": ("4.50.0", [], ["transformers.py"]),
 "native": ("1.0", ["extra>=1; extra == 'fixture'"], ["nvidia/lib/libfixture.so"]),
 "extra": ("1.0", [], ["extra.py"]),
}
class Distribution:
 def __init__(self, name):
  if name == missing or name not in definitions: raise metadata.PackageNotFoundError(name)
  self.version, self.requires, names = definitions[name]
  self.files = [Path(name) for name in names]
 def locate_file(self, name): return Path(root) / name
metadata.distribution = Distribution
metadata.version = lambda name: Distribution(name).version
sys.argv = [script, "--model-requirements", requirements, "--hash-files"]
runpy.run_path(script, run_name="__main__")
`;
  const collect = missing => JSON.parse(execFileSync("python3",
    ["-I", "-B", "-c", harness, parent, script, requirements, missing], { encoding: "utf8" }));
  const plan = collect("");
  assert.equal(plan.ready, true, plan.issues.join("; "));
  assert.equal(plan.profile, "local-model");
  assert.equal(plan.distributionPins.transformers.version, "4.50.0");
  assert(plan.distributions.includes("extra"));
  assert.equal(plan.fileHashes["torch/lib/libtorch.so"], sha("fixture native bytes"));
  assert.equal(plan.fileHashes["nvidia/lib/libfixture.so"], sha("transitive native bytes"));
  const missing = collect("transformers");
  assert.equal(missing.ready, false);
  assert(missing.issues.some(issue => issue.includes("Missing declared dependency")));
});

test("owned fixture generations record exact version/content pins and reject model profile or native dependency tampering", { timeout: 60_000 }, async t => {
  const parent = await fixture(t), fixtureRepository = join(parent, "fixture-repository");
  const packageRoot = join(fixtureRepository, "next-server");
  for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules"])
    await mkdir(join(packageRoot, name), { recursive: true });
  await mkdir(join(fixtureRepository, "resources"));
  await writeFile(join(packageRoot, "package.json"), '{"type":"module","version":"0.1.0"}');
  await writeFile(join(packageRoot, "dist", "cli.js"), "// Explicit packaging fixture; no runtime connection claim.\n");
  const data = await initialize(join(parent, "data")), managedRoot = join(parent, "managed");
  const manifest = await stageIsolatedManagedGeneration({ managedRoot, data, repositoryRoot: fixtureRepository });
  assert.equal(manifest.pythonDependencyProfile, "fastmcp");
  const directory = join(managedRoot, "generations", manifest.generation);
  const launchPath = join(directory, "launch.json");
  const launchBytes = await readFile(launchPath);
  const launch = JSON.parse(launchBytes);
  assert.equal(Object.hasOwn(launch, "snapshotScheduler"), false,
    "Ordinary immutable generations must never enable a scheduler implicitly");
  await writeFile(launchPath, JSON.stringify({ ...launch, snapshotScheduler: {
    schema: "pkm.native-snapshot-scheduler/v1", workspaceId: randomUUID(),
    actorId: "mcp:external", admissionSha256: "a".repeat(64),
  } }));
  await assert.rejects(verifyIsolatedManagedGeneration(managedRoot, manifest.generation), /inventory|build mismatch/);
  await writeFile(launchPath, launchBytes);
  const pins = JSON.parse(await readFile(join(directory, "python-dependencies.json"), "utf8"));
  assert.equal(pins.profile, "fastmcp");
  assert(pins.distributions.fastmcp.version);
  assert(Object.values(pins.distributions.fastmcp.files).every(value => /^[a-f0-9]{64}$/.test(value)));
  const native = Object.keys(manifest.files).find(name => name.startsWith("runtime/site-packages/") && /\.(so|pyd)$/.test(name));
  assert(native);
  const original = await readFile(join(directory, native));
  await writeFile(join(directory, native), Buffer.concat([original, Buffer.from("tampered")]));
  await assert.rejects(verifyIsolatedManagedGeneration(managedRoot, manifest.generation), /inventory|build mismatch/);
  await writeFile(join(directory, native), original);
  const filename = join(directory, "manifest.json");
  await writeFile(filename, JSON.stringify({ ...manifest, pythonDependencyProfile: "local-model" }));
  await assert.rejects(verifyIsolatedManagedGeneration(managedRoot, manifest.generation), /platform dependency identity/);
});
