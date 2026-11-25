import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";

export const stagedValidationMode = "core-then-background-v2";
export const startupSchema = "pkm.deployment-startup/v2";
export const coreSchema = "pkm.deployment-core/v2";
// Reviewed enforcement code, deliberately not its transitive import closure.
export const startupCodeFiles = Object.freeze([
  "dist/cli.js", "dist/native-public-mcp.js", "dist/native-public-mcp-stdio.js",
  "dist/native-public-mcp-lifecycle.js", "dist/native-public-mcp-owner.js",
  "dist/native-public-mcp-note-read.js", "dist/native-public-mcp-contracts.js",
  "dist/root-owner.js", "dist/linux-root-writer-fence.js", "dist/workspace-validation.js",
  "dist/storage-startup-classification.js", "dist/workspace-storage-paths.js", "dist/storage-bootstrap-profile.js",
  "dist/fresh-note-index-storage.js",
  "dist/workspace-runtime-control.js", "dist/workspace-git-protection.js",
  "dist/shared-manager-control.js", "dist/sync-storage-boundary.js",
  "dist/browser-mutation-receipt.js", "dist/mutation-receipt-contracts.js",
  "dist/storage-owner-schema.js", "dist/deployment-integrity.js", "dist/deployment-integrity-worker.js",
]);
export const startupControlFiles = Object.freeze([
  "launch.json", "platform.json", "runtime/next-server/package.json", "runtime/next-server/deployment-core.json",
]);
export const coreByteBudget = 2 * 1024 * 1024;
const chunkBytes = 64 * 1024;
const maximumManifestBytes = 8 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const lifecycleSchema = "pkm.mcp.lifecycle/v1";
type Json = Record<string, any>;
export interface StartupReceipt {
  schema: typeof startupSchema;
  mode: typeof stagedValidationMode;
  manifest: Json;
  manifestSha256: string;
  core: Record<string, string>;
  coreBytes: number;
}
export interface DeploymentFailure { group: "critical" | "browser-ui"; code: string; path: string }
export interface DeploymentAudit {
  state: "verified" | "partial-failure" | "critical-failure" | "cancelled";
  files: number;
  bytes: number;
  failures: DeploymentFailure[];
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
export function deploymentName(name: string) {
  if (typeof name !== "string" || name.length > 1024 || name.includes("\\") || name.includes("\0")
    || name.split("/").some(part => !part || part === "." || part === "..") || isAbsolute(name))
    throw new Error("Invalid deployment entry name.");
  return name;
}
function namedPath(root: string, name: string) {
  deploymentName(name);
  let path = root;
  const parts = name.split("/");
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory())
      throw new Error("Linked or invalid deployment path.");
  }
  return path;
}
export function deploymentBytes(root: string, name: string, maximum: number) {
  const fd = openSync(namedPath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Deployment metadata exceeds its budget.");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maximum + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error("Deployment metadata changed size.");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function jsonBytes(bytes: Buffer): Json {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!object(value)) throw new Error("Invalid deployment metadata.");
  return value;
}
export function deploymentJson(root: string, name: string, maximum = 64 * 1024) {
  return jsonBytes(deploymentBytes(root, name, maximum));
}
export function deploymentFileHash(root: string, name: string) {
  const fd = openSync(namedPath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Deployment entry is not a regular file.");
    const value = createHash("sha256"), buffer = Buffer.alloc(chunkBytes);
    let count: number;
    while ((count = readSync(fd, buffer))) value.update(buffer.subarray(0, count));
    return value.digest("hex");
  } finally { closeSync(fd); }
}
function claims(manifest: Json, root: string, generation: string) {
  if (manifest.schema !== lifecycleSchema || manifest.managedRoot !== root || manifest.generation !== generation
    || manifest.version !== "0.1.0" || manifest.experimental !== true
    || !isDeepStrictEqual(manifest.enabledFeatureDomains, [])
    || !isDeepStrictEqual(manifest.components, { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" })
    || !hashPattern.test(manifest.runtimeBuild) || !hashPattern.test(manifest.launcherSha256)
    || manifest.startupValidation !== stagedValidationMode || !object(manifest.interpreters))
    throw new Error("Invalid staged generation ownership.");
  for (const key of ["node", "python"]) {
    const interpreter = manifest.interpreters[key];
    if (!object(interpreter) || typeof interpreter.path !== "string" || !isAbsolute(interpreter.path)
      || realpathSync(interpreter.path) !== interpreter.path || !hashPattern.test(interpreter.sha256))
      throw new Error("Invalid staged interpreter identity.");
  }
  if (manifest.node !== manifest.interpreters.node.path) throw new Error("Invalid Node ownership.");
}
export function buildDeploymentCore(runtime: string) {
  const core: Record<string, string> = {};
  let bytes = 0;
  for (const name of startupCodeFiles) {
    bytes += deploymentBytes(runtime, name, coreByteBudget).length;
    core[name] = deploymentFileHash(runtime, name);
  }
  if (bytes > coreByteBudget) throw new Error("Reviewed startup core exceeds its byte budget.");
  return { schema: coreSchema, mode: stagedValidationMode, core, codeBytes: bytes };
}
export function readStartupReceipt(directory: string, published = true, verifyCore = true): StartupReceipt | undefined {
  const root = dirname(dirname(directory)), generation = relative(join(root, "generations"), directory);
  let marker: Json;
  try { marker = deploymentJson(root, ".pkm-isolated-migration"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (marker.schema !== "pkm.isolated-managed-migration/v1") throw new Error("Invalid managed root marker.");
  if (!Object.hasOwn(marker, "startupValidation")) return undefined;
  if (marker.startupValidation !== stagedValidationMode) throw new Error("Unsupported startup validation mode.");
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory
    || !/^[a-f0-9-]{36}$/.test(generation)) throw new Error("Invalid deployment generation path.");
  const name = `startup-v2/${generation}.json`, raw = deploymentBytes(root, name, 64 * 1024);
  const receipt = jsonBytes(raw) as StartupReceipt;
  if (published) {
    const baseline = deploymentJson(root, "active-generation.json");
    let latest: Json;
    try { latest = deploymentJson(root, "latest-generation.json"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; latest = baseline; }
    const pointer = latest.generation === generation ? latest : baseline.generation === generation ? baseline : undefined;
    if (!pointer || pointer.schema !== lifecycleSchema || pointer.startupValidation !== stagedValidationMode
      || pointer.startupReceiptSha256 !== hash(raw)) throw new Error("Staged publication receipt mismatch.");
  }
  if (receipt.schema !== startupSchema || receipt.mode !== stagedValidationMode || !object(receipt.manifest)
    || !hashPattern.test(receipt.manifestSha256) || !object(receipt.core) || !Number.isSafeInteger(receipt.coreBytes)
    || receipt.coreBytes < 0 || receipt.coreBytes > coreByteBudget)
    throw new Error("Invalid staged startup receipt.");
  claims(receipt.manifest, root, generation);
  const required = [...startupCodeFiles.map(name => `runtime/next-server/${name}`), ...startupControlFiles].sort();
  if (required.length > 32 || !isDeepStrictEqual(Object.keys(receipt.core).sort(), required))
    throw new Error("Reviewed startup core membership mismatch.");
  if (!verifyCore) return receipt;
  let bytes = 0;
  for (const name of required) {
    if (!hashPattern.test(receipt.core[name])) throw new Error("Invalid startup core digest.");
    const actual = deploymentBytes(directory, name, coreByteBudget);
    bytes += actual.length;
    if (bytes > coreByteBudget || hash(actual) !== receipt.core[name])
      throw new Error("Startup core content mismatch.");
  }
  if (bytes !== receipt.coreBytes) throw new Error("Startup core byte budget mismatch.");
  const declaration = deploymentJson(directory, "runtime/next-server/deployment-core.json");
  if (declaration.schema !== coreSchema || declaration.mode !== stagedValidationMode || !object(declaration.core)
    || !isDeepStrictEqual(Object.keys(declaration.core).sort(), [...startupCodeFiles].sort())
    || startupCodeFiles.some(name => declaration.core[name] !== receipt.core[`runtime/next-server/${name}`]))
    throw new Error("Build-declared startup core mismatch.");
  if (deploymentFileHash(root, "launch.py") !== receipt.manifest.launcherSha256)
    throw new Error("Staged launcher integrity mismatch.");
  const platform = deploymentJson(directory, "platform.json");
  for (const key of ["interpreters", "launcherSha256", "pythonDistributions", "pythonDependencyProfile"])
    if (!isDeepStrictEqual(platform[key], receipt.manifest[key])) throw new Error("Staged platform identity mismatch.");
  const options = deploymentJson(directory, "launch.json");
  if (Object.hasOwn(options, "snapshotScheduler")) throw new Error("Autonomous enrollment requires full-foreground policy.");
  if (deploymentJson(directory, "runtime/next-server/package.json").runtimeMcpFacade !== "native-v1")
    throw new Error("Staged startup requires the native facade marker.");
  return receipt;
}

export async function auditDeployment(directory: string, receipt: StartupReceipt,
  beforeQuantum: () => Promise<void>, checked?: (count: number) => void): Promise<DeploymentAudit> {
  const result: DeploymentAudit = { state: "verified", files: 0, bytes: 0, failures: [] };
  const fail = (name: string, code: string, critical = false) => {
    // Only browser UI resources are proven unused by this native stdio process.
    const group = !critical && name.startsWith("runtime/next-server/browser/") ? "browser-ui" : "critical";
    if (result.failures.length < 8) result.failures.push({ group, code, path: name.slice(0, 256) });
    if (group === "critical") { result.state = "critical-failure"; throw new Error("critical-deployment-failure"); }
    result.state = "partial-failure";
  };
  async function digestFile(root: string, name: string) {
    await beforeQuantum();
    const handle = await fs.open(namedPath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Non-regular deployment entry.");
      const digest = createHash("sha256"), buffer = Buffer.alloc(chunkBytes);
      while (true) {
        await beforeQuantum();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) return digest.digest("hex");
        digest.update(buffer.subarray(0, bytesRead)); result.bytes += bytesRead;
      }
    } finally { await handle.close(); }
  }
  async function metadata(name: string, maximum = 64 * 1024) {
    await beforeQuantum();
    const handle = await fs.open(namedPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum) throw new Error("Deployment metadata budget exceeded.");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        await beforeQuantum();
        const buffer = Buffer.alloc(chunkBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) return Buffer.concat(chunks, total);
        total += bytesRead;
        if (total > maximum) throw new Error("Deployment metadata changed size.");
        chunks.push(buffer.subarray(0, bytesRead)); result.bytes += bytesRead;
      }
    } finally { await handle.close(); }
  }
  async function* walk(path = directory, prefix = "", depth = 0): AsyncGenerator<string> {
    if (depth > 64) throw new Error("Deployment directory depth exceeded.");
    await beforeQuantum();
    for await (const entry of await fs.opendir(path, { bufferSize: 1 })) {
      await beforeQuantum();
      const name = prefix + entry.name;
      deploymentName(name);
      if (entry.isSymbolicLink()) { fail(name, "linked-entry", true); }
      else if (entry.isDirectory()) yield* walk(join(path, entry.name), `${name}/`, depth + 1);
      else if (entry.isFile()) yield name;
      else fail(name, "special-entry", true);
    }
  }
  try {
    await beforeQuantum();
    const currentReceipt = readStartupReceipt(directory, false, false);
    if (!currentReceipt || !isDeepStrictEqual(currentReceipt, receipt))
      fail("startup-receipt", "generation-or-receipt-identity", true);
    const raw = await metadata("manifest.json", maximumManifestBytes);
    if (hash(raw) !== receipt.manifestSha256) fail("manifest.json", "manifest-identity", true);
    const manifest = jsonBytes(raw), expected = manifest.files;
    const { files: _files, ...identity } = manifest;
    if (!isDeepStrictEqual(identity, receipt.manifest)) fail("manifest.json", "receipt-claims", true);
    if (!object(expected) || Object.keys(expected).length > 20000) fail("manifest.json", "inventory-budget", true);
    const build = createHash("sha256");
    for (const name of Object.keys(expected).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      deploymentName(name);
      if (!hashPattern.test(expected[name])) fail(name, "invalid-inventory-digest", true);
      build.update(`${name}\0${expected[name]}\0`);
    }
    if (build.digest("hex") !== manifest.runtimeBuild) fail("manifest.json", "build-identity", true);
    const actual: Record<string, string> = Object.create(null);
    for await (const name of walk()) {
      if (name === "manifest.json") continue;
      if (!Object.hasOwn(expected, name)) fail(name, "unexpected-member", true);
      actual[name] = await digestFile(directory, name); result.files++;
      checked?.(result.files);
      if (actual[name] !== expected[name]) fail(name, "content-mismatch");
    }
    for (const name of Object.keys(expected)) if (!Object.hasOwn(actual, name)) fail(name, "missing-member");
    const platform = jsonBytes(await metadata("platform.json"));
    for (const key of ["interpreters", "launcherSha256", "pythonDistributions", "pythonDependencyProfile"])
      if (!isDeepStrictEqual(platform[key], manifest[key])) fail("platform.json", "platform-identity", true);
    const dependencies = jsonBytes(await metadata("python-dependencies.json", maximumManifestBytes));
    if (!["fastmcp", "local-model"].includes(dependencies.profile) || dependencies.profile !== manifest.pythonDependencyProfile
      || !object(dependencies.distributions)
      || !isDeepStrictEqual(Object.keys(dependencies.distributions).sort(), manifest.pythonDistributions))
      fail("python-dependencies.json", "dependency-profile", true);
    for (const distribution of Object.values(dependencies.distributions) as Json[]) {
      if (typeof distribution.version !== "string" || !distribution.version || !object(distribution.files))
        fail("python-dependencies.json", "dependency-version", true);
      for (const [name, pin] of Object.entries(distribution.files))
        if (actual[`runtime/site-packages/${name}`] !== pin) fail("python-dependencies.json", "dependency-content", true);
    }
    if (dependencies.profile === "local-model" && dependencies.requirementsSha256
      !== actual["runtime/next-server/legacy/resources/retrieval-model-requirements.txt"])
      fail("python-dependencies.json", "model-requirements", true);
    const root = manifest.managedRoot;
    if (await digestFile(root, "launch.py") !== manifest.launcherSha256) fail("launch.py", "launcher-content", true);
    for (const key of ["node", "python"]) {
      const interpreter = manifest.interpreters[key];
      if (realpathSync(interpreter.path) !== interpreter.path
        || await digestFile(dirname(interpreter.path), relative(dirname(interpreter.path), interpreter.path)) !== interpreter.sha256)
        fail(key, "interpreter-content", true);
    }
    if (deploymentJson(directory, "runtime/next-server/package.json").runtimeMcpFacade !== "native-v1")
      fail("runtime/next-server/package.json", "facade-marker", true);
    if (deploymentFileHash(root, `startup-v2/${manifest.generation}.json`)
      !== hash(Buffer.from(JSON.stringify(receipt)))) {
      const current = deploymentJson(root, `startup-v2/${manifest.generation}.json`);
      if (!isDeepStrictEqual(current, receipt)) fail("startup-receipt", "receipt-changed", true);
    }
  } catch (error) {
    if ((error as Error).message === "deployment-audit-cancelled") result.state = "cancelled";
    else if (result.state !== "critical-failure") {
      result.state = "critical-failure";
      result.failures.push({ group: "critical", code: "audit-unavailable", path: "" });
    }
  }
  return result;
}

if (!isMainThread && workerData?.schema === "pkm.deployment-audit-worker/v2") {
  const control = new Int32Array(workerData.control as SharedArrayBuffer);
  void auditDeployment(workerData.directory, workerData.receipt, async () => {
    while (Atomics.load(control, 0) > 0) {
      if (Atomics.load(control, 1)) throw new Error("deployment-audit-cancelled");
      await sleep(5);
    }
    if (Atomics.load(control, 1)) throw new Error("deployment-audit-cancelled");
    await sleep(2);
    if (Atomics.load(control, 1)) throw new Error("deployment-audit-cancelled");
    Atomics.add(control, 3, 1);
  }, count => Atomics.store(control, 2, count)).then(result => parentPort!.postMessage(result)).catch(() => {
    parentPort!.postMessage({ state: "critical-failure", files: 0, bytes: 0,
      failures: [{ group: "critical", code: "worker-unavailable", path: "" }] });
  });
}
