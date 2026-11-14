import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyIsolatedManagedGeneration } from "./managed-launch-client.mjs";
export { isolatedManagedLaunch, verifyIsolatedManagedGeneration } from "./managed-launch-client.mjs";

const execute = promisify(execFile);
const experimentalRoot = () => dirname(fileURLToPath(import.meta.url));
const schema = "pkm.mcp.lifecycle/v1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashFile(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}
const components = Object.fromEntries(["knowledge", "chat", "recipes", "agent_sessions"].map(name => [name, "0.1.0"]));
const isolationSchema = "pkm.isolated-managed-migration/v1";
const digest = files => hash(Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(name => `${name}\0${files[name]}\0`).join(""));
const contains = (parent, child) => {
  const delta = relative(parent, child);
  return !delta || delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
};

async function copyTree(source, target, captured = new Map()) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if ([".bin", "__pycache__", ".git"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Linked runtime dependency: ${entry.name}`);
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, captured);
    else if (entry.isFile()) {
      const before = await fs.readFile(from);
      await fs.writeFile(to, before, { flag: "wx" });
      captured.set(from, hash(before));
    }
    else throw new Error(`Unsupported runtime dependency: ${entry.name}`);
  }
}

async function inventory(root, directory = root) {
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(root, filename));
    else if (entry.isFile()) files[relative(root, filename).split("\\").join("/")] = await hashFile(filename);
    else throw new Error("Runtime inventory contains a link or special file");
  }
  return files;
}

export async function planIsolatedPythonDependencies({
  repositoryRoot = resolve(experimentalRoot(), "../.."), python = "python3", modelDependencies = false,
  maxPythonDependencyBytes = 512 * 1024 * 1024,
} = {}) {
  isolatedPath(repositoryRoot);
  if (typeof modelDependencies !== "boolean" || !Number.isSafeInteger(maxPythonDependencyBytes) || maxPythonDependencyBytes < 1)
    throw new Error("Explicit model dependency profile and positive safe byte budget required");
  const args = ["-I", "-B", join(experimentalRoot(), "python-dependencies.py"),
    ...(modelDependencies ? ["--model-requirements", join(repositoryRoot, "resources", "retrieval-model-requirements.txt")] : [])];
  const { stdout } = await execute(python, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const plan = JSON.parse(stdout);
  if (plan.totalBytes > maxPythonDependencyBytes)
    plan.issues.push(`Python dependency closure requires ${plan.totalBytes} bytes, exceeding explicit budget ${maxPythonDependencyBytes}`);
  return { ...plan, ready: plan.ready && plan.totalBytes <= maxPythonDependencyBytes, maxPythonDependencyBytes };
}

async function verifySourceTree(directory, captured) {
  let count = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if ([".bin", "__pycache__", ".git"].includes(entry.name)) continue;
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) count += await verifySourceTree(filename, captured);
    else if (entry.isFile() && captured.get(filename) === hash(await fs.readFile(filename))) count++;
    else throw new Error("Runtime source changed while staging; rebuild and stage again");
  }
  return count;
}

async function atomicJson(filename, value) {
  const pending = `${filename}.${randomUUID()}.pending`;
  try {
    const file = await fs.open(pending, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
    await fs.rename(pending, filename);
  } finally { await fs.rm(pending, { force: true }); }
}

async function lock(root, operation) {
  await fs.mkdir(root, { recursive: true });
  const filename = join(root, ".migration-publication-lock");
  const file = await fs.open(filename, "wx", 0o600).catch(() => {
    throw new Error("Isolated generation publication is busy; no stale lock takeover");
  });
  try { return await operation(); } finally { await file.close(); await fs.unlink(filename); }
}

function isolatedPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error("An absolute normalized isolated path is required");
  return value;
}

async function assertOwnedRoot(root, create = false) {
  if (create) {
    try { await fs.mkdir(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (await fs.realpath(root) !== root) throw new Error("Linked managed roots are forbidden");
  const marker = join(root, ".pkm-isolated-migration");
  try {
    const value = JSON.parse(await fs.readFile(marker, "utf8"));
    if (value.schema !== isolationSchema) throw new Error("Invalid isolated managed root marker");
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    if ((await fs.readdir(root)).length) throw new Error("Refusing to adopt a nonempty or production managed root");
    await fs.writeFile(marker, JSON.stringify({ schema: isolationSchema }), { flag: "wx", mode: 0o600 });
  }
}

/** Snapshot all JavaScript, Python and adapter dependencies; never publish partial staging. */
export async function stageIsolatedManagedGeneration({
  managedRoot, data, repositoryRoot = resolve(experimentalRoot(), "../.."), python = "python3", node = process.execPath, allowWrites = false,
  modelDependencies = false, maxPythonDependencyBytes = 512 * 1024 * 1024,
  snapshotScheduler,
}) {
  isolatedPath(managedRoot); isolatedPath(data); isolatedPath(repositoryRoot);
  if (typeof allowWrites !== "boolean") throw new Error("Explicit boolean write authority required");
  if (contains(data, managedRoot) || contains(managedRoot, data))
    throw new Error("Managed runtime and disposable workspace must be separate");
  const marker = JSON.parse(await fs.readFile(join(data, ".pkm-next-workspace"), "utf8"));
  if (!marker || !["pkm.next-workspace/v1", "pkm.next-workspace/v2"].includes(marker.schema ?? marker.workspaceVersion))
    throw new Error("An initialized isolated next workspace is required");
  if (await fs.realpath(data) !== data) throw new Error("Linked workspace roots are forbidden");
  if (snapshotScheduler !== undefined) {
    if (!snapshotScheduler || typeof snapshotScheduler !== "object" || Array.isArray(snapshotScheduler)
      || Object.keys(snapshotScheduler).sort().join(",") !== "actorId,admissionSha256,schema,workspaceId"
      || snapshotScheduler.schema !== "pkm.native-snapshot-scheduler/v1"
      || snapshotScheduler.actorId !== "mcp:external"
      || typeof snapshotScheduler.admissionSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(snapshotScheduler.admissionSha256)
      || typeof snapshotScheduler.workspaceId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snapshotScheduler.workspaceId)
      || snapshotScheduler.workspaceId !== marker.id || !allowWrites)
      throw new Error("Snapshot scheduler requires an exact existing workspace enrollment and explicit write authority");
    snapshotScheduler = Object.freeze({ ...snapshotScheduler });
    const { inspectLegacyKnowledgeSnapshotSchedulerEnrollment } = await import(pathToFileURL(
      join(repositoryRoot, "next-server", "dist", "legacy-knowledge-snapshots.js")).href);
    const database = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
    try {
      const current = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(database, data, snapshotScheduler.admissionSha256);
      if (Object.keys(current).sort().join(",") !== "actorId,admissionSha256,schema,workspaceId"
        || Object.keys(snapshotScheduler).some(name => current[name] !== snapshotScheduler[name]))
        throw new Error("Snapshot scheduler enrollment does not match the existing native host admission");
    } finally { database.close(); }
  }
  const dependencies = await planIsolatedPythonDependencies({ repositoryRoot, python, modelDependencies, maxPythonDependencyBytes });
  if (!dependencies.ready) throw new Error(`Isolated Python dependency provisioning refused: ${dependencies.issues.join("; ")}`);
  const disk = await fs.statfs(dirname(managedRoot));
  if (Number(disk.bavail) * Number(disk.bsize) < dependencies.totalBytes)
    throw new Error("Insufficient free disk for the measured Python dependency closure");
  await assertOwnedRoot(managedRoot, true);
  const generation = randomUUID(), target = join(managedRoot, "generations", generation);
  await fs.mkdir(target, { recursive: true });
  try {
    const packageRoot = join(repositoryRoot, "next-server");
    const captured = new Map();
    const externalCaptured = new Map();
    for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules"])
      await copyTree(join(packageRoot, name), join(target, "runtime", "next-server", name), captured);
    const packageManifest = join(packageRoot, "package.json"), packageBytes = await fs.readFile(packageManifest);
    await fs.writeFile(join(target, "runtime", "next-server", "package.json"), packageBytes, { flag: "wx" });
    externalCaptured.set(packageManifest, hash(packageBytes));
    await copyTree(join(repositoryRoot, "resources"), join(target, "runtime", "resources"), captured);
    for (const [name, source] of Object.entries(dependencies.files)) {
      const destination = join(target, "runtime", "site-packages", name);
      if (name.includes("\\") || !contains(join(target, "runtime", "site-packages"), destination))
        throw new Error("Unsafe Python dependency path");
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      externalCaptured.set(source, await hashFile(destination));
    }
    await fs.writeFile(join(target, "launch.json"), JSON.stringify({
      data, allowWrites, ...(snapshotScheduler === undefined ? {} : { snapshotScheduler }),
    }), { flag: "wx" });
    await fs.copyFile(join(experimentalRoot(), "python-bootstrap.py"), join(target, "python-bootstrap.py"));
    const dependencyPins = Object.fromEntries(Object.entries(dependencies.distributionPins).map(([name, value]) => [name, {
      version: value.version, files: Object.fromEntries(Object.keys(value.files).map(filename =>
        [filename, externalCaptured.get(dependencies.files[filename])])),
    }]));
    await fs.writeFile(join(target, "python-dependencies.json"), JSON.stringify({
      schema: dependencies.schema, profile: dependencies.profile, requirementsSha256: dependencies.requirementsSha256,
      totalBytes: dependencies.totalBytes, distributions: dependencyPins,
    }), { flag: "wx" });
    if (modelDependencies) {
      await execute(dependencies.python, ["-I", "-S", "-B", "-c",
        "import sys;sys.path.insert(0,sys.argv[1]);import torch,numpy,sklearn,sentence_transformers,transformers,sentencepiece,yaml,safetensors",
        join(target, "runtime", "site-packages")], {
        timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
    }
    const interpreters = {};
    for (const [name, filename] of Object.entries({ python: dependencies.python, node: await fs.realpath(node) }))
      interpreters[name] = { path: filename, sha256: hash(await fs.readFile(filename)) };
    const launcher = await fs.readFile(join(experimentalRoot(), "managed-launcher.py"));
    await fs.writeFile(join(target, "platform.json"), JSON.stringify({
      interpreters, launcherSha256: hash(launcher), pythonDistributions: dependencies.distributions,
      pythonDependencyProfile: dependencies.profile,
    }), { flag: "wx" });
    const files = await inventory(target);
    const manifest = { schema, generation, managedRoot, version: "0.1.0", extensionVersion: "0.1.0", launcherSha256: hash(launcher),
      components, enabledFeatureDomains: [], experimental: true, runtimeBuild: digest(files), files,
      node: interpreters.node.path, interpreters, pythonDistributions: dependencies.distributions,
      pythonDependencyProfile: dependencies.profile,
      compatibility: { protocol: "pkm.mcp.api/1", components: Object.fromEntries(Object.keys(components).map(name => [name, "0"])) } };
    await fs.writeFile(join(target, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    // Installation is isolated to the caller's root; never replace any existing launcher.
    try { await fs.writeFile(join(managedRoot, "launch.py"), launcher, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || !launcher.equals(await fs.readFile(join(managedRoot, "launch.py"))))
        throw new Error("Existing isolated launcher differs; explicit migration required");
    }
    await verifyIsolatedManagedGeneration(managedRoot, generation);
    let verified = await verifySourceTree(join(repositoryRoot, "resources"), captured);
    for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules"])
      verified += await verifySourceTree(join(packageRoot, name), captured);
    if (verified !== captured.size) throw new Error("Runtime source entries changed while staging; rebuild and stage again");
    for (const [filename, expected] of externalCaptured)
      if (await hashFile(filename) !== expected) throw new Error("Runtime dependency changed while staging; rebuild and stage again");
    return manifest;
  } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
}

/** One atomic latest pointer is the commit boundary; compatibility baseline never changes. */
export async function publishIsolatedManagedGeneration(managedRoot, generation) {
  isolatedPath(managedRoot);
  await assertOwnedRoot(managedRoot);
  return lock(managedRoot, async () => {
    const manifest = await verifyIsolatedManagedGeneration(managedRoot, generation);
    const baseline = join(managedRoot, "active-generation.json");
    const latest = join(managedRoot, "latest-generation.json");
    try { await fs.access(baseline); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Without a baseline neither the original client nor the launcher can admit
      // calls. Install it last so a failed first publication cannot become active.
      await atomicJson(latest, { schema, generation });
      try { await atomicJson(baseline, { schema, generation, compatibilityBaseline: true }); }
      catch (error) { await fs.rm(latest, { force: true }); throw error; }
      return manifest;
    }
    const before = JSON.parse(await fs.readFile(baseline, "utf8"));
    if (before.schema !== schema || before.compatibilityBaseline !== true)
      throw new Error("Not an isolated compatible publication baseline");
    await atomicJson(latest, { schema, generation });
    return manifest;
  });
}
