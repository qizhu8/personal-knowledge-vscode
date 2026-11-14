import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";

const ack = "--acknowledge-quiescent-disposable-copy";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
const within = (parent, candidate) => {
  const path = relative(parent, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function realDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Paths must be absolute and canonical.");
  let current = sep;
  for (const component of path.slice(1).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory paths cannot contain symlinks.");
  }
  if (await realpath(path) !== path) throw new Error("Directory path is not canonical.");
  return path;
}

async function inventory(root) {
  await realDirectory(root);
  const rootStat = await lstat(root, { bigint: true });
  const entries = [];
  let total = 0;
  async function walk(dir, prefix, depth) {
    if (depth > 64) throw new Error("Inventory depth limit exceeded.");
    for (const name of (await readdir(dir)).sort(compare)) {
      if (entries.length >= 20000) throw new Error("Inventory entry limit exceeded.");
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      const before = await lstat(full, { bigint: true });
      if (before.isSymbolicLink()) throw new Error(`Unsupported symlink: ${path}`);
      const mode = Number(before.mode & 0o777n);
      if (before.isDirectory()) {
        entries.push({ path, kind: "directory", mode });
        await walk(full, path, depth + 1);
        const after = await lstat(full, { bigint: true });
        if (!after.isDirectory() || after.ino !== before.ino || after.dev !== before.dev
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error(`Directory changed: ${path}`);
      } else if (before.isFile()) {
        if (before.size > 268435456n || total + Number(before.size) > 1073741824) throw new Error(`Inventory byte limit exceeded: ${path}`);
        const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat({ bigint: true });
          if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`File changed: ${path}`);
          const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
          let size = 0;
          for (;;) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > Number(before.size)) throw new Error(`File changed: ${path}`);
            digest.update(buffer.subarray(0, bytesRead));
          }
          const after = await file.stat({ bigint: true }), pathAfter = await lstat(full, { bigint: true });
          if (BigInt(size) !== before.size || after.ino !== before.ino || after.dev !== before.dev
            || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
            || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || !pathAfter.isFile())
            throw new Error(`File changed: ${path}`);
          total += size;
          entries.push({ path, kind: "file", mode, size, sha256: digest.digest("hex"), mtimeNs: before.mtimeNs.toString() });
        } finally { await file.close(); }
      } else throw new Error(`Unsupported special file: ${path}`);
    }
  }
  await walk(root, "", 0);
  const after = await lstat(root, { bigint: true });
  if (after.dev !== rootStat.dev || after.ino !== rootStat.ino || after.mtimeNs !== rootStat.mtimeNs
    || after.ctimeNs !== rootStat.ctimeNs) throw new Error("Inventory root changed.");
  return { schema: "pkm.disposable-inventory/v1", root, device: String(rootStat.dev), inode: String(rootStat.ino), entries };
}

async function readSnapshot(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Snapshot path must be absolute and canonical.");
  await realDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16777216n) throw new Error("Invalid snapshot file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Snapshot changed.");
    const data = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (BigInt(data.length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) throw new Error("Snapshot changed.");
    const snapshot = JSON.parse(data.toString("utf8"));
    if (snapshot?.schema !== "pkm.disposable-inventory/v1" || typeof snapshot.root !== "string"
      || !isAbsolute(snapshot.root) || resolve(snapshot.root) !== snapshot.root
      || typeof snapshot.device !== "string" || !/^\d+$/.test(snapshot.device)
      || typeof snapshot.inode !== "string" || !/^\d+$/.test(snapshot.inode) || !Array.isArray(snapshot.entries)
      || snapshot.entries.length > 20000) throw new Error("Invalid snapshot.");
    const seen = new Set();
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/")
        || entry.path.split("/").some(part => !part || part === "." || part === "..")
        || seen.has(entry.path) || !["file", "directory"].includes(entry.kind)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 511
        || entry.kind === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0
          || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
          || typeof entry.mtimeNs !== "string" || !/^-?\d+$/.test(entry.mtimeNs)))
        throw new Error("Invalid snapshot entry.");
      seen.add(entry.path);
    }
    return snapshot;
  } finally { await file.close(); }
}

async function reconcile(source, destination) {
  await realDirectory(source);
  await realDirectory(destination);
  const rel = relative(source, destination), reverse = relative(destination, source);
  if (!rel || !reverse || !rel.startsWith(`..${sep}`) && rel !== ".." || !reverse.startsWith(`..${sep}`) && reverse !== "..")
    throw new Error("Source and destination must not overlap.");
  const plan = await planLegacyImport(source);
  const outcome = await recoverLegacyImportOutcome(destination);
  if (!plan.ready || outcome.status !== "published" || outcome.receipt.fingerprint !== plan.fingerprint)
    return { status: "blocked", planReady: plan.ready, blockers: plan.blockers, outcome: outcome.status,
      sourceMatchesReceipt: !!plan.fingerprint && outcome.receipt?.fingerprint === plan.fingerprint };
  const observed = await inventory(destination);
  const files = new Map(observed.entries.map(entry => [entry.path, entry]));
  const rows = plan.entries.map(entry => {
    if (!entry.destination) return { source: entry.source, result: "unverified-transformed" };
    const actual = files.get(entry.destination);
    if (!actual) return { source: entry.source, destination: entry.destination, result: "missing" };
    const matches = entry.kind === "directory" ? actual.kind === "directory"
      : actual.kind === "file" && actual.sha256 === entry.sha256 && actual.size === entry.size
        && (entry.mode === undefined || actual.mode === entry.mode)
        && (entry.mtimeNs === undefined || actual.mtimeNs === entry.mtimeNs);
    return { source: entry.source, destination: entry.destination, result: matches ? "match" : "mismatch" };
  });
  const special = ["statePlan", "trashPlan", "recipeTrashPlan", "projectEnvelopePlan", "memoryPlan", "routerConfigPlan", "retrievalHistoryPlan"]
    .filter(key => plan[key] !== undefined);
  return { status: rows.every(row => row.result === "match") && !special.length ? "matched-scoped" : "blocked",
    fingerprint: plan.fingerprint, rows, unverifiedSpecialPlans: special,
    scope: "Planned paths only; native operations, extra files and unplanned external state are not certified." };
}

function changesBetween(baseline, current) {
  if (baseline.root !== current.root || baseline.device !== current.device || baseline.inode !== current.inode)
    throw new Error("Inventory root identity differs from baseline.");
  const old = new Map(baseline.entries.map(entry => [entry.path, entry])), now = new Map(current.entries.map(entry => [entry.path, entry]));
  return [...new Set([...old.keys(), ...now.keys()])].sort(compare).flatMap(path => {
    const before = old.get(path), after = now.get(path);
    return !before ? [{ path, change: "added" }] : !after ? [{ path, change: "removed" }]
      : JSON.stringify(before) !== JSON.stringify(after) ? [{ path, change: "changed" }] : [];
  });
}

async function copyPinned(root, entry, output) {
  const input = join(root, ...entry.path.split("/"));
  const before = await lstat(input, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(entry.size)
    || before.mtimeNs.toString() !== entry.mtimeNs) throw new Error(`Source changed: ${entry.path}`);
  const source = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await source.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`Source changed: ${entry.path}`);
    const target = await open(output, "wx", 0o600);
    try {
      const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
      let total = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > entry.size) throw new Error(`Source changed: ${entry.path}`);
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const count = (await target.write(buffer, written, bytesRead - written)).bytesWritten;
          if (!count) throw new Error("Delivery write made no progress.");
          written += count;
        }
      }
      const after = await source.stat({ bigint: true }), pathAfter = await lstat(input, { bigint: true });
      if (total !== entry.size || digest.digest("hex") !== entry.sha256 || after.ino !== before.ino || after.dev !== before.dev
        || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || !pathAfter.isFile())
        throw new Error(`Source changed: ${entry.path}`);
      await target.sync();
    } finally { await target.close(); }
  } finally { await source.close(); }
}

async function deliver(root, baselinePath, destination) {
  await realDirectory(root);
  if (!isAbsolute(destination) || resolve(destination) !== destination) throw new Error("Destination must be absolute and canonical.");
  await realDirectory(dirname(destination));
  if (within(root, destination) || within(destination, root) || within(destination, baselinePath) || within(root, baselinePath))
    throw new Error("Destination, baseline and source must not overlap.");
  const baseline = await readSnapshot(baselinePath);
  const current = await inventory(root);
  const changes = changesBetween(baseline, current);
  const sidecars = current.entries.filter(entry => entry.kind === "file" && /(?:-wal|-shm|-journal)$/.test(entry.path));
  await mkdir(destination, { mode: 0o700 });
  const payload = join(destination, "payload");
  await mkdir(payload, { mode: 0o700 });
  for (const entry of current.entries) {
    const output = join(payload, ...entry.path.split("/"));
    if (entry.kind === "directory") await mkdir(output, { mode: 0o700 });
    else await copyPinned(root, entry, output);
  }
  const after = await inventory(root);
  if (JSON.stringify(after) !== JSON.stringify(current)) throw new Error("Source changed during delivery; incomplete artifact retained.");
  const manifest = { schema: "pkm.disposable-migration-delivery/v1", baseline, current, changes,
    sqliteSidecars: sidecars.map(entry => entry.path),
    scope: "Complete inventoried workspace files only; external state, semantic merge and protected deletion authority are not established." };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const file = await open(join(destination, "manifest.json"), "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { destination, manifestSha256: sha256(bytes), changes: changes.length };
}

async function verifyDelivery(destination, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Expected manifest SHA-256 must be lowercase hex.");
  await realDirectory(destination);
  const names = (await readdir(destination)).sort(compare);
  if (JSON.stringify(names) !== JSON.stringify(["manifest.json", "payload"])) throw new Error("Incomplete or unexpected delivery entries.");
  const manifestPath = join(destination, "manifest.json"), stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33554432) throw new Error("Invalid manifest.");
  const file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("Manifest changed.");
    bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("Manifest changed.");
  } finally { await file.close(); }
  if (sha256(bytes) !== expected) throw new Error("Manifest digest mismatch.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema !== "pkm.disposable-migration-delivery/v1" || !Array.isArray(manifest.current?.entries)
    || !Array.isArray(manifest.baseline?.entries) || !Array.isArray(manifest.changes)
    || JSON.stringify(changesBetween(manifest.baseline, manifest.current)) !== JSON.stringify(manifest.changes))
    throw new Error("Invalid delivery manifest.");
  const observed = await inventory(join(destination, "payload"));
  const project = entries => entries.map(entry => entry.kind === "directory" ? { path: entry.path, kind: entry.kind }
    : { path: entry.path, kind: entry.kind, size: entry.size, sha256: entry.sha256 });
  if (JSON.stringify(project(observed.entries)) !== JSON.stringify(project(manifest.current.entries)))
    throw new Error("Delivery payload differs from manifest.");
  return { status: "verified", manifestSha256: expected, changes: manifest.changes.length,
    scope: "Byte integrity only; not authority, lineage, application compatibility or a merge." };
}

async function assertSingleDatabase(root, entries) {
  for (const entry of entries) {
    if (entry.kind !== "file" || ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"].includes(entry.path)) continue;
    if (/(?:\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?|-wal|-shm|-journal)$/i.test(entry.path))
      throw new Error(`Additional database or sidecar requires independent coordination: ${entry.path}`);
    const file = await open(join(root, ...entry.path.split("/")), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== entry.size) throw new Error(`Source changed: ${entry.path}`);
      const header = Buffer.alloc(16);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead === 16 && header.equals(Buffer.from("SQLite format 3\0")))
        throw new Error(`Additional SQLite database requires independent coordination: ${entry.path}`);
    } finally { await file.close(); }
  }
}

async function consistentDelivery(root, baselinePath, destination, python) {
  await realDirectory(root);
  if (!isAbsolute(destination) || resolve(destination) !== destination
    || !isAbsolute(python) || resolve(python) !== python) throw new Error("Destination and Python must be absolute canonical paths.");
  await realDirectory(dirname(destination));
  if (within(root, destination) || within(destination, root) || within(destination, baselinePath) || within(root, baselinePath))
    throw new Error("Destination, baseline and source must not overlap.");
  const baseline = await readSnapshot(baselinePath);
  const before = await inventory(root);
  changesBetween(baseline, before);
  await assertSingleDatabase(root, before.entries);
  await mkdir(destination, { mode: 0o700 });
  const backup = join(destination, "backup");
  const cli = resolve(import.meta.dirname, "../dist/cli.js");
  const { stdout } = await execute(process.execPath, [cli, "backup", "--data", root, "--destination", backup],
    { timeout: 120000, maxBuffer: 1048576, env: { ...process.env, PYTHON: python } });
  const receipt = JSON.parse(stdout).backup;
  if (!receipt || receipt.backupPath !== backup || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256))
    throw new Error("Backup receipt is invalid; incomplete delivery retained.");
  const source = await inventory(root), captured = await inventory(backup);
  await assertSingleDatabase(root, source.entries);
  const changes = changesBetween(baseline, source);
  const stable = entries => entries.filter(item => !["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"].includes(item.path))
    .map(item => item.kind === "directory" ? { path: item.path, kind: item.kind }
      : { path: item.path, kind: item.kind, size: item.size, sha256: item.sha256 });
  if (JSON.stringify(stable(before.entries)) !== JSON.stringify(stable(source.entries)))
    throw new Error("Workspace files changed during backup; incomplete delivery retained.");
  const expectedFiles = stable(source.entries);
  const capturedFiles = stable(captured.entries).filter(item => item.path !== ".pkm-workspace-backup.json");
  if (JSON.stringify(expectedFiles) !== JSON.stringify(capturedFiles))
    throw new Error("Backup omits or changes workspace files; incomplete delivery retained.");
  const nativeManifest = captured.entries.find(item => item.path === ".pkm-workspace-backup.json");
  if (!nativeManifest || nativeManifest.sha256 !== receipt.manifestSha256)
    throw new Error("Backup manifest digest differs from receipt.");
  const manifest = { schema: "pkm.disposable-consistent-delivery/v1", baseline, source, changes,
    backupReceipt: receipt, backupInventory: captured,
    scope: "Host backup with SQLite snapshot and bounded workspace files; external state and authority are not established." };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const file = await open(join(destination, "manifest.json"), "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { destination, manifestSha256: sha256(bytes), backupManifestSha256: receipt.manifestSha256, changes: changes.length };
}

async function verifyConsistentDelivery(destination, expected, python) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !isAbsolute(python) || resolve(python) !== python)
    throw new Error("Provide an exact lowercase manifest SHA-256 and absolute canonical Python executable.");
  await realDirectory(destination);
  if (JSON.stringify((await readdir(destination)).sort(compare)) !== JSON.stringify(["backup", "manifest.json"]))
    throw new Error("Incomplete or unexpected delivery entries.");
  const path = join(destination, "manifest.json"), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33554432) throw new Error("Invalid manifest.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Manifest changed.");
    bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("Manifest changed.");
  } finally { await file.close(); }
  if (sha256(bytes) !== expected) throw new Error("Manifest digest mismatch.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema !== "pkm.disposable-consistent-delivery/v1"
    || JSON.stringify(changesBetween(manifest.baseline, manifest.source)) !== JSON.stringify(manifest.changes))
    throw new Error("Invalid delivery manifest.");
  const backup = join(destination, "backup"), observed = await inventory(backup);
  const project = entries => entries.map(entry => entry.kind === "directory" ? { path: entry.path, kind: entry.kind }
    : { path: entry.path, kind: entry.kind, size: entry.size, sha256: entry.sha256 });
  if (JSON.stringify(project(observed.entries)) !== JSON.stringify(project(manifest.backupInventory.entries)))
    throw new Error("Backup payload differs from delivery manifest.");
  if (observed.entries.find(item => item.path === ".pkm-workspace-backup.json")?.sha256 !== manifest.backupReceipt.manifestSha256)
    throw new Error("Backup manifest digest differs from receipt.");
  const script = "import pathlib,sqlite3,sys; p=pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro&immutable=1'; c=sqlite3.connect(p,uri=True); r=c.execute('pragma integrity_check').fetchall(); c.close(); sys.exit(0 if r == [('ok',)] else 1)";
  await execute(python, ["-c", script, join(backup, "core.sqlite")], { timeout: 30000, maxBuffer: 1048576 });
  const rechecked = await inventory(backup);
  if (JSON.stringify(rechecked) !== JSON.stringify(observed)) throw new Error("Backup changed during verification.");
  return { status: "verified", manifestSha256: expected, changes: manifest.changes.length,
    scope: "Integrity and SQLite integrity_check only; requires trusted host backup, quiescence and independently retained digest." };
}

async function main(args) {
  const command = args.shift(), values = new Map();
  let acknowledged = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === ack) {
      if (acknowledged) throw new Error("Duplicate acknowledgment.");
      acknowledged = true;
    } else {
      const value = args[++i];
      if (!["--source", "--destination", "--root", "--baseline", "--manifest-sha256", "--python"].includes(option) || !value || value.startsWith("--") || values.has(option))
        throw new Error("Invalid or duplicate option.");
      values.set(option, value);
    }
  }
  const allowed = command === "reconcile" ? ["--source", "--destination"]
    : command === "snapshot" ? ["--root"] : command === "diff" ? ["--root", "--baseline"]
    : command === "deliver" ? ["--root", "--baseline", "--destination"]
    : command === "deliver-consistent" ? ["--root", "--baseline", "--destination", "--python"]
    : command === "verify-consistent" ? ["--destination", "--manifest-sha256", "--python"]
    : command === "verify-delivery" ? ["--destination", "--manifest-sha256"] : [];
  if (!acknowledged || !allowed.length || values.size !== allowed.length || allowed.some(option => !values.has(option)))
    throw new Error("Usage: migration-audit.mjs reconcile|snapshot|diff|deliver|verify-delivery|deliver-consistent|verify-consistent; see README for options. Each requires --acknowledge-quiescent-disposable-copy.");
  if (command === "reconcile") {
    const result = await reconcile(values.get("--source"), values.get("--destination"));
    console.log(JSON.stringify(result));
    if (result.status !== "matched-scoped") process.exitCode = 1;
  } else if (command === "snapshot") console.log(JSON.stringify(await inventory(values.get("--root"))));
  else if (command === "deliver") console.log(JSON.stringify(await deliver(values.get("--root"), values.get("--baseline"), values.get("--destination"))));
  else if (command === "verify-delivery") console.log(JSON.stringify(await verifyDelivery(values.get("--destination"), values.get("--manifest-sha256"))));
  else if (command === "deliver-consistent") console.log(JSON.stringify(await consistentDelivery(values.get("--root"), values.get("--baseline"), values.get("--destination"), values.get("--python"))));
  else if (command === "verify-consistent") console.log(JSON.stringify(await verifyConsistentDelivery(values.get("--destination"), values.get("--manifest-sha256"), values.get("--python"))));
  else {
    const baselineRelative = relative(values.get("--root"), values.get("--baseline"));
    if (!baselineRelative || !baselineRelative.startsWith(`..${sep}`) && baselineRelative !== "..")
      throw new Error("Baseline must be outside the inventoried root.");
    const baseline = await readSnapshot(values.get("--baseline"));
    const current = await inventory(values.get("--root"));
    const changes = changesBetween(baseline, current);
    console.log(JSON.stringify({ status: changes.length ? "changed" : "unchanged", changes,
      scope: "Filesystem comparison only; unchanged is not authorization to roll back or evidence of erasure lineage." }));
    if (changes.length) process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
