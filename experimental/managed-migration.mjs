import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { constants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyIsolatedManagedGeneration, managedOriginalMcpSourceProtocol } from "./managed-launch-client.mjs";
export { isolatedManagedLaunch, verifyIsolatedManagedGeneration } from "./managed-launch-client.mjs";

const execute = promisify(execFile);
const experimentalRoot = () => dirname(fileURLToPath(import.meta.url));
const schema = "pkm.mcp.lifecycle/v1";
const stagedMode = "core-then-background-v2";
const managedHelpers = ["managed-migration.mjs", "managed-launch-client.mjs", "managed-launcher.py",
  "python-bootstrap.py", "python-dependencies.py"];
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

async function copyRuntimeFile(source, target, budget) {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(budget.remaining))
      throw new Error("Runtime exceeds explicit staging byte budget");
    const disk = await fs.statfs(dirname(target), { bigint: true });
    if (disk.bavail * disk.bsize < before.size + BigInt(budget.minFreeBytes))
      throw new Error("Insufficient destination free space while staging runtime");
    const output = await fs.open(target, "wx", 0o600);
    try {
      const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
      let total = 0;
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - total + 1), null);
        if (!bytesRead) break;
        total += bytesRead;
        if (BigInt(total) > before.size) throw new Error("Runtime source grew while staging");
        digest.update(buffer.subarray(0, bytesRead));
        for (let written = 0; written < bytesRead;) {
          const result = await output.write(buffer, written, bytesRead - written);
          written += result.bytesWritten;
        }
      }
      const after = await input.stat({ bigint: true });
      if (BigInt(total) !== before.size || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key]))
        throw new Error("Runtime source changed while staging");
      await output.sync();
      budget.remaining -= total;
      return digest.digest("hex");
    } finally { await output.close(); }
  } finally { await input.close(); }
}

async function copyTree(source, target, captured = new Map(), budget) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if ([".bin", "__pycache__", ".git"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Linked runtime dependency: ${entry.name}`);
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, captured, budget);
    else if (entry.isFile()) {
      captured.set(from, await copyRuntimeFile(from, to, budget));
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
  repositoryRoot = resolve(experimentalRoot(), ".."), python = "python3", modelDependencies = false,
  maxPythonDependencyBytes = 512 * 1024 * 1024,
} = {}) {
  isolatedPath(repositoryRoot);
  if (typeof modelDependencies !== "boolean" || !Number.isSafeInteger(maxPythonDependencyBytes) || maxPythonDependencyBytes < 1)
    throw new Error("Explicit model dependency profile and positive safe byte budget required");
  const args = ["-I", "-B", join(experimentalRoot(), "python-dependencies.py"),
    ...(modelDependencies ? ["--model-requirements", join(repositoryRoot, "legacy", "resources", "retrieval-model-requirements.txt")] : [])];
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
    else if (entry.isFile() && captured.get(filename) === await hashFile(filename)) count++;
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
    if (process.platform !== "win32") {
      const directory = await fs.open(dirname(filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await fs.rm(pending, { force: true }); }
}

const generationPattern = /^[a-f0-9-]{36}$/;
async function control(root, name, optional = false) {
  try {
    let path = root;
    for (const part of name.split("/")) {
      if (!part || part === "." || part === "..") throw new Error("Invalid managed control path");
      path = join(path, part);
      if ((await fs.lstat(path)).isSymbolicLink()) throw new Error("Linked managed lifecycle control");
    }
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("Invalid managed lifecycle control");
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
}

async function historyLocation(root, data) {
  data ??= (await control(root, ".pkm-isolated-migration")).workspaceData;
  if (!data) return undefined;
  isolatedPath(data);
  const { workspaceStoragePaths } = await import("../dist/workspace-storage-paths.js");
  return { root: workspaceStoragePaths(data).serverData, name: "runtime-control/managed-runtime-history.json" };
}

async function lifecycle(root, data) {
  const location = await historyLocation(root, data);
  const value = (location ? await control(location.root, location.name, true) : undefined)
    ?? await control(root, "runtime-lifecycle.json", true)
    ?? { schema: "pkm.managed-runtime-history/v1", transitions: [], retired: [] };
  if (value.schema !== "pkm.managed-runtime-history/v1" || !Array.isArray(value.transitions)
    || !Array.isArray(value.retired) || value.retired.some(id => !generationPattern.test(id)))
    throw new Error("Invalid durable managed lifecycle history");
  for (const [index, item] of value.transitions.entries())
    if (item.sequence !== index + 1 || !generationPattern.test(item.to)
      || item.from !== null && !generationPattern.test(item.from) || !["prepared", "switched", "aborted"].includes(item.phase))
      throw new Error("Invalid managed transition history");
  return value;
}

async function writeLifecycle(root, value, data) {
  const location = await historyLocation(root, data);
  if (!location) throw new Error("Durable runtime history requires explicit workspace identity");
  const directory = join(location.root, "runtime-control");
  await lock(directory, () => atomicJson(join(location.root, location.name), value), ".managed-runtime-history.guard");
}

async function runtimeStatus(root) {
  for (const name of ["generations", "leases", "staging", "startup-v2"]) {
    const stat = await fs.lstat(join(root, name)).catch(error => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Linked managed lifecycle directory");
  }
  const history = await lifecycle(root);
  const pointer = await control(root, "latest-generation.json", true);
  const baseline = await control(root, "active-generation.json", true);
  if (pointer && (pointer.schema !== schema || !generationPattern.test(pointer.generation)))
    throw new Error("Invalid active managed generation");
  if (baseline && (baseline.schema !== schema || !generationPattern.test(baseline.generation)
    || baseline.compatibilityBaseline !== true)) throw new Error("Invalid compatibility baseline");
  const activeGeneration = baseline ? pointer?.generation ?? baseline.generation : null;
  const candidates = [];
  for (const entry of await fs.readdir(join(root, "generations"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!generationPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Invalid managed generation membership");
    candidates.push(entry.name);
  }
  const leases = [];
  for (const entry of await fs.readdir(join(root, "leases"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!/^[1-9][0-9]*\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink())
      throw new Error("Invalid managed process lease");
    const lease = await control(root, `leases/${entry.name}`);
    if (lease.schema !== "pkm.managed-process-lease/v1" || !generationPattern.test(lease.generation)
      || !Number.isSafeInteger(lease.pid) || `${lease.pid}.json` !== entry.name)
      throw new Error("Invalid managed process lease");
    let live = true;
    try { process.kill(lease.pid, 0); } catch (error) { if (error.code === "ESRCH") live = false; else if (error.code !== "EPERM") throw error; }
    leases.push({ ...lease, live });
  }
  for (const entry of await fs.readdir(join(root, "staging"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!/^[a-f0-9-]{36}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink())
      throw new Error("Invalid managed staging lease");
    const lease = await control(root, `staging/${entry.name}`);
    if (!generationPattern.test(lease.generation) || `${lease.generation}.json` !== entry.name
      || !Number.isSafeInteger(lease.pid) || lease.pid < 1) throw new Error("Invalid managed staging lease");
    let live = true;
    try { process.kill(lease.pid, 0); } catch (error) { if (error.code === "ESRCH") live = false; else if (error.code !== "EPERM") throw error; }
    leases.push({ ...lease, staging: true, live });
  }
  return { activeGeneration, candidates: candidates.sort(), leases, history,
    pendingCleanup: candidates.filter(id => id !== activeGeneration) };
}

/** Status never treats retained admission/history receipts as installed runtime bytes. */
export async function inspectIsolatedManagedRuntime(managedRoot) {
  isolatedPath(managedRoot); await assertOwnedRoot(managedRoot);
  return lock(managedRoot, () => runtimeStatus(managedRoot));
}

/** Never terminates a process or modifies workspace/server data. Live leases defer retirement. */
export async function cleanupIsolatedManagedRuntime(managedRoot) {
  isolatedPath(managedRoot); await assertOwnedRoot(managedRoot);
  return lock(managedRoot, async () => {
    const status = await runtimeStatus(managedRoot);
    if (!status.activeGeneration) throw new Error("Cannot prune before a verified active publication");
    await verifyIsolatedManagedGeneration(managedRoot, status.activeGeneration);
    for (const transition of status.history.transitions)
      if (transition.phase === "prepared") transition.phase = transition.to === status.activeGeneration ? "switched" : "aborted";
    await writeLifecycle(managedRoot, status.history);
    for (const id of status.pendingCleanup) {
      if (status.leases.some(lease => lease.generation === id && lease.live)) continue;
      if (!status.history.retired.includes(id)) {
        status.history.retired.push(id);
        await writeLifecycle(managedRoot, status.history);
      }
      await fs.rm(join(managedRoot, "generations", id), { recursive: true, force: true });
      await fs.rm(join(managedRoot, "startup-v2", `${id}.json`), { force: true });
    }
    for (const lease of status.leases.filter(lease => !lease.live))
      await fs.unlink(join(managedRoot, lease.staging ? "staging" : "leases", lease.staging ? `${lease.generation}.json` : `${lease.pid}.json`));
    return runtimeStatus(managedRoot);
  });
}

async function lock(root, operation, guardName = ".migration-publication-guard") {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (await fs.realpath(root) !== root) throw new Error("Linked managed publication guard directory");
  if (guardName === ".migration-publication-guard" && await fs.lstat(join(root, ".migration-publication-lock")).catch(error => {
    if (error.code === "ENOENT") return undefined; throw error;
  })) throw new Error("Isolated generation publication is busy; legacy lock requires explicit action");
  if (process.platform !== "linux") throw new Error("Crash-recoverable managed publication currently requires Linux advisory locking");
  const guard = join(root, guardName);
  const helper = spawn("python3", ["-I", "-S", "-B", "-c",
    "import fcntl,os,stat,sys\nfd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)\n"
    + "assert stat.S_ISREG(os.fstat(fd).st_mode)\nfcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n"
    + "print('locked',flush=True)\nsys.stdin.buffer.read()\n", guard],
  { stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  helper.stderr.on("data", bytes => { errors = (errors + bytes).slice(-4096); });
  const exited = once(helper, "exit");
  try {
    await new Promise((resolve, reject) => {
      helper.once("error", reject);
      helper.once("exit", () => reject(new Error(`Isolated generation publication is busy or guard unavailable: ${errors}`)));
      helper.stdout.once("data", bytes => String(bytes).trim() === "locked" ? resolve() : reject(new Error("Invalid publication guard")));
    });
    return await operation();
  } finally {
    helper.stdin.end();
    if (helper.exitCode === null) await exited;
  }
}

function isolatedPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error("An absolute normalized isolated path is required");
  return value;
}

async function assertOwnedRoot(root, create = false, startupValidation, workspaceData) {
  if (create) {
    try { await fs.mkdir(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (await fs.realpath(root) !== root) throw new Error("Linked managed roots are forbidden");
  const marker = join(root, ".pkm-isolated-migration");
  try {
    const value = await control(root, ".pkm-isolated-migration");
    if (value.schema !== isolationSchema) throw new Error("Invalid isolated managed root marker");
    if (Object.hasOwn(value, "startupValidation") && value.startupValidation !== stagedMode)
      throw new Error("Unsupported managed startup validation mode");
    if (create && value.startupValidation !== startupValidation)
      throw new Error("A different startup validation policy requires a new managed root and launcher locator");
    if (workspaceData && value.workspaceData && value.workspaceData !== workspaceData)
      throw new Error("Managed runtime cannot change its durable workspace identity");
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    if ((await fs.readdir(root)).length) throw new Error("Refusing to adopt a nonempty or production managed root");
    await fs.writeFile(marker, JSON.stringify({ schema: isolationSchema, ...(workspaceData ? { workspaceData } : {}),
      ...(startupValidation === undefined ? {} : { startupValidation }) }), { flag: "wx", mode: 0o600 });
  }
}

/** Snapshot all JavaScript, Python and adapter dependencies; never publish partial staging. */
export async function stageIsolatedManagedGeneration({
  managedRoot, data, repositoryRoot = resolve(experimentalRoot(), ".."), python = "python3", node = process.execPath, allowWrites = false,
  modelDependencies = false, maxPythonDependencyBytes = 512 * 1024 * 1024,
  snapshotScheduler, maxTotalBytes = 8 * 1024 ** 3, minFreeBytes = 64 * 1024 ** 2,
  coreHostProfile, backendKind = coreHostProfile === undefined ? "native-public-mcp" : "standalone-core",
}) {
  isolatedPath(managedRoot); isolatedPath(data); isolatedPath(repositoryRoot);
  if (typeof allowWrites !== "boolean") throw new Error("Explicit boolean write authority required");
  if (!["native-public-mcp", "standalone-core"].includes(backendKind)
    || (backendKind === "standalone-core") !== (coreHostProfile !== undefined)
    || backendKind === "standalone-core" && (snapshotScheduler !== undefined || !allowWrites))
    throw new Error("Explicit matching backend kind/profile required; Core requires allowWrites:true and cannot use native MCP snapshot enrollment");
  let coreProfileBytes, coreConfigBytes;
  if (coreHostProfile !== undefined) {
    coreProfileBytes = Buffer.from(JSON.stringify(coreHostProfile));
    if (coreProfileBytes.length > 32768) throw new Error("Core host profile exceeds its explicit 32768-byte budget");
    coreHostProfile = JSON.parse(coreProfileBytes);
    const { parseSharedCoreProfile } = await import(pathToFileURL(join(repositoryRoot, "dist", "shared-core-profile.js")).href);
    parseSharedCoreProfile(coreHostProfile);
    coreConfigBytes = Buffer.from(JSON.stringify(coreHostProfile.config));
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0)
    throw new Error("Explicit positive runtime byte budget and nonnegative free-space headroom required");
  if (contains(data, managedRoot) || contains(managedRoot, data)) {
    const { workspaceStoragePaths } = await import(pathToFileURL(join(repositoryRoot, "dist", "workspace-storage-paths.js")).href);
    const paths = workspaceStoragePaths(data);
    if (paths.layout !== "separated" || managedRoot !== join(paths.runtime, "managed-server"))
      throw new Error("Managed runtime and workspace must be separate except the admitted runtime/managed-server storage boundary");
  }
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
      join(repositoryRoot, "dist", "legacy-knowledge-snapshots.js")).href);
    const { coreDatabasePath } = await import(pathToFileURL(join(repositoryRoot, "dist", "workspace-storage-paths.js")).href);
    const database = new DatabaseSync(coreDatabasePath(data), { readOnly: true });
    try {
      const current = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(database, data, snapshotScheduler.admissionSha256);
      if (Object.keys(current).sort().join(",") !== "actorId,admissionSha256,schema,workspaceId"
        || Object.keys(snapshotScheduler).some(name => current[name] !== snapshotScheduler[name]))
        throw new Error("Snapshot scheduler enrollment does not match the existing native host admission");
    } finally { database.close(); }
  }
  const runtimePackage = JSON.parse(await fs.readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (runtimePackage.runtimeMcpFacade !== undefined && runtimePackage.runtimeMcpFacade !== "native-v1")
    throw new Error("Unsupported isolated MCP facade marker.");
  let coreDeclaration;
  const declarationPath = join(repositoryRoot, "deployment-core.json");
  try {
    const stat = await fs.lstat(declarationPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Invalid build startup core declaration");
    coreDeclaration = JSON.parse(await fs.readFile(declarationPath, "utf8"));
    if (coreDeclaration.schema !== "pkm.deployment-core/v2" || coreDeclaration.mode !== stagedMode
      || runtimePackage.runtimeMcpFacade !== "native-v1" || !coreDeclaration.core
      || Object.keys(coreDeclaration.core).length > 32 || !Number.isSafeInteger(coreDeclaration.codeBytes)
      || coreDeclaration.codeBytes < 0 || coreDeclaration.codeBytes > 2 * 1024 * 1024)
      throw new Error("Unsupported build startup core declaration");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const startupValidation = coreDeclaration && snapshotScheduler === undefined && backendKind === "native-public-mcp" ? stagedMode : undefined;
  const dependencies = await planIsolatedPythonDependencies({ repositoryRoot, python, modelDependencies, maxPythonDependencyBytes });
  if (!dependencies.ready) throw new Error(`Isolated Python dependency provisioning refused: ${dependencies.issues.join("; ")}`);
  const disk = await fs.statfs(dirname(managedRoot));
  let measuredBytes = dependencies.totalBytes;
  async function measure(path) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Linked runtime staging source");
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(path)) if (![".bin", "__pycache__", ".git"].includes(name)) await measure(join(path, name));
    } else if (stat.isFile()) measuredBytes += stat.size;
    else throw new Error("Unsupported runtime staging source");
    if (!Number.isSafeInteger(measuredBytes) || measuredBytes > maxTotalBytes) throw new Error("Runtime exceeds explicit staging byte budget");
  }
  for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules", "legacy/resources", ...(coreDeclaration ? ["legacy/dist"] : [])])
    await measure(join(repositoryRoot, name));
  for (const name of managedHelpers) await measure(join(experimentalRoot(), name));
  if (measuredBytes > maxTotalBytes || Number(disk.bavail) * Number(disk.bsize) < measuredBytes + minFreeBytes)
    throw new Error("Insufficient free disk for the measured Python dependency closure");
  await assertOwnedRoot(managedRoot, true, startupValidation, data);
  const generation = randomUUID(), target = join(managedRoot, "generations", generation);
  await lock(managedRoot, async () => {
    await fs.mkdir(join(managedRoot, "staging"), { recursive: true });
    await atomicJson(join(managedRoot, "staging", `${generation}.json`), {
      schema: "pkm.managed-process-lease/v1", pid: process.pid, generation,
    });
    await fs.mkdir(target, { recursive: true });
  });
  try {
    const packageRoot = repositoryRoot;
    const captured = new Map();
    const externalCaptured = new Map();
    const budget = { remaining: maxTotalBytes, minFreeBytes };
    for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules"])
      await copyTree(join(packageRoot, name), join(target, "runtime", "next-server", name), captured, budget);
    await fs.mkdir(join(target, "runtime", "next-server", "experimental"), { recursive: true });
    for (const name of managedHelpers) {
      const source = join(experimentalRoot(), name);
      externalCaptured.set(source, await copyRuntimeFile(source,
        join(target, "runtime", "next-server", "experimental", name), budget));
    }
    const packageManifest = join(packageRoot, "package.json"), packageBytes = await fs.readFile(packageManifest);
    await fs.writeFile(join(target, "runtime", "next-server", "package.json"), packageBytes, { flag: "wx" });
    externalCaptured.set(packageManifest, hash(packageBytes));
    if (coreDeclaration) {
      const declaration = await fs.readFile(declarationPath);
      await fs.writeFile(join(target, "runtime", "next-server", "deployment-core.json"), declaration, { flag: "wx" });
      externalCaptured.set(declarationPath, hash(declaration));
    }
    await copyTree(join(repositoryRoot, "legacy", "resources"),
      join(target, "runtime", "next-server", "legacy", "resources"), captured, budget);
    if (coreDeclaration) {
      await copyTree(join(repositoryRoot, "legacy", "dist"),
        join(target, "runtime", "next-server", "legacy", "dist"), captured, budget);
      const legacyPackage = join(repositoryRoot, "legacy", "package.json"), bytes = await fs.readFile(legacyPackage);
      await fs.writeFile(join(target, "runtime", "next-server", "legacy", "package.json"), bytes, { flag: "wx" });
      externalCaptured.set(legacyPackage, hash(bytes));
    }
    for (const [name, source] of Object.entries(dependencies.files)) {
      const destination = join(target, "runtime", "site-packages", name);
      if (name.includes("\\") || !contains(join(target, "runtime", "site-packages"), destination))
        throw new Error("Unsafe Python dependency path");
      await fs.mkdir(dirname(destination), { recursive: true });
      externalCaptured.set(source, await copyRuntimeFile(source, destination, budget));
    }
    await fs.writeFile(join(target, "launch.json"), JSON.stringify({
      data, allowWrites, ...(snapshotScheduler === undefined ? {} : { snapshotScheduler }),
    }), { flag: "wx" });
    if (coreProfileBytes) {
      await fs.writeFile(join(target, "core-host.json"), coreProfileBytes, { flag: "wx", mode: 0o600 });
      await fs.writeFile(join(target, "core-host-config.json"), coreConfigBytes, { flag: "wx", mode: 0o600 });
      if (!(await fs.lstat(join(target, "runtime", "next-server", "dist", "shared-core-backend.js"))).isFile())
        throw new Error("Standalone Core requires its immutable managed backend entry");
    }
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
    const originalMcpSourceProtocol = await managedOriginalMcpSourceProtocol(target, files);
    const manifest = { schema, generation, managedRoot, version: "0.1.0", extensionVersion: "0.1.0", launcherSha256: hash(launcher),
      components, enabledFeatureDomains: [], experimental: true, runtimeBuild: digest(files), files,
      backendKind, backendAbi: backendKind === "standalone-core" ? "pkm.shared-core-http/v1" : "pkm.mcp.api/1",
      ...(coreProfileBytes ? { coreHostProfileSha256: hash(coreProfileBytes) } : {}),
      node: interpreters.node.path, interpreters, pythonDistributions: dependencies.distributions,
      pythonDependencyProfile: dependencies.profile,
      ...(startupValidation ? { startupValidation } : {}),
      compatibility: { protocol: backendKind === "standalone-core" ? "pkm.shared-core-http/v1" : "pkm.mcp.api/1",
        components: Object.fromEntries(Object.keys(components).map(name => [name, "0"])),
        ...(originalMcpSourceProtocol ? { originalMcpSourceProtocol } : {}) } };
    await fs.writeFile(join(target, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    let stagedBytes = 0;
    for (const name of [...Object.keys(files), "manifest.json"]) stagedBytes += (await fs.stat(join(target, name))).size;
    const remainingDisk = await fs.statfs(target, { bigint: true });
    if (stagedBytes > maxTotalBytes || remainingDisk.bavail * remainingDisk.bsize < BigInt(minFreeBytes))
      throw new Error("Runtime metadata or destination exceeded the explicit staging budget");
    if (startupValidation) {
      const core = Object.fromEntries(Object.entries(coreDeclaration.core).map(([name, pin]) => [
        `runtime/next-server/${name}`, pin,
      ]));
      for (const name of ["launch.json", "platform.json", "runtime/next-server/package.json",
        "runtime/next-server/deployment-core.json"]) core[name] = files[name];
      let coreBytes = 0;
      for (const [name, pin] of Object.entries(core)) {
        if (typeof name !== "string" || name.includes("\\") || !contains(target, join(target, name))
          || files[name] !== pin) throw new Error("Build startup core does not match the snapshotted generation");
        coreBytes += (await fs.stat(join(target, name))).size;
      }
      if (Object.keys(core).length > 32 || coreBytes > 2 * 1024 * 1024)
        throw new Error("Build startup core exceeds its explicit budget");
      const { files: _files, ...identity } = manifest;
      await fs.mkdir(join(managedRoot, "startup-v2"), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(managedRoot, "startup-v2", `${generation}.json`), JSON.stringify({
        schema: "pkm.deployment-startup/v2", mode: stagedMode, manifest: identity,
        manifestSha256: await hashFile(join(target, "manifest.json")), core, coreBytes,
      }), { flag: "wx", mode: 0o600 });
    }
    // Installation is isolated to the caller's root; never replace any existing launcher.
    try { await fs.writeFile(join(managedRoot, "launch.py"), launcher, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || !launcher.equals(await fs.readFile(join(managedRoot, "launch.py"))))
        throw new Error("Existing isolated launcher differs; explicit migration required");
    }
    await verifyIsolatedManagedGeneration(managedRoot, generation);
    let verified = await verifySourceTree(join(repositoryRoot, "legacy", "resources"), captured);
    if (coreDeclaration) verified += await verifySourceTree(join(repositoryRoot, "legacy", "dist"), captured);
    for (const name of ["dist", "compat", "compute", "domain", "browser", "node_modules"])
      verified += await verifySourceTree(join(packageRoot, name), captured);
    if (verified !== captured.size) throw new Error("Runtime source entries changed while staging; rebuild and stage again");
    for (const [filename, expected] of externalCaptured)
      if (await hashFile(filename) !== expected) throw new Error("Runtime dependency changed while staging; rebuild and stage again");
    return manifest;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    if (startupValidation) await fs.rm(join(managedRoot, "startup-v2", `${generation}.json`), { force: true });
    throw error;
  } finally {
    await fs.rm(join(managedRoot, "staging", `${generation}.json`), { force: true });
  }
}

/** One atomic latest pointer is the commit boundary; compatibility baseline never changes. */
export async function publishIsolatedManagedGeneration(managedRoot, generation) {
  isolatedPath(managedRoot);
  await assertOwnedRoot(managedRoot);
  return lock(managedRoot, async () => {
    const manifest = await verifyIsolatedManagedGeneration(managedRoot, generation);
    const launch = await control(managedRoot, `generations/${generation}/launch.json`);
    const marker = await control(managedRoot, ".pkm-isolated-migration");
    isolatedPath(launch.data);
    if (marker.workspaceData && marker.workspaceData !== launch.data)
      throw new Error("Managed runtime cannot change its durable workspace identity");
    if (!marker.workspaceData) await atomicJson(join(managedRoot, ".pkm-isolated-migration"), { ...marker, workspaceData: launch.data });
    const pointer = { schema, generation, ...(manifest.startupValidation ? {
      startupValidation: manifest.startupValidation,
      startupReceiptSha256: await hashFile(join(managedRoot, "startup-v2", `${generation}.json`)),
    } : {}) };
    const baseline = join(managedRoot, "active-generation.json");
    const latest = join(managedRoot, "latest-generation.json");
    try { await fs.access(baseline); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Without a baseline neither the original client nor the launcher can admit
      // calls. Install it last so a failed first publication cannot become active.
      const history = await lifecycle(managedRoot);
      for (const transition of history.transitions) if (transition.phase === "prepared") transition.phase = "aborted";
      history.transitions.push({ sequence: history.transitions.length + 1, from: null, to: generation,
        phase: "prepared", dataRollback: false });
      await writeLifecycle(managedRoot, history);
      await atomicJson(latest, pointer);
      try { await atomicJson(baseline, { ...pointer, compatibilityBaseline: true }); }
      catch (error) { await fs.rm(latest, { force: true }); throw error; }
      history.transitions.at(-1).phase = "switched";
      await writeLifecycle(managedRoot, history);
      return manifest;
    }
    const before = JSON.parse(await fs.readFile(baseline, "utf8"));
    if (before.schema !== schema || before.compatibilityBaseline !== true)
      throw new Error("Not an isolated compatible publication baseline");
    const currentPointer = await control(managedRoot, "latest-generation.json");
    const current = await verifyIsolatedManagedGeneration(managedRoot, currentPointer.generation);
    if ((current.backendKind ?? "native-public-mcp") !== (manifest.backendKind ?? "native-public-mcp")
      || (current.backendAbi ?? "pkm.mcp.api/1") !== (manifest.backendAbi ?? "pkm.mcp.api/1"))
      throw new Error("Incompatible backend kind or ABI; a separate managed backend admission is required");
    if (!isDeepStrictEqual(current.compatibility, manifest.compatibility))
      throw new Error("Incompatible runtime; explicit data migration is required, not rollback");
    const launchBefore = await control(managedRoot, `generations/${current.generation}/launch.json`);
    const launchAfter = await control(managedRoot, `generations/${manifest.generation}/launch.json`);
    if (launchBefore.data !== launchAfter.data)
      throw new Error("Compatible runtime publication cannot change durable workspace identity");
    const history = await lifecycle(managedRoot);
    for (const transition of history.transitions)
      if (transition.phase === "prepared") transition.phase = transition.to === current.generation ? "switched" : "aborted";
    const transition = { sequence: history.transitions.length + 1, from: current.generation,
      to: generation, phase: "prepared", dataRollback: false };
    history.transitions.push(transition);
    await writeLifecycle(managedRoot, history);
    await atomicJson(latest, pointer);
    transition.phase = "switched";
    await writeLifecycle(managedRoot, history);
    return manifest;
  });
}

export async function isolatedManagedBackendLaunch(managedRoot, expectedKind = "standalone-core") {
  const pointer = await control(managedRoot, "latest-generation.json");
  const manifest = await verifyIsolatedManagedGeneration(managedRoot, pointer.generation);
  if (expectedKind !== "standalone-core" || manifest.backendKind !== expectedKind || manifest.backendAbi !== "pkm.shared-core-http/v1")
    throw new Error("Explicit standalone Core backend kind and ABI are required");
  const directory = join(managedRoot, "generations", manifest.generation);
  const launch = await control(managedRoot, `generations/${manifest.generation}/launch.json`);
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
    PKM_ISOLATED_PYTHON_COMMAND: manifest.interpreters.python.path,
    PKM_ISOLATED_PYTHON_BOOTSTRAP: join(directory, "python-bootstrap.py") };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME"]) delete env[name];
  return { command: manifest.interpreters.node.path,
    args: [join(directory, "runtime", "next-server", "dist", "shared-core-backend.js"),
      "--managed-generation", directory, "--profile", join(directory, "core-host.json"), "--data", launch.data],
    cwd: directory, env };
}

/** Admission guard spans verification, actual spawn and registration; PID lease survives supervisor death. */
export async function withIsolatedManagedGenerationAdmission(managedRoot, generation, expectedKind, start) {
  isolatedPath(managedRoot); await assertOwnedRoot(managedRoot);
  if (typeof start !== "function" || !generationPattern.test(generation)) throw new Error("Explicit backend spawn admission required");
  return lock(managedRoot, async () => {
    const launch = await isolatedManagedBackendLaunch(managedRoot, expectedKind);
    const pointer = await control(managedRoot, "latest-generation.json");
    if (pointer.generation !== generation) throw new Error("Backend admission generation pin changed");
    const result = await start(launch);
    if (!result || !Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error("Actual spawned backend PID required");
    process.kill(result.pid, 0);
    const leases = join(managedRoot, "leases");
    await fs.mkdir(leases, { recursive: true, mode: 0o700 });
    if (await fs.realpath(leases) !== leases) throw new Error("Linked backend process lease directory");
    await atomicJson(join(leases, `${result.pid}.json`), {
      schema: "pkm.managed-process-lease/v1", pid: result.pid, generation,
    });
    return result.value;
  });
}
