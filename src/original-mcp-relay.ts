import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { serverStatusSchema, type ServerStatus } from "./server-status.js";

export interface OriginalMcpFilePin {
  path: string; device: string; inode: string; size: string; mtimeNs: string; ctimeNs: string;
  mode: number; uid: string; sha256: string;
}
export interface OriginalMcpBrokerDescriptor {
  schema: "pkm.original-mcp-broker/v1";
  brokerId: string; descriptorPath: string;
  root: { path: string; device: string; inode: string };
  workspaceId: string; planSha256: string; profileSha256: string; operatorId: string;
  scope: "knowledge-content-only/v1" | "native-dogfood/v1"; writable: boolean;
  nativeHost?: { receiptSha256: string; catalogSha256: string; catalogRevision: string; authorityId: string; epoch: string };
  runtime: { node: OriginalMcpFilePin; relay: OriginalMcpFilePin; buildSha256: string };
  process: { pid: number; startTimeTicks: string; bootId: string };
  socket: { path: string; device: string; inode: string; mode: 384 };
  availability: { enabledOperationIds: string[]; disabledOperationIds: string[]; limitations: string[];
    unconditionalOperationIds?: string[]; conditionalOperationIds?: string[] };
  token: string;
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
export function originalMcpBrokerError(): never {
  throw new Error("ORIGINAL_MCP_BROKER_UNAVAILABLE: Verify the independently pinned private broker descriptor and runtime. No call was replayed.");
}
function same(value: string, expected: string): boolean {
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function statPin(stat: { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint;
  size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function canonical(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) originalMcpBrokerError();
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() && current !== path
      || stat.isDirectory() && (stat.mode & 0o002) !== 0) originalMcpBrokerError();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function assertOriginalMcpBrokerDirectory(path: string): void {
  canonical(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)
    originalMcpBrokerError();
}
const runtimePins = new Map<string, { stat: string; pin: OriginalMcpFilePin }>();
function protectedByPrivateAncestor(path: string) {
  for (let current = dirname(path);;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7002) !== 0) return false;
    if ((stat.mode & 0o077) === 0) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
export function pinOriginalMcpBrokerFile(path: string): OriginalMcpFilePin {
  canonical(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o7002n) !== 0n
    || (before.mode & 0o020n) !== 0n && !protectedByPrivateAncestor(path)
    || before.uid !== 0n && before.uid !== BigInt(process.getuid!()) || before.size > 268_435_456n)
    originalMcpBrokerError();
  const cached = runtimePins.get(path);
  if (cached?.stat === statPin(before)) return { ...cached.pin };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (statPin(before) !== statPin(opened)) originalMcpBrokerError();
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(262_144);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > 268_435_456) originalMcpBrokerError();
      digest.update(buffer.subarray(0, count));
    }
    if (String(bytes) !== String(before.size) || statPin(opened) !== statPin(fstatSync(fd, { bigint: true }))
      || statPin(opened) !== statPin(lstatSync(path, { bigint: true }))) originalMcpBrokerError();
    const pin = { path, device: String(opened.dev), inode: String(opened.ino), size: String(opened.size),
      mtimeNs: String(opened.mtimeNs), ctimeNs: String(opened.ctimeNs), mode: Number(opened.mode & 0o777n),
      uid: String(opened.uid), sha256: digest.digest("hex") };
    if (runtimePins.size >= 128) runtimePins.delete(runtimePins.keys().next().value!);
    runtimePins.set(path, { stat: statPin(opened), pin });
    return { ...pin };
  } finally { closeSync(fd); }
}
export function originalMcpBrokerProcessPin(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || lstatSync(`/proc/${pid}`).uid !== process.getuid?.())
    originalMcpBrokerError();
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), close = raw.lastIndexOf(")");
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  if (!Number.isSafeInteger(pid) || pid <= 0 || close < 0 || !/^\d+$/.test(fields[19] ?? "")
    || fields[0] === "Z") originalMcpBrokerError();
  return { pid, startTimeTicks: fields[19]!,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}
function privateControl(path: string, maximumBytes: number): Record<string, any> {
  canonical(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(maximumBytes)) originalMcpBrokerError();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd);
    if (statPin(before) !== statPin(opened) || statPin(opened) !== statPin(fstatSync(fd, { bigint: true }))
      || statPin(opened) !== statPin(lstatSync(path, { bigint: true }))) originalMcpBrokerError();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(value)) originalMcpBrokerError();
    return value;
  } finally { closeSync(fd); }
}
function parsedDescriptor(value: unknown): OriginalMcpBrokerDescriptor {
  const native = record(value) && value.scope === "native-dogfood/v1";
  if (!record(value) || !keys(value, ["schema", "brokerId", "descriptorPath", "root", "workspaceId", "planSha256",
    "profileSha256", "operatorId", "scope", "writable", "runtime", "process", "socket", "availability", "token",
    ...(native ? ["nativeHost"] : [])])
    || value.schema !== "pkm.original-mcp-broker/v1" || !uuid(value.brokerId) || !uuid(value.workspaceId)
    || typeof value.descriptorPath !== "string"
    || !hex(value.planSha256) || !hex(value.profileSha256) || !hex(value.token)
    || !["knowledge-content-only/v1", "native-dogfood/v1"].includes(value.scope) || typeof value.writable !== "boolean"
    || typeof value.operatorId !== "string" || !value.operatorId || value.operatorId.length > 128
    || !record(value.root) || !keys(value.root, ["path", "device", "inode"]) || typeof value.root.path !== "string"
    || !record(value.runtime) || !keys(value.runtime, ["node", "relay", "buildSha256"]) || !hex(value.runtime.buildSha256)
    || !record(value.process) || !keys(value.process, ["pid", "startTimeTicks", "bootId"])
    || !record(value.socket) || !keys(value.socket, ["path", "device", "inode", "mode"])
    || typeof value.socket.path !== "string" || value.socket.mode !== 0o600
    || !record(value.availability) || !keys(value.availability, ["enabledOperationIds", "disabledOperationIds", "limitations",
      ...(native ? ["unconditionalOperationIds", "conditionalOperationIds"] : [])]))
    originalMcpBrokerError();
  for (const list of Object.values(value.availability))
    if (!Array.isArray(list) || list.length > 256 || list.some(item => typeof item !== "string" || item.length > 512))
      originalMcpBrokerError();
  if (native) {
    const binding = value.nativeHost, availability = value.availability;
    if (!record(binding) || !keys(binding, ["receiptSha256", "catalogSha256", "catalogRevision", "authorityId", "epoch"])
      || !hex(binding.receiptSha256) || !hex(binding.catalogSha256) || !hex(binding.catalogRevision)
      || typeof binding.authorityId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.authorityId)
      || typeof binding.epoch !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.epoch))
      originalMcpBrokerError();
    const unconditional: string[] = availability.unconditionalOperationIds, conditional: string[] = availability.conditionalOperationIds;
    const enabled = [...unconditional, ...conditional], disabled: string[] = availability.disabledOperationIds;
    if (new Set([...enabled, ...disabled]).size !== enabled.length + disabled.length
      || JSON.stringify([...enabled].sort()) !== JSON.stringify([...availability.enabledOperationIds].sort()))
      originalMcpBrokerError();
  }
  for (const pin of [value.runtime.node, value.runtime.relay]) {
    if (!record(pin) || !keys(pin, ["path", "device", "inode", "size", "mtimeNs", "ctimeNs", "mode", "uid", "sha256"])
      || typeof pin.path !== "string" || !hex(pin.sha256)
      || JSON.stringify(pinOriginalMcpBrokerFile(pin.path)) !== JSON.stringify(pin)) originalMcpBrokerError();
  }
  canonical(value.root.path);
  const root = lstatSync(value.root.path, { bigint: true });
  if (!root.isDirectory() || root.uid !== BigInt(process.getuid!())
    || String(root.dev) !== value.root.device || String(root.ino) !== value.root.inode
    || JSON.stringify(originalMcpBrokerProcessPin(value.process.pid)) !== JSON.stringify(value.process))
    originalMcpBrokerError();
  const marker = privateControl(join(value.root.path, ".pkm-next-workspace"), 4096);
  const journal = privateControl(join(value.root.path, ".pkm-next-original-mcp.json"), 65_536);
  const commit = privateControl(join(value.root.path, ".pkm-next-original-mcp.commit.json"), 4096);
  const { journalSha256, ...journalBody } = journal, { receiptSha256, ...commitBody } = commit;
  if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== value.workspaceId
    || journal.workspaceId !== value.workspaceId
    || !record(journal.plan) || journal.plan.planSha256 !== value.planSha256
    || !(journal.schema === "pkm.original-mcp-root/v1" && journal.plan.schema === "pkm.original-mcp-custody/v1"
      || journal.schema === "pkm.original-mcp-root/v2" && journal.plan.schema === "pkm.original-mcp-custody/v2"
      || journal.schema === "pkm.original-mcp-root/v3" && journal.plan.schema === "pkm.original-mcp-custody/v3")
    || journal.plan.profileSha256 !== value.profileSha256 || journal.plan.operatorId !== value.operatorId
    || journal.plan.root !== value.root.path || journal.plan.device !== value.root.device || journal.plan.inode !== value.root.inode
    || hash(JSON.stringify(journalBody)) !== journalSha256
    || commit.schema !== "pkm.original-mcp-root-commit/v1" || commit.journalSha256 !== journalSha256
    || hash(JSON.stringify(commitBody)) !== receiptSha256) originalMcpBrokerError();
  const { planSha256, ...planBody } = journal.plan;
  if (hash(JSON.stringify(planBody)) !== planSha256) originalMcpBrokerError();
  const socket = lstatSync(value.socket.path, { bigint: true });
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== BigInt(process.getuid!())
    || Number(socket.mode & 0o7777n) !== 0o600
    || String(socket.dev) !== value.socket.device || String(socket.ino) !== value.socket.inode)
    originalMcpBrokerError();
  return value as OriginalMcpBrokerDescriptor;
}
export function readOriginalMcpBrokerDescriptor(path: string, sha256: string) {
  try {
    if (process.platform !== "linux" || !hex(sha256)) originalMcpBrokerError();
    assertOriginalMcpBrokerDirectory(dirname(path));
    canonical(path);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
      || (before.mode & 0o7777n) !== 0o600n || before.size > 32_768n) originalMcpBrokerError();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd);
      if (!same(hash(bytes), sha256) || statPin(before) !== statPin(opened)
        || statPin(opened) !== statPin(fstatSync(fd, { bigint: true }))
        || statPin(opened) !== statPin(lstatSync(path, { bigint: true }))) originalMcpBrokerError();
      const descriptor = parsedDescriptor(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (descriptor.descriptorPath !== path || dirname(descriptor.socket.path) !== dirname(path)) originalMcpBrokerError();
      return { descriptor, filePin: statPin(opened) };
    } finally { closeSync(fd); }
  } catch { originalMcpBrokerError(); }
}
export function originalMcpRelayLaunch(path: string, sha256: string) {
  const { descriptor } = readOriginalMcpBrokerDescriptor(path, sha256);
  return { command: descriptor.runtime.node.path,
    args: [descriptor.runtime.relay.path, "relay", "--descriptor", path, "--pin", sha256] };
}
export function originalMcpBrokerAuthLine(descriptor: OriginalMcpBrokerDescriptor, descriptorSha256: string,
  statusOnly = false): string {
  return JSON.stringify({ schema: statusOnly ? "pkm.server-status-request/v1" : "pkm.original-mcp-auth/v1", brokerId: descriptor.brokerId,
    descriptorSha256, token: descriptor.token }) + "\n";
}
async function authenticatedSocket(path: string, sha256: string, statusOnly = false): Promise<{ socket: Socket; status?: ServerStatus }> {
  const initial = readOriginalMcpBrokerDescriptor(path, sha256), descriptor = initial.descriptor;
  if (realpathSync(process.execPath) !== descriptor.runtime.node.path
    || !process.argv[1] || realpathSync(process.argv[1]) !== descriptor.runtime.relay.path) originalMcpBrokerError();
  const socket = connect(descriptor.socket.path);
  let status: ServerStatus | undefined;
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error("authentication timeout")), 3000);
      let pending = Buffer.alloc(0);
      const failed = () => { clearTimeout(timer); reject(new Error("authentication failed")); };
      socket.once("error", failed); socket.once("close", failed);
      socket.once("connect", () => socket.write(originalMcpBrokerAuthLine(descriptor, sha256, statusOnly)));
      const data = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf(10);
        if (pending.length > 2048 || end !== -1 && end !== pending.length - 1) { failed(); return; }
        if (end === -1) return;
        try {
          const value = JSON.parse(pending.subarray(0, end).toString("utf8"));
          if (!record(value) || !keys(value, ["schema", "brokerId", "workspaceId", "descriptorSha256", "accepted",
            ...(statusOnly ? ["serverStatus"] : [])])
            || value.schema !== "pkm.original-mcp-auth-result/v1" || value.accepted !== true
            || value.brokerId !== descriptor.brokerId || value.workspaceId !== descriptor.workspaceId
            || value.descriptorSha256 !== sha256
            || readOriginalMcpBrokerDescriptor(path, sha256).filePin !== initial.filePin) originalMcpBrokerError();
          if (statusOnly) {
            status = serverStatusSchema.parse(value.serverStatus);
            if (status.workspaceId !== descriptor.workspaceId || status.instanceId !== descriptor.brokerId
              || status.runtimeBuild !== descriptor.runtime.buildSha256 || status.writable !== descriptor.writable
              || status.scope !== descriptor.scope) originalMcpBrokerError();
          }
          clearTimeout(timer); socket.removeListener("data", data);
          socket.removeListener("error", failed); socket.removeListener("close", failed);
          socket.pause(); ready();
        } catch { failed(); }
      };
      socket.on("data", data);
    });
    return { socket, status };
  } catch { socket.destroy(); originalMcpBrokerError(); }
}
export async function runOriginalMcpRelay(path: string, sha256: string): Promise<void> {
  const { socket } = await authenticatedSocket(path, sha256);
  await new Promise<void>((done, reject) => {
    let localClosed = false, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      process.stdin.unpipe(socket); socket.unpipe(process.stdout); process.stdin.pause(); socket.destroy();
      process.stdin.removeListener("end", ended);
      process.stdin.removeListener("error", failed);
      if (error) reject(error); else done();
    };
    const ended = () => { localClosed = true; socket.end(); finish(); };
    const failed = () => finish(new Error("Broker relay failed; no call was replayed."));
    socket.once("error", failed);
    socket.once("close", () => localClosed ? finish() : failed());
    process.stdin.once("end", ended); process.stdin.once("error", failed);
    process.stdout.once("error", failed);
    socket.pipe(process.stdout, { end: false }); process.stdin.pipe(socket); socket.resume();
  });
}

export async function readOriginalMcpServerStatus(path: string, sha256: string): Promise<ServerStatus> {
  const { socket, status } = await authenticatedSocket(path, sha256, true);
  try {
    if (!status) originalMcpBrokerError();
    return status;
  } finally { socket.destroy(); }
}
