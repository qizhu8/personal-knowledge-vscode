import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertLinuxLegacyWritersQuiescent } from "../dist/linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";
import { renameNoReplace } from "../dist/rename-no-replace.js";

const exec = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME;
const schema = "pkm.cold-state-recovery/v1";
const suffixes = ["", "-wal", "-shm", "-journal"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) + "\n";
const fdPath = handle => `/proc/${process.pid}/fd/${handle.fd}`;
const within = (parent, child) => child === parent || child.startsWith(parent + sep);
const pinKeys = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
const pin = stat => Object.fromEntries(pinKeys.map(key => [key, String(stat[key])]));
const equal = (left, right) => canonical(left) === canonical(right);
const uid = () => BigInt(process.getuid());
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const fail = (code, condition = code) => { throw new ColdStateRecoveryError(code, condition); };

export class ColdStateRecoveryError extends Error {
  constructor(code, condition) {
    super(condition);
    this.code = code;
    this.condition = condition;
  }
}

function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) fail("UNKNOWN_SHAPE");
}

function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || path.includes("\0")) fail("UNSAFE_PATH");
  return path;
}

function owned(stat) {
  if (stat.uid !== uid()) fail("UNOWNED_SOURCE");
  if (stat.isFile() && stat.nlink !== 1n) fail("HARDLINK_UNSUPPORTED");
}

async function exists(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

// Ancestors remain open until the native ACL/group check finishes. Subsequent
// traversal uses descriptor paths, not a second resolution through those parents.
async function directory(path, { create = false, privateDirectory = false } = {}) {
  absolute(path);
  const handles = [await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const current = handles.at(-1), child = join(fdPath(current), part);
      if (create && !await exists(child)) {
        const { mkdir } = await import("node:fs/promises");
        try { await mkdir(child, { mode: 0o700 }); await current.sync(); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const handle = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      if (stat.mode & 0o002n || stat.uid !== uid() && stat.mode & 0o020n) fail("UNSAFE_PARENT");
    }
    const program = [
      "import os,sys,json,grp,pwd",
      "uid=os.getuid()",
      "for path in json.loads(sys.argv[1]):",
      " s=os.stat(path)",
      " if any(x in ('system.posix_acl_access','system.posix_acl_default') for x in os.listxattr(path)): sys.exit(12)",
      " if s.st_mode & 0o020:",
      "  members=set(grp.getgrgid(s.st_gid).gr_mem)",
      "  members.update(p.pw_name for p in pwd.getpwall() if p.pw_gid==s.st_gid)",
      "  if members-{pwd.getpwuid(uid).pw_name,'root'}: sys.exit(13)",
    ].join("\n");
    try {
      await exec("python3", ["-I", "-B", "-c", program, JSON.stringify(handles.map(fdPath))],
        { timeout: 10000, maxBuffer: 1024 });
    } catch { fail("UNSAFE_PARENT", "parent-acl-or-group-ownership-unproven"); }
    if (await realpath(path) !== path) fail("UNSAFE_PATH");
    const last = handles.at(-1), stat = await last.stat({ bigint: true });
    if (privateDirectory && (stat.uid !== uid() || stat.mode & 0o077n)) fail("NONPRIVATE_DESTINATION");
    for (const handle of handles.slice(0, -1)) await handle.close();
    return last;
  } catch (error) {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    throw error;
  }
}

async function parentFor(path) {
  let parent = dirname(path);
  while (!await exists(parent)) {
    if (parent === dirname(parent)) fail("UNSAFE_PATH");
    parent = dirname(parent);
  }
  const handle = await directory(parent);
  return { handle, relative: relative(parent, path), parent };
}

async function relativeParent(root, path, create = false) {
  const parts = path === "." ? [] : path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\0") || part.includes("\\")))
    fail("UNSAFE_RELATIVE_PATH");
  let handle = await open(fdPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      const path = join(fdPath(handle), part);
      if (create && !await exists(path)) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path, { mode: 0o700 });
        await handle.sync();
      }
      const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = child;
    }
    return { handle, name: parts.at(-1) ?? "." };
  } catch (error) { await handle.close(); throw error; }
}

async function durable(parent, name, value) {
  const file = await open(join(fdPath(parent), name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const bytes = typeof value === "string" ? value : canonical(value);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await parent.sync();
  return sha(bytes);
}

async function hashFile(path) {
  const file = await open(path, readFlags);
  try {
    const before = await file.stat({ bigint: true });
    owned(before);
    if (!before.isFile()) fail("UNKNOWN_SOURCE_SHAPE");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let first = true, sqlite = false, bytes = 0n;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (first) sqlite = buffer.subarray(0, Math.min(16, bytesRead)).equals(Buffer.from("SQLite format 3\0"));
      first = false;
      bytes += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (bytes !== before.size || !equal(pin(before), pin(await file.stat({ bigint: true })))
      || !equal(pin(before), pin(await lstat(path, { bigint: true })))) fail("SOURCE_CHANGED");
    return { sha256: hash.digest("hex"), sqlite };
  } finally { await file.close(); }
}

async function namesOf(parent) {
  const { opendir } = await import("node:fs/promises");
  const directory = await opendir(fdPath(parent));
  const names = [];
  for await (const entry of directory) {
    names.push(entry.name);
    if (names.length > 200000) fail("DIRECTORY_ENTRY_LIMIT");
  }
  return names.sort();
}

async function* lines(path) {
  const file = await open(path, readFlags);
  try {
    let pending = "";
    for await (const chunk of file.createReadStream({ encoding: "utf8", autoClose: false, highWaterMark: 32768 })) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        if (end > 65536) fail("INVENTORY_INVALID");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        yield JSON.parse(line);
      }
      if (pending.length > 65536) fail("INVENTORY_INVALID");
    }
    if (pending) fail("INVENTORY_TRUNCATED");
  } finally { await file.close(); }
}

async function privateBase(request) {
  const base = join(absolute(homedir()), ".local/state/pkm-v5-recovery");
  if (within(repository, base) || base.split(sep).includes("session-state")
    || [request.originalRoot, ...request.externalDirectories.map(entry => entry.path)]
      .some(path => within(path, base) || within(base, path))) fail("SOURCE_DESTINATION_OVERLAP");
  return base;
}

const nativeRuntimeDirectories = [".pkm-next-todo", ".pkm-next-memory", ".pkm-next-retrieval-models"];

function requestShape(request) {
  keys(request, ["schema", "originalRoot", "externalDirectories", "configurationFiles", "opaqueLinks", "fileLinks", "includeNativeRuntimeDirectories"]);
  if (request.schema !== "pkm.cold-state-request/v1" || !Array.isArray(request.externalDirectories)
    || !request.externalDirectories.length || request.externalDirectories.length > 32
    || !Array.isArray(request.configurationFiles) || request.configurationFiles.length > 32
    || !["refuse", "metadata-only"].includes(request.opaqueLinks)) fail("UNKNOWN_SHAPE");
  absolute(request.originalRoot);
  if (request.includeNativeRuntimeDirectories !== undefined && request.includeNativeRuntimeDirectories !== true)
    fail("UNKNOWN_SHAPE");
  for (const entry of [...request.externalDirectories, ...request.configurationFiles]) {
    keys(entry, ["id", "path"]);
    if (!identifier(entry.id)) fail("UNKNOWN_SHAPE");
    absolute(entry.path);
  }
  if (request.fileLinks !== undefined && (!Array.isArray(request.fileLinks) || request.fileLinks.length > 32))
    fail("UNKNOWN_SHAPE");
  for (const binding of request.fileLinks ?? []) {
    keys(binding, ["path", "target"]);
    absolute(binding.path);
    absolute(binding.target);
    if (binding.path === binding.target) fail("LINK_BINDING_AMBIGUOUS");
  }
  const bindings = request.fileLinks ?? [];
  if (new Set(bindings.map(binding => binding.path)).size !== bindings.length
    || new Set(bindings.map(binding => binding.target)).size !== bindings.length
    || bindings.some(binding => bindings.some(other => binding.target === other.path)))
    fail("LINK_BINDING_AMBIGUOUS");
  if (request.externalDirectories.some(entry => within(request.originalRoot, entry.path))) fail("SOURCE_OVERLAP");
}

function checkFence(root, options) {
  keys(options, ["writerFence"]);
  if (options.writerFence !== undefined) {
    if (!isTrustedLinuxRootWriterFence(options.writerFence, root)) fail("WRITER_FENCE_INVALID");
    options.writerFence.assertHeld();
  }
}

async function fileLink(binding, hashes = false) {
  const parent = await directory(dirname(binding.path));
  let targetParent;
  try {
    const path = join(fdPath(parent), basename(binding.path)), before = await exists(path);
    if (!before?.isSymbolicLink()) fail("LINK_BINDING_MISMATCH");
    owned(before);
    if (before.nlink !== 1n) fail("HARDLINK_UNSUPPORTED");
    if (binding.linkIdentity && !equal(binding.linkIdentity, pin(before))) fail("SOURCE_CHANGED");
    const { readlink } = await import("node:fs/promises");
    const linkText = await readlink(path);
    if (linkText !== binding.target) fail("LINK_BINDING_MISMATCH");
    targetParent = await directory(dirname(binding.target));
    const targetPath = join(fdPath(targetParent), basename(binding.target)), target = await exists(targetPath);
    if (!target?.isFile()) fail("LINK_TARGET_UNSUPPORTED");
    owned(target);
    if (binding.targetIdentity && !equal(binding.targetIdentity, pin(target))) fail("SOURCE_CHANGED");
    const content = hashes ? await hashFile(targetPath) : {};
    if (!equal(pin(before), pin(await lstat(path, { bigint: true })))
      || linkText !== await readlink(path)
      || !equal(pin(target), pin(await lstat(targetPath, { bigint: true })))) fail("SOURCE_CHANGED");
    return { linkText, linkIdentity: pin(before), targetIdentity: pin(target),
      ...(hashes ? { targetSha256: content.sha256 } : {}) };
  } finally { await targetParent?.close(); await parent.close(); }
}

export async function planColdStateRecovery(request, options = {}) {
  if (process.platform !== "linux") fail("LINUX_REQUIRED");
  requestShape(request);
  checkFence(request.originalRoot, options);
  if (request.includeNativeRuntimeDirectories && !options.writerFence) fail("WRITER_FENCE_INVALID");
  const root = await directory(request.originalRoot);
  const originalRootIdentity = pin(await root.stat({ bigint: true }));
  await root.close();
  const scopes = [
    { id: "legacy-pkm", path: join(request.originalRoot, ".pkm"), kind: "tree" },
    { id: "legacy-chatrooms", path: join(request.originalRoot, "chatrooms"), kind: "tree" },
    { id: "legacy-mcp", path: join(request.originalRoot, "mcp-server"), kind: "tree" },
    ...(request.includeNativeRuntimeDirectories ? nativeRuntimeDirectories.map(name => ({
      id: name.slice(1), path: join(request.originalRoot, name), kind: "tree",
    })) : []),
    ...suffixes.map((suffix, index) => ({ id: `knowledge-${index}`, path: join(request.originalRoot, "knowledge.db" + suffix), kind: "file" })),
    ...request.externalDirectories.map(entry => ({ ...entry, kind: "tree" })),
    ...request.configurationFiles.flatMap(entry => suffixes.map((suffix, index) =>
      ({ id: `${entry.id}-${index}`, path: entry.path + suffix, kind: "file" }))),
  ];
  const fileLinks = [];
  for (const [index, binding] of (request.fileLinks ?? []).entries()) {
    if (!logicalPayload({ scopes }, binding.path)) fail("LINK_OUTSIDE_SCOPE");
    const observed = await fileLink(binding);
    if (!logicalPayload({ scopes }, binding.target))
      scopes.push({ id: `link-target-${index}`, path: binding.target, kind: "file" });
    fileLinks.push({ ...binding, ...observed, targetPayload: logicalPayload({ scopes }, binding.target) });
  }
  scopes.sort((a, b) => a.id < b.id ? -1 : 1);
  if (new Set(scopes.map(scope => scope.id)).size !== scopes.length) fail("DUPLICATE_SCOPE");
  for (const [index, scope] of scopes.entries())
    for (const other of scopes.slice(index + 1))
      if (within(scope.path, other.path) || within(other.path, scope.path)) fail("SOURCE_OVERLAP");
  const base = await privateBase(request);
  for (const scope of scopes) {
    if (within(base, scope.path) || within(scope.path, base)) fail("SOURCE_DESTINATION_OVERLAP");
    const parent = await parentFor(scope.path);
    await parent.handle.close();
  }
  checkFence(request.originalRoot, options);
  return { schema: "pkm.cold-state-plan/v1", request: JSON.parse(canonical(request)), scopes, fileLinks,
    originalRootIdentity, privateBase: base, attempts: 1,
    readiness: "not-ready", missingConditions: ["global-shutdown-not-proven"],
    credentialRecovery: "opaque-file-bytes-only; local-profile-and-keyring-coverage-not-proven" };
}

async function quiescent(plan, options) {
  checkFence(plan.request.originalRoot, options);
  const original = await directory(plan.request.originalRoot);
  try {
    const current = pin(await original.stat({ bigint: true }));
    if (["dev", "ino", "mode", "uid", "gid"].some(key => current[key] !== plan.originalRootIdentity[key]))
      fail("SOURCE_CHANGED", "original-root-identity-changed");
  } finally { await original.close(); }
  const boundaries = [{ id: "original-root", path: plan.request.originalRoot },
    ...plan.request.externalDirectories, ...plan.request.configurationFiles.map(entry => ({ id: entry.id, path: dirname(entry.path) })),
    ...(plan.fileLinks ?? []).map((binding, index) => ({ id: `link-target-${index}`, path: dirname(binding.target) }))];
  for (const boundary of boundaries) {
    let path = boundary.path;
    while (!await exists(path)) path = dirname(path);
    const handle = await directory(path);
    try {
      await assertLinuxLegacyWritersQuiescent(path);
    } catch (error) {
      const denied = new ColdStateRecoveryError("NOT_QUIESCENT", `linux-writer-quiescence:${boundary.id}`);
      denied.gateCode = error.code ?? "INVENTORY_UNAVAILABLE";
      throw denied;
    } finally { await handle.close(); }
  }
  for (const binding of plan.fileLinks ?? []) await fileLink(binding);
  checkFence(plan.request.originalRoot, options);
}

async function* inventory(plan, hashes) {
  for (const scope of plan.scopes) {
    const parent = await parentFor(scope.path);
    try {
      if (!await exists(scope.path)) {
        yield { scope: scope.id, path: ".", kind: "absent", parentIdentity: pin(await parent.handle.stat({ bigint: true })) };
        continue;
      }
      async function* visit(base, name, path, depth) {
        if (depth > 128) fail("SOURCE_DEPTH_LIMIT");
        const full = join(fdPath(base), name), before = await exists(full);
        if (!before) {
          yield { scope: scope.id, path, kind: "absent", parentIdentity: pin(await base.stat({ bigint: true })) };
          return;
        }
        owned(before);
        const row = { scope: scope.id, path, kind: "", sourceIdentity: pin(before) };
        if (before.isSymbolicLink()) {
          const logicalPath = path === "." ? scope.path : join(scope.path, path);
          const binding = plan.fileLinks?.find(binding => binding.path === logicalPath);
          if (binding) {
            const observed = await fileLink(binding, true);
            if (!equal(pin(before), observed.linkIdentity)) fail("SOURCE_CHANGED");
            row.kind = "file-link";
            row.linkText = observed.linkText;
            row.targetIdentity = observed.targetIdentity;
            row.targetSha256 = observed.targetSha256;
            row.targetPayload = binding.targetPayload;
          } else {
            if (plan.request.opaqueLinks !== "metadata-only") fail("SYMLINK_UNSUPPORTED");
            const { readlink } = await import("node:fs/promises");
            row.kind = "opaque-link";
            row.linkText = await readlink(full);
          }
          yield row;
        } else if (before.isDirectory()) {
          if (path === "." && scope.kind !== "tree") fail("UNKNOWN_SOURCE_SHAPE");
          row.kind = "directory";
          const child = await open(full, readFlags | constants.O_DIRECTORY);
          try {
            if (!equal(pin(before), pin(await child.stat({ bigint: true })))) fail("SOURCE_CHANGED");
            yield row;
            for (const name of await namesOf(child))
              yield* visit(child, name, path === "." ? name : `${path}/${name}`, depth + 1);
            if (!equal(pin(before), pin(await child.stat({ bigint: true })))) fail("SOURCE_CHANGED");
          } finally { await child.close(); }
        } else if (before.isFile()) {
          if (path === "." && scope.kind !== "file") fail("UNKNOWN_SOURCE_SHAPE");
          row.kind = "file";
          if (hashes) Object.assign(row, await hashFile(full));
          yield row;
        } else fail("UNKNOWN_SOURCE_SHAPE");
        if (!equal(pin(before), pin(await lstat(full, { bigint: true })))) fail("SOURCE_CHANGED");
      }
      const location = await relativeParent(parent.handle, parent.relative);
      try { yield* visit(location.handle, location.name, ".", 0); }
      finally { await location.handle.close(); }
    } finally { await parent.handle.close(); }
  }
}

async function writeInventory(parent, name, iterator) {
  const file = await open(join(fdPath(parent), name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let count = 0;
  try {
    for await (const row of iterator) {
      const bytes = canonical(row);
      await file.writeFile(bytes);
      hash.update(bytes);
      count++;
    }
    await file.sync();
    await parent.sync();
    return { sha256: hash.digest("hex"), entries: count };
  } finally { await file.close(); }
}

async function mkdir(parent, name) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(fdPath(parent), name), { mode: 0o700 });
  await parent.sync();
  return open(join(fdPath(parent), name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function copyFile(source, target, expected) {
  const input = await open(source, readFlags);
  let output;
  try {
    const before = await input.stat({ bigint: true });
    owned(before);
    if (!before.isFile() || expected?.sourceIdentity && !equal(pin(before), expected.sourceIdentity)) fail("SOURCE_CHANGED");
    output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024), hash = createHash("sha256");
    let first = true, sqlite = false, bytes = 0n;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (first) sqlite = buffer.subarray(0, Math.min(bytesRead, 16)).equals(Buffer.from("SQLite format 3\0"));
      first = false;
      bytes += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
      await output.writeFile(buffer.subarray(0, bytesRead));
    }
    if (bytes !== before.size || !equal(pin(before), pin(await input.stat({ bigint: true })))
      || !equal(pin(before), pin(await lstat(source, { bigint: true })))) fail("SOURCE_CHANGED");
    const result = { sha256: hash.digest("hex"), sqlite };
    if (expected?.sha256 && result.sha256 !== expected.sha256) fail("CORRUPT_BYTES");
    await output.sync();
    return result;
  } finally { await output?.close(); await input.close(); }
}

function materialized(row) { return row.path === "." ? row.scope : `${row.scope}/${row.path}`; }

async function* copyRows(plan, from, payload, inventoryPath) {
  let sourceScope, sourceRoot, sourceRelative;
  try {
    for await (const row of lines(inventoryPath)) {
      if (["absent", "opaque-link", "file-link"].includes(row.kind)) { yield row; continue; }
      const target = await relativeParent(payload, materialized(row), true);
      try {
        if (row.kind === "directory") {
          const child = await mkdir(target.handle, target.name);
          await child.close();
        } else {
          if (!from && sourceScope !== row.scope) {
            await sourceRoot?.close();
            sourceRoot = undefined;
            const scope = plan.scopes.find(scope => scope.id === row.scope);
            if (scope.kind === "tree") {
              sourceRoot = await directory(scope.path);
              sourceRelative = undefined;
            } else {
              const parent = await parentFor(scope.path);
              sourceRoot = parent.handle;
              sourceRelative = parent.relative;
            }
            sourceScope = row.scope;
          }
          const location = await relativeParent(from ?? sourceRoot,
            from ? materialized(row) : sourceRelative ?? row.path);
          try {
            Object.assign(row, await copyFile(join(fdPath(location.handle), location.name),
              join(fdPath(target.handle), target.name), from ? { sha256: row.sha256 } : row));
          } finally { await location.handle.close(); }
        }
        await target.handle.sync();
        yield row;
      } finally { await target.handle.close(); }
    }
  } finally { await sourceRoot?.close(); }
}

async function payloadCheck(payload, manifest, inventoryPath) {
  let expectedCount = 0, last = "", opaque = 0, approved = 0, files = 0, absent = 0, bytes = 0n;
  const requestedLinks = manifest.plan.request.fileLinks ?? [], bindings = manifest.plan.fileLinks ?? [];
  if (requestedLinks.length !== bindings.length || requestedLinks.some((entry, index) =>
    entry.path !== bindings[index].path || entry.target !== bindings[index].target))
    fail("LINK_BINDING_MISMATCH");
  for await (const row of lines(inventoryPath)) {
    const scope = manifest.plan.scopes.find(scope => scope.id === row.scope);
    if (!scope || typeof row.path !== "string"
      || !["file", "directory", "absent", "opaque-link", "file-link"].includes(row.kind)) fail("INVENTORY_INVALID");
    const path = materialized(row), location = await relativeParent(payload, path);
    const key = row.scope + "\0" + (row.path === "." ? "" : row.path.split("/").join("\0"));
    if (key <= last) { await location.handle.close(); fail("INVENTORY_INVALID"); }
    last = key;
    try {
      const full = join(fdPath(location.handle), location.name), stat = await exists(full);
      if (["absent", "opaque-link", "file-link"].includes(row.kind)) {
        if (stat) fail("UNEXPECTED_PAYLOAD");
        if (row.kind === "file-link") {
          const sourcePath = row.path === "." ? scope.path : join(scope.path, row.path);
          const binding = manifest.plan.fileLinks?.find(binding => binding.path === sourcePath);
          if (!binding || row.linkText !== binding.target || row.targetPayload !== binding.targetPayload
            || binding.targetPayload !== logicalPayload(manifest.plan, binding.target)
            || !equal(row.sourceIdentity, binding.linkIdentity) || !equal(row.targetIdentity, binding.targetIdentity)
            || !/^[a-f0-9]{64}$/.test(row.targetSha256)) fail("LINK_BINDING_MISMATCH");
          const target = await relativeParent(payload, row.targetPayload);
          try {
            const full = join(fdPath(target.handle), target.name), targetStat = await lstat(full, { bigint: true });
            if (!targetStat.isFile() || (await hashFile(full)).sha256 !== row.targetSha256) fail("CORRUPT_BYTES");
          } finally { await target.handle.close(); }
          approved++;
        } else if (row.kind === "absent") absent++; else opaque++;
        continue;
      }
      if (!stat || stat.isSymbolicLink() || stat.uid !== uid()
        || (stat.mode & 0o777n) !== (row.kind === "directory" ? 0o700n : 0o600n)
        || (row.kind === "directory" ? !stat.isDirectory() : !stat.isFile())) fail("PAYLOAD_INVALID");
      if (row.kind === "file") {
        if (!/^[a-f0-9]{64}$/.test(row.sha256) || (await hashFile(full)).sha256 !== row.sha256) fail("CORRUPT_BYTES");
        bytes += stat.size;
        files++;
      }
      expectedCount++;
    } finally { await location.handle.close(); }
  }
  async function count(parent) {
    let result = 0;
    for (const name of await namesOf(parent)) {
      const stat = await lstat(join(fdPath(parent), name), { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("PAYLOAD_INVALID");
      result++;
      if (stat.isDirectory()) {
        const child = await open(join(fdPath(parent), name), readFlags | constants.O_DIRECTORY);
        try { result += await count(child); } finally { await child.close(); }
      }
    }
    await parent.sync();
    return result;
  }
  if (await count(payload) !== expectedCount) fail("UNEXPECTED_PAYLOAD");
  if (approved !== (manifest.plan.fileLinks?.length ?? 0)) fail("LINK_BINDING_MISMATCH");
  return { files, bytes: String(bytes), absent, opaqueLinks: opaque,
    ...(approved ? { approvedFileLinks: approved } : {}), targetClosureComplete: opaque === 0 };
}

async function destination(plan, path) {
  absolute(path);
  if (dirname(path) !== plan.privateBase || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(basename(path)))
    fail("DESTINATION_POLICY", "destination-must-be-a-new-direct-child-of-private-recovery-root");
  const parent = await directory(plan.privateBase, { create: true, privateDirectory: true });
  if (await exists(join(fdPath(parent), basename(path)))) {
    await parent.close();
    fail("DESTINATION_EXISTS");
  }
  return parent;
}

async function readJson(path, maximum = 4 * 1024 * 1024) {
  const file = await open(path, readFlags);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== uid() || stat.mode & 0o077n || stat.size > BigInt(maximum))
      fail("MANIFEST_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function verifyOpened(pack, manifestSha256) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) fail("PIN_REQUIRED");
  if (basename(await realpath(fdPath(pack))).startsWith(".")) fail("INCOMPLETE_CAPTURE");
  const complete = await readJson(join(fdPath(pack), "capture.complete.json")).catch(() => fail("INCOMPLETE_CAPTURE"));
  const manifestPath = join(fdPath(pack), "manifest.json");
  if ((await hashFile(manifestPath)).sha256 !== manifestSha256 || complete.manifestSha256 !== manifestSha256)
    fail("WRONG_PIN");
  const manifest = await readJson(manifestPath);
  if (manifest.schema !== schema || complete.schema !== schema || manifest.readiness !== "not-ready"
    || !Array.isArray(manifest.plan?.scopes)) fail("MANIFEST_INVALID");
  requestShape(manifest.plan.request);
  const replanned = await privateBase(manifest.plan.request);
  if (replanned !== manifest.plan.privateBase) fail("MANIFEST_INVALID");
  const inventoryPath = join(fdPath(pack), "inventory.jsonl");
  if ((await hashFile(inventoryPath)).sha256 !== manifest.inventorySha256
    || complete.inventorySha256 !== manifest.inventorySha256) fail("CORRUPT_INVENTORY");
  const payload = await open(join(fdPath(pack), "payload"), readFlags | constants.O_DIRECTORY);
  try {
    const summary = await payloadCheck(payload, manifest, inventoryPath);
    if (!equal(summary, manifest.summary)) fail("MANIFEST_INVALID");
    return { manifest, summary };
  } finally { await payload.close(); }
}

export async function captureColdStateRecovery(request, path, options = {}) {
  const plan = await planColdStateRecovery(request, options);
  await quiescent(plan, options);
  const parent = await destination(plan, path), stageName = `.${basename(path)}.partial-${randomUUID()}`;
  let stage;
  try {
    stage = await mkdir(parent, stageName);
    await durable(stage, "capture-started.json", { schema, plan });
    const before = await writeInventory(stage, "inventory.before.jsonl", inventory(plan, false));
    await durable(stage, "inventory.before.complete.json", before);
    await quiescent(plan, options);
    const payload = await mkdir(stage, "payload");
    let captured;
    try {
      captured = await writeInventory(stage, "inventory.jsonl",
        copyRows(plan, undefined, payload, join(fdPath(stage), "inventory.before.jsonl")));
      const expected = lines(join(fdPath(stage), "inventory.jsonl"))[Symbol.asyncIterator]();
      try {
        for await (const current of inventory(plan, true)) {
          const next = await expected.next();
          if (next.done || !equal(current, next.value)) fail("SOURCE_CHANGED");
        }
        if (!(await expected.next()).done) fail("SOURCE_CHANGED");
      } finally { await expected.return?.(); }
      await quiescent(plan, options);
      const manifest = { schema, plan, inventorySha256: captured.sha256,
        capturedAt: new Date().toISOString(), readiness: "not-ready",
        missingConditions: ["global-shutdown-not-proven"], sourceAttempts: 1,
        inodePreservation: false };
      manifest.summary = await payloadCheck(payload, manifest, join(fdPath(stage), "inventory.jsonl"));
      if (!manifest.summary.targetClosureComplete) manifest.missingConditions.push("opaque-link-target-closure-incomplete");
      manifest.sqlite = await validateSqlite(stage, payload, manifest, join(fdPath(stage), "inventory.jsonl"));
      const manifestSha256 = await durable(stage, "manifest.json", manifest);
      await quiescent(plan, options);
      await durable(stage, "capture.complete.json", { schema, manifestSha256,
        inventorySha256: captured.sha256, readiness: "not-ready" });
      await renameNoReplace(join(fdPath(parent), stageName), join(fdPath(parent), basename(path)));
      await parent.sync();
      return { schema, path, manifestSha256, readiness: "not-ready", missingConditions: manifest.missingConditions,
        summary: manifest.summary, sqlite: manifest.sqlite };
    } finally { await payload.close(); }
  } catch (error) {
    if (stage) {
      error.retainedStage = join(plan.privateBase, stageName);
      await durable(stage, "failure.json", { code: error.code ?? "IO_ERROR",
        condition: error.condition ?? "operation-failed", stageIsNotAReadyColdBaseline: true }).catch(() => {});
    }
    throw error;
  } finally { await stage?.close(); await parent.close(); }
}

export async function verifyColdStateRecovery(path, manifestSha256) {
  const pack = await directory(absolute(path), { privateDirectory: true });
  try {
    const { manifest, summary } = await verifyOpened(pack, manifestSha256);
    return { schema, valid: true, manifestSha256, readiness: manifest.readiness,
      missingConditions: manifest.missingConditions, summary };
  } finally { await pack.close(); }
}

function logicalPayload(plan, path) {
  const scope = plan.scopes.find(scope => scope.path === path || scope.kind === "tree" && within(scope.path, path));
  return scope ? scope.path === path ? scope.id : `${scope.id}/${relative(scope.path, path)}` : undefined;
}

async function validateSqlite(stage, payload, manifest, inventoryPath) {
  const validation = await mkdir(stage, "sqlite-validation");
  let databases = 0;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    for await (const row of lines(inventoryPath)) {
      if (row.kind !== "file" || !row.sqlite) continue;
      if (!manifest.summary.targetClosureComplete) fail("SQLITE_SIDECAR_SCOPE_UNPROVEN", "opaque-target-closure-prevents-sqlite-qualification");
      const scope = manifest.plan.scopes.find(scope => scope.id === row.scope);
      const sourcePath = row.path === "." ? scope.path : join(scope.path, row.path);
      const target = await mkdir(validation, `db-${++databases}`);
      try {
        for (const suffix of suffixes) {
          const path = logicalPayload(manifest.plan, sourcePath + suffix);
          if (!path) fail("SQLITE_SIDECAR_SCOPE_UNPROVEN");
          const source = await relativeParent(payload, path);
          try {
            const sourceFile = join(fdPath(source.handle), source.name);
            if (await exists(sourceFile)) await copyFile(sourceFile, join(fdPath(target), "database.sqlite" + suffix));
          } finally { await source.handle.close(); }
        }
        await target.sync();
        const db = new DatabaseSync(join(fdPath(target), "database.sqlite"));
        try {
          db.exec("PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;");
          const check = db.prepare("PRAGMA integrity_check").all();
          if (check.length !== 1 || Object.values(check[0])[0] !== "ok") fail("SQLITE_INTEGRITY_FAILED");
        } finally { db.close(); }
        for (const name of await namesOf(target)) {
          const path = join(fdPath(target), name), stat = await lstat(path, { bigint: true });
          if (!suffixes.some(suffix => name === "database.sqlite" + suffix)
            || !stat.isFile() || stat.nlink !== 1n || stat.uid !== uid() || stat.mode & 0o077n)
            fail("SQLITE_VALIDATION_SHAPE_UNSUPPORTED");
          const file = await open(path, readFlags);
          try { await file.sync(); } finally { await file.close(); }
        }
        await target.sync();
      } finally { await target.close(); }
    }
    return { databases, integrityChecksPassed: databases, validationCopiesOnly: true };
  } finally { await validation.close(); }
}

export async function restoreColdStateRecovery(path, manifestSha256, restorePath) {
  const pack = await directory(absolute(path), { privateDirectory: true });
  let parent, stage;
  let stageName;
  try {
    const { manifest } = await verifyOpened(pack, manifestSha256);
    if (within(path, restorePath) || within(restorePath, path)) fail("SOURCE_DESTINATION_OVERLAP");
    parent = await destination(manifest.plan, restorePath);
    stageName = `.${basename(restorePath)}.partial-${randomUUID()}`;
    stage = await mkdir(parent, stageName);
    await durable(stage, "restore-started.json", { schema, manifestSha256, readiness: "not-ready" });
    const payload = await mkdir(stage, "payload");
    const source = await open(join(fdPath(pack), "payload"), readFlags | constants.O_DIRECTORY);
    try {
      const restored = await writeInventory(stage, "inventory.jsonl",
        copyRows(manifest.plan, source, payload, join(fdPath(pack), "inventory.jsonl")));
      if (restored.sha256 !== manifest.inventorySha256) fail("RESTORE_CLOSURE_MISMATCH");
      const summary = await payloadCheck(payload, manifest, join(fdPath(stage), "inventory.jsonl"));
      if (!equal(summary, manifest.summary)) fail("RESTORE_CLOSURE_MISMATCH");
      const sqlite = await validateSqlite(stage, payload, manifest, join(fdPath(stage), "inventory.jsonl"));
      await verifyOpened(pack, manifestSha256);
      await durable(stage, "manifest.json", manifest);
      await durable(stage, "restore.complete.json", { schema, manifestSha256, sqlite,
        readiness: "not-ready", inodePreservation: false, originalPathsOverwritten: false });
      await renameNoReplace(join(fdPath(parent), stageName), join(fdPath(parent), basename(restorePath)));
      await parent.sync();
      return { schema, path: restorePath, manifestSha256, readiness: "not-ready",
        summary, sqlite, originalPathsOverwritten: false, inodePreservation: false };
    } finally { await payload.close(); await source.close(); }
  } catch (error) {
    if (stage) {
      error.retainedStage = join(dirname(restorePath), stageName);
      await durable(stage, "failure.json", { code: error.code ?? "IO_ERROR", readiness: "not-ready" }).catch(() => {});
    }
    throw error;
  } finally { await stage?.close(); await parent?.close(); await pack.close(); }
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan" && args.length === 1) {
    const plan = await planColdStateRecovery(await readJson(absolute(args[0])));
    return { schema: plan.schema, scopes: plan.scopes.map(scope => ({ id: scope.id, kind: scope.kind })),
      planSha256: sha(canonical(plan)), readiness: plan.readiness, missingConditions: plan.missingConditions };
  }
  if (command === "capture" && args.length === 2)
    return captureColdStateRecovery(await readJson(absolute(args[0])), absolute(args[1]));
  if (command === "verify" && args.length === 2) return verifyColdStateRecovery(absolute(args[0]), args[1]);
  if (command === "restore" && args.length === 3) return restoreColdStateRecovery(absolute(args[0]), args[1], absolute(args[2]));
  fail("USAGE", "plan REQUEST | capture REQUEST NEW_PACK | verify PACK SHA256 | restore PACK SHA256 NEW_PRIVATE_DESTINATION");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().then(result => {
    console.log(JSON.stringify(result));
    if (result.readiness === "not-ready" && ["plan", "capture", "restore"].includes(process.argv[2])) process.exitCode = 2;
  }).catch(error => {
    console.error(JSON.stringify({ code: error.code ?? "IO_ERROR", condition: error.condition ?? "operation-failed",
      ...(error.gateCode ? { gateCode: error.gateCode } : {}),
      ...(error.retainedStage ? { retainedStage: error.retainedStage } : {}) }));
    process.exitCode = 1;
  });
}
