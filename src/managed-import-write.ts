import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Core } from "./core.js";
import { createNativeRuntime } from "./native-runtime.js";
import { Storage } from "./storage.js";
import { CoreError } from "./contracts.js";
import { captureImportedExperiment } from "./managed-import-audit.js";
import type { ManagedClientHost, ManagedDocumentOperation } from "./managed-client-host.js";

export const experimentCoverage = Object.freeze({
  inProcessCalls: "tracked" as const, cooperatingHosts: "native-lease" as const,
  external: "unknown" as const, cutoverAuthorized: false as const,
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const recordName = ".pkm-isolated-experiment.json";
const lockName = ".pkm-isolated-experiment.lock";
type Binding = {
  schema: "pkm.isolated-experiment/v1"; scope: "isolated_experiment"; parent: string; target: string;
  parentPin: string;
  workspaceId: string; planSha256: string; actorId: string; capabilityHash: string;
  source: string; legacyRoot: string;
  state: "active" | "clean"; baseline: string; mac: string;
};
function disjoint(left: string, right: string) {
  const inside = (a: string, b: string) => { const delta = relative(a, b); return !delta || delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta); };
  return !inside(left, right) && !inside(right, left);
}

async function privatePath(path: string, directory: boolean) {
  if (!path || resolve(path) !== path || await realpath(path) !== path) throw new Error("Noncanonical experiment path.");
  for (let current: string = sep; current !== path;) {
    const remaining = path.slice(current === sep ? 1 : current.length + 1).split(sep)[0]!;
    current = join(current, remaining);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw new Error("Experiment links forbidden.");
  }
  const stat = await lstat(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.()
    || (stat.mode & 0o077) !== 0 || !directory && stat.nlink !== 1)
    throw new Error("Experiment path must be private and owner-bound.");
}
async function readBinding(parent: string): Promise<Binding> {
  await privatePath(parent, true);
  const path = join(parent, recordName);
  await privatePath(path, false);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.nlink !== 1
      || stat.size > 16 * 1024 * 1024) throw new Error("Experiment binding unsafe or too large.");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat(), current = await lstat(path);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || current.isSymbolicLink())
      throw new Error("Experiment binding changed while reading.");
    const value = JSON.parse(bytes.subarray(0, size).toString("utf8")) as Binding;
    if (value.schema !== "pkm.isolated-experiment/v1" || value.scope !== "isolated_experiment"
      || value.parent !== parent || value.target !== join(parent, "workspace")
      || typeof value.parentPin !== "string" || !/^\d+:\d+:\d+$/.test(value.parentPin)
      || !/^[a-f0-9-]{36}$/.test(value.workspaceId) || !/^[a-f0-9]{64}$/.test(value.planSha256)
      || !/^experiment:[a-f0-9-]{36}$/.test(value.actorId) || !/^[a-f0-9]{64}$/.test(value.capabilityHash)
      || typeof value.mac !== "string" || !/^[a-f0-9]{64}$/.test(value.mac)
      || !["active", "clean"].includes(value.state) || typeof value.baseline !== "string"
      || typeof value.source !== "string" || !isAbsolute(value.source) || resolve(value.source) !== value.source
      || typeof value.legacyRoot !== "string" || !isAbsolute(value.legacyRoot) || resolve(value.legacyRoot) !== value.legacyRoot
      || !disjoint(value.source, parent) || !disjoint(value.legacyRoot, parent) || !disjoint(value.source, value.legacyRoot))
      throw new Error("Invalid experiment binding.");
    return value;
  } finally { await file.close(); }
}
function bindingMac(binding: Binding, capability: string) {
  const { mac: _mac, ...payload } = binding;
  return createHmac("sha256", Buffer.from(capability, "hex")).update(JSON.stringify(payload)).digest("hex");
}
async function saveBinding(binding: Binding, capability: string, initial = false) {
  binding.mac = bindingMac(binding, capability);
  const path = join(binding.parent, recordName);
  const staged = initial ? path : `${path}.${randomUUID()}`;
  const file = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(binding)); await file.sync(); } finally { await file.close(); }
  if (!initial) await rename(staged, path);
  const directory = await open(binding.parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** A local bearer capability for isolated rehearsal, never human/production or lineage authority. */
export async function openImportedExperiment(options: {
  parent: string; capability?: string;
  initial?: { workspaceId: string; planSha256: string; source: string; legacyRoot: string; assertUnchanged(): Promise<void> };
}): Promise<{ host: ManagedClientHost; capability?: string }> {
  const { parent } = options;
  await privatePath(parent, true);
  const parentStat = await lstat(parent, { bigint: true });
  const parentPin = `${parentStat.dev}:${parentStat.ino}:${parentStat.uid}`;
  const target = join(parent, "workspace");
  await privatePath(target, true);
  let binding: Binding, capability: string | undefined;
  if (options.initial) {
    await options.initial.assertUnchanged();
    capability = randomBytes(32).toString("hex");
    binding = { schema: "pkm.isolated-experiment/v1", scope: "isolated_experiment", parent, target, parentPin,
      workspaceId: options.initial.workspaceId, planSha256: options.initial.planSha256,
      source: options.initial.source, legacyRoot: options.initial.legacyRoot,
      actorId: `experiment:${randomUUID()}`, capabilityHash: digest(capability), state: "active", baseline: "", mac: "" };
    if (!disjoint(binding.source, parent) || !disjoint(binding.legacyRoot, parent) || !disjoint(binding.source, binding.legacyRoot))
      throw new Error("Experiment source/target boundaries overlap.");
  } else {
    binding = await readBinding(parent);
    if (typeof options.capability !== "string" || !/^[a-f0-9]{64}$/.test(options.capability)
      || !timingSafeEqual(Buffer.from(binding.capabilityHash, "hex"), Buffer.from(digest(options.capability), "hex")))
      throw new Error("Experiment capability rejected.");
    if (!timingSafeEqual(Buffer.from(binding.mac, "hex"), Buffer.from(bindingMac(binding, options.capability), "hex")))
      throw new Error("Experiment authorization binding changed.");
    if (binding.parentPin !== parentPin) throw new Error("Experiment parent identity changed.");
    if (binding.state !== "clean") throw new Error("Experiment outcome unknown; unclean sessions cannot reopen for writes.");
    if ((await captureImportedExperiment(target)).full !== binding.baseline)
      throw new Error("Experiment changed since clean close; investigate without replay.");
  }
  const marker = JSON.parse(await readFile(join(target, ".pkm-next-workspace"), "utf8"));
  if (marker.id !== binding.workspaceId) throw new Error("Experiment workspace identity changed.");
  const beforeOpen = await captureImportedExperiment(target);
  if (options.initial) await options.initial.assertUnchanged();
  else if (beforeOpen.full !== binding.baseline) throw new Error("Experiment changed before writer acquisition.");
  const lock = await open(join(parent, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await lock.close();
  // Persist active before opening Storage: failures/crashes never manufacture a clean checkpoint.
  binding.state = "active";
  const secret = capability ?? options.capability!;
  await saveBinding(binding, secret, !!options.initial);
  const storage = await Storage.open(target);
  let native: Awaited<ReturnType<typeof createNativeRuntime>>;
  try { native = await createNativeRuntime({ storage }); }
  catch (error) { await storage.close(); throw error; }
  const actor = Object.freeze({ id: binding.actorId, canWrite: true });
  const names = { list: "knowledge.document.list", get: "knowledge.document.get",
    "asset-list": "knowledge.asset.list", "asset-get": "knowledge.asset.get",
    "board-list": "todo.board.list", "board-get": "todo.board.get",
    "board-tasks": "todo.workitem.list", "board-stories": "todo.story.list",
    "research-list": "knowledge.research.list", "skill-list": "knowledge.skill.list",
    "skill-get": "knowledge.skill.get", "metadata-get": "knowledge.metadata.get",
    "recipe-list": "project.recipe.list", "recipe-get": "project.recipe.get",
    "library-list": "knowledge.library.list", "library-get": "knowledge.library.get",
    "mutation-scan": "knowledge.mutation.scan",
    "note-create": "knowledge.note.create", "note-update": "knowledge.note.update",
    "skill-create": "knowledge.skill.create", "skill-update": "knowledge.skill.update",
    "research-create": "knowledge.research.create", "research-update": "knowledge.research.update",
    create: "knowledge.document.create", update: "knowledge.document.update" } as const;
  const isRead = (operation: string) => ["list", "get", "asset-list", "asset-get", "board-list", "board-get", "board-tasks", "board-stories",
    "research-list", "skill-list", "skill-get", "metadata-get", "recipe-list", "recipe-get", "library-list", "library-get", "mutation-scan"].includes(operation);
  const structured = (operation: string) => /^(note|skill|research)-(create|update)$/.test(operation);
  const core = new Core(storage, { assertAdmission({ method, input, actor: principal }) {
    const operation = input && typeof input === "object" && "operation" in input ? String(input.operation) : "";
    if (principal.id !== actor.id || principal.canWrite !== true || !Object.values(names).includes(operation as typeof names[keyof typeof names])
      || method !== (operation.endsWith(".list") || operation.endsWith(".get") || operation === "knowledge.mutation.scan" ? "capability_read" : "capability_call"))
      throw new CoreError("ACCESS_DENIED", "Isolated experiment capability scope exceeded.");
  } });
  let baseline: string;
  try {
    baseline = (await captureImportedExperiment(target)).live;
    if (baseline !== beforeOpen.live) throw new Error("Experiment changed during writer acquisition.");
  }
  catch (error) { await native.close(); await storage.close(); throw error; }
  let closed = false, failed = false, tail: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined;
  async function assertBinding() {
    const current = await readBinding(parent);
    const stat = await lstat(parent, { bigint: true });
    if (current.mac !== binding.mac || current.state !== "active"
      || `${stat.dev}:${stat.ino}:${stat.uid}` !== binding.parentPin
      || !timingSafeEqual(Buffer.from(current.mac, "hex"), Buffer.from(bindingMac(current, secret), "hex")))
      throw new Error("Experiment authorization changed during session.");
  }
  const host: ManagedClientHost = Object.freeze({
    workspaceId: binding.workspaceId, writerCoverage: experimentCoverage,
    invoke(operation: ManagedDocumentOperation, args: Record<string, unknown>) {
      if (closed) return Promise.reject(new Error("Experiment admission closed."));
      const task = tail.then(async () => {
        if (failed) throw new Error("Experiment outcome unknown; close without replay.");
        if (!Object.hasOwn(names, operation)) throw new Error("Experiment operation rejected.");
        try {
          await assertBinding();
          storage.assertWorkspaceLease();
          if ((await captureImportedExperiment(target)).live !== baseline) throw new Error("External experiment changes detected.");
          // The strict native schema rejects this field before planning any move.
          const scopedArgs = structured(operation) && args.moveTo !== undefined
            ? { ...args, experimentalMoveNotAuthorized: true } : args;
          const result = await (structured(operation) ? native.core : core).dispatch(isRead(operation) ? "capability_read" : "capability_call",
            { operation: names[operation], version: 1, arguments: scopedArgs }, actor);
          if ("error" in result && (result.error as { effect?: string }).effect === "unknown")
            throw new Error("Experiment mutation outcome unknown; do not replay.");
          storage.assertWorkspaceLease();
          await assertBinding();
          const current = (await captureImportedExperiment(target)).live;
          if (isRead(operation) || "error" in result) {
            if (current !== baseline) throw new Error("Unexpected experiment side effects.");
          } else {
            // Only the requested document may change; all other preserved files remain pinned.
            const before = JSON.parse(baseline), after = JSON.parse(current);
            const document = (result as { result: { area: string; path: string; sha256: string } }).result;
            const allowed = `${document.area}/${document.path}`;
            const files = (value: typeof before) => JSON.stringify(value.entries.filter(([path, entry]: [string, { kind: string }]) =>
              entry.kind === "file" && path !== allowed));
            if (before.rootPin !== after.rootPin || files(before) !== files(after)) throw new Error("Unexpected non-document experiment changes.");
            const previous = new Map<string, { kind: string; sha256?: string }>(before.entries);
            const observed = new Map<string, { kind: string; sha256?: string }>(after.entries);
            if (observed.get(allowed)?.sha256 !== document.sha256) throw new Error("Written experiment document differs from its receipt.");
            for (const [path, entry] of previous) {
              if (entry.kind === "directory" && JSON.stringify(observed.get(path)) !== JSON.stringify(entry))
                throw new Error("Existing experiment directory changed.");
            }
            for (const [path, entry] of observed) {
              if (entry.kind === "directory" && !previous.has(path) && !allowed.startsWith(`${path}/`))
                throw new Error("Unexpected experiment directory created.");
            }
          }
          baseline = current;
          return result;
        } catch (error) { failed = true; throw error; }
      });
      tail = task.catch(() => undefined);
      return task;
    },
    close() {
      closed = true;
      return closing ??= (async () => {
        await tail;
        let safe = !failed;
        try { await assertBinding(); storage.assertWorkspaceLease(); safe &&= (await captureImportedExperiment(target)).live === baseline; }
        catch { safe = false; }
        await native.close();
        await storage.close();
        if (!safe) throw new Error("Experiment drain completed but outcome unknown; no clean restart checkpoint.");
        const checkpoint = await captureImportedExperiment(target);
        if (checkpoint.live !== baseline || (await captureImportedExperiment(target)).full !== checkpoint.full)
          throw new Error("Experiment changed during close; no clean restart checkpoint.");
        binding.baseline = checkpoint.full;
        binding.state = "clean";
        await saveBinding(binding, secret);
        await unlink(join(parent, lockName));
      })();
    },
  });
  return { host, ...(capability ? { capability } : {}) };
}
