import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const execute = promisify(execFile);
const stagedMode = "core-then-background-v2";
const actionProtocols = Object.freeze({
  source: ["pkm.native-action-module-source/v2", "pkm.action.module-bytes/v1"],
  catalog: ["pkm.native-action-package-admission/v2"],
  gc: ["pkm.native-action-gc/v1"],
  cosmos: ["pkm.native-action-cosmos-config/v1"],
  artifacts: ["native-blob/v1"],
});
export async function managedOriginalMcpSourceProtocol(directory, files) {
  const name = "runtime/next-server/dist/original-mcp-source-protocol.json";
  if (!files[name]) {
    if (files["runtime/next-server/dist/original-mcp-source-protocol.js"])
      throw new Error("Original MCP source protocol declaration is missing from the receiver build.");
    return undefined;
  }
  const { bytes, value } = await smallJson(directory, name);
  if (createHash("sha256").update(bytes).digest("hex") !== files[name])
    throw new Error("Original MCP source protocol declaration changed.");
  if (!value || !["custody,schema,trash", "action,custody,schema,trash"].includes(Object.keys(value).sort().join(","))
    || value.schema !== "pkm.original-mcp-source-protocol/v1"
    || !Array.isArray(value.custody) || !Array.isArray(value.trash)
    || value.custody.length === 0 || value.trash.length === 0 || value.custody.length > 16 || value.trash.length > 16
    || new Set(value.custody).size !== value.custody.length || new Set(value.trash).size !== value.trash.length
    || value.custody.some(name => typeof name !== "string" || !/^pkm\.original-mcp-custody\/v[1-9][0-9]*$/.test(name))
    || value.trash.some(name => typeof name !== "string" || !/^pkm\.original-native-trash-request\/v[1-9][0-9]*$/.test(name)))
    throw new Error("Invalid original MCP source protocol declaration.");
  if (Object.hasOwn(value, "action")) {
    const action = value.action;
    if (!action || typeof action !== "object" || Array.isArray(action) || !Object.keys(action).length
      || Object.entries(action).some(([key, versions]) => !Object.hasOwn(actionProtocols, key)
        || !Array.isArray(versions) || !versions.length || new Set(versions).size !== versions.length
        || versions.some(version => !actionProtocols[key].includes(version))))
      throw new Error("Invalid Action source protocol declaration.");
  }
  return JSON.parse(JSON.stringify(value));
}

async function smallJson(root, name) {
  let path = root;
  for (const part of name.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Invalid managed control path");
    path = join(path, part);
    if ((await fs.lstat(path)).isSymbolicLink()) throw new Error("Linked managed control");
  }
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Managed control exceeds its budget");
  const bytes = await fs.readFile(path);
  if (bytes.length > 64 * 1024) throw new Error("Managed control changed size");
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

export async function verifyIsolatedManagedGeneration(managedRoot, generation) {
  if (typeof managedRoot !== "string" || !isAbsolute(managedRoot) || resolve(managedRoot) !== managedRoot
      || await fs.realpath(managedRoot) !== managedRoot) throw new Error("An absolute nonlinked isolated root is required");
  const marker = JSON.parse(await fs.readFile(join(managedRoot, ".pkm-isolated-migration"), "utf8"));
  if (marker.schema !== "pkm.isolated-managed-migration/v1") throw new Error("Invalid isolated managed root marker");
  if (Object.hasOwn(marker, "startupValidation") && marker.startupValidation !== stagedMode)
    throw new Error("Unsupported managed startup validation mode");
  if (typeof generation !== "string" || !/^[a-f0-9-]{36}$/.test(generation)) throw new Error("Invalid isolated generation");
  const manifest = JSON.parse(await fs.readFile(join(managedRoot, "generations", generation, "manifest.json"), "utf8"));
  const launcher = await fs.readFile(join(managedRoot, "launch.py"));
  if (createHash("sha256").update(launcher).digest("hex") !== manifest.launcherSha256)
    throw new Error("Isolated launcher integrity mismatch");
  await execute(manifest.interpreters.python.path, ["-I", "-S", join(managedRoot, "launch.py"), "--verify-generation", generation],
    { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const protocols = await managedOriginalMcpSourceProtocol(join(managedRoot, "generations", generation), manifest.files);
  if (!isDeepStrictEqual(protocols, manifest.compatibility?.originalMcpSourceProtocol))
    throw new Error("Original MCP source protocol advertisement does not match the verified receiver.");
  return manifest;
}

export async function isolatedManagedLaunch(managedRoot) {
  if (typeof managedRoot !== "string" || !isAbsolute(managedRoot) || resolve(managedRoot) !== managedRoot
    || await fs.realpath(managedRoot) !== managedRoot) throw new Error("An absolute nonlinked isolated root is required");
  const marker = (await smallJson(managedRoot, ".pkm-isolated-migration")).value;
  if (marker.schema !== "pkm.isolated-managed-migration/v1") throw new Error("Invalid isolated managed root marker");
  if (Object.hasOwn(marker, "startupValidation") && marker.startupValidation !== stagedMode)
    throw new Error("Unsupported managed startup validation mode");
  const pointer = (await smallJson(managedRoot, "latest-generation.json")).value;
  let manifest;
  if (marker.startupValidation === stagedMode && process.env.PKM_CAPABILITY_PROFILE !== "legacy") {
    if (pointer.schema !== "pkm.mcp.lifecycle/v1" || pointer.startupValidation !== stagedMode
      || typeof pointer.generation !== "string" || !/^[a-f0-9-]{36}$/.test(pointer.generation))
      throw new Error("Invalid staged generation pointer");
    const receipt = await smallJson(managedRoot, `startup-v2/${pointer.generation}.json`);
    if (createHash("sha256").update(receipt.bytes).digest("hex") !== pointer.startupReceiptSha256
      || receipt.value.schema !== "pkm.deployment-startup/v2" || receipt.value.mode !== stagedMode
      || receipt.value.manifest?.managedRoot !== managedRoot || receipt.value.manifest?.generation !== pointer.generation)
      throw new Error("Staged startup receipt mismatch");
    manifest = receipt.value.manifest;
    if ((manifest.files?.["runtime/next-server/dist/original-mcp-source-protocol.js"]
      || manifest.files?.["runtime/next-server/dist/original-mcp-source-protocol.json"])
      && !manifest.compatibility?.originalMcpSourceProtocol)
      throw new Error("Original MCP source protocol advertisement is required before launch.");
    const launcher = await boundedLauncherBytes(managedRoot);
    if (createHash("sha256").update(launcher).digest("hex") !== manifest.launcherSha256
      || typeof manifest.interpreters?.python?.path !== "string" || !isAbsolute(manifest.interpreters.python.path))
      throw new Error("Staged launcher identity mismatch");
  } else manifest = await verifyIsolatedManagedGeneration(managedRoot, pointer.generation);
  if ((manifest.backendKind ?? "native-public-mcp") !== "native-public-mcp"
    || (manifest.backendAbi ?? "pkm.mcp.api/1") !== "pkm.mcp.api/1")
    throw new Error("Native MCP launch cannot admit a standalone Core backend");
  return { command: manifest.interpreters.python.path, args: ["-I", "-S", join(managedRoot, "launch.py")],
    cwd: managedRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } };
}

async function boundedLauncherBytes(root) {
  const path = join(root, "launch.py"), stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid staged launcher");
  const bytes = await fs.readFile(path);
  if (bytes.length > 64 * 1024) throw new Error("Staged launcher changed size");
  return bytes;
}
