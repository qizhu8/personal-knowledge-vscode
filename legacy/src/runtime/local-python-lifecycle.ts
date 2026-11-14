import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { LocalEnvironmentCatalog, type LocalEnvironment } from "./local-environment-catalog";
import { inspectPythonFolder, runOfflinePythonProcess } from "./local-python-management";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const bashQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
function directory(root: string, privateDirectory = false): string {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root
    || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & (privateDirectory ? 0o022 : 0o002)) !== 0
    || root === "/" || root === process.env.HOME)
    throw new Error(`Choose a canonical owned environment folder, not a root, home, symlink or world-writable directory: ${root}`);
  return `${stat.dev}:${stat.ino}`;
}
function read(file: string): Buffer {
  if (fs.realpathSync(file) !== file) throw new Error("Environment input must not be a symlink.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o002 || stat.size > 65_536)
      throw new Error("Environment input must be bounded, owned and not world-writable.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== stat.size) throw new Error("Environment input changed during review.");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
export type PythonLifecyclePlan = Readonly<{
  environmentId: string; root: string; identity: string; configSha256: string;
  activation: string; activationSha256: string; deletionScript: string;
}>;
export function planPythonLifecycle(entry: LocalEnvironment): PythonLifecyclePlan {
  if (process.platform !== "linux" || entry.language !== "python" || entry.kind !== "environment"
    || !["venv", "uv"].includes(entry.manager) || !entry.root)
    throw new Error("This Linux lifecycle supports Python venv/uv folders only. Conda base/cloning and C# executor sets are not venv operations.");
  const root = entry.root, identity = directory(root);
  const inspected = inspectPythonFolder(root, entry.name, entry.id);
  if (inspected.manager !== entry.manager || entry.executors.length !== 1 || entry.executors[0].id !== "python"
    || entry.executors[0].executable !== path.join(root, "bin", "python"))
    throw new Error("Environment mapping changed; explicitly repair it before lifecycle actions.");
  const configSha256 = digest(read(path.join(root, "pyvenv.cfg")));
  const activationBytes = read(path.join(root, "bin", "activate")), activation = activationBytes.toString("utf8");
  if (!Buffer.from(activation).equals(activationBytes) || activation.includes("\0"))
    throw new Error("Reviewable UTF-8 activation source is required.");
  const q = bashQuote(root);
  const deletionScript = `#!/bin/bash\nset -eu\n# MANUAL ONLY: permanent filesystem deletion; catalog and legacy registry remain unchanged.\n# Metadata restore cannot recover deleted files. Review the target; do not run while it is in use.\n[ ! -L ${q} ] && [ "$(/usr/bin/realpath -- ${q})" = ${q} ]\n[ "$(/usr/bin/stat -c '%d:%i' -- ${q})" = ${bashQuote(identity)} ]\n[ "$(/usr/bin/sha256sum -- ${bashQuote(path.join(root, "pyvenv.cfg"))} | /usr/bin/cut -d ' ' -f 1)" = ${bashQuote(configSha256)} ]\n/bin/rm -rf -- ${q}\n`;
  return Object.freeze({ environmentId: entry.id, root, identity, configSha256, activation,
    activationSha256: digest(activationBytes), deletionScript });
}
export function validatePythonLifecycle(plan: PythonLifecyclePlan, entry: LocalEnvironment): void {
  if (JSON.stringify(planPythonLifecycle(entry)) !== JSON.stringify(plan))
    throw new Error("Environment/activation changed; review it again. No automatic retry.");
}
export function pythonActivationCommand(plan: PythonLifecyclePlan): string {
  const delimiter = `PKM_${plan.activationSha256}`;
  if (plan.activation.split(/\r?\n/).includes(delimiter)) throw new Error("Activation delimiter collision.");
  return `source /dev/stdin <<'${delimiter}'\n${plan.activation}${plan.activation.endsWith("\n") ? "" : "\n"}${delimiter}\n`;
}
export function planPythonMigration(storage: string, entry: LocalEnvironment) {
  directory(storage, true);
  const source = planPythonLifecycle(entry), operationId = randomUUID();
  return Object.freeze({ source, sourceTreeSha256: treeDigest(source.root), operationId,
    target: path.join(storage, "next-synthetic-python", `migrated-${operationId}`) });
}
export function planPythonRemoval(storage: string, entry: LocalEnvironment) {
  directory(storage, true);
  const source = planPythonLifecycle(entry), parent = path.join(storage, "next-synthetic-python");
  if (path.dirname(source.root) !== parent || !/^(local-python|migrated)-[a-f0-9-]{36}$/.test(path.basename(source.root)))
    throw new Error("This removal action is restricted to this profile's synthetic prefixes. External/original prefixes may only be unregistered or manually reviewed; permanent deletion is disabled.");
  directory(parent, true);
  const operationId = randomUUID();
  return Object.freeze({ source, operationId, target: path.join(parent, `.removed-${operationId}`) });
}
function externalDeletionLocation(storage: string, entry: LocalEnvironment): void {
  const root = entry.root;
  const overlaps = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  };
  if (process.platform !== "linux" || entry.language !== "python" || entry.kind !== "environment"
    || !["venv", "uv"].includes(entry.manager) || !root || !path.isAbsolute(root)
    || path.resolve(root) !== root || root === "/" || root === process.env.HOME
    || overlaps(root, storage) || overlaps(storage, root)
    || path.basename(root) === "pkm-mcp" || entry.name === "PKM MCP Runtime" || entry.legacyPython?.name === "PKM MCP Runtime"
    || /Managed runtime for pkm/i.test(`${entry.description ?? ""}\n${entry.legacyPython?.description ?? ""}`))
    throw new Error("External deletion requires a registered Linux venv/uv outside and not containing profile storage. Root/home, MCP runtimes, conda and profile-owned prefixes are refused.");
}
export function planExternalPythonDeletion(storage: string, entry: LocalEnvironment) {
  directory(storage, true);
  externalDeletionLocation(storage, entry);
  rejectPythonDeletionMounts(entry.root!);
  return Object.freeze({ source: planPythonLifecycle(entry), operationId: randomUUID(), deletionEnabled: false as const });
}
export function pythonDeletionMountPoints(root: string, mountinfo: string): string[] {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !mountinfo.trim() || Buffer.byteLength(mountinfo) > 2_000_000)
    throw new Error("A canonical root and bounded Linux mountinfo snapshot are required; deletion refused.");
  return mountinfo.trimEnd().split("\n").flatMap(line => {
    const parts = line.split(" - ");
    const fields = parts[0].split(" ");
    const point = fields[4];
    if (parts.length !== 2 || parts[1].split(" ").length < 3 || fields.length < 6 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])
      || !/^\d+:\d+$/.test(fields[2]) || !point || /\\(?!040|011|012|134)/.test(point))
      throw new Error("Malformed Linux mountinfo snapshot; deletion refused.");
    const decoded = point.replace(/\\(040|011|012|134)/g, (_match, code: string) =>
      String.fromCharCode(parseInt(code, 8)));
    if (!path.isAbsolute(decoded) || path.resolve(decoded) !== decoded)
      throw new Error("Noncanonical Linux mount point; deletion refused.");
    return decoded === root || decoded.startsWith(root === "/" ? "/" : `${root}/`) ? [decoded] : [];
  });
}
export function rejectPythonDeletionMounts(root: string): void {
  if (process.platform !== "linux") throw new Error("Linux mount information is required; deletion refused.");
  const mounts = pythonDeletionMountPoints(root, fs.readFileSync("/proc/self/mountinfo", "utf8"));
  if (mounts.length) throw new Error(`Deletion refused: target or nested mount points (including same-device bind mounts): ${JSON.stringify(mounts)}`);
}
type RemovalReceipt = { schema: "pkm.local-python-removal/v1"; operationId: string; source: string; target: string;
  entry: LocalEnvironment; identity: string; configSha256: string; activationSha256: string; sourceRevision: number };
function removalReceipt(storage: string, operationId: string): RemovalReceipt {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) throw new Error("Select a recorded removal operation.");
  directory(storage, true); directory(path.join(storage, "next-environment-maintenance"), true);
  const value = JSON.parse(read(path.join(storage, "next-environment-maintenance", `${operationId}.json`)).toString("utf8")) as RemovalReceipt;
  const parent = path.join(storage, "next-synthetic-python");
  if (value.schema !== "pkm.local-python-removal/v1" || value.operationId !== operationId
    || value.target !== path.join(parent, `.removed-${operationId}`) || path.dirname(value.source) !== parent
    || !/^(local-python|migrated)-[a-f0-9-]{36}$/.test(path.basename(value.source))
    || value.entry?.root !== value.source || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 1)
    throw new Error("Invalid removal receipt; repair explicitly, no automatic replay.");
  return value;
}
export function listPythonRemovals(storage: string): string[] {
  const ledger = path.join(storage, "next-environment-maintenance");
  if (!fs.existsSync(ledger)) return [];
  directory(ledger, true);
  return fs.readdirSync(ledger).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const value = JSON.parse(read(path.join(ledger, name)).toString("utf8"));
    return value.schema === "pkm.local-python-removal/v1" ? [name.slice(0, -5)] : [];
  });
}
function recordRemovalRequest(storage: string, operationId: string, receipt: unknown): void {
  const ledger = path.join(storage, "next-environment-maintenance");
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 }); directory(ledger, true);
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > 65_536) throw new Error("Removal receipt exceeds the bounded recovery record size; no files removed.");
  const fd = fs.openSync(path.join(ledger, `${operationId}.json`), "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(ledger, "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
type PythonDeletionReceipt = {
  schema: "pkm.local-python-deletion/v1" | "pkm.local-python-external-deletion/v1"; operationId: string; entry: LocalEnvironment;
  sourceRevision: number; identity: string; state: "requested"; automaticReplay: false;
};
export function listPythonDeletions(storage: string): string[] {
  const ledger = path.join(storage, "next-environment-maintenance");
  if (!fs.existsSync(ledger)) return [];
  directory(storage, true); directory(ledger, true);
  return fs.readdirSync(ledger).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const value = JSON.parse(read(path.join(ledger, name)).toString("utf8"));
    return ["pkm.local-python-deletion/v1", "pkm.local-python-external-deletion/v1"].includes(value.schema) ? [name.slice(0, -5)] : [];
  });
}
export function inspectPythonDeletion(storage: string, operationId: string, store: LocalEnvironmentCatalog) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) throw new Error("Select a recorded deletion operation.");
  directory(storage, true); directory(path.join(storage, "next-environment-maintenance"), true);
  const receipt = JSON.parse(read(path.join(storage, "next-environment-maintenance", `${operationId}.json`))
    .toString("utf8")) as PythonDeletionReceipt;
  const root = receipt.entry?.root, parent = path.join(storage, "next-synthetic-python");
  if (!["pkm.local-python-deletion/v1", "pkm.local-python-external-deletion/v1"].includes(receipt.schema)
    || receipt.operationId !== operationId || receipt.state !== "requested" || receipt.automaticReplay !== false || !root
    || !Number.isSafeInteger(receipt.sourceRevision) || receipt.sourceRevision < 1
    || JSON.stringify(store.read(receipt.sourceRevision).catalog.entries.find(e => e.id === receipt.entry.id))
      !== JSON.stringify(receipt.entry)) throw new Error("Deletion receipt/history mismatch; no automatic recovery.");
  if (receipt.schema === "pkm.local-python-external-deletion/v1") externalDeletionLocation(storage, receipt.entry);
  else {
    if (path.dirname(root) !== parent || !/^(local-python|migrated)-[a-f0-9-]{36}$/.test(path.basename(root)))
      throw new Error("Invalid synthetic deletion receipt; no automatic recovery.");
    directory(parent, true);
  }
  const current = store.read().catalog.entries.find(e => e.id === receipt.entry.id);
  let sourcePresent = true;
  try { fs.lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sourcePresent = false;
  }
  return { receipt, sourcePresent, registrationPresent: !!current,
    registrationMatches: !!current && JSON.stringify(current) === JSON.stringify(receipt.entry),
    warning: "Observed state only, not a completion receipt. A present folder may be partial or replaced. Deleted files cannot be restored by metadata/quarantine recovery. Inspect any stale registration and explicitly unregister or restore files from your own backup; never automatically replay deletion." };
}
export function deleteSyntheticPythonFiles(options: {
  storage: string; entry: LocalEnvironment; plan: ReturnType<typeof planPythonRemoval>;
  store: LocalEnvironmentCatalog; expected: string; check(): void;
}): void {
  options.check();
  throw new Error("Synthetic permanent deletion is disabled: path-based recursive removal cannot atomically exclude mount changes or directory redirection. No files, registration or deletion receipt were changed. Quarantine remains a separate non-erasing operation.");
}
export function deleteExternalPythonFiles(options: {
  storage: string; entry: LocalEnvironment; plan: ReturnType<typeof planExternalPythonDeletion>;
  store: LocalEnvironmentCatalog; expected: string; check(): void;
}): void {
  options.check();
  throw new Error("External permanent deletion is disabled: recursive path-based removal can cross nested mounts, including same-device bind mounts, or follow a concurrently redirected directory. Mount-table preflight cannot make fs.rmSync atomic. No files, registration or deletion receipt were changed.");
}
export function removePythonToQuarantine(options: {
  storage: string; entry: LocalEnvironment; plan: ReturnType<typeof planPythonRemoval>;
  store: LocalEnvironmentCatalog; expected: string; check(): void;
}): void {
  const { storage, entry, plan, store, expected, check } = options;
  check();
  const fresh = planPythonRemoval(storage, entry);
  if (JSON.stringify(fresh.source) !== JSON.stringify(plan.source)
    || plan.target !== path.join(storage, "next-synthetic-python", `.removed-${plan.operationId}`)
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.operationId))
    throw new Error("Removal source/destination changed; review it again.");
  const view = store.read();
  if (view.digest !== expected || JSON.stringify(view.catalog.entries.find(item => item.id === entry.id)) !== JSON.stringify(entry))
    throw new Error("Catalog changed; no filesystem removal started.");
  const ledger = path.join(storage, "next-environment-maintenance");
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 }); directory(ledger, true);
  if (fs.existsSync(plan.target)) throw new Error("Quarantine target exists; inspect it, do not overwrite.");
  const receipt = { schema: "pkm.local-python-removal/v1", operationId: plan.operationId,
    source: plan.source.root, target: plan.target, entry, identity: plan.source.identity,
    configSha256: plan.source.configSha256, activationSha256: plan.source.activationSha256,
    sourceRevision: view.catalog.revision, state: "requested", completionSource: "catalog", automaticReplay: false };
  recordRemovalRequest(storage, plan.operationId, receipt);
  check(); validatePythonLifecycle(plan.source, entry);
  if (store.read().digest !== expected) throw new Error("Catalog changed before rename; source kept, requested receipt retained.");
  try {
    fs.renameSync(plan.source.root, plan.target);
    const parentFd = fs.openSync(path.dirname(plan.target), "r");
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    check(); store.unregister(entry.id, expected);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Removal outcome unknown."} Inspect ${plan.target} and removal ${plan.operationId}. No automatic retry or rollback; explicitly restore quarantine before restoring metadata.`);
  }
}
export function restorePythonQuarantine(storage: string, operationId: string, store: LocalEnvironmentCatalog,
  expected: string, check: () => void): void {
  check();
  const receipt = removalReceipt(storage, operationId), current = store.read();
  if (current.digest !== expected) throw new Error("Catalog changed; review restoration again.");
  const historical = store.read(receipt.sourceRevision).catalog.entries.find(entry => entry.id === receipt.entry.id);
  if (JSON.stringify(historical) !== JSON.stringify(receipt.entry)) throw new Error("Removal receipt/history mismatch.");
  const existing = current.catalog.entries.find(entry => entry.id === receipt.entry.id);
  if (existing && (existing.root !== receipt.source || existing.language !== "python" || existing.kind !== "environment"))
    throw new Error("Environment ID was rebound elsewhere; restore refused.");
  if (fs.existsSync(receipt.source)) throw new Error("Original path exists; inspect it, never overwrite on restore.");
  const moved = planPythonLifecycle({ ...receipt.entry, root: receipt.target,
    executors: [{ id: "python", executable: path.join(receipt.target, "bin", "python") }] });
  if (moved.identity !== receipt.identity || moved.configSha256 !== receipt.configSha256
    || moved.activationSha256 !== receipt.activationSha256) throw new Error("Quarantined prefix changed; repair explicitly.");
  check();
  if (store.read().digest !== expected) throw new Error("Catalog changed; no restore started.");
  try {
    fs.renameSync(receipt.target, receipt.source);
    const parentFd = fs.openSync(path.dirname(receipt.source), "r");
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    check();
    if (!existing) store.register(receipt.entry, expected);
    else if (store.read().digest !== expected) throw new Error("Catalog changed during restore.");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Restoration unknown."} Files may already be restored; inspect catalog and prefix. No automatic replay or execution grant.`);
  }
}
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  let files = 0, total = 0;
  const walk = (folder: string) => {
    directory(folder);
    for (const name of fs.readdirSync(folder).sort()) {
      if (++files > 10_000) throw new Error("Migration is limited to 10,000 entries; use an external backup tool for larger environments.");
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      hash.update(JSON.stringify([path.relative(root, file), stat.mode, stat.size]));
      if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); continue; }
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o002 || stat.size > 67_108_864
        || (total += stat.size) > 268_435_456) throw new Error("Migration requires owned regular bounded inputs (64 MiB/file, 256 MiB/tree).");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(32_768);
        let length = 0, count: number;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          length += count;
          if (length > stat.size) throw new Error("Migration source grew; review it again.");
          hash.update(buffer.subarray(0, count));
        }
        if (length !== stat.size) throw new Error("Migration source changed; review it again.");
      } finally { fs.closeSync(fd); }
    }
  };
  walk(root); return hash.digest("hex");
}
function relocatePythonShebang(text: string, source: string, target: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0 || !text.startsWith(`#!${source}/bin/`)) return text;
  const interpreter = text.slice(2, newline).replace(/\r$/, "");
  const match = /^(python(?:\d+(?:\.\d+)*)?)(?:[ \t]+(.+))?$/.exec(interpreter.slice(`${source}/bin/`.length));
  if (!match) return text;
  const relocated = path.join(target, "bin", match[1]), argument = match[2]?.trim();
  if (!/\s/.test(relocated) && Buffer.byteLength(`#!${relocated}${argument ? ` ${argument}` : ""}\n`) <= 127) return text;
  // A kernel shebang cannot quote spaces or an overlong interpreter path.
  // The shell/Python polyglot keeps argv literal and supports direct Python use.
  const body = text.slice(newline + 1);
  const cookie = body.split("\n", 1)[0];
  const encoding = /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/.test(cookie) ? `${cookie}\n` : "";
  const quote = (value: string) => `'${value.replace(/['\\]/g, char => char === "'" ? "'\\''" : "'\\\\'")}'`;
  return `#!/bin/sh\n${encoding}'''exec' ${quote(relocated)}${argument ? ` ${quote(argument)}` : ""} "$0" "$@"\n' '''\n${body}`;
}
export async function migratePythonCopy(options: {
  storage: string; entry: LocalEnvironment; plan: ReturnType<typeof planPythonMigration>;
  store: LocalEnvironmentCatalog; expected: string; check(): void; signal?: AbortSignal;
}): Promise<void> {
  const { storage, entry, plan, store, expected, check } = options;
  const parent = path.join(storage, "next-synthetic-python"), ledger = path.join(storage, "next-environment-maintenance");
  if (!/^[a-f0-9-]{36}$/.test(plan.operationId) || plan.target !== path.join(parent, `migrated-${plan.operationId}`))
    throw new Error("Migration destination must be a new synthetic prefix in this profile.");
  const fresh = () => {
    check(); directory(storage, true);
    if (options.signal?.aborted) throw new Error("Migration cancelled.");
    if (store.read().digest !== expected) throw new Error("Catalog changed; inspect retained copies, do not retry automatically.");
    validatePythonLifecycle(plan.source, entry);
    if (treeDigest(plan.source.root) !== plan.sourceTreeSha256) throw new Error("Migration source tree changed; review it again.");
  };
  fresh();
  for (const folder of [parent, ledger]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); directory(folder, true);
  }
  if (fs.existsSync(plan.target)) throw new Error("Migration target already exists; inspect it, no automatic overwrite.");
  const receipt = path.join(ledger, `${plan.operationId}.json`), fd = fs.openSync(receipt, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ schema: "pkm.local-python-migration/v1", environmentId: entry.id,
      source: plan.source.root, target: plan.target, state: "requested", completionSource: "catalog",
      sourcePreserved: true, automaticReplay: false, expectedCatalogDigest: expected }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const ledgerFd = fs.openSync(ledger, "r");
  try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }
  try {
    // Unlike the old rename/remove migration, copying never invalidates an in-use or external source.
    fs.mkdirSync(plan.target, { mode: 0o700 });
    fs.cpSync(plan.source.root, plan.target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    directory(plan.target);
    directory(path.join(plan.target, "bin"));
    for (const file of [...fs.readdirSync(path.join(plan.target, "bin")).map(name => path.join(plan.target, "bin", name)),
      path.join(plan.target, "pyvenv.cfg")]) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      if (fs.realpathSync(file) !== file) throw new Error("Copied script escaped the synthetic prefix.");
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      if (Buffer.from(text).equals(bytes) && text.includes(plan.source.root))
        fs.writeFileSync(file, relocatePythonShebang(text, plan.source.root, plan.target)
          .split(plan.source.root).join(plan.target));
    }
    fresh();
    inspectPythonFolder(plan.target, entry.name, entry.id);
    const prefix = await runOfflinePythonProcess(path.join(plan.target, "bin", "python"),
      ["-I", "-B", "-c", "import sys; print(sys.prefix)"], parent, {}, options.signal);
    fresh();
    if (prefix.trim() !== plan.target) throw new Error("Copied interpreter reports the wrong prefix.");
    store.rebindPython(entry.id, plan.target, expected);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Migration outcome unknown."} Source is untouched; copy/receipt retained at ${plan.target} / ${receipt}. Inspect catalog completion before manual repair or retry. No automatic removal, replay or download.`);
  }
}
