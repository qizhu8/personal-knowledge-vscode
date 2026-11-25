import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
export const originalMcpCutoverScope = "preserve-existing-mcp/v1";
export const originalMcpCutoverCatalogSha256 = "696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21";
export const originalMcpCutoverCatalogRevision = "8f4de8526bc2b4a043cfb493c180709292ed245bbf97bef8b7e9e4b4891a76a5";
export const originalMcpCutoverPublicTools = Object.freeze([
  "capabilities_describe", "capabilities_inventory", "capabilities_list", "capabilities_search",
  "capability_call", "capability_read", "check_version", "mcp_lifecycle_quiesce", "mcp_lifecycle_status",
]);
export const originalMcpNativeAttachmentContract = Object.freeze({
  schema: "pkm.original-mcp-native-attachment-contract/v1",
  protocol: "pkm.original-mcp-native-attachment/v1",
  credentialPolicy: "native-reenroll-separate-id",
  offlineQualification: "deployment-facts-only",
  storageRecovery: "deferred-until-authenticated-native-attachment",
  businessPublication: "after-native-admission-and-full-parity",
  ownerPolicy: "same-cold-owner-no-reopen",
  descriptorSchema: "pkm.original-mcp-native-attachment/v1",
  framing: "utf8-json-lines/v1",
  serverFrames: ["challenge", "attached", "ping"],
  clientFrames: ["attestation", "pong"],
  maximumFrameBytes: 65536,
});
const requiredCommonTools = ["note", "skill"].flatMap(module => ["read", "write", "modify", "list", "search"].map(action => `${module}_${action}`));
const managedNames = Object.freeze([
  ".pkm-next-original-mcp.json", ".pkm-next-original-mcp.commit.json", ".pkm-next-original-mcp.rollback.json",
  ".pkm-next-workspace", ".pkm-next-writer-fenced.json",
  "core.sqlite", "core.sqlite-wal", "core.sqlite-shm", "core.sqlite-journal",
  "coding-process.sqlite", "coding-process.sqlite-wal", "coding-process.sqlite-shm", "coding-process.sqlite-journal",
]);
const nativeB1Directories = new Set([".pkm-next-todo", ".pkm-next-memory", ".pkm-next-retrieval-models"]);
const legacyRootSidecars = new Set(["knowledge.db-wal", "knowledge.db-shm", "knowledge.db-journal"]);
const rootTopology = names => sorted(names.filter(name => !legacyRootSidecars.has(name)));
const entries = Object.freeze({
  coordinator: "experimental/original-mcp-cutover.mjs", recovery: "experimental/cold-state-recovery.mjs",
  root: "dist/original-mcp-root.js", broker: "dist/original-mcp-broker.js",
  descriptor: "dist/original-mcp-broker-descriptor.js", profile: "dist/original-mcp-profile-binding.js",
  relay: "dist/original-mcp-relay-cli.js", readiness: "dist/original-mcp-public.js",
  nativeAuthority: "dist/original-mcp-native-host.js", fence: "dist/linux-root-writer-fence.js",
  quiescence: "dist/linux-legacy-writer-quiescence.js", noReplace: "dist/rename-no-replace.js",
  gitProtection: "dist/original-mcp-git-protection.js",
  rootMode: "dist/original-mcp-root-mode.js",
  nativeAttachment: "dist/original-mcp-native-attachment.js",
  nativeIdentity: "dist/original-mcp-native-identity.js",
});
// Version-pinned policy intent only. The parent's cold/fenced Git helper still
// performs the real CAS, backups and native Git verification after hardening.
const gitProtectionBlock = "# BEGIN PKM v5 private runtime state\n/core.sqlite\n/core.sqlite-*\n/coding-process.sqlite\n/coding-process.sqlite-*\n/.pkm-*\n# END PKM v5 private runtime state\n";
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) + "\n";
const hash = value => digest(encode(value));
const within = (base, path) => path === base || path.startsWith(base + sep);
const sorted = values => [...values].sort();
const same = (left, right) => encode(left) === encode(right);
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fileIdentity = stat => Object.fromEntries(
  ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));

export class OriginalMcpCutoverError extends Error {
  constructor(code, condition = code) { super(condition); this.code = code; this.condition = condition; }
}
const noPrimaryError = Symbol("no-primary-error");
const cleanupErrorBrands = new WeakSet();
function redactedError(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "OPERATION_FAILED";
  return { code, ...(cleanupErrorBrands.has(error) && error.primaryCode ? { primaryCode: error.primaryCode } : {}),
    ...(cleanupErrorBrands.has(error) ? { cleanupFailures: error.cleanupFailures } : {}) };
}
async function cleanupSteps(steps) {
  const failures = [];
  for (const [operation, run] of steps) {
    try { await run(); } catch (error) { failures.push({ operation, error }); }
  }
  return failures;
}
function cleanupError(primary, failures) {
  const hasPrimary = primary !== noPrimaryError;
  const error = new AggregateError([...(hasPrimary ? [primary] : []), ...failures.map(item => item.error)],
    "Offline cutover cleanup or failure notification did not complete.", hasPrimary ? { cause: primary } : undefined);
  error.code = "ORIGINAL_MCP_CLEANUP_FAILED";
  error.condition = "cleanup-incomplete; retain-state-and-inspect-native-resources";
  if (hasPrimary) { error.primaryError = primary; error.primaryCode = redactedError(primary).code; }
  error.cleanupErrors = failures;
  error.cleanupFailures = failures.map(({ operation, error }) => ({ operation, ...redactedError(error) }));
  cleanupErrorBrands.add(error);
  return error;
}
async function withCleanup(run, steps) {
  let value, primary = noPrimaryError;
  try { value = await run(); } catch (error) { primary = error; }
  const failures = await cleanupSteps(steps);
  if (failures.length) throw cleanupError(primary, failures);
  if (primary !== noPrimaryError) throw primary;
  return value;
}
async function recordCleanupFailure(plan, primary, failures, phase, evidence = {}) {
  const all = [...failures], reportPath = join(plan.stageDirectory, `cleanup-failure-${randomUUID()}.json`);
  try {
    await durable(reportPath, { schema: "pkm.original-mcp-cutover-cleanup-failure/v1", phase,
      planSha256: plan.planSha256, ...(primary !== noPrimaryError ? { primary: redactedError(primary) } : {}),
      cleanupFailures: all.map(({ operation, error }) => ({ operation, ...redactedError(error) })),
      originalStateRetained: true, cleanupConfirmed: false, evidence });
  } catch (error) { all.push({ operation: "cleanup-notification-write", error }); }
  const error = cleanupError(primary, all);
  error.cleanupReportPath = reportPath;
  error.cleanupReportDurable = all.length === failures.length;
  return error;
}
function notifyFailure(error) {
  process.stderr.write(JSON.stringify({ schema: "pkm.original-mcp-cutover-failure/v1", ...redactedError(error),
    ...(error?.cleanupReportPath ? { cleanupReportPath: error.cleanupReportPath, cleanupReportDurable: error.cleanupReportDurable } : {}) }) + "\n");
}
const fail = (code, condition) => { throw new OriginalMcpCutoverError(code, condition); };
function exact(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) fail("UNKNOWN_SHAPE");
}
function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || path.includes("\0")) fail("UNSAFE_PATH");
  return path;
}
function safeRelative(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")
    || path.split("/").some(part => !part || part === "." || part === ".." || part.includes("\0"))) fail("UNSAFE_PATH");
  return path;
}
async function statOrAbsent(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function canonical(path, kind = "directory", privatePath = false) {
  absolute(path);
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory() || stat.mode & 0o002n) fail("UNSAFE_PATH");
  }
  const stat = await lstat(path, { bigint: true });
  if (await realpath(path) !== path || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    || kind === "file" && stat.nlink !== 1n
    || privatePath && (stat.uid !== BigInt(process.getuid()) || stat.mode & 0o077n)) fail("UNSAFE_PATH");
  return stat;
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return withCleanup(() => handle.sync(), [["directory-handle-close", () => handle.close()]]);
}
async function durable(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const bytes = typeof value === "string" ? value : encode(value);
  await withCleanup(async () => { await handle.writeFile(bytes); await handle.sync(); },
    [["control-handle-close", () => handle.close()]]);
  await syncDirectory(dirname(path));
  return digest(bytes);
}
async function pinFile(path, destination) {
  const before = await canonical(path, "file");
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (before.uid === BigInt(process.getuid()) ? constants.O_NOATIME : 0));
  let output;
  return withCleanup(async () => {
    if (!same(fileIdentity(before), fileIdentity(await input.stat({ bigint: true })))) fail("SOURCE_CHANGED");
    if (destination) output = await open(destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest_ = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0n;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest_.update(chunk); bytes += BigInt(bytesRead);
      if (output) await output.writeFile(chunk);
    }
    if (bytes !== before.size || !same(fileIdentity(before), fileIdentity(await input.stat({ bigint: true })))
      || !same(fileIdentity(before), fileIdentity(await lstat(path, { bigint: true })))) fail("SOURCE_CHANGED");
    await output?.sync();
    return { path, sha256: digest_.digest("hex"), identity: fileIdentity(before) };
  }, [["output-handle-close", () => output?.close()], ["input-handle-close", () => input.close()]]);
}
async function checkedPin(value, destination) {
  exact(value, ["path", "sha256"]);
  if (!isHash(value.sha256)) fail("PIN_REQUIRED");
  const actual = await pinFile(absolute(value.path), destination);
  if (actual.sha256 !== value.sha256) fail("WRONG_PIN");
  return actual;
}
async function json(path, pin, maximum = 4 * 1024 * 1024) {
  const stat = await canonical(path, "file", true);
  if (stat.size > BigInt(maximum)) fail("CONTROL_TOO_LARGE");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME);
  return withCleanup(async () => {
    if (!same(fileIdentity(stat), fileIdentity(await file.stat({ bigint: true })))) fail("SOURCE_CHANGED");
    const bytes = await file.readFile();
    if (!same(fileIdentity(stat), fileIdentity(await file.stat({ bigint: true })))
      || !same(fileIdentity(stat), fileIdentity(await lstat(path, { bigint: true })))) fail("SOURCE_CHANGED");
    if (pin !== undefined && (!isHash(pin) || digest(bytes) !== pin)) fail("WRONG_PIN");
    return JSON.parse(bytes.toString("utf8"));
  }, [["control-read-handle-close", () => file.close()]]);
}
async function children(path) {
  const directory = await opendir(path), result = [];
  return withCleanup(async () => {
    for (let entry; (entry = await directory.read()) !== null;) {
      result.push(entry.name);
      if (result.length > 200000) fail("ENTRY_LIMIT");
    }
    return result.sort();
  }, [["directory-reader-close", () => directory.close()]]);
}
async function treeFiles(root, prefix = "", depth = 0) {
  if (depth > 128) fail("DEPTH_LIMIT");
  const result = [];
  for (const name of await children(prefix ? join(root, prefix) : root)) {
    const path = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(root, path));
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("RELEASE_SHAPE");
    if (stat.isDirectory()) result.push(...await treeFiles(root, path, depth + 1));
    else result.push(path);
  }
  return result.sort();
}
async function syncTreeDirectories(path) {
  for (const name of await children(path)) {
    const full = join(path, name);
    if ((await lstat(full)).isDirectory()) await syncTreeDirectories(full);
  }
  await syncDirectory(path);
}
function modulePath(plan, entry) { return join(plan.stageDirectory, "runtime", entries[entry]); }
async function runtimeModule(plan, entry) { return import(pathToFileURL(modulePath(plan, entry)).href); }
function coverage(request, path) {
  return request.externalDirectories.some(entry => within(entry.path, path))
    || request.configurationFiles.some(entry => entry.path === path);
}
function recoveryWithGitPolicy(request, root) {
  const result = structuredClone(request), path = join(root, ".gitignore");
  if ("includeNativeRuntimeDirectories" in result) fail("RECOVERY_PLAN_INVALID", "native-runtime-directories-are-b1-only");
  if (!result.configurationFiles.some(entry => entry.path === path))
    result.configurationFiles.push({ id: "original-root-gitignore", path });
  if (result.configurationFiles.length > 32) fail("RECOVERY_PLAN_INVALID", "explicit-gitignore-scope-exceeds-recovery-scope-bound");
  return result;
}
async function gitPolicyIntent(root) {
  const path = join(root, ".gitignore"), stat = await statOrAbsent(path);
  let bytes = Buffer.alloc(0), beforeIdentity = null, beforeMode = 0o600;
  if (stat) {
    if (stat.size > 2097152n || stat.uid !== BigInt(process.getuid()) || stat.mode & 0o7002n) fail("GIT_PROTECTION_UNAVAILABLE");
    const pinned = await pinFile(path);
    bytes = await readFile(path);
    if (digest(bytes) !== pinned.sha256) fail("SOURCE_CHANGED");
    beforeIdentity = ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => pinned.identity[key]).join(":");
    beforeMode = Number(stat.mode & 0o777n);
  }
  const hasMarker = bytes.includes(Buffer.from("# BEGIN PKM v5 private runtime state")) || bytes.includes(Buffer.from("# END PKM v5 private runtime state"));
  if (hasMarker && !bytes.includes(Buffer.from(gitProtectionBlock))) fail("GIT_PROTECTION_POLICY_CONFLICT");
  const after = hasMarker ? bytes : Buffer.concat([bytes, bytes.length && bytes.at(-1) !== 10 ? Buffer.from("\n") : Buffer.alloc(0), Buffer.from(gitProtectionBlock)]);
  return { schema: "pkm.original-mcp-git-protection-intent/v1", root,
    beforeSha256: stat ? digest(bytes) : null, beforeIdentity, beforeMode, desiredSha256: digest(after) };
}
function sameRootIdentity(current, expected, hardened = false) {
  return ["dev", "ino", "uid", "gid"].every(key => current[key] === expected[key])
    && current.mode === (hardened ? String(BigInt(expected.mode) & ~0o777n | 0o700n) : expected.mode);
}

export function assertOriginalMcpFullParity(value, oracle) {
  if (!value || value.ready !== true || value.scope !== originalMcpCutoverScope
    || value.catalogSha256 !== originalMcpCutoverCatalogSha256 || value.catalogRevision !== originalMcpCutoverCatalogRevision
    || !same(sorted(value.enabledOperationIds ?? []), sorted(oracle.operationIds))
    || (value.disabledOperationIds?.length ?? 0) !== 0 || !Array.isArray(value.missingConditions)
    || value.missingConditions.length || !same(sorted(value.canonicalDomains ?? []), ["memory", "todo"])
    || !same(sorted(value.nativeAuthorities ?? []), ["model-provider", "tool-approval"])
    || !same(sorted(value.publicTools ?? []),
      sorted([...originalMcpCutoverPublicTools, ...(oracle.directAliases ?? []).map(alias => alias.name)])))
    fail("FULL_PARITY_UNAVAILABLE", "preserve-existing-mcp-requires-actual151-handlers-and-native-authorities");
}

async function releaseInputs(request) {
  exact(request.release, ["directory", "manifest", "qualification", "oracle"]);
  const manifest = await json(request.release.manifest.path, request.release.manifest.sha256);
  exact(manifest, ["schema", "files", "node", "buildSha256", "catalogSha256", "catalogRevision", "extension",
    "toolSurface", "aliasSurfaceSha256"]);
  if (manifest.schema !== "pkm.original-mcp-cutover-release/v1" || !Array.isArray(manifest.files)
    || manifest.files.length > 100000 || !isHash(manifest.buildSha256)
    || manifest.catalogSha256 !== originalMcpCutoverCatalogSha256 || manifest.catalogRevision !== originalMcpCutoverCatalogRevision
    || manifest.toolSurface !== "hybrid" || !isHash(manifest.aliasSurfaceSha256))
    fail("RELEASE_UNQUALIFIED");
  if (request.release.manifest.path !== join(request.release.directory, "release-manifest.json")) fail("RELEASE_SHAPE");
  await canonical(request.release.directory);
  const files = [];
  for (const entry of manifest.files) {
    exact(entry, ["path", "sha256"]);
    safeRelative(entry.path);
    if (!isHash(entry.sha256) || entry.path === "release-manifest.json") fail("RELEASE_SHAPE");
    files.push(entry.path);
  }
  if (new Set(files).size !== files.length || !Object.entries(entries).filter(([name]) => name !== "nativeAttachment").every(([_name, entry]) => files.includes(entry))
    || !same(sorted(await treeFiles(request.release.directory)), sorted([...files, "release-manifest.json"])))
    fail("RELEASE_INCOMPLETE");
  await checkedPin(manifest.node);
  if (within(request.originalRoot, manifest.node.path)) fail("RUNTIME_INSIDE_ORIGINAL");
  const qualification = await json(request.release.qualification.path, request.release.qualification.sha256);
  if (qualification.schema !== "pkm.original-mcp-cutover-release-qualification/v1"
    || qualification.releaseSha256 !== request.release.manifest.sha256
    || qualification.catalogSha256 !== originalMcpCutoverCatalogSha256
    || qualification.acceptedScope !== originalMcpCutoverScope
    || qualification.actualNativeRuntime !== true || qualification.describesPassed !== 151
    || qualification.discoveryCasesPassed !== 23 || qualification.nativeCliCasesPassed !== 9
    || !same(sorted(qualification.canonicalDomains ?? []), ["memory", "todo"])
    || !Number.isInteger(qualification.canonicalRuntimeCasesPassed) || qualification.canonicalRuntimeCasesPassed < 1
    || qualification.nativeCliSha256 !== request.nativeCli.sha256)
    fail("RELEASE_UNQUALIFIED");
  const oracle = await json(request.release.oracle.path, request.release.oracle.sha256);
  if (oracle.schema !== "pkm.original-mcp-cutover-oracle/v1" || oracle.catalogSha256 !== originalMcpCutoverCatalogSha256
    || oracle.catalogRevision !== originalMcpCutoverCatalogRevision || !Array.isArray(oracle.operationIds)
    || oracle.operationIds.length !== 151 || new Set(oracle.operationIds).size !== 151
    || !oracle.operationIds.every(id => /^mcp\.tool\.[a-z0-9_]+$/.test(id))
    || !Array.isArray(oracle.describes) || oracle.describes.length !== 151
    || !same(sorted(oracle.describes.map(entry => entry.operation)), sorted(oracle.operationIds))
    || !oracle.describes.every(entry => isHash(entry.sha256))
    || !Array.isArray(oracle.discovery) || oracle.discovery.length !== 23
    || !oracle.discovery.every(entry => ["capabilities_list", "capabilities_search", "capabilities_inventory"].includes(entry.tool)
      && isHash(entry.sha256))) fail("ORACLE_INCOMPLETE");
  if (oracle.toolSurface !== "hybrid" || !Array.isArray(oracle.directAliases)
    || oracle.directAliases.length > 32 || new Set(oracle.directAliases.map(alias => alias.name)).size !== oracle.directAliases.length
    || !requiredCommonTools.every(name => oracle.directAliases.some(alias => alias.name === name))
    || !oracle.directAliases.every(alias => /^[a-z][a-z0-9]*_(?:read|write|modify|list|search)$/.test(alias.name)
      && !originalMcpCutoverPublicTools.includes(alias.name) && alias.version === 1 && typeof alias.readOnly === "boolean"
      && isHash(alias.inputSchemaSha256) && (oracle.operationIds.includes(alias.operation) || /^(?:todo|memory)\.[a-z][a-z0-9._-]*$/.test(alias.operation))
      && !/^(?:prompt|script)_(?:write|modify)$/.test(alias.name))
    || manifest.aliasSurfaceSha256 !== hash(oracle.directAliases)
    || qualification.toolSurface !== "hybrid" || qualification.aliasSurfaceSha256 !== manifest.aliasSurfaceSha256
    || !Number.isInteger(qualification.directAliasCasesPassed) || qualification.directAliasCasesPassed < oracle.directAliases.length)
    fail("HYBRID_SURFACE_UNQUALIFIED", "original-nine-plus-approved-common-aliases-required-with-unchanged-canonical151");
  if (qualification.nativeAttachmentContractSha256 !== hash(originalMcpNativeAttachmentContract)
    || qualification.nativeCredentialPolicy !== "native-reenroll-separate-id"
    || !Number.isInteger(qualification.nativeDeploymentCasesPassed) || qualification.nativeDeploymentCasesPassed < 1)
    fail("NATIVE_DEPLOYMENT_UNQUALIFIED", "qualified-new-namespace-package-and-attachment-protocol-required-not-live-model-authority");
  return { manifest, oracle, qualification };
}

async function verifyLegacy(request) {
  exact(request.legacy, ["installedDirectory", "package", "main", "vsix"]);
  if (request.legacy.package.path !== join(request.legacy.installedDirectory, "package.json")) fail("LEGACY_PIN_INVALID");
  const package_ = await checkedPin(request.legacy.package);
  if (BigInt(package_.identity.size) > 4n * 1024n * 1024n) fail("CONTROL_TOO_LARGE");
  const info = JSON.parse(await readFile(package_.path, "utf8"));
  if (`${info.publisher}.${info.name}` !== "uone.personal-knowledge" || info.version !== "4.0.22"
    || typeof info.main !== "string" || request.legacy.main.path !== join(request.legacy.installedDirectory, safeRelative(info.main.replace(/^\.\//, ""))))
    fail("LEGACY_PIN_INVALID");
  await checkedPin(request.legacy.main);
  await checkedPin(request.legacy.vsix);
  const program = [
    "import sys,zipfile,json,hashlib",
    "with zipfile.ZipFile(sys.argv[1]) as z:",
    " p=z.getinfo('extension/package.json')",
    " if p.file_size>4194304: sys.exit(12)",
    " v=json.loads(z.read(p)); main=v.get('main','').removeprefix('./')",
    " if not main or main.startswith('/') or any(x in ('','..','.') for x in main.split('/')): sys.exit(13)",
    " m=z.getinfo('extension/'+main)",
    " h=hashlib.sha256()",
    " with z.open(m) as f:",
    "  while True:",
    "   b=f.read(1048576)",
    "   if not b: break",
    "   h.update(b)",
    " print(json.dumps({'id':v.get('publisher','')+'.'+v.get('name',''),'version':v.get('version'),'mainSha256':h.hexdigest()}))",
  ].join("\n");
  let source;
  try { source = JSON.parse((await exec("python3", ["-I", "-B", "-c", program, request.legacy.vsix.path],
    { timeout: 30000, maxBuffer: 1024 })).stdout); }
  catch { fail("LEGACY_VSIX_INVALID"); }
  if (source.id !== "uone.personal-knowledge" || source.version !== "4.0.22" || source.mainSha256 !== request.legacy.main.sha256)
    fail("LEGACY_VSIX_INVALID");
}

function requestShape(request) {
  exact(request, ["schema", "acceptedScope", "operatorId", "originalRoot", "recovery", "profile",
    "legacy", "nativeCli", "release", "maintenance", "custodyLimits", "rootMode", "nativeDeployment"]);
  if (request.schema !== "pkm.original-mcp-cutover-request/v1" || request.acceptedScope !== originalMcpCutoverScope
    || typeof request.operatorId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.operatorId)) fail("UNKNOWN_SHAPE");
  absolute(request.originalRoot);
  exact(request.profile, ["storageDirectory", "sha256", "userDataDirectory", "extensionsDirectory"]);
  for (const path of [request.profile.storageDirectory, request.profile.userDataDirectory, request.profile.extensionsDirectory]) absolute(path);
  if (!isHash(request.profile.sha256)) fail("PIN_REQUIRED");
  exact(request.nativeDeployment, ["publicEnrollment", "identitySha256", "package", "payloadBuildId",
    "hostEntry", "payloadManifest", "protocolSha256", "credentialPolicy"]);
  if (request.nativeDeployment.protocolSha256 !== hash(originalMcpNativeAttachmentContract)
    || request.nativeDeployment.credentialPolicy !== "native-reenroll-separate-id"
    || !isHash(request.nativeDeployment.identitySha256) || !isHash(request.nativeDeployment.payloadBuildId))
    fail("NATIVE_DEPLOYMENT_UNQUALIFIED");
  if (request.nativeDeployment.publicEnrollment.path !== join(request.profile.storageDirectory, "original-mcp-native-identity.json"))
    fail("NATIVE_IDENTITY_PROFILE_MISMATCH");
  exact(request.rootMode, ["approvedMode"]);
  if (request.rootMode.approvedMode !== 0o700) fail("ROOT_MODE_APPROVAL_REQUIRED", "explicit-root-only-approved-mode-0700-required-not-cold-authority");
  if (!["code-server", "code"].includes(basename(request.nativeCli.path))) fail("NATIVE_CLI_UNQUALIFIED");
  exact(request.maintenance, ["systemctl", "unit", "unitFile", "hostExecutable"]);
  if (!/^[A-Za-z0-9_-]+\.service$/.test(request.maintenance.unit)) fail("MAINTENANCE_CONTROL_UNAVAILABLE");
}

export async function planOriginalMcpCutover(request, stageDirectory) {
  requestShape(request);
  const base = join(absolute(homedir()), ".local/state/pkm-v5-recovery");
  await canonical(base, "directory", true);
  if (dirname(absolute(stageDirectory)) !== base || !/^cutover-[a-f0-9-]{36}$/.test(basename(stageDirectory))
    || within(request.originalRoot, base) || within(base, request.originalRoot)) fail("DESTINATION_POLICY");
  if (await statOrAbsent(stageDirectory)) fail("DESTINATION_EXISTS");
  const root = await canonical(request.originalRoot), sourceRootWritePlan = [];
  for (const name of await children(request.originalRoot))
    if ((name.startsWith(".pkm-") || name.startsWith("core.sqlite") || name.startsWith("coding-process.sqlite"))
      && !managedNames.includes(name)) fail("ORIGINAL_PRIVATE_STATE_UNQUALIFIED");
  for (const name of managedNames) {
    if (await statOrAbsent(join(request.originalRoot, name))) fail("ORIGINAL_ALREADY_MANAGED");
    sourceRootWritePlan.push({ path: join(request.originalRoot, name), baseline: "absent", operation: "create-only" });
  }
  const enrollmentPath = join(request.profile.storageDirectory, "original-mcp-enrollment.json");
  await canonical(request.profile.storageDirectory, "directory", true);
  if (await statOrAbsent(enrollmentPath)) fail("ENROLLMENT_EXISTS");
  const recovery = recoveryWithGitPolicy(await json(request.recovery.path, request.recovery.sha256), request.originalRoot);
  if (recovery.originalRoot !== request.originalRoot
    || ![request.profile.storageDirectory, request.profile.userDataDirectory, request.profile.extensionsDirectory]
      .every(path => coverage(recovery, path))) fail("PROFILE_BACKUP_COVERAGE_INCOMPLETE");
  const loaded = await releaseInputs(request);
  await checkedPin(request.nativeDeployment.publicEnrollment);
  await checkedPin(request.nativeDeployment.package);
  await checkedPin(request.nativeDeployment.hostEntry); await checkedPin(request.nativeDeployment.payloadManifest);
  const packageRoot = dirname(request.nativeDeployment.package.path);
  if (!within(request.profile.extensionsDirectory, packageRoot)
    || request.nativeDeployment.hostEntry.path !== join(packageRoot, "dist/extension.cjs")
    || request.nativeDeployment.payloadManifest.path !== join(packageRoot, "next-runtime/manifest.json"))
    fail("NATIVE_PACKAGE_BINDING_INVALID");
  if ((await lstat(request.nativeDeployment.package.path)).size > 4 * 1024 * 1024) fail("CONTROL_TOO_LARGE");
  const packageBytes = await readFile(request.nativeDeployment.package.path);
  if (digest(packageBytes) !== request.nativeDeployment.package.sha256) fail("SOURCE_CHANGED");
  const candidatePackage = JSON.parse(packageBytes.toString("utf8"));
  if (`${candidatePackage.publisher}.${candidatePackage.name}` !== loaded.manifest.extension?.id
    || candidatePackage.version !== loaded.manifest.extension?.version) fail("NATIVE_PACKAGE_BINDING_INVALID");
  await verifyLegacy(request);
  await checkedPin(request.nativeCli);
  await checkedPin(request.maintenance.systemctl);
  await checkedPin(request.maintenance.unitFile);
  await checkedPin(request.maintenance.hostExecutable);
  await mkdir(stageDirectory, { mode: 0o700 });
  const runtime = join(stageDirectory, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  try {
    for (const entry of loaded.manifest.files) {
      const target = join(runtime, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await checkedPin({ path: join(request.release.directory, entry.path), sha256: entry.sha256 }, target);
    }
    await durable(join(runtime, "release-manifest.json"), encode(loaded.manifest));
    const legacyVsix = join(stageDirectory, "original-4.0.22.vsix");
    await checkedPin(request.legacy.vsix, legacyVsix);
    await durable(join(stageDirectory, "recovery-request.json"), recovery);
    await durable(join(stageDirectory, "oracle.json"), loaded.oracle);
    await durable(join(stageDirectory, "release-qualification.json"), loaded.qualification);
    await checkedPin(request.nativeDeployment.publicEnrollment, join(stageDirectory, "native-public-enrollment.json"));
    const profile = await runtimeModule({ stageDirectory }, "profile");
    if (profile.originalMcpProfileBinding(request.profile.storageDirectory).sha256 !== request.profile.sha256)
      fail("PROFILE_CHANGED");
    const identity = await runtimeModule({ stageDirectory }, "nativeIdentity");
    identity.verifyOriginalMcpNativeIdentity(await json(request.nativeDeployment.publicEnrollment.path,
      request.nativeDeployment.publicEnrollment.sha256), request.nativeDeployment.identitySha256, request.profile.sha256);
    const mode = await runtimeModule({ stageDirectory }, "rootMode");
    const rootModePlan = mode.planOriginalMcpRootMode(request.originalRoot);
    const gitProtectionPlan = await gitPolicyIntent(request.originalRoot);
    sourceRootWritePlan.push({ path: join(request.originalRoot, ".gitignore"),
      baseline: { sha256: gitProtectionPlan.beforeSha256, identity: gitProtectionPlan.beforeIdentity },
      operation: "cas-append-private-runtime-guards", desiredSha256: gitProtectionPlan.desiredSha256 });
    const brokerDirectory = join(base, `b-${randomBytes(6).toString("hex")}`);
    if (Buffer.byteLength(join(brokerDirectory, "s")) > 103) fail("BROKER_SOCKET_PATH_LIMIT");
    const body = { schema: "pkm.original-mcp-cutover-plan/v1", acceptedScope: originalMcpCutoverScope,
      id: basename(stageDirectory), stageDirectory, originalRootIdentity: fileIdentity(root), request,
      originalRootEntries: await children(request.originalRoot), gitProtectionPlan,
      rootModePlan, rootModeWritePlan: { path: request.originalRoot, operation: "fchmod-only-this-opened-root-inode",
        fromMode: rootModePlan.fromMode, toMode: 0o700, noAutomaticPermissionLoosening: true },
      runtime: loaded.manifest, oracle: loaded.oracle, sourceRootWritePlan, enrollmentPath, brokerDirectory,
      stagedRecoverySha256: hash(recovery), stagedOracleSha256: hash(loaded.oracle),
      stagedQualificationSha256: hash(loaded.qualification),
      b0: join(base, `${basename(stageDirectory)}-b0`), b0Restored: join(base, `${basename(stageDirectory)}-b0-restored`),
      profileNativeEdits: [enrollmentPath],
      nativeAttachmentContract: originalMcpNativeAttachmentContract,
      nativePublicEnrollmentSha256: request.nativeDeployment.publicEnrollment.sha256,
      nativeIdentitySha256: request.nativeDeployment.identitySha256,
      nativeCredentialPolicy: "native-reenroll-separate-id; old-credentials-untouched",
      rollbackPolicy: "preserve-B1-first; qualified-retirement-only; never-overwrite-originals",
      globalColdAuthority: "requires-real-native-systemd-profile-control-and-all-fixed-gates",
      parentOwnsQualifiedNewVsixInstallAndNativeRestart: true };
    const plan = { ...body, planSha256: hash(body) };
    await syncTreeDirectories(runtime);
    await durable(join(stageDirectory, "plan.json"), plan);
    await syncDirectory(runtime); await syncDirectory(stageDirectory);
    return { path: join(stageDirectory, "plan.json"), sha256: digest(encode(plan)), planSha256: plan.planSha256,
      acceptedScope: originalMcpCutoverScope, staged: true, activated: false,
      readiness: "staged-only-full-scope-unverified" };
  } catch (error) {
    error.retainedStage = stageDirectory;
    const failures = await cleanupSteps([["staging-failure-journal", () => durable(join(stageDirectory, "stage.failure.json"),
      { code: redactedError(error).code, activated: false })]]);
    if (failures.length) {
      const combined = cleanupError(error, failures); combined.retainedStage = stageDirectory; throw combined;
    }
    throw error;
  }
}

async function loadPlan(path, independentSha256) {
  const plan = await json(absolute(path), independentSha256);
  const { planSha256, ...body } = plan;
  if (plan.schema !== "pkm.original-mcp-cutover-plan/v1" || plan.acceptedScope !== originalMcpCutoverScope
    || hash(body) !== planSha256 || path !== join(plan.stageDirectory, "plan.json")) fail("PLAN_INVALID");
  requestShape(plan.request);
  const privateBase = join(absolute(homedir()), ".local/state/pkm-v5-recovery");
  if (dirname(plan.stageDirectory) !== privateBase || !/^cutover-[a-f0-9-]{36}$/.test(basename(plan.stageDirectory)))
    fail("DESTINATION_POLICY");
  await canonical(plan.stageDirectory, "directory", true);
  if (plan.request.originalRoot !== plan.sourceRootWritePlan[0]?.path.slice(0, -managedNames[0].length - 1)) fail("PLAN_INVALID");
  if (!same(plan.sourceRootWritePlan.map(entry => entry.path),
    [...managedNames, ".gitignore"].map(name => join(plan.request.originalRoot, name))))
    fail("WRITE_PLAN_INVALID");
  if (!plan.sourceRootWritePlan.slice(0, -1).every(entry => entry.baseline === "absent" && entry.operation === "create-only")
    || plan.sourceRootWritePlan.at(-1).operation !== "cas-append-private-runtime-guards"
    || plan.sourceRootWritePlan.at(-1).desiredSha256 !== plan.gitProtectionPlan.desiredSha256) fail("WRITE_PLAN_INVALID");
  for (const entry of plan.runtime.files)
    await checkedPin({ path: join(plan.stageDirectory, "runtime", safeRelative(entry.path)), sha256: entry.sha256 });
  if (!same(sorted(await treeFiles(join(plan.stageDirectory, "runtime"))),
    sorted([...plan.runtime.files.map(entry => entry.path), "release-manifest.json"]))) fail("RELEASE_INCOMPLETE");
  if (!same(await json(join(plan.stageDirectory, "runtime/release-manifest.json")), plan.runtime)) fail("RELEASE_CHANGED");
  await checkedPin(plan.runtime.node);
  await checkedPin({ path: join(plan.stageDirectory, "original-4.0.22.vsix"), sha256: plan.request.legacy.vsix.sha256 });
  for (const [file, pin] of [["recovery-request.json", plan.stagedRecoverySha256], ["oracle.json", plan.stagedOracleSha256],
    ["release-qualification.json", plan.stagedQualificationSha256], ["native-public-enrollment.json", plan.nativePublicEnrollmentSha256]])
    await checkedPin({ path: join(plan.stageDirectory, file), sha256: pin });
  return plan;
}

async function profileBinding(plan) {
  const profile = await runtimeModule(plan, "profile");
  const result = profile.originalMcpProfileBinding(plan.request.profile.storageDirectory);
  if (result.sha256 !== plan.request.profile.sha256) fail("PROFILE_CHANGED");
  return result;
}

async function implementationReadiness(plan) {
  let readiness;
  try { readiness = await runtimeModule(plan, "readiness"); }
  catch { fail("FULL_PARITY_UNAVAILABLE", "fixed-native-implementation-readiness-verifier-unavailable"); }
  if (typeof readiness.verifyOriginalMcpImplementationReadiness !== "function") fail("FULL_PARITY_UNAVAILABLE");
  const verified = await readiness.verifyOriginalMcpImplementationReadiness({
    acceptedScope: originalMcpCutoverScope, catalogSha256: originalMcpCutoverCatalogSha256,
    catalogRevision: originalMcpCutoverCatalogRevision,
  });
  if (verified?.schema !== "pkm.original-mcp-implementation-readiness/v1" || verified.ready !== true
    || verified.acceptedScope !== originalMcpCutoverScope || verified.catalogSha256 !== originalMcpCutoverCatalogSha256
    || verified.catalogRevision !== originalMcpCutoverCatalogRevision || !Array.isArray(verified.missingImplementations)
    || verified.missingImplementations.length || !Array.isArray(verified.authorityRequirements)
    || !same(sorted(verified.requiredOperationIds ?? []), sorted(plan.oracle.operationIds))
    || !same(sorted(verified.implementedOperationIds ?? []), sorted(plan.oracle.operationIds)))
    fail("FULL_PARITY_UNAVAILABLE", "concrete-native151-implementation-registry-is-incomplete");
  const broker = await runtimeModule(plan, "broker");
  const available = broker.originalMcpBrokerAvailability(true);
  if (!same(sorted(available.enabledOperationIds), sorted(plan.oracle.operationIds)) || available.disabledOperationIds.length
    || !broker.originalMcpBrokerAuthorizationSchema?.safeParse({
      schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.request.operatorId,
      profileSha256: plan.request.profile.sha256, planSha256: "0".repeat(64),
      acceptedScope: originalMcpCutoverScope, writable: true,
    }).success) fail("FULL_PARITY_UNAVAILABLE", "reduced-knowledge-only-broker-is-not-preserved-original-mcp");
  return { broker };
}

async function nativeAttachmentProtocol(plan) {
  let native;
  try { native = await runtimeModule(plan, "nativeAttachment"); }
  catch { fail("NATIVE_ATTACHMENT_PROTOCOL_UNAVAILABLE", "qualified-private-native-attachment-source-api-is-not-shipped"); }
  if (!same(native.originalMcpNativeAttachmentContract, originalMcpNativeAttachmentContract)
    || !["verifyOriginalMcpOfflineDeployment", "isTrustedOriginalMcpOfflineDeployment",
      "bootstrapOriginalMcpNativeAttachment", "isTrustedOriginalMcpNativeBootstrap",
      "verifyOriginalMcpNativeAttachmentDescriptor",
      "waitForOriginalMcpNativeAttachment", "isTrustedOriginalMcpNativeAttachment",
      "admitOriginalMcpNativeAttachment", "publishOriginalMcpNativeBusiness",
      "verifyOriginalMcpNativeActivation"].every(name => typeof native[name] === "function"))
    fail("NATIVE_ATTACHMENT_PROTOCOL_UNAVAILABLE", "source-private-control-plane-and-signed-native-session-contract-unqualified");
  return native;
}

async function offlineDeployment(plan) {
  const native = await nativeAttachmentProtocol(plan);
  await checkedPin(plan.request.nativeDeployment.package);
  await checkedPin(plan.request.nativeDeployment.publicEnrollment);
  await checkedPin(plan.request.nativeDeployment.hostEntry); await checkedPin(plan.request.nativeDeployment.payloadManifest);
  const identityModule = await runtimeModule(plan, "nativeIdentity");
  const identity = identityModule.verifyOriginalMcpNativeIdentity(
    await json(join(plan.stageDirectory, "native-public-enrollment.json"), plan.nativePublicEnrollmentSha256),
    plan.nativeIdentitySha256, plan.request.profile.sha256);
  const maintenanceEvidence = await maintenance(plan);
  const deployment = await native.verifyOriginalMcpOfflineDeployment({
    root: plan.request.originalRoot, profile: await profileBinding(plan), operatorId: plan.request.operatorId,
    releaseSha256: plan.request.release.manifest.sha256, package: plan.request.nativeDeployment.package,
    publicEnrollment: { path: join(plan.stageDirectory, "native-public-enrollment.json"), sha256: plan.nativePublicEnrollmentSha256 },
    identity, identitySha256: plan.nativeIdentitySha256, payloadBuildId: plan.request.nativeDeployment.payloadBuildId,
    hostEntry: plan.request.nativeDeployment.hostEntry, payloadManifest: plan.request.nativeDeployment.payloadManifest,
    contract: originalMcpNativeAttachmentContract, maintenance: maintenanceEvidence,
  });
  try {
    if (!native.isTrustedOriginalMcpOfflineDeployment(deployment, {
      root: plan.request.originalRoot, profileSha256: plan.request.profile.sha256, acceptedScope: originalMcpCutoverScope,
    }) || typeof deployment?.close !== "function") fail("NATIVE_DEPLOYMENT_UNAVAILABLE");
    const facts = deployment.facts;
    exact(facts, ["schema", "root", "profileSha256", "operatorId", "releaseSha256", "packageSha256", "publicEnrollmentSha256",
      "protocolSha256", "identitySha256", "payloadBuildId", "hostEntrySha256", "payloadManifestSha256",
      "credentialPolicy", "modelAuthority", "humanAuthority", "businessReady"]);
    if (facts.schema !== "pkm.original-mcp-offline-deployment/v1" || facts.root !== plan.request.originalRoot
      || facts.profileSha256 !== plan.request.profile.sha256 || facts.operatorId !== plan.request.operatorId
      || facts.releaseSha256 !== plan.request.release.manifest.sha256 || facts.packageSha256 !== plan.request.nativeDeployment.package.sha256
      || facts.publicEnrollmentSha256 !== plan.nativePublicEnrollmentSha256
      || facts.identitySha256 !== plan.nativeIdentitySha256 || facts.payloadBuildId !== plan.request.nativeDeployment.payloadBuildId
      || facts.hostEntrySha256 !== plan.request.nativeDeployment.hostEntry.sha256
      || facts.payloadManifestSha256 !== plan.request.nativeDeployment.payloadManifest.sha256
      || facts.protocolSha256 !== plan.request.nativeDeployment.protocolSha256
      || facts.credentialPolicy !== "native-reenroll-separate-id"
      || facts.modelAuthority !== false || facts.humanAuthority !== false || facts.businessReady !== false)
      fail("OFFLINE_DEPLOYMENT_IS_NOT_AUTHORITY");
    if (!same(sorted(deployment.managedRootFiles ?? []),
      sorted(plan.sourceRootWritePlan.filter(entry => entry.operation === "create-only").map(entry => entry.path))))
      fail("WRITE_PLAN_UNQUALIFIED", "native-bootstrap-startup-footprint-exceeds-exact-approved-managed-files");
  } catch (error) {
    if (deployment) {
      const failures = await cleanupSteps([["native-deployment-close", () => {
        if (typeof deployment.close !== "function") fail("NATIVE_DEPLOYMENT_CLEANUP_UNAVAILABLE");
        return deployment.close();
      }]]);
      if (failures.length) throw await recordCleanupFailure(plan, error, failures, "native-deployment-validation");
    }
    throw error;
  }
  return { native, deployment };
}

async function validateNativeControlDescriptor(plan, custody, bootstrap) {
  const native = await nativeAttachmentProtocol(plan);
  const verified = await native.verifyOriginalMcpNativeAttachmentDescriptor(
    bootstrap.attachmentDescriptorPath, bootstrap.attachmentDescriptorSha256, plan.request.profile.sha256);
  const descriptor = await json(bootstrap.attachmentDescriptorPath, bootstrap.attachmentDescriptorSha256, 16384);
  exact(descriptor, ["schema", "brokerId", "socketPath", "identitySha256", "binding"]);
  exact(descriptor.binding, ["root", "workspaceId", "planSha256", "catalogSha256", "profileSha256", "payloadBuildId", "hostEntrySha256"]);
  const binding = descriptor.binding;
  if (descriptor.schema !== originalMcpNativeAttachmentContract.descriptorSchema
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(descriptor.brokerId ?? "")
    || binding.root !== plan.request.originalRoot || binding.workspaceId !== bootstrap.workspaceId
    || binding.planSha256 !== custody.planSha256 || binding.catalogSha256 !== originalMcpCutoverCatalogSha256
    || binding.profileSha256 !== plan.request.profile.sha256 || descriptor.identitySha256 !== plan.nativeIdentitySha256
    || binding.payloadBuildId !== plan.request.nativeDeployment.payloadBuildId
    || binding.hostEntrySha256 !== plan.request.nativeDeployment.hostEntry.sha256
    || verified.schema !== descriptor.schema || verified.brokerId !== descriptor.brokerId
    || verified.socketPath !== descriptor.socketPath || !same(verified.binding, binding)
    || verified.identitySha256 !== descriptor.identitySha256
    || dirname(absolute(descriptor.socketPath)) !== plan.brokerDirectory
    || Buffer.byteLength(descriptor.socketPath) > 103)
    fail("NATIVE_CONTROL_DESCRIPTOR_UNQUALIFIED");
  return descriptor;
}

export async function validateOriginalMcpNativeStaging(path, independentSha256) {
  const plan = await loadPlan(path, independentSha256);
  const { deployment } = await offlineDeployment(plan);
  return withCleanup(async () => ({ schema: "pkm.original-mcp-native-staging-verification/v1",
    planSha256: plan.planSha256, ...deployment.facts, mutationPerformed: false }),
  [["native-deployment-close", () => deployment.close()]]);
}

async function maintenance(plan) {
  const request = plan.request, control = request.maintenance;
  await checkedPin(control.systemctl); await checkedPin(control.unitFile); await checkedPin(control.hostExecutable);
  if (control.systemctl.path !== await realpath("/usr/bin/systemctl")) fail("MAINTENANCE_CONTROL_UNAVAILABLE", "actual-native-systemctl-required");
  // The actual native profile launcher is the bounded systemd unit. An arbitrary
  // operator boolean or captured process list cannot establish restart control.
  if ((await lstat(control.unitFile.path)).size > 65536) fail("CONTROL_TOO_LARGE");
  const unit = await readFile(control.unitFile.path, "utf8");
  const execs = unit.split(/\r?\n/).filter(line => /^ExecStart=/.test(line));
  const expected = `ExecStart=${control.hostExecutable.path} --start-server --user-data-dir ${request.profile.userDataDirectory} --extensions-dir ${request.profile.extensionsDirectory} --disable-extension uone.personal-knowledge`;
  if (execs.length !== 1 || execs[0] !== expected
    || /^(?:Environment|EnvironmentFile|Include|ExecStartPre|ExecStartPost)=/m.test(unit))
    fail("MAINTENANCE_CONTROL_UNAVAILABLE", "native-profile-launcher-unit-not-exactly-qualified");
  let fields;
  try {
    const result = await exec(control.systemctl.path, ["--user", "show", control.unit,
      "--property=Id,ActiveState,SubState,UnitFileState,FragmentPath,ControlGroup,DropInPaths"], { timeout: 10000, maxBuffer: 65536 });
    fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } catch { fail("MAINTENANCE_CONTROL_UNAVAILABLE", "native-user-systemd-controller-unavailable"); }
  if (fields.Id !== control.unit || fields.ActiveState !== "inactive" || fields.SubState !== "dead"
    || fields.UnitFileState !== "masked" || fields.FragmentPath !== "/dev/null" || fields.ControlGroup || fields.DropInPaths)
    fail("MAINTENANCE_CONTROL_UNAVAILABLE", "native-host-must-be-persistently-masked-inactive-and-without-dropins");
  const gate = await runtimeModule(plan, "quiescence");
  const boundaries = [request.originalRoot, request.profile.userDataDirectory, request.profile.extensionsDirectory,
    request.profile.storageDirectory];
  for (const path of boundaries) await gate.assertLinuxLegacyWritersQuiescent(path);
  return { schema: "pkm.original-mcp-native-maintenance/v1", unit: control.unit,
    systemctlSha256: control.systemctl.sha256, hostSha256: control.hostExecutable.sha256,
    profileSha256: request.profile.sha256, observedAt: new Date().toISOString(),
    restartControl: "native-profile-systemd-unit-persistently-masked", crossDomainAtomicityClaimed: false };
}

async function nativeExtensions(plan) {
  const request = plan.request;
  await checkedPin(request.nativeCli);
  const base = ["--user-data-dir", request.profile.userDataDirectory, "--extensions-dir", request.profile.extensionsDirectory];
  try {
    const result = await exec(request.nativeCli.path, [...base, "--list-extensions", "--show-versions"],
      { timeout: 60000, maxBuffer: 1048576, env: { ...process.env, TMPDIR: plan.stageDirectory } });
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.toLowerCase());
  } catch { fail("NATIVE_CLI_FAILED"); }
}

class Journal {
  constructor(path, plan) { this.path = path; this.plan = plan; this.sequence = 0; this.previous = null; }
  async write(phase, evidence = {}) {
    const record = { schema: "pkm.original-mcp-cutover-stage/v1", sequence: ++this.sequence, phase,
      planSha256: this.plan.planSha256, previousSha256: this.previous, at: new Date().toISOString(), evidence };
    this.previous = await durable(join(this.path, `${String(this.sequence).padStart(3, "0")}-${phase}.json`), record);
    return this.previous;
  }
}
async function verifyExecutionReceipt(plan, independentSha256, descriptorPath, descriptorSha256) {
  if (!isHash(independentSha256)) fail("EXECUTION_RECEIPT_PIN_REQUIRED");
  const directory = join(plan.stageDirectory, "execution");
  const receipt = await json(join(directory, "execution-receipt.json"), independentSha256);
  if (receipt.schema !== "pkm.original-mcp-cutover-execution-receipt/v1" || receipt.planSha256 !== plan.planSha256
    || receipt.descriptorPath !== descriptorPath || receipt.descriptorSha256 !== descriptorSha256)
    fail("EXECUTION_RECEIPT_INVALID");
  let previous = null, sequence = 0, matched = false;
  const phases = [];
  for (const name of (await children(directory)).filter(name => /^\d{3}-.*\.json$/.test(name))) {
    const path = join(directory, name), pin = await pinFile(path), record = await json(path, pin.sha256);
    if (record.schema !== "pkm.original-mcp-cutover-stage/v1" || record.sequence !== ++sequence
      || record.previousSha256 !== previous || record.planSha256 !== plan.planSha256) fail("STAGE_JOURNAL_INVALID");
    previous = pin.sha256;
    phases.push(record.phase);
    if (previous === receipt.journalHeadSha256) { matched = true; break; }
  }
  const expected = ["planned", "maintenance-verified", "root-fence-held", "b0-capture-intent", "b0-captured",
    "b0-restore-verified", "root-mode-write-intent", "root-mode-verified", "git-protection-write-intent",
    "git-protection-verified", "custody-verified", "original-write-intent", "original-prepared",
    "native-attachment-bootstrap", "native-signed-attachment", "native-admission-complete",
    "business-broker-verified", "enrolled-after-native-admission"];
  if (!matched || !same(phases, expected)) fail("STAGE_JOURNAL_INVALID");
  for (const artifact of receipt.artifacts) await checkedPin(artifact);
  if ((await pinFile(plan.enrollmentPath)).sha256 !== receipt.enrollmentSha256) fail("ENROLLMENT_CHANGED");
  const recovery = await runtimeModule(plan, "recovery");
  const b0 = await recovery.verifyColdStateRecovery(receipt.b0.path, receipt.b0.manifestSha256);
  if (!b0.summary.targetClosureComplete) fail("BACKUP_INCOMPLETE");
  return receipt;
}

async function assertBeforeMutation(plan, gitProtection, hardened = false) {
  const stat = await canonical(plan.request.originalRoot);
  const current = fileIdentity(stat);
  if (!sameRootIdentity(current, plan.originalRootIdentity, hardened)) fail("SOURCE_CHANGED");
  if (gitProtection) {
    gitProtection.assertCurrent();
    if (!same(rootTopology(await children(plan.request.originalRoot)), rootTopology([...new Set([...plan.originalRootEntries, ".gitignore"])])))
      fail("SOURCE_CHANGED");
  } else if (!same(rootTopology(await children(plan.request.originalRoot)), rootTopology(plan.originalRootEntries))) fail("SOURCE_CHANGED");
  for (const entry of plan.sourceRootWritePlan.filter(entry => entry.operation === "create-only"))
    if (await statOrAbsent(entry.path)) fail("SOURCE_CHANGED");
  if (await statOrAbsent(plan.enrollmentPath)) fail("ENROLLMENT_EXISTS");
  await profileBinding(plan);
  await verifyLegacy(plan.request);
}

async function consumeInventory(path, consume) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME);
  return withCleanup(async () => {
    let pending = "";
    for await (const chunk of file.createReadStream({ encoding: "utf8", autoClose: false, highWaterMark: 32768 })) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        if (end > 65536) fail("BACKUP_INCOMPLETE");
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        await consume(JSON.parse(line));
      }
      if (pending.length > 65536) fail("BACKUP_INCOMPLETE");
    }
    if (pending) fail("BACKUP_INCOMPLETE");
  }, [["inventory-handle-close", () => file.close()]]);
}

async function verifyB0Sources(plan, recovery, b0, gitProtection, hardened = false) {
  await recovery.verifyColdStateRecovery(plan.b0, b0.manifestSha256);
  const manifest = await json(join(plan.b0, "manifest.json"), b0.manifestSha256);
  await checkedPin({ path: join(plan.b0, "inventory.jsonl"), sha256: manifest.inventorySha256 });
  return consumeInventory(join(plan.b0, "inventory.jsonl"), async row => {
    const scope = manifest.plan.scopes.find(scope => scope.id === row.scope);
    if (!scope) fail("BACKUP_INCOMPLETE");
    const path = row.path === "." ? scope.path : join(scope.path, safeRelative(row.path));
    const stat = await statOrAbsent(path);
    if (gitProtection && path === join(plan.request.originalRoot, ".gitignore")) {
      gitProtection.assertCurrent();
      if (row.kind === "absent" ? plan.gitProtectionPlan.beforeSha256 !== null
        : row.kind !== "file" || row.sha256 !== plan.gitProtectionPlan.beforeSha256) fail("SOURCE_CHANGED");
      return;
    }
    if (row.kind === "absent") {
      if (stat) fail("SOURCE_CHANGED");
      let parent = dirname(path);
      while (!await statOrAbsent(parent)) parent = dirname(parent);
      const current = fileIdentity(await canonical(parent));
      if (gitProtection && parent === plan.request.originalRoot) {
        gitProtection.assertCurrent();
        if (!sameRootIdentity(current, row.parentIdentity, hardened)) fail("SOURCE_CHANGED");
      } else if (!same(current, row.parentIdentity)) fail("SOURCE_CHANGED");
      return;
    }
    if (!stat || !same(fileIdentity(stat), row.sourceIdentity)) fail("SOURCE_CHANGED");
    await canonical(dirname(path));
    if (row.kind === "file") await checkedPin({ path, sha256: row.sha256 });
    else if (row.kind === "directory") await canonical(path);
    else if (row.kind === "file-link") {
      const { readlink } = await import("node:fs/promises");
      const binding = manifest.plan.fileLinks.find(binding => binding.path === path);
      if (!stat.isSymbolicLink() || !binding || await readlink(path) !== row.linkText) fail("SOURCE_CHANGED");
      const target = await checkedPin({ path: binding.target, sha256: row.targetSha256 });
      if (!same(target.identity, row.targetIdentity)) fail("SOURCE_CHANGED");
    } else fail("BACKUP_INCOMPLETE");
  });
}

async function probeBroker(plan, descriptorPath, descriptorSha256) {
  const verifier = await runtimeModule(plan, "descriptor");
  const info = await verifier.verifyOriginalMcpBrokerDescriptor(descriptorPath, descriptorSha256, plan.request.profile.sha256);
  if (info.scope !== originalMcpCutoverScope || info.root !== plan.request.originalRoot
    || info.rootDevice !== plan.originalRootIdentity.dev || info.rootInode !== plan.originalRootIdentity.ino
    || info.profileSha256 !== plan.request.profile.sha256 || info.operatorId !== plan.request.operatorId
    || info.writable !== true || info.descriptorPath !== descriptorPath || info.descriptorSha256 !== descriptorSha256
    || !same(sorted(info.enabledOperationIds), sorted(plan.oracle.operationIds)) || info.disabledOperationIds.length
    || info.nodePath !== plan.runtime.node.path || info.nodeSha256 !== plan.runtime.node.sha256
    || info.runtimeBuildSha256 !== plan.runtime.buildSha256
    || info.relayPath !== modulePath(plan, "relay")
    || info.relaySha256 !== plan.runtime.files.find(entry => entry.path === entries.relay).sha256) fail("BROKER_NOT_FULL_PARITY");
  const child = spawn(plan.runtime.node.path,
    [info.relayPath, "relay", "--descriptor", descriptorPath, "--pin", descriptorSha256],
    { stdio: ["pipe", "pipe", "pipe"], cwd: plan.stageDirectory, env: { ...process.env, TMPDIR: plan.stageDirectory } });
  let pending = "", serial = 0, failed = false;
  const waiters = new Map();
  const closed = new Promise(resolve_ => child.once("close", resolve_));
  const refuse = cause => {
    failed = true;
    for (const value of waiters.values()) {
      const error = new OriginalMcpCutoverError("BROKER_AUTHENTICATION_FAILED");
      if (cause instanceof Error) error.cause = cause;
      value.reject(error);
    }
    waiters.clear();
  };
  child.on("error", refuse); child.once("close", refuse); child.stderr.on("data", () => {});
  child.stdin.on("error", refuse);
  child.stdout.on("data", chunk => {
    pending += chunk.toString("utf8");
    if (pending.length > 4 * 1024 * 1024) { refuse(); child.stdin.end(); return; }
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const text = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const value = JSON.parse(text), waiter = waiters.get(value.id);
        if (waiter) { waiters.delete(value.id); if (value.error) waiter.reject(new OriginalMcpCutoverError("BROKER_PROBE_FAILED")); else waiter.resolve(value.result); }
      } catch { refuse(); }
    }
  });
  const rpc = (method, params) => new Promise((resolve_, reject) => {
    if (failed) { reject(new OriginalMcpCutoverError("BROKER_AUTHENTICATION_FAILED")); return; }
    const id = ++serial, timer = setTimeout(() => { waiters.delete(id); reject(new OriginalMcpCutoverError("BROKER_PROBE_TIMEOUT")); }, 10000);
    waiters.set(id, { resolve(value) { clearTimeout(timer); resolve_(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, arguments_) => {
    const value = await rpc("tools/call", { name, arguments: arguments_ });
    if (value.isError) fail("BROKER_PROBE_FAILED");
    return value.structuredContent ?? JSON.parse(value.content.find(item => item.type === "text").text);
  };
  return withCleanup(async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "original-mcp-offline-cutover", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await rpc("tools/list", {});
    const expectedTools = [...originalMcpCutoverPublicTools, ...plan.oracle.directAliases.map(alias => alias.name)];
    if (!same(sorted(tools.tools.map(tool => tool.name)), sorted(expectedTools))) fail("BROKER_PUBLIC_TOOLS_MISMATCH");
    for (const alias of plan.oracle.directAliases) {
      const actual = tools.tools.find(tool => tool.name === alias.name);
      if (hash(actual.inputSchema) !== alias.inputSchemaSha256) fail("BROKER_DIRECT_TOOL_SCHEMA_MISMATCH");
    }
    for (const item of plan.oracle.describes)
      if (hash(await call("capabilities_describe", { operation: item.operation })) !== item.sha256) fail("BROKER_DESCRIBE_MISMATCH");
    for (const item of plan.oracle.discovery)
      if (hash(await call(item.tool, item.arguments)) !== item.sha256) fail("BROKER_DISCOVERY_MISMATCH");
    for (const path of ["todo", "memory"]) {
      const value = await call("capabilities_list", { path, limit: 3, offset: 0 });
      if (!Array.isArray(value.operations) || !value.operations.length) fail("CANONICAL_DOMAIN_UNAVAILABLE");
    }
    return { ...info, authenticated: true, describesVerified: 151, discoveryCasesVerified: 23,
      publicToolsVerified: tools.tools.length, toolSurface: "hybrid", aliasSurfaceSha256: plan.runtime.aliasSurfaceSha256 };
  }, [["relay-stdin-close", () => new Promise((resolve_, reject) => {
    if (child.stdin.destroyed) { resolve_(); return; }
    child.stdin.end(error => error ? reject(error) : resolve_());
  })], ["relay-process-close", async () => {
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 3000);
    try { await closed; } finally { clearTimeout(timer); }
  }]]);
}

export async function executeOriginalMcpCutover(path, independentSha256) {
  const plan = await loadPlan(path, independentSha256);
  if (SELF !== modulePath(plan, "coordinator") || within(plan.request.originalRoot, await realpath(process.cwd()))
    || within(plan.request.originalRoot, SELF)) fail("EXECUTOR_NOT_OFFLINE_STAGED");
  if (await realpath(process.execPath) !== plan.runtime.node.path
    || (await pinFile(await realpath(process.execPath))).sha256 !== plan.runtime.node.sha256) fail("EXECUTOR_RUNTIME_CHANGED");
  await assertBeforeMutation(plan);
  await implementationReadiness(plan);
  const { native, deployment } = await offlineDeployment(plan);
  const execution = join(plan.stageDirectory, "execution");
  let journal, root, recovery, fenceModule;
  try {
    await maintenance(plan);
    if (await statOrAbsent(execution)) fail("INTERRUPTED_TRANSACTION", "existing-transaction-requires-independent-inspection-not-replay");
    await mkdir(execution, { mode: 0o700 });
    journal = new Journal(execution, plan);
    await journal.write("planned", { sourceRootWritePlan: plan.sourceRootWritePlan, rootModeWritePlan: plan.rootModeWritePlan,
      profileNativeEdits: plan.profileNativeEdits });
    root = await runtimeModule(plan, "root"); recovery = await runtimeModule(plan, "recovery");
    fenceModule = await runtimeModule(plan, "fence");
  } catch (error) {
    const failures = await cleanupSteps([["native-deployment-close", () => deployment.close()]]);
    if (failures.length) throw await recordCleanupFailure(plan, error, failures, "execute-setup");
    throw error;
  }
  let writerFence, bootstrap, attachment, broker, custody, prepared, gitProtection;
  let fenceHandedOff = false, rootMutation = false, profileMutation = false;
  let lifecycle, plannedShutdown = false;
  const observedClosureFailures = [];
  const failTransaction = async error => {
    plannedShutdown = true;
    const failures = await cleanupSteps([
      ...(broker ? [["broker-stop", () => broker.stop()]] : []),
      ...(attachment ? [["native-attachment-close", () => attachment.close()]] : []),
      ...(bootstrap ? [["native-bootstrap-close", () => bootstrap.close()]] : []),
      ...(!bootstrap && writerFence && !fenceHandedOff ? [["writer-fence-release", () => writerFence.release()]] : []),
      ["native-deployment-close", () => deployment.close()],
    ]);
    failures.push(...observedClosureFailures);
    if (!bootstrap && writerFence && fenceHandedOff)
      failures.push({ operation: "writer-fence-retained",
        error: new OriginalMcpCutoverError("OWNER_SHUTDOWN_UNCONFIRMED", "canonical-fence-retained-after-uncertain-owner-handoff") });
    failures.push(...await cleanupSteps([["failure-journal", () => journal.write("failed-retained", {
      ...redactedError(error), rootMutation, profileMutation, fenceHandedOff,
      cleanupConfirmed: failures.length === 0 && !cleanupErrorBrands.has(error),
      cleanupFailures: failures.map(({ operation, error }) => ({ operation, ...redactedError(error) })),
      automaticRevertAttempted: false, b1RequiredBeforeAnyRevert: true })]]));
    const result = failures.length ? await recordCleanupFailure(plan, error, failures, "execute-transaction") : error;
    result.executionDirectory = execution;
    lifecycle?.reject(result);
    return result;
  };
  try {
    await journal.write("maintenance-verified", await maintenance(plan));
    writerFence = await fenceModule.acquireLinuxRootWriterFence(plan.request.originalRoot);
    if (!fenceModule.isTrustedLinuxRootWriterFence(writerFence, plan.request.originalRoot)) fail("WRITER_FENCE_INVALID");
    writerFence.assertHeld();
    await maintenance(plan);
    await journal.write("root-fence-held");
    const recoveryRequest = await json(join(plan.stageDirectory, "recovery-request.json"));
    if (!same(recoveryRequest, recoveryWithGitPolicy(
      await json(plan.request.recovery.path, plan.request.recovery.sha256), plan.request.originalRoot))) fail("RECOVERY_PLAN_CHANGED");
    await journal.write("b0-capture-intent");
    const b0 = await recovery.captureColdStateRecovery(recoveryRequest, plan.b0, { writerFence });
    if (!b0.summary.targetClosureComplete) fail("BACKUP_INCOMPLETE");
    await recovery.verifyColdStateRecovery(plan.b0, b0.manifestSha256);
    await journal.write("b0-captured", { path: plan.b0, manifestSha256: b0.manifestSha256,
      captureReadiness: b0.readiness, captureNotPromotedToGlobalColdAuthority: true });
    const restored = await recovery.restoreColdStateRecovery(plan.b0, b0.manifestSha256, plan.b0Restored);
    if (!restored.summary.targetClosureComplete || restored.sqlite.databases !== restored.sqlite.integrityChecksPassed
      || !same(restored.summary, b0.summary)) fail("BACKUP_RESTORE_UNQUALIFIED");
    await journal.write("b0-restore-verified", { path: plan.b0Restored, manifestSha256: b0.manifestSha256,
      sqlite: restored.sqlite, summary: restored.summary });
    writerFence.assertHeld();
    await assertBeforeMutation(plan);
    await verifyB0Sources(plan, recovery, b0);
    const mode = await runtimeModule(plan, "rootMode");
    const modePlan = mode.planOriginalMcpRootMode(plan.request.originalRoot);
    if (!same(modePlan, plan.rootModePlan)) fail("ROOT_MODE_CHANGED");
    await journal.write("root-mode-write-intent", { plan: modePlan, b0ManifestSha256: b0.manifestSha256,
      backupDirectory: join(execution, "root-mode") });
    rootMutation = true;
    const hardened = await mode.applyOriginalMcpRootMode(modePlan,
      { writerFence, backupDirectory: join(execution, "root-mode"), approvedMode: plan.request.rootMode.approvedMode });
    await journal.write("root-mode-verified", { ...hardened, mode: 0o700, childrenChanged: false });
    await journal.write("git-protection-write-intent", { path: join(plan.request.originalRoot, ".gitignore"),
      beforeSha256: plan.gitProtectionPlan.beforeSha256, desiredSha256: plan.gitProtectionPlan.desiredSha256,
      b0ManifestSha256: b0.manifestSha256 });
    const git = await runtimeModule(plan, "gitProtection");
    const gitPlan = git.planOriginalMcpGitProtection(plan.request.originalRoot);
    if (gitPlan.beforeSha256 !== plan.gitProtectionPlan.beforeSha256 || gitPlan.beforeIdentity !== plan.gitProtectionPlan.beforeIdentity
      || gitPlan.desiredSha256 !== plan.gitProtectionPlan.desiredSha256) fail("GIT_PROTECTION_CHANGED");
    await durable(join(execution, "git-protection-plan.json"), gitPlan);
    gitProtection = await git.applyOriginalMcpGitProtection(gitPlan,
      { writerFence, backupDirectory: join(execution, "git-protection") });
    gitProtection.assertCurrent();
    await journal.write("git-protection-verified", { changed: gitProtection.changed,
      backupDirectory: gitProtection.backupDirectory, sha256: plan.gitProtectionPlan.desiredSha256 });
    custody = await root.captureOriginalMcpCustody({ root: plan.request.originalRoot,
      backup: join(execution, "custody"), operatorId: plan.request.operatorId,
      profileSha256: plan.request.profile.sha256, limits: plan.request.custodyLimits }, { writerFence });
    await root.verifyOriginalMcpCustody(custody);
    await durable(join(execution, "custody-plan.json"), custody);
    await journal.write("custody-verified", { planSha256: custody.planSha256 });
    await loadPlan(path, independentSha256);
    await implementationReadiness(plan); await maintenance(plan); await assertBeforeMutation(plan, gitProtection, true);
    if (!native.isTrustedOriginalMcpOfflineDeployment(deployment, {
      root: plan.request.originalRoot, profileSha256: plan.request.profile.sha256, acceptedScope: originalMcpCutoverScope,
    })) fail("NATIVE_DEPLOYMENT_UNAVAILABLE");
    await verifyB0Sources(plan, recovery, b0, gitProtection, true);
    await journal.write("original-write-intent", { files: plan.sourceRootWritePlan, b0ManifestSha256: b0.manifestSha256,
      custodyPlanSha256: custody.planSha256 });
    gitProtection.assertCurrent();
    prepared = await root.prepareOriginalMcpRoot(custody, { writerFence, gitProtection });
    await durable(join(execution, "prepared.json"), prepared);
    await journal.write("original-prepared", prepared);
    await mkdir(plan.brokerDirectory, { mode: 0o700 });
    const relay = plan.runtime.files.find(entry => entry.path === entries.relay);
    fenceHandedOff = true;
    bootstrap = await native.bootstrapOriginalMcpNativeAttachment({
      plan: custody, writerFence, directory: plan.brokerDirectory,
      deployment, prepared,
      runtime: { node: plan.runtime.node, relay: { path: modulePath(plan, "relay"), sha256: relay.sha256 }, buildSha256: plan.runtime.buildSha256 },
      manifest: { schema: "pkm.mcp.lifecycle/v1", managedRoot: plan.stageDirectory, generation: plan.id, version: "0.1.0",
        runtimeBuild: plan.runtime.buildSha256, components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
        enabledFeatureDomains: [] },
      gitProtection, contract: originalMcpNativeAttachmentContract,
    });
    void bootstrap?.closed?.then(result => {
      if (!lifecycle && result?.reason === "critical-failure")
        observedClosureFailures.push({ operation: "native-bootstrap-observed", error: new OriginalMcpCutoverError("BROKER_CRITICAL_FAILURE") });
    }, error => {
      if (!lifecycle) observedClosureFailures.push({ operation: "native-bootstrap-observed", error });
    });
    writerFence.assertHeld();
    const binding = { root: plan.request.originalRoot, profileSha256: plan.request.profile.sha256,
      planSha256: custody.planSha256, publicEnrollmentSha256: plan.nativePublicEnrollmentSha256,
      identitySha256: plan.nativeIdentitySha256, payloadBuildId: plan.request.nativeDeployment.payloadBuildId,
      hostEntrySha256: plan.request.nativeDeployment.hostEntry.sha256 };
    if (!native.isTrustedOriginalMcpNativeBootstrap(bootstrap, binding) || !bootstrap.owner || !bootstrap.storage
      || typeof bootstrap.close !== "function" || !isHash(bootstrap.attachmentDescriptorSha256)
      || bootstrap.businessReady !== false || bootstrap.storageRecovered !== false
      || bootstrap.descriptorPath !== undefined || bootstrap.descriptorSha256 !== undefined)
      fail("NATIVE_BOOTSTRAP_UNQUALIFIED", "private-attachment-endpoint-is-not-a-business-mcp-or-recovery-grant");
    await canonical(bootstrap.attachmentDescriptorPath, "file", true);
    await checkedPin({ path: bootstrap.attachmentDescriptorPath, sha256: bootstrap.attachmentDescriptorSha256 });
    await validateNativeControlDescriptor(plan, custody, bootstrap);
    const canonicalOwner = bootstrap.owner, canonicalStorage = bootstrap.storage;
    canonicalOwner.assertWorkspaceLease();
    if (observedClosureFailures.length) throw observedClosureFailures.shift().error;
    await journal.write("native-attachment-bootstrap", { workspaceId: bootstrap.workspaceId,
      attachmentDescriptorPath: bootstrap.attachmentDescriptorPath, attachmentDescriptorSha256: bootstrap.attachmentDescriptorSha256,
      businessReady: false, storageRecovered: false });
    let resolveLifecycle, rejectLifecycle;
    const closed = new Promise((resolve_, reject) => { resolveLifecycle = resolve_; rejectLifecycle = reject; });
    lifecycle = { resolve: resolveLifecycle, reject: rejectLifecycle };
    void closed.catch(notifyFailure);
    let closing;
    const shutdown = async (primary = noPrimaryError) => {
      return closing ??= (async () => {
        plannedShutdown = true;
        const failures = await cleanupSteps([
          ...(broker ? [["broker-stop", () => broker.stop()]] : []),
          ...(attachment ? [["native-attachment-close", () => attachment.close()]] : []),
          ["native-bootstrap-close", () => bootstrap.close()],
          ["native-deployment-close", () => deployment.close()],
        ]);
        failures.push(...observedClosureFailures);
        failures.push(...await cleanupSteps([["shutdown-journal", () => journal.write(
          failures.length ? "broker-close-failed" : "broker-closed", { originalStateRetained: true,
            cleanupConfirmed: failures.length === 0,
            cleanupFailures: failures.map(({ operation, error }) => ({ operation, ...redactedError(error) })) })]]));
        if (failures.length || primary !== noPrimaryError) {
          const error = await recordCleanupFailure(plan, primary, failures, primary === noPrimaryError ? "broker-close" : "broker-background");
          lifecycle.reject(error); throw error;
        }
        lifecycle.resolve({ reason: "maintenance", cleanupConfirmed: true });
      })();
    };
    const close = () => shutdown();
    void bootstrap.closed?.then(result => {
      if (plannedShutdown) return;
      return shutdown(result?.reason === "critical-failure"
        ? new OriginalMcpCutoverError("BROKER_CRITICAL_FAILURE") : noPrimaryError);
    }, error => {
      if (plannedShutdown) { observedClosureFailures.push({ operation: "native-bootstrap-observed", error }); return; }
      return shutdown(error);
    }).catch(error => lifecycle.reject(error));
    let completing;
    const complete = () => completing ??= (async () => {
      try {
        if (plannedShutdown) fail("NATIVE_BOOTSTRAP_CLOSED");
        canonicalOwner.assertWorkspaceLease(); writerFence.assertHeld();
        let timer;
        try {
          attachment = await Promise.race([
            native.waitForOriginalMcpNativeAttachment(bootstrap, { timeoutMs: 300000 }),
            closed.then(() => fail("NATIVE_BOOTSTRAP_CLOSED")),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new OriginalMcpCutoverError("NATIVE_ATTACHMENT_TIMEOUT")), 300000);
            }),
          ]);
        } finally { clearTimeout(timer); }
        if (plannedShutdown) fail("NATIVE_BOOTSTRAP_CLOSED");
        canonicalOwner.assertWorkspaceLease(); writerFence.assertHeld();
        if (!native.isTrustedOriginalMcpNativeAttachment(attachment, { ...binding, bootstrap })
          || typeof attachment.close !== "function") fail("NATIVE_ATTACHMENT_UNAUTHENTICATED");
        await journal.write("native-signed-attachment", { workspaceId: bootstrap.workspaceId,
          publicEnrollmentSha256: plan.nativePublicEnrollmentSha256 });
        const admission = await native.admitOriginalMcpNativeAttachment(bootstrap, attachment);
        if (admission?.schema !== "pkm.original-mcp-native-admission/v1" || admission.profileSha256 !== binding.profileSha256
          || admission.workspaceId !== bootstrap.workspaceId || admission.planSha256 !== custody.planSha256
          || admission.publicEnrollmentSha256 !== plan.nativePublicEnrollmentSha256 || admission.recoveryCompleted !== true
          || admission.identitySha256 !== plan.nativeIdentitySha256 || admission.payloadBuildId !== binding.payloadBuildId
          || admission.hostEntrySha256 !== binding.hostEntrySha256
          || admission.credentialPolicy !== "native-reenroll-separate-id" || admission.oldCredentialsTouched !== false
          || !same(sorted(admission.canonicalDomains ?? []), ["memory", "todo"])
          || !same(sorted(admission.enabledOperationIds ?? []), sorted(plan.oracle.operationIds))
          || typeof admission.epoch !== "string" || !admission.epoch) fail("NATIVE_ADMISSION_UNQUALIFIED");
        if (bootstrap.owner !== canonicalOwner || bootstrap.storage !== canonicalStorage) fail("NATIVE_OWNER_REOPENED");
        await canonicalOwner.ensureFull();
        canonicalOwner.assertWorkspaceLease(); writerFence.assertHeld();
        await implementationReadiness(plan);
        canonicalOwner.assertWorkspaceLease(); writerFence.assertHeld();
        if (!native.isTrustedOriginalMcpNativeAttachment(attachment, { ...binding, bootstrap }))
          fail("NATIVE_ATTACHMENT_UNAUTHENTICATED");
        await journal.write("native-admission-complete", { workspaceId: bootstrap.workspaceId, epoch: admission.epoch,
          recoveryCompleted: true, oldCredentialsTouched: false });
        broker = await native.publishOriginalMcpNativeBusiness({
          bootstrap, attachment, deployment, plan: custody, toolSurface: "hybrid", gitProtection,
          authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.request.operatorId,
            profileSha256: binding.profileSha256, planSha256: custody.planSha256,
            acceptedScope: originalMcpCutoverScope, writable: true },
        });
        if (broker.owner !== canonicalOwner || broker.storage !== canonicalStorage) fail("NATIVE_OWNER_REOPENED");
        const verified = await probeBroker(plan, broker.descriptorPath, broker.descriptorSha256);
        gitProtection.assertCurrent();
        await journal.write("business-broker-verified", { descriptorPath: broker.descriptorPath,
          descriptorSha256: broker.descriptorSha256, workspaceId: verified.workspaceId });
        await profileBinding(plan);
        if (plannedShutdown || !native.isTrustedOriginalMcpNativeAttachment(attachment, { ...binding, bootstrap }))
          fail("NATIVE_ATTACHMENT_UNAUTHENTICATED");
        await checkedPin(plan.request.nativeDeployment.publicEnrollment);
        if (await statOrAbsent(plan.enrollmentPath)) fail("ENROLLMENT_EXISTS");
        const enrollment = { schema: "pkm.original-mcp-enrollment/v1", descriptorPath: broker.descriptorPath,
          descriptorSha256: broker.descriptorSha256, profileSha256: binding.profileSha256 };
        const enrollmentStage = join(plan.request.profile.storageDirectory, `.original-mcp-enrollment-${randomUUID()}.partial`);
        profileMutation = true;
        await durable(enrollmentStage, enrollment);
        const noReplace = await runtimeModule(plan, "noReplace");
        await noReplace.renameNoReplace(enrollmentStage, plan.enrollmentPath);
        await syncDirectory(dirname(plan.enrollmentPath));
        const journalHeadSha256 = await journal.write("enrolled-after-native-admission", {
          enrollmentPath: plan.enrollmentPath, enrollmentSha256: hash(enrollment), acceptedScope: originalMcpCutoverScope });
        const artifacts = [];
        for (const artifactPath of [join(execution, "root-mode/root-mode.before.json"), join(execution, "git-protection/gitignore.before"),
          join(execution, "git-protection/protection.json"), join(execution, "git-protection-plan.json"),
          join(execution, "custody-plan.json"), join(execution, "prepared.json"), join(plan.b0Restored, "restore.complete.json")])
          artifacts.push({ path: artifactPath, sha256: (await pinFile(artifactPath)).sha256 });
        const executionReceiptPath = join(execution, "execution-receipt.json");
        const executionReceiptSha256 = await durable(executionReceiptPath, {
          schema: "pkm.original-mcp-cutover-execution-receipt/v1", planSha256: plan.planSha256,
          descriptorPath: broker.descriptorPath, descriptorSha256: broker.descriptorSha256, workspaceId: verified.workspaceId,
          b0: { path: plan.b0, manifestSha256: b0.manifestSha256 }, artifacts, journalHeadSha256,
          enrollmentSha256: hash(enrollment), activated: false, nativeAdmissionEpoch: admission.epoch,
        });
        return { schema: "pkm.original-mcp-cutover-execution/v1", planPath: path, planSha256: plan.planSha256,
          executionDirectory: execution, descriptorPath: broker.descriptorPath, descriptorSha256: broker.descriptorSha256,
          enrollmentPath: plan.enrollmentPath, acceptedScope: originalMcpCutoverScope, executionReceiptPath, executionReceiptSha256,
          status: "business-enrolled-after-native-admission", activated: false,
          b0ManifestSha256: b0.manifestSha256, broker, custody, prepared, close, closed };
      } catch (error) { throw await failTransaction(error); }
    })();
    return { schema: "pkm.original-mcp-native-bootstrap/v1", planPath: path, planSha256: plan.planSha256,
      executionDirectory: execution, attachmentDescriptorPath: bootstrap.attachmentDescriptorPath,
      attachmentDescriptorSha256: bootstrap.attachmentDescriptorSha256, status: "awaiting-native-attachment",
      businessReady: false, storageRecovered: false, activated: false, complete, close, closed };
  } catch (error) {
    throw await failTransaction(error);
  }
}

export async function verifyOriginalMcpCutover(path, independentSha256, descriptorPath, descriptorSha256, executionReceiptSha256) {
  const plan = await loadPlan(path, independentSha256);
  const executionReceipt = await verifyExecutionReceipt(plan, executionReceiptSha256, descriptorPath, descriptorSha256);
  await implementationReadiness(plan); await profileBinding(plan);
  await checkedPin({ path: join(plan.request.originalRoot, ".gitignore"), sha256: plan.gitProtectionPlan.desiredSha256 });
  const enrollment = await json(plan.enrollmentPath);
  if (enrollment.schema !== "pkm.original-mcp-enrollment/v1" || enrollment.descriptorPath !== descriptorPath
    || enrollment.descriptorSha256 !== descriptorSha256 || enrollment.profileSha256 !== plan.request.profile.sha256)
    fail("ENROLLMENT_CHANGED");
  const broker = await probeBroker(plan, descriptorPath, descriptorSha256);
  const installed = await nativeExtensions(plan);
  if (!plan.runtime.extension || !installed.includes(`${plan.runtime.extension.id}@${plan.runtime.extension.version}`.toLowerCase()))
    fail("PARENT_NATIVE_INSTALL_PENDING");
  const native = await nativeAttachmentProtocol(plan);
  if (typeof native.verifyOriginalMcpNativeActivation !== "function")
    fail("NATIVE_ACTIVATION_QUALIFICATION_REQUIRED", "qualified-native-profile-activation-and-same-owner-reuse-receipt-required");
  const receipt = await native.verifyOriginalMcpNativeActivation({
    broker, profile: await profileBinding(plan), releaseSha256: plan.request.release.manifest.sha256,
    extension: plan.runtime.extension, enrollmentSha256: hash(enrollment), executionReceiptSha256,
  });
  if (receipt?.schema !== "pkm.original-mcp-native-activation/v1"
    || receipt.profileSha256 !== plan.request.profile.sha256 || receipt.workspaceId !== broker.workspaceId
    || receipt.descriptorSha256 !== descriptorSha256 || receipt.rootOwnerReopened !== false
    || receipt.releaseSha256 !== plan.request.release.manifest.sha256
    || receipt.authenticatedBrokerReuse !== true || receipt.workspaceId !== executionReceipt.workspaceId
    || receipt.credentialPolicy !== "native-reenroll-separate-id" || receipt.oldCredentialsTouched !== false
    || receipt.legacyRuntimeActive !== false || receipt.publicEnrollmentSha256 !== plan.nativePublicEnrollmentSha256
    || receipt.identitySha256 !== plan.nativeIdentitySha256 || receipt.payloadBuildId !== plan.request.nativeDeployment.payloadBuildId
    || receipt.hostEntrySha256 !== plan.request.nativeDeployment.hostEntry.sha256
    || !["authenticated-native-promotion/v1", "qualified-same-owner-native-rebind/v1"].includes(receipt.registrationMode))
    fail("NATIVE_ACTIVATION_QUALIFICATION_REQUIRED");
  return { schema: "pkm.original-mcp-cutover-verification/v1", acceptedScope: originalMcpCutoverScope,
    verified: true, activated: true, descriptorSha256, workspaceId: broker.workspaceId,
    receipt: { schema: receipt.schema, profileSha256: receipt.profileSha256, workspaceId: receipt.workspaceId,
      descriptorSha256: receipt.descriptorSha256, rootOwnerReopened: false, authenticatedBrokerReuse: true,
      registrationMode: receipt.registrationMode } };
}

export async function preserveOriginalMcpCutoverB1(path, independentSha256) {
  const plan = await loadPlan(path, independentSha256);
  await maintenance(plan);
  const root = await runtimeModule(plan, "root"), recovery = await runtimeModule(plan, "recovery");
  const writerFence = await root.acquireOriginalMcpRootFence(plan.request.originalRoot);
  let primary = noPrimaryError;
  try {
    await checkedPin({ path: join(plan.request.originalRoot, ".gitignore"), sha256: plan.gitProtectionPlan.desiredSha256 });
    const git = await runtimeModule(plan, "gitProtection");
    if (git.planOriginalMcpGitProtection(plan.request.originalRoot).desiredSha256 !== plan.gitProtectionPlan.desiredSha256)
      fail("GIT_PROTECTION_CHANGED");
    for (const name of await children(plan.request.originalRoot))
      if ((name.startsWith(".pkm-") || name.startsWith("core.sqlite") || name.startsWith("coding-process.sqlite"))
        && !managedNames.includes(name) && !nativeB1Directories.has(name))
        fail("B1_SCOPE_UNQUALIFIED", "retain-unknown-private-native-state; explicit-complete-scope-retirement-required");
    const request = await json(join(plan.stageDirectory, "recovery-request.json"));
    request.includeNativeRuntimeDirectories = true;
    request.configurationFiles = [...request.configurationFiles, ...managedNames
      .filter(name => !/^(?:core|coding-process)\.sqlite-/.test(name))
      .map((name, index) => ({ id: `native-b1-${index}`, path: join(plan.request.originalRoot, name) }))];
    const suffix = randomBytes(6).toString("hex"), base = dirname(plan.stageDirectory);
    const target = join(base, `${plan.id}-b1-${suffix}`), restored = `${target}-restored`;
    const captured = await recovery.captureColdStateRecovery(request, target, { writerFence });
    if (!captured.summary.targetClosureComplete) fail("BACKUP_INCOMPLETE");
    await recovery.verifyColdStateRecovery(target, captured.manifestSha256);
    const validated = await recovery.restoreColdStateRecovery(target, captured.manifestSha256, restored);
    if (!same(validated.summary, captured.summary)) fail("BACKUP_RESTORE_UNQUALIFIED");
    const record = { schema: "pkm.original-mcp-cutover-b1/v1", path: target, restored, manifestSha256: captured.manifestSha256,
      scope: "selected-db-config-history-old-mcp-and-enumerated-native-runtime-files-and-directories",
      completeOriginalRootImage: false, originalFilesReverted: false, retirementQualified: false, planSha256: plan.planSha256 };
    await durable(join(plan.stageDirectory, `b1-${suffix}.json`), record);
    return record;
  } catch (error) { primary = error; throw error; }
  finally {
    const failures = await cleanupSteps([["writer-fence-release", () => writerFence.release()]]);
    if (failures.length) throw await recordCleanupFailure(plan, primary, failures, "b1-preservation");
  }
}

export async function rollbackOriginalMcpCutover(path, independentSha256) {
  const b1 = await preserveOriginalMcpCutoverB1(path, independentSha256);
  const error = new OriginalMcpCutoverError("ROLLBACK_RETIREMENT_UNQUALIFIED",
    "B1-retained; no-qualified-original-state-retirement-or-native-profile-reinstall-protocol");
  error.b1 = b1;
  throw error;
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan" && args.length === 2) return planOriginalMcpCutover(await json(absolute(args[0])), absolute(args[1]));
  if (command === "execute" && args.length === 2) {
    const result = await executeOriginalMcpCutover(absolute(args[0]), args[1]);
    console.log(JSON.stringify({ ...result, complete: undefined, close: undefined, closed: undefined }));
    const stop = () => { void result.close().catch(error => { notifyFailure(error); process.exitCode = 1; }); };
    void result.closed?.catch(() => { process.exitCode = 1; });
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const active = await result.complete();
    console.log(JSON.stringify({ ...active, broker: undefined, custody: undefined, prepared: undefined, close: undefined, closed: undefined }));
    return undefined;
  }
  if (command === "validate-native-staging" && args.length === 2)
    return validateOriginalMcpNativeStaging(absolute(args[0]), args[1]);
  if (command === "verify" && args.length === 5)
    return verifyOriginalMcpCutover(absolute(args[0]), args[1], absolute(args[2]), args[3], args[4]);
  if (command === "preserve-b1" && args.length === 2) return preserveOriginalMcpCutoverB1(absolute(args[0]), args[1]);
  if (command === "rollback" && args.length === 2) return rollbackOriginalMcpCutover(absolute(args[0]), args[1]);
  fail("USAGE", "plan REQUEST NEW_PRIVATE_STAGE | validate-native-staging PLAN PIN | execute PLAN PIN | verify PLAN PIN DESCRIPTOR PIN EXECUTION_RECEIPT_PIN | preserve-b1 PLAN PIN | rollback PLAN PIN");
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  cli().then(value => { if (value) console.log(JSON.stringify(value)); }).catch(error => {
    console.error(JSON.stringify({ ...redactedError(error),
      condition: error instanceof OriginalMcpCutoverError || cleanupErrorBrands.has(error) ? error.condition : "operation-failed",
      ...(error.retainedStage ? { retainedStage: error.retainedStage } : {}),
      ...(error.executionDirectory ? { executionDirectory: error.executionDirectory } : {}),
      ...(error.cleanupReportPath ? { cleanupReportPath: error.cleanupReportPath, cleanupReportDurable: error.cleanupReportDurable } : {}),
      ...(error.b1 ? { b1: error.b1 } : {}) }));
    process.exitCode = 1;
  });
}
