import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { inspectLegacyChatroomTree } from "./legacy-chatroom-continuation.js";
import { legacyPathHasNoSymlinks, legacyPrivateRootGuard, sameLegacyPrivateRoot } from "./legacy-effective-private-root.js";
import { verifyNativeSyncRootContent } from "./sync-root-content-custody.js";
import { coreDatabasePath } from "./workspace-storage-paths.js";

const surfaces = new Map<string, "directory" | "file">([
  [".git", "directory"], [".gitignore", "file"], ["chatrooms", "directory"],
  ["mcp-server", "directory"], ["servers", "directory"], ["fixture-sentinel.txt", "file"],
]);
const gitRootEntries = ["HEAD", "config", "description", "hooks", "index", "info", "objects", "refs"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;

/** Preserve a closed generation as bytes only; this does not establish writer quiescence or trust its code. */
function validateManagedMcp(root: string, maximumBytes: number, maximumEntries: number): void {
  let totalBytes = 0, totalEntries = 0;
  const knowledgeRoot = dirname(root), privateRoot = legacyPrivateRootGuard(knowledgeRoot);
  let usesPrivateRoot = false;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o7002) !== 0
    || process.getuid === undefined || rootStat.uid !== process.getuid())
    fail("mcp-server", "Managed MCP root must be a real owned directory.");
  const top = readdirSync(root).sort();
  const required = ["active-generation.json", "generations", "requirements.txt", "server.py"];
  if (required.some(name => !top.includes(name)) || top.some(name => ![...required, "latest-generation.json", "instances"].includes(name)))
    fail("mcp-server", "Unknown or incomplete managed MCP state requires its original recovery procedure.");
  const read = (file: string, privateFile = false, legacyInstance = false): Buffer => {
    const before = lstatSync(file);
    const sharedInstance = legacyInstance && !!privateRoot && (before.mode & 0o7002) === 0;
    if (sharedInstance && (before.mode & 0o077) !== 0) usesPrivateRoot = true;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_777_216
      || (before.mode & 0o7002) !== 0 || process.getuid === undefined || before.uid !== process.getuid()
      || privateFile && (before.mode & 0o077) !== 0 && !sharedInstance
      || !legacyPathHasNoSymlinks(knowledgeRoot, relative(knowledgeRoot, file)))
      fail("mcp-server", "Managed MCP files must be bounded, owned regular files with safe permissions.");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1
        || opened.size !== before.size || opened.mode !== before.mode || opened.uid !== before.uid)
        fail("mcp-server", "Managed MCP file identity changed while opening.");
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(file);
      totalBytes += bytes.length;
      if (totalBytes > maximumBytes) fail("mcp-server", "Managed MCP generation exceeds the bounded byte limit.");
      if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== before.size || current.mode !== before.mode || current.uid !== before.uid
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs)
        fail("mcp-server", "Managed MCP file changed during inspection.");
      return bytes;
    } finally { closeSync(fd); }
  };
  const json = (file: string, legacyInstance = false): Record<string, any> => {
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read(file, true, legacyInstance)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a record");
      return value as Record<string, any>;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "LEGACY_ROOT_INERT_STATE_UNSUPPORTED") throw error;
      return fail("mcp-server", "Managed MCP controls must be valid bounded UTF-8 JSON records.");
    }
  };
  const baseline = json(join(root, "active-generation.json"));
  const latest = top.includes("latest-generation.json") ? json(join(root, "latest-generation.json")) : baseline;
  for (const [value, isBaseline] of [[baseline, true], [latest, false]] as const) {
    const keys = Object.keys(value);
    if (keys.some(key => !["schema", "generation", ...(isBaseline ? ["compatibilityBaseline"] : [])].includes(key))
      || value.schema !== "pkm.mcp.lifecycle/v1" || typeof value.generation !== "string" || !uuid.test(value.generation)
      || value.compatibilityBaseline !== undefined && value.compatibilityBaseline !== true)
      fail("mcp-server", "Managed MCP generation pointers are invalid.");
  }
  if (baseline.generation !== latest.generation && baseline.compatibilityBaseline !== true)
    fail("mcp-server", "Managed MCP generation transition is incomplete.");
  const generationRoot = join(root, "generations");
  const directory = lstatSync(generationRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o7002) !== 0
    || process.getuid === undefined || directory.uid !== process.getuid())
    fail("mcp-server", "Managed MCP generations must be a real owned directory.");
  const generations = readdirSync(generationRoot).sort();
  if (!generations.length || generations.length > 128 || generations.some(name => !uuid.test(name))
    || !generations.includes(baseline.generation) || !generations.includes(latest.generation))
    fail("mcp-server", "Managed MCP generation set is incomplete or unknown.");
  const manifests = new Map<string, Record<string, any>>();
  for (const generation of generations) {
    const location = join(generationRoot, generation);
    const locationStat = lstatSync(location);
    if (!locationStat.isDirectory() || locationStat.isSymbolicLink() || (locationStat.mode & 0o7002) !== 0
      || process.getuid === undefined || locationStat.uid !== process.getuid())
      fail("mcp-server", "Managed MCP generation must be a real owned directory.");
    const manifest = json(join(location, "manifest.json"));
    if (manifest.schema !== "pkm.mcp.lifecycle/v1" || manifest.generation !== generation
      || typeof manifest.managedRoot !== "string" || !manifest.managedRoot.startsWith("/")
      || typeof manifest.version !== "string" || typeof manifest.extensionVersion !== "string"
      || typeof manifest.runtimeBuild !== "string" || !sha256.test(manifest.runtimeBuild)
      || typeof manifest.node !== "string" || !manifest.components || typeof manifest.components !== "object"
      || Array.isArray(manifest.components) || !Array.isArray(manifest.enabledFeatureDomains)
      || manifest.enabledFeatureDomains.some((value: unknown) => !["knowledge", "automation", "skillRouter"].includes(String(value)))
      || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files))
      fail("mcp-server", "Managed MCP generation manifest is unsupported.");
    if (["knowledge", "chat", "recipes", "agent_sessions"].some(key => typeof manifest.components[key] !== "string"))
      fail("mcp-server", "Managed MCP component identities are incomplete.");
    if (manifest.compatibility !== undefined && (!manifest.compatibility || typeof manifest.compatibility !== "object"
      || typeof manifest.compatibility.protocol !== "string" || !manifest.compatibility.components
      || typeof manifest.compatibility.components !== "object" || Array.isArray(manifest.compatibility.components)
      || Object.entries(manifest.components).some(([name, version]) => typeof version !== "string"
        || manifest.compatibility.components[name] !== version.split(".")[0])))
      fail("mcp-server", "Managed MCP compatibility metadata is invalid.");
    const expected = new Map<string, string>(Object.entries(manifest.files));
    if (!expected.size || expected.size > 20_000) fail("mcp-server", "Managed MCP file set exceeds its bounds.");
    for (const [name, digest] of expected) {
      if (!name || name === "manifest.json" || name.startsWith("/") || name.includes("\\")
        || name.split("/").some(part => !part || part === "." || part === "..")
        || typeof digest !== "string" || !sha256.test(digest))
        fail("mcp-server", "Managed MCP manifest contains an invalid path or digest.");
    }
    const runtime = createHash("sha256");
    const runtimeFiles = [...expected.keys()].filter(name => name.startsWith("runtime/"))
      .map(name => name.slice("runtime/".length)).sort();
    if (!runtimeFiles.length) fail("mcp-server", "Managed MCP runtime is missing.");
    for (const name of runtimeFiles) runtime.update(name).update("\0").update(expected.get(`runtime/${name}`)!).update("\0");
    if (runtime.digest("hex") !== manifest.runtimeBuild) fail("mcp-server", "Managed MCP runtime build identity does not match.");
    const observed = new Set<string>();
    const walk = (path: string, prefix = "", depth = 0): void => {
      if (depth > 32) fail("mcp-server", "Managed MCP generation exceeds its depth bound.");
      const before = lstatSync(path);
      if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7002) !== 0
        || process.getuid === undefined || before.uid !== process.getuid())
        fail("mcp-server", "Managed MCP directories must be real and owned with safe permissions.");
      for (const name of readdirSync(path).sort()) {
        if (++totalEntries > maximumEntries) fail("mcp-server", "Managed MCP generation exceeds the bounded entry limit.");
        const relative = prefix ? `${prefix}/${name}` : name, file = join(path, name);
        const stat = lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file, relative, depth + 1);
        else {
          if (relative === "manifest.json") continue;
          const wanted = expected.get(relative);
          if (!wanted || createHash("sha256").update(read(file)).digest("hex") !== wanted)
            fail("mcp-server", "Managed MCP files differ from their preserved generation manifest.");
          observed.add(relative);
        }
      }
      const after = lstatSync(path);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        fail("mcp-server", "Managed MCP directory changed during inspection.");
    };
    walk(location);
    if (observed.size !== expected.size) fail("mcp-server", "Managed MCP generation has missing files.");
    manifests.set(generation, manifest);
  }
  if (top.includes("instances")) {
    const instances = join(root, "instances"), before = lstatSync(instances);
    const sharedInstances = !!privateRoot && (before.mode & 0o7002) === 0;
    if (sharedInstances && (before.mode & 0o077) !== 0) usesPrivateRoot = true;
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7000) !== 0
      || (before.mode & 0o077) !== 0 && !sharedInstances
      || process.getuid === undefined || before.uid !== process.getuid())
      fail("mcp-server", "MCP instance archive must be a private owned directory.");
    const names = readdirSync(instances).sort();
    if (names.length > 512 || totalEntries + names.length > maximumEntries)
      fail("mcp-server", "MCP instance archive exceeds its bounded entry limit.");
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) fail("mcp-server", "Unknown or pending MCP instance state.");
      const instance = json(join(instances, name), true);
      const expected = ["acceptingNewCalls", "action", "attribution", "automaticReplay", "automaticTermination",
        "compatibility", "components", "controlError", "drainDeadlineExceeded", "drainTimeoutSeconds",
        "extensionVersion", "generation", "gracefulRetirement", "heartbeatAt", "inFlight", "instanceId",
        "phase", "pid", "runtimeBuild", "schema", "uncertainCalls", "updateAvailable", "version"];
      const manifest = manifests.get(instance.generation);
      if (Object.keys(instance).sort().join("\n") !== expected.sort().join("\n")
        || instance.schema !== "pkm.mcp.lifecycle/v1" || instance.instanceId !== name.slice(0, -5)
        || !manifest || instance.runtimeBuild !== manifest.runtimeBuild || instance.version !== manifest.version
        || instance.extensionVersion !== manifest.extensionVersion || !instance.components || typeof instance.components !== "object"
        || Array.isArray(instance.components)
        || Object.keys(instance.components).sort().join("\n") !== Object.keys(manifest.components).sort().join("\n")
        || Object.keys(manifest.components).some(key => instance.components[key] !== manifest.components[key])
        || !["drained", "retired"].includes(instance.phase) || instance.acceptingNewCalls !== false
        || instance.inFlight !== 0 || instance.uncertainCalls !== 0 || instance.controlError !== ""
        || instance.drainDeadlineExceeded !== false || instance.automaticReplay !== false
        || instance.automaticTermination !== false || instance.gracefulRetirement !== true
        || !Number.isSafeInteger(instance.pid) || instance.pid < 1
        || !Number.isFinite(instance.heartbeatAt) || instance.heartbeatAt <= 0
        || !Number.isFinite(instance.drainTimeoutSeconds) || instance.drainTimeoutSeconds <= 0
        || !["current", "compatible-update", "reconnect-required"].includes(instance.compatibility)
        || typeof instance.updateAvailable !== "boolean" || instance.action !== "reconnect"
        || !instance.attribution || typeof instance.attribution !== "object" || Array.isArray(instance.attribution)
        || instance.attribution.schema !== "pkm.mcp.attribution/v1")
        fail("mcp-server", "MCP instance record is not a bounded completed lifecycle record.");
    }
    const after = lstatSync(instances);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail("mcp-server", "MCP instance archive changed during inspection.");
  }
  if (baseline.generation !== latest.generation) {
    const before = manifests.get(baseline.generation)!, after = manifests.get(latest.generation)!;
    const contract = (manifest: Record<string, any>) => manifest.compatibility ?? {
      protocol: "pkm.mcp.api/1",
      components: Object.fromEntries(Object.entries(manifest.components).map(([name, version]) =>
        [name, String(version).split(".")[0]])),
    };
    const first = contract(before), second = contract(after);
    if (first?.protocol !== "pkm.mcp.api/1" || second?.protocol !== first.protocol
      || !first.components || typeof first.components !== "object" || Array.isArray(first.components)
      || !second.components || typeof second.components !== "object" || Array.isArray(second.components)
      || !Object.keys(first.components).length
      || Object.entries(first.components).some(([name, major]) => typeof major !== "string"
        || !/^\d+$/.test(major) || second.components[name] !== major)
      || before.enabledFeatureDomains.some((domain: string) => !after.enabledFeatureDomains.includes(domain)))
      fail("mcp-server", "Managed MCP baseline and latest generation are incompatible.");
  }
  read(join(root, "server.py"));
  read(join(root, "requirements.txt"));
  if (usesPrivateRoot && (!privateRoot || !sameLegacyPrivateRoot(knowledgeRoot, privateRoot)))
    fail("mcp-server", "The private legacy root changed during MCP archive inspection.");
}

export interface LegacyRootInertInventory {
  schema: "pkm.legacy-root-inert-inventory/v1";
  paths: string[];
  chatroomArchives?: Array<{
    roomId: string;
    sourceFingerprint: string;
    files: Array<{ path: string; sha256: string; size: number; mode: number; dev: number; ino: number; mtimeMs: number }>;
  }>;
}

function validateCompletedRollbackArchive(root: string, name: string, maximumBytes: number): void {
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const prefix = hash(root).slice(0, 40);
  const match = new RegExp(`^${prefix}\\.([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\.postcommit$`).exec(name);
  if (!match) fail(name, "Rollback archive identity is invalid.");
  const directory = join(root, name), directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0
    || process.getuid === undefined || directoryStat.uid !== process.getuid())
    fail(name, "Rollback archive directory is unsafe.");
  const names = [".pkm-next-workspace", ".pkm-next-root-adoption.json", ".pkm-next-root-adoption.commit.json",
    "core.sqlite", "writer-fenced.json"];
  const allowed = [".gitignore", "complete.json", "manifest.json", ...names].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(allowed))
    fail(name, "Rollback archive is incomplete or contains unknown files.");
  const read = (file: string, maximum: number): Buffer => {
    const full = join(directory, file), before = lstatSync(full);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum
      || (before.mode & 0o7002) !== 0 || process.getuid === undefined || before.uid !== process.getuid())
      fail(name, "Rollback archive contains an unsafe file.");
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        fail(name, "Rollback archive changed while opening.");
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(full);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs)
        fail(name, "Rollback archive changed while being checked.");
      return bytes;
    } finally { closeSync(fd); }
  };
  let manifest: Record<string, any>, completion: Record<string, any>;
  try {
    manifest = JSON.parse(read("manifest.json", 16_777_216).toString("utf8"));
    completion = JSON.parse(read("complete.json", 4096).toString("utf8"));
  } catch { return fail(name, "Rollback archive metadata is invalid."); }
  if (read(".gitignore", 16).toString("utf8") !== "*\n"
    || Object.keys(manifest).sort().join("\0") !== "baselineSha256\0files\0journalSha256\0manifestSha256\0root\0schema\0workspaceId"
    || Object.keys(completion).sort().join("\0") !== "manifestSha256\0schema"
    || manifest.schema !== "pkm.legacy-root-postcommit-rollback/v1" || manifest.root !== root
    || manifest.workspaceId !== match[1] || !sha256.test(manifest.journalSha256)
    || !sha256.test(manifest.baselineSha256) || !sha256.test(manifest.manifestSha256)
    || !Array.isArray(manifest.files) || manifest.files.length !== names.length
    || completion.schema !== "pkm.legacy-root-postcommit-rollback-complete/v1"
    || completion.manifestSha256 !== manifest.manifestSha256)
    fail(name, "Rollback archive identity or completion receipt is invalid.");
  const body = { schema: manifest.schema, root: manifest.root, workspaceId: manifest.workspaceId,
    journalSha256: manifest.journalSha256, baselineSha256: manifest.baselineSha256, files: manifest.files };
  if (hash(JSON.stringify(body)) !== manifest.manifestSha256
    || JSON.stringify(manifest.files.map((file: { name?: unknown }) => file.name).sort()) !== JSON.stringify([...names].sort()))
    fail(name, "Rollback archive manifest does not match its files.");
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.name !== "string" || !names.includes(file.name) || !sha256.test(file.sha256)
      || Object.keys(file).sort().join("\0") !== "device\0inode\0mode\0name\0sha256\0size"
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximumBytes
      || !Number.isInteger(file.mode) || !/^\d+$/.test(file.device) || !/^\d+$/.test(file.inode))
      fail(name, "Rollback archive file record is invalid.");
    total += file.size;
    if (total > maximumBytes) fail(name, "Rollback archive exceeds the bounded byte limit.");
    const full = join(directory, file.name), before = lstatSync(full, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.dev.toString() !== file.device || before.ino.toString() !== file.inode
      || Number(before.mode & 0o777n) !== file.mode || before.size !== BigInt(file.size)
      || process.getuid === undefined || before.uid !== BigInt(process.getuid()) || (before.mode & 0o7002n) !== 0n)
      fail(name, "Rollback archive file identity is invalid.");
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }), digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        fail(name, "Rollback archive file changed while opening.");
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        digest.update(buffer.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true }), current = lstatSync(full, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs
        || digest.digest("hex") !== file.sha256)
        fail(name, "Rollback archive file changed or does not match its manifest.");
    } finally { closeSync(fd); }
  }
  try {
    const journal = JSON.parse(read(".pkm-next-root-adoption.json", 16_777_216).toString("utf8"));
    const rootStat = lstatSync(root, { bigint: true });
    if (journal.schema !== "pkm.legacy-root-adoption-journal/v1" || journal.sourceRoot !== root
      || journal.workspaceId !== manifest.workspaceId || journal.journalSha256 !== manifest.journalSha256
      || journal.rootIdentity?.device !== rootStat.dev.toString() || journal.rootIdentity?.inode !== rootStat.ino.toString())
      fail(name, "Rollback archive journal does not match the current Root identity.");
  } catch { return fail(name, "Rollback archive journal is invalid or mismatched."); }
  const directoryAfter = lstatSync(directory);
  if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
    || directoryAfter.dev !== directoryStat.dev || directoryAfter.ino !== directoryStat.ino
    || directoryAfter.uid !== directoryStat.uid || directoryAfter.mode !== directoryStat.mode
    || directoryAfter.mtimeMs !== directoryStat.mtimeMs || directoryAfter.ctimeMs !== directoryStat.ctimeMs)
    fail(name, "Rollback archive directory changed during inspection.");
}

export function inspectLegacyRootInertInventory(
  root: string, limits: { maxEntries?: number; maxDepth?: number; maxTotalBytes?: number; nativeUserGit?: boolean } = {},
): LegacyRootInertInventory {
  if (resolve(root) !== root || realpathSync(root) !== root)
    fail(".", "Legacy root must be canonical and contain no symlink aliases.");
  const maxEntries = limits.maxEntries ?? 20_000, maxDepth = limits.maxDepth ?? 32;
  const maxTotalBytes = limits.maxTotalBytes ?? 536_870_912;
  const paths: string[] = [], portableNames = new Map<string, string>();
  let chatroomArchives: LegacyRootInertInventory["chatroomArchives"];
  let totalBytes = 0;
  const add = (path: string) => {
    if (!path || path.split("/").some(part => !part || part === "." || part === ".."
      || Buffer.byteLength(part) > 255 || /[\u0000-\u001f\u007f:\\]/.test(part))
      || Buffer.byteLength(path) > 2048) fail(path, "Legacy inert metadata path is not portable.");
    const key = path.normalize("NFC").toLowerCase();
    const previous = portableNames.get(key);
    if (previous !== undefined && previous !== path) fail(path, `Legacy inert metadata collides with ${previous}.`);
    portableNames.set(key, path);
    paths.push(path);
    if (paths.length > maxEntries) fail(path, "Legacy inert metadata exceeds the bounded entry limit.");
  };
  const visit = (directory: string, prefix: string, depth: number, managedMcp = false) => {
    if (depth > maxDepth) fail(prefix, "Legacy inert metadata exceeds the bounded directory depth.");
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7000) !== 0)
      fail(prefix, "Legacy inert metadata directories must be real and have no special permission bits.");
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = `${prefix}/${name}`, full = join(directory, name);
      add(path);
      const stat = lstatSync(full);
      const managedCode = managedMcp && stat.isFile()
        && (/\.(?:js|py|template)$/i.test(name) || name === "package-lock.json");
      if (!managedCode && /(?:^|[._-])(?:lock|lck|intent)(?:[._-]|$)|\.(?:tmp|partial)$/i.test(name))
        fail(path, "Legacy metadata lock, intent or temporary entries require their original recovery procedure.");
      if (stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0) fail(path, "Links and special-permission metadata cannot be adopted.");
      if (stat.isDirectory()) visit(full, path, depth + 1, managedMcp);
      else if (stat.isFile() && stat.nlink === 1) {
        totalBytes += stat.size;
        if (totalBytes > maxTotalBytes) fail(path, "Legacy inert metadata exceeds the bounded byte limit.");
      } else fail(path, "Legacy inert metadata must contain only unlinked regular files and real directories.");
    }
    const after = lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      fail(prefix, "Legacy inert metadata directory changed during inventory.");
  };
  const entries = [...surfaces].filter(([name]) => name !== ".git" || !limits.nativeUserGit);
  const archivePrefix = createHash("sha256").update(root).digest("hex").slice(0, 40) + ".";
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith(archivePrefix) || !name.endsWith(".postcommit")) continue;
    validateCompletedRollbackArchive(root, name, maxTotalBytes);
    entries.push([name, "directory"]);
  }
  for (const [name, expected] of entries) {
    const path = join(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (expected === "directory" ? !stat.isDirectory() : !stat.isFile())
      || (expected === "file" && stat.nlink !== 1) || (stat.mode & 0o7000) !== 0) {
      fail(name, `Legacy inert root surface must remain a regular ${expected} without links or special permissions.`);
    }
    add(name);
    if (expected === "directory") {
      const managedMcp = name === "mcp-server" && readdirSync(path).length > 0;
      if (name === "servers" && readdirSync(path).length) {
        if (!lstatSync(coreDatabasePath(root), { throwIfNoEntry: false }))
          fail(name, "Non-empty legacy Servers require genuine completed native Sync byte custody.");
        verifyNativeSyncRootContent(root, "servers");
      }
      if (managedMcp) validateManagedMcp(path, maxTotalBytes, maxEntries);
      visit(path, name, 1, managedMcp);
      if (name === "chatrooms" && readdirSync(path).length) {
        try {
          chatroomArchives = inspectLegacyChatroomTree(root).map(archive => ({
            roomId: archive.roomId,
            sourceFingerprint: archive.sourceFingerprint,
            files: archive.files,
          }));
          if (JSON.stringify(readdirSync(path).sort())
            !== JSON.stringify(chatroomArchives.map(archive => archive.roomId).sort()))
            fail(name, "Legacy Chatroom rooms changed during archive qualification.");
        } catch {
          fail(name, "A non-empty Chatroom tree must match the exact closed, bounded legacy SQLite archive schema.");
        }
      }
      if (name === ".git") validateGit(path);
    }
    else {
      if (name === "fixture-sentinel.txt" && stat.size > 65_536) fail(name, "Synthetic activation metadata exceeds its 64 KiB limit.");
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) fail(name, "Legacy inert metadata exceeds the bounded byte limit.");
    }
  }
  return {
    schema: "pkm.legacy-root-inert-inventory/v1",
    paths: paths.sort(),
    ...(chatroomArchives === undefined ? {} : { chatroomArchives }),
  };
}

function validateGit(root: string): void {
  const names = readdirSync(root).sort();
  if (JSON.stringify(names) !== JSON.stringify([...gitRootEntries].sort()))
    fail(".git", "Only the bounded local Git layout without worktrees, remotes, packed refs, or extra metadata is supported.");
  if (lstatSync(join(root, "config")).size > 65_536 || lstatSync(join(root, "HEAD")).size > 1024)
    fail(".git", "Git config and HEAD exceed their bounded metadata sizes.");
  let config: string;
  try { config = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(root, "config"))); }
  catch { fail(".git/config", "Git config must be valid UTF-8."); }
  const values = new Map<string, string>();
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([a-z]+)\]$/i.exec(line);
    if (sectionMatch) { section = sectionMatch[1]!.toLowerCase(); continue; }
    const pair = /^([a-z][a-z0-9-]*)\s*=\s*(.*?)$/i.exec(line);
    if (section !== "core" || !pair) fail(".git/config", "Only plain local [core] Git configuration without external or executable extensions is supported.");
    const key = pair[1]!.toLowerCase();
    if (values.has(key)) fail(".git/config", "Duplicate local Git configuration keys are not supported.");
    values.set(key, pair[2]!.toLowerCase());
  }
  const expectedConfig = new Map([
    ["repositoryformatversion", "0"], ["filemode", "true"], ["bare", "false"], ["logallrefupdates", "true"],
  ]);
  if (JSON.stringify([...values].sort()) !== JSON.stringify([...expectedConfig].sort()))
    fail(".git/config", "Git configuration must match the inert local-init schema and contain no remote, hook path, filter or fsmonitor configuration.");
  const head = readFileSync(join(root, "HEAD"), "utf8");
  if (!/^ref: refs\/heads\/[A-Za-z0-9._/-]+\n$/.test(head)
    || head.includes("..") || head.includes("//")) fail(".git/HEAD", "Only a local branch symbolic HEAD is supported.");
  const hooks = readdirSync(join(root, "hooks"));
  if (hooks.some(name => !name.endsWith(".sample"))) fail(".git/hooks", "Only inactive `*.sample` hooks are supported.");
  const info = readdirSync(join(root, "info"));
  if (JSON.stringify(info) !== JSON.stringify(["exclude"])) fail(".git/info", "Only the ordinary local exclude file is supported.");
  const refs = readdirSync(join(root, "refs")).sort();
  if (JSON.stringify(refs) !== JSON.stringify(["heads", "tags"])
    || readdirSync(join(root, "refs", "heads")).length || readdirSync(join(root, "refs", "tags")).length)
    fail(".git/refs", "Legacy Git references must remain the exact empty heads/tags directories.");
  const objects = readdirSync(join(root, "objects")).sort();
  if (!objects.includes("info") || !objects.includes("pack")
    || objects.some(name => name !== "info" && name !== "pack" && !/^[a-f0-9]{2}$/.test(name))
    || readdirSync(join(root, "objects", "info")).length || readdirSync(join(root, "objects", "pack")).length) {
    fail(".git/objects", "Only original loose Git objects and an empty objects/info directory are supported.");
  }
  for (const fanout of objects.filter(name => name !== "info")) {
    const files = readdirSync(join(root, "objects", fanout));
    if (files.some(name => !/^[a-f0-9]{38}$/.test(name)))
      fail(`.git/objects/${fanout}`, "Loose Git object names must be content-addressed SHA-1 filenames.");
  }
}

function fail(path: string, message: string): never {
  throw Object.assign(new Error(message), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED", path });
}
