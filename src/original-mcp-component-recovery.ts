import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  acquireOriginalMcpRootFence, validateOriginalMcpWorkspace,
} from "./original-mcp-root.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { originalMcpLimits, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import { readOriginalMcpDomain, verifyOriginalMcpDomainFiles } from "./original-mcp-domain-state.js";
import { readOriginalMcpTodoGenesisSources, readPendingOriginalMcpTodoGenesis } from "./original-mcp-todo-genesis.js";
import { verifyLegacyRetrievalModels } from "./legacy-retrieval-model.js";

type Limits = OriginalMcpPlan["limits"];
interface Row {
  path: string; directory: boolean; mode: number; size: number; sha256: string | null; identity: string;
}
interface Image {
  path: string; payload: string; sha256: string; rows: readonly Row[];
  entries: number; bytes: number; sqliteChecks: number;
}
export interface OriginalMcpColdComponentFixture {
  readonly kind: "pkm.original-mcp-cold-component-fixture/v1";
  readonly directory: string;
  readonly root: string;
}
interface FixtureState {
  identity: string; limits?: Limits; baseline?: Image; retired: boolean;
}
export interface OriginalMcpComponentRetirementTicket {
  readonly kind: "pkm.original-mcp-component-b1/v1";
  readonly b1Path: string; readonly b1Sha256: string; readonly entries: number; readonly bytes: number;
  readonly sqliteChecks: number; readonly optionalDirectories: readonly string[];
  close(): Promise<void>;
}
export interface OriginalMcpComponentRetirement {
  readonly kind: "pkm.original-mcp-component-retirement/v1";
  readonly root: string; readonly archive: string; readonly receiptPath: string; readonly receiptSha256: string;
  readonly originalPathRetired: true; readonly fullCutoverQualified: false;
}
const fixtures = new WeakMap<object, FixtureState>();
const tickets = new WeakMap<object, {
  fixture: OriginalMcpColdComponentFixture; image: Image; fence: LinuxRootWriterFence; active: boolean;
}>();
const retirements = new WeakMap<object, { fixture: OriginalMcpColdComponentFixture; b1: Image; restored: boolean }>();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => JSON.stringify(value) + "\n";
const pin = (s: Awaited<ReturnType<typeof lstat>>) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
const rootPin = (s: Awaited<ReturnType<typeof lstat>>) => [s.dev, s.ino, s.mode, s.uid, s.gid].join(":");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function inside(root: string, path: string) {
  const member = relative(root, path);
  return member !== "" && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}
async function privateParents(path: string) {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path)
    fail("COMPONENT_PRIVATE_PATH_REQUIRED");
  let directory: string = sep;
  let privateAncestor = false;
  for (const part of path.split(sep).filter(Boolean)) {
    directory = join(directory, part);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o002)
      fail("COMPONENT_PRIVATE_PATH_REQUIRED");
    if (stat.uid === process.getuid!() && (stat.mode & 0o077) === 0) privateAncestor = true;
  }
  const stat = await lstat(path);
  if (!privateAncestor || stat.uid !== process.getuid!() || stat.mode & 0o077 || await realpath(path) !== path)
    fail("COMPONENT_PRIVATE_PATH_REQUIRED");
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durable(path: string, value: unknown) {
  const bytes = encode(value);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
  return hash(bytes);
}
async function fixtureState(fixture: OriginalMcpColdComponentFixture) {
  const state = fixtures.get(fixture);
  if (!state || rootPin(await lstat(fixture.root)) !== state.identity) fail("COMPONENT_FIXTURE_IDENTITY_REQUIRED");
  await privateParents(fixture.directory);
  await privateParents(fixture.root);
  return state;
}
/** Only newly created, disjoint private fixtures can enter this component-only recovery path. */
export async function createOriginalMcpColdComponentFixture(directory: string): Promise<OriginalMcpColdComponentFixture> {
  const base = join(homedir(), ".local", "state", "pkm-v5-recovery");
  if (resolve(directory) !== directory || !inside(base, directory)) fail("COMPONENT_FIXTURE_LOCATION_REQUIRED");
  await privateParents(dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  await privateParents(directory);
  const root = join(directory, "root");
  await mkdir(root, { mode: 0o700 });
  const fixture = Object.freeze({ kind: "pkm.original-mcp-cold-component-fixture/v1" as const, directory, root });
  fixtures.set(fixture, { identity: rootPin(await lstat(root)), retired: false });
  return fixture;
}
export async function assertOriginalMcpColdComponentFixture(fixture: OriginalMcpColdComponentFixture): Promise<void> {
  const state = await fixtureState(fixture);
  if (state.retired) fail("COMPONENT_FIXTURE_RETIRED");
}
async function streamFile(source: string, maximumBytes: number, destination?: string): Promise<string> {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
    || before.mode & 0o7002 || before.size > maximumBytes) fail("COMPONENT_FILE_UNQUALIFIED");
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (pin(before) !== pin(await input.stat())) fail("COMPONENT_SOURCE_CHANGED");
    if (destination) output = await open(destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const sha = createHash("sha256"), buffer = Buffer.allocUnsafe(262144);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) fail("COMPONENT_IMAGE_LIMIT");
      const part = buffer.subarray(0, bytesRead); sha.update(part);
      if (output) {
        let offset = 0;
        while (offset < bytesRead) offset += (await output.write(part, offset, bytesRead - offset)).bytesWritten;
      }
    }
    if (bytes !== before.size || pin(before) !== pin(await input.stat()) || pin(before) !== pin(await lstat(source)))
      fail("COMPONENT_SOURCE_CHANGED");
    await output?.sync();
    return sha.digest("hex");
  } finally { await output?.close(); await input.close(); }
}
async function inventory(root: string, limits: Limits, destination?: string): Promise<Row[]> {
  const rows: Row[] = [];
  let bytes = 0;
  async function visit(directory: string, prefix: string, depth: number) {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid!()
      || before.mode & 0o7002 || depth > limits.maxDepth) fail("COMPONENT_DIRECTORY_UNQUALIFIED");
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, source = join(root, path), stat = await lstat(source);
      if (rows.length >= limits.maxEntries) fail("COMPONENT_IMAGE_LIMIT");
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("COMPONENT_LINK_OR_SPECIAL_FILE");
      const row: Row = { path, directory: stat.isDirectory(), mode: stat.mode & 0o777,
        size: stat.isFile() ? stat.size : 0, sha256: null, identity: pin(stat) };
      rows.push(row);
      if (stat.isDirectory()) {
        if (destination) await mkdir(join(destination, path), { mode: 0o700 });
        await visit(source, path, depth + 1);
        if (destination) await syncDirectory(join(destination, path));
      } else {
        bytes += stat.size;
        if (bytes > limits.maxBytes) fail("COMPONENT_IMAGE_LIMIT");
        row.sha256 = await streamFile(source, limits.maxFileBytes, destination ? join(destination, path) : undefined);
      }
    }
    if (pin(before) !== pin(await lstat(directory))) fail("COMPONENT_SOURCE_CHANGED");
  }
  await visit(root, "", 0);
  return rows;
}
function logical(rows: readonly Row[]) {
  return rows.map(({ identity: _identity, ...row }) => row);
}
async function verifyImage(image: Image, limits: Limits) {
  await privateParents(image.path);
  const manifest = join(image.path, "manifest.json");
  if (await streamFile(manifest, 536870912) !== image.sha256) fail("COMPONENT_IMAGE_PIN_CHANGED");
  const rows = await inventory(image.payload, limits);
  const content = (values: readonly Row[]) => values.map(({ mode: _mode, identity: _identity, ...row }) => row);
  if (encode(content(rows)) !== encode(content(image.rows))) fail("COMPONENT_IMAGE_CHANGED");
}
async function materialize(image: Image, limits: Limits, destination: string) {
  await verifyImage(image, limits);
  await mkdir(destination, { mode: 0o700 });
  for (const row of image.rows) {
    const target = join(destination, row.path);
    if (row.directory) await mkdir(target, { mode: 0o700 });
    else if (await streamFile(join(image.payload, row.path), limits.maxFileBytes, target) !== row.sha256)
      fail("COMPONENT_IMAGE_CHANGED");
  }
  for (const row of [...image.rows].reverse()) {
    await chmod(join(destination, row.path), row.mode);
    if (row.directory) await syncDirectory(join(destination, row.path));
  }
  await syncDirectory(destination);
  if (encode(logical(await inventory(destination, limits))) !== encode(logical(image.rows)))
    fail("COMPONENT_RESTORE_UNQUALIFIED");
}
async function sqliteChecks(root: string, rows: readonly Row[]): Promise<number> {
  const mains: string[] = [];
  for (const row of rows) {
    if (row.directory) continue;
    const file = await open(join(root, row.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const header = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    if (!header.equals(Buffer.from("SQLite format 3\0"))) {
      if (/\.(?:sqlite3?|db3?|vscdb)$/i.test(row.path)) fail("COMPONENT_SQLITE_INVALID");
      continue;
    }
    mains.push(row.path);
  }
  for (const path of mains) {
    const database = new DatabaseSync(join(root, path));
    try {
      const result = database.prepare("PRAGMA integrity_check").all();
      if (result.length !== 1 || Object.values(result[0]!)[0] !== "ok") fail("COMPONENT_SQLITE_INVALID");
    } finally { database.close(); }
  }
  return mains.length;
}
async function captureImage(fixture: OriginalMcpColdComponentFixture, name: string, limits: Limits, fence: LinuxRootWriterFence) {
  const path = join(fixture.directory, name), payload = join(path, "payload");
  await mkdir(path, { mode: 0o700 }); await mkdir(payload, { mode: 0o700 });
  fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(fixture.root);
  const rows = await inventory(fixture.root, limits, payload);
  await syncDirectory(payload);
  const bytes = rows.reduce((sum, row) => sum + row.size, 0);
  const sha256 = await durable(join(path, "manifest.json"), {
    schema: "pkm.original-mcp-component-image/v1", root: fixture.root,
    rootIdentity: (await fixtureState(fixture)).identity, entries: rows.length, bytes, rows,
    scope: "complete-created-fixture-root-no-links", productionQualification: false,
  });
  const image: Image = { path, payload, rows, sha256, entries: rows.length, bytes, sqliteChecks: 0 };
  await materialize(image, limits, join(path, "validation"));
  image.sqliteChecks = await sqliteChecks(join(path, "validation"), rows);
  if (encode(await inventory(fixture.root, limits)) !== encode(rows)) fail("COMPONENT_SOURCE_CHANGED");
  await assertLinuxLegacyWritersQuiescent(fixture.root); fence.assertHeld();
  await durable(join(path, "complete.json"), { sha256, sqliteChecks: image.sqliteChecks });
  return image;
}
export async function captureOriginalMcpComponentB0(fixture: OriginalMcpColdComponentFixture, limits: Limits,
  fence: LinuxRootWriterFence) {
  const state = await fixtureState(fixture);
  if (state.baseline || state.retired || !isTrustedLinuxRootWriterFence(fence, fixture.root))
    fail("COMPONENT_BASELINE_ALREADY_BOUND");
  state.limits = originalMcpLimits.parse(limits);
  state.baseline = await captureImage(fixture, "b0", state.limits, fence);
  return Object.freeze({ path: state.baseline.path, sha256: state.baseline.sha256,
    entries: state.baseline.entries, bytes: state.baseline.bytes, sqliteChecks: state.baseline.sqliteChecks });
}
export async function preserveOriginalMcpComponentB1(fixture: OriginalMcpColdComponentFixture): Promise<OriginalMcpComponentRetirementTicket> {
  const state = await fixtureState(fixture);
  if (!state.baseline || !state.limits || state.retired) fail("COMPONENT_BASELINE_REQUIRED");
  const fence = await acquireOriginalMcpRootFence(fixture.root);
  try {
    await validateOriginalMcpWorkspace(fixture.root, undefined, fence);
    const names = await readdir(fixture.root), optionalDirectories: string[] = [];
    const database = new DatabaseSync(join(fixture.root, "core.sqlite"), { readOnly: true });
    try {
      if (readPendingOriginalMcpTodoGenesis(fixture.root, database))
        fail("COMPONENT_PENDING_DOMAIN_CLOSURE_UNQUALIFIED");
      for (const domain of ["todo", "memory"] as const) {
        const name = `.pkm-next-${domain}`;
        const domainState = readOriginalMcpDomain(fixture.root, domain, database);
        if (domainState && !domainState.committed) fail("COMPONENT_PENDING_DOMAIN_CLOSURE_UNQUALIFIED");
        if (names.includes(name)) {
          const genesis = domain === "todo" && readOriginalMcpTodoGenesisSources(fixture.root, database).length > 0;
          if (!domainState?.committed && !genesis || verifyOriginalMcpDomainFiles(fixture.root, domain, database).length)
            fail("COMPONENT_PENDING_DOMAIN_CLOSURE_UNQUALIFIED");
          optionalDirectories.push(name);
        } else if (domainState) fail("COMPONENT_DOMAIN_DIRECTORY_MISSING");
      }
      if (verifyLegacyRetrievalModels(database, fixture.root).pending.length) fail("COMPONENT_PENDING_MODEL_STATE");
    } finally { database.close(); }
    if (names.includes(".pkm-next-retrieval-models")) optionalDirectories.push(".pkm-next-retrieval-models");
    if (names.includes(".pkm-action-authority")) fail("COMPONENT_ACTION_RETIREMENT_UNQUALIFIED");
    const image = await captureImage(fixture, `b1-${randomUUID()}`, state.limits, fence);
    let active = true;
    const ticket = Object.freeze({
      kind: "pkm.original-mcp-component-b1/v1" as const, b1Path: image.path, b1Sha256: image.sha256,
      entries: image.entries, bytes: image.bytes, sqliteChecks: image.sqliteChecks,
      optionalDirectories: Object.freeze(optionalDirectories),
      async close() {
        if (!active) return; active = false;
        tickets.get(ticket)!.active = false; await fence.release();
      },
    });
    tickets.set(ticket, { fixture, image, fence, active: true });
    return ticket;
  } catch (error) {
    try { await fence.release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Component B1 capture and fence cleanup failed."); }
    throw error;
  }
}
export async function retireOriginalMcpColdComponent(ticket: OriginalMcpComponentRetirementTicket): Promise<OriginalMcpComponentRetirement> {
  const bound = tickets.get(ticket);
  if (!bound?.active) fail("COMPONENT_B1_RETIREMENT_TICKET_REQUIRED");
  const { fixture, image, fence } = bound, state = await fixtureState(fixture);
  if (!state.baseline || !state.limits || state.retired) fail("COMPONENT_RETIREMENT_UNAVAILABLE");
  fence.assertHeld();
  await verifyImage(image, state.limits); await verifyImage(state.baseline, state.limits);
  await assertLinuxLegacyWritersQuiescent(fixture.root);
  if (encode(await inventory(fixture.root, state.limits)) !== encode(image.rows)) fail("COMPONENT_B1_SOURCE_CHANGED");
  const names = (await readdir(fixture.root)).sort(), archiveName = `.pkm-next-component-retired-${randomUUID()}`;
  const archive = join(fixture.root, archiveName);
  const intentSha256 = await durable(join(fixture.directory, "retirement-intent.json"), {
    schema: "pkm.original-mcp-component-retirement-intent/v1", root: fixture.root,
    b0Sha256: state.baseline.sha256, b1Sha256: image.sha256, archive, names,
    restoration: "fresh-disjoint-root-only", fullCutoverQualified: false,
  });
  await mkdir(archive, { mode: 0o700 }); await syncDirectory(fixture.root);
  for (const name of names.sort((a, b) => Number(b === ".pkm-next-workspace") - Number(a === ".pkm-next-workspace") || a.localeCompare(b))) {
    fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(fixture.root);
    fence.renameNoReplaceWithinRoot(join(fixture.root, name), join(archive, name));
    await syncDirectory(archive); await syncDirectory(fixture.root);
  }
  if (encode(logical(await inventory(archive, state.limits))) !== encode(logical(image.rows))
    || encode(await readdir(fixture.root)) !== encode([archiveName])) fail("COMPONENT_RETIREMENT_INCOMPLETE");
  const receiptPath = join(fixture.directory, "retirement-complete.json");
  const receiptSha256 = await durable(receiptPath, {
    schema: "pkm.original-mcp-component-retirement/v1", intentSha256, root: fixture.root, archive,
    b1Sha256: image.sha256, b0Sha256: state.baseline.sha256,
    originalPathRetired: true, enginesStopped: true, fullCutoverQualified: false,
  });
  state.retired = true;
  const result = Object.freeze({ kind: "pkm.original-mcp-component-retirement/v1" as const,
    root: fixture.root, archive, receiptPath, receiptSha256, originalPathRetired: true as const, fullCutoverQualified: false as const });
  retirements.set(result, { fixture, b1: image, restored: false });
  await ticket.close();
  return result;
}
export async function restoreOriginalMcpColdComponentB0(retirement: OriginalMcpComponentRetirement) {
  const bound = retirements.get(retirement);
  if (!bound || bound.restored) fail("COMPONENT_TYPED_RETIREMENT_REQUIRED");
  const state = await fixtureState(bound.fixture);
  if (!state.retired || !state.baseline || !state.limits) fail("COMPONENT_TYPED_RETIREMENT_REQUIRED");
  if (await streamFile(retirement.receiptPath, 65536) !== retirement.receiptSha256)
    fail("COMPONENT_RETIREMENT_RECEIPT_CHANGED");
  const fence = await acquireOriginalMcpRootFence(bound.fixture.root);
  try {
    await verifyImage(bound.b1, state.limits);
    if (encode(logical(await inventory(retirement.archive, state.limits))) !== encode(logical(bound.b1.rows)))
      fail("COMPONENT_RETIRED_B1_CHANGED");
    const root = join(bound.fixture.directory, "restored-b0");
    await materialize(state.baseline, state.limits, root);
    const sqlite = await sqliteChecks(root, state.baseline.rows);
    if (rootPin(await lstat(root)) === state.identity) fail("COMPONENT_RESTORE_IDENTITY_INVALID");
    const receiptPath = join(bound.fixture.directory, "b0-restored.json");
    const receiptSha256 = await durable(receiptPath, {
      schema: "pkm.original-mcp-component-b0-restored/v1", root,
      originalRoot: bound.fixture.root, retirementSha256: retirement.receiptSha256,
      b0Sha256: state.baseline.sha256, b1Sha256: bound.b1.sha256,
      originalRootOverwritten: false, newRootIdentity: rootPin(await lstat(root)), sqliteChecks: sqlite,
      nativeIdentityOrProfileRestored: false, fullCutoverQualified: false,
    });
    bound.restored = true;
    return Object.freeze({ root, receiptPath, receiptSha256, sqliteChecks: sqlite,
      originalRootOverwritten: false as const, newRootIdentity: true as const, fullCutoverQualified: false as const });
  } finally { await fence.release(); }
}
