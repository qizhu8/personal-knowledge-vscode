import { createServer, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import type { OriginalSdkImmutableSelection } from "./original-mcp-native-sdk-control.js";
import { OriginalSdkForwardingError } from "./original-mcp-native-sdk-forwarding.js";

export interface OriginalSdkEgressLease {
  readonly clientOptions: Readonly<CopilotClientOptions>;
  bindClient(stop: () => Promise<unknown>): void;
  ready(): Promise<void>;
  assertCurrent(): void;
  observation(): Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}
const issued = new WeakMap<object, { check(): void }>();
export function assertOriginalSdkEgressLease(value: OriginalSdkEgressLease) {
  const record = issued.get(value);
  if (!record) throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent");
  try { record.check(); }
  catch { throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"); }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function failed(): never { throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"); }
async function proc(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { status, parent: Number(fields[1]), start: fields[19]!, network: await readlink(`/proc/${pid}/ns/net`),
    pidNamespace: await readlink(`/proc/${pid}/ns/pid`) };
}
async function gone(pid: number, start: string) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] !== start || fields[0] === "Z";
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

/** SDK-specific managed child owner; public SDK spawn remains untouched. Kernel receipts, not interface booleans, admit model work. */
export async function createOriginalSdkEgressOwner(options: {
  selection: OriginalSdkImmutableSelection; profileRoot: string; baseOptions: Readonly<CopilotClientOptions>;
  python: string; supervisor: string; supervisorSha256: string;
  registerChild(close: () => Promise<void>): () => void;
  reportFailure?(error: Error): void;
  assertCurrent(): void; signal: AbortSignal;
  probePort?: number;
}) {
  options = { ...options, selection: structuredClone(options.selection), baseOptions: structuredClone(options.baseOptions) };
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) failed();
  options.assertCurrent(); options.signal.throwIfAborted();
  if (await realpath(options.python) !== options.python || await realpath(options.supervisor) !== options.supervisor
    || digest(await readFile(options.supervisor)) !== options.supervisorSha256) failed();
  const interpreter = await lstat(options.python, { bigint: true });
  if (!interpreter.isFile() || (interpreter.mode & 0o022n) !== 0n || (interpreter.mode & 0o111n) === 0n) failed();
  const hostNetwork = await readlink("/proc/self/ns/net"), hostPidNamespace = await readlink("/proc/self/ns/pid");
  const leases = new Set<OriginalSdkEgressLease>();
  const reservations = new Set<Promise<void>>();
  let closed = false;
  let fault: Error | undefined, detached = false, unregisterOwner: (() => void) | undefined;
  let ownerDisposal: Promise<void> | undefined;
  const latch = (error: unknown) => {
    if (fault) return;
    fault = error instanceof Error ? error : new Error("NATIVE_SDK_CLEANUP_UNCONFIRMED", { cause: error });
    try {
      if (options.reportFailure) options.reportFailure(fault);
      else console.error("NATIVE_SDK_CLEANUP_UNCONFIRMED: the managed SDK child owner is faulted; inspect its retained failure.");
    } catch (notification) {
      fault = new AggregateError([fault, notification], "NATIVE_SDK_FAILURE_NOTIFICATION_FAILED");
      try { console.error("NATIVE_SDK_CLEANUP_UNCONFIRMED: managed SDK failure notification failed."); }
      catch (logging) { fault = new AggregateError([fault, logging], "NATIVE_SDK_FAILURE_LOGGING_FAILED"); }
    }
    queueMicrotask(() => { void ownerClose().catch(latch); });
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    options.signal.removeEventListener("abort", abort);
    try { unregisterOwner?.(); } catch (error) { latch(error); }
  };
  const current = () => {
    if (fault) throw fault;
    options.assertCurrent(); options.signal.throwIfAborted();
    if (closed) failed();
  };
  const ownerClose = () => {
    if (ownerDisposal) return ownerDisposal;
    closed = true;
    return ownerDisposal = (async () => {
      try {
        await Promise.all([...reservations]);
        const results = await Promise.allSettled([...leases].map(lease => lease.close()));
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) latch(new AggregateError(errors, "NATIVE_SDK_CLEANUP_UNCONFIRMED"));
      } finally { detach(); }
      if (fault) throw fault;
    })();
  };
  const abort = () => { void ownerClose().catch(latch); };
  unregisterOwner = options.registerChild(ownerClose);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const owner = {
    async reserve(): Promise<OriginalSdkEgressLease> {
      current();
      let finishReservation!: () => void;
      const reservation = new Promise<void>(resolve => { finishReservation = resolve; });
      reservations.add(reservation);
      let directoryPin: { dev: bigint; ino: bigint } | undefined;
      let closePartial: (() => Promise<void>) | undefined;
      const nonce = randomUUID(), directory = join(options.profileRoot, `sdk-child-${nonce}`);
      try {
      if (await readlink("/proc/self/ns/net") !== hostNetwork || await readlink("/proc/self/ns/pid") !== hostPidNamespace
        || digest(await readFile(options.supervisor)) !== options.supervisorSha256) failed();
      await mkdir(directory, { mode: 0o700 });
      const ownedDirectory = await lstat(directory, { bigint: true });
      directoryPin = { dev: ownedDirectory.dev, ino: ownedDirectory.ino };
      const controlSocket = `\0pkm-sdk-${nonce}`, manifestFile = join(directory, "launch.json");
      const manifest = { schema: "pkm.sdk-linux-stdio-launch/v1", nonce, hostPid: process.pid, uid: process.getuid!(),
        python: options.python, pythonIdentity: {
          dev: String(interpreter.dev), ino: String(interpreter.ino), size: String(interpreter.size),
          mtimeNs: String(interpreter.mtimeNs), ctimeNs: String(interpreter.ctimeNs),
        },
        probePort: options.probePort ?? 9,
        hostNetworkNamespace: hostNetwork, controlSocket, runtimeFile: options.selection.runtimeFile,
        runtimeIdentity: options.selection.runtimeIdentity,
        readonlyPaths: [dirname(options.selection.moduleManifest), dirname(options.selection.runtimeManifest), options.supervisor] };
      const bytes = Buffer.from(JSON.stringify(manifest));
      let peer: Socket | undefined, supervisorPid = 0, initPid = 0, supervisorStart = "", initStart = "";
      let phase: "reserved" | "ready" | "drained" | "closed" | "failed" = "reserved";
      let stopClient: (() => Promise<unknown>) | undefined, disposal: Promise<void> | undefined;
      let blockedProbes: unknown;
      let leaseFailure: unknown, closing = false, lease: OriginalSdkEgressLease | undefined;
      let protocol = Promise.resolve();
      let netHandle: FileHandle | undefined, pidHandle: FileHandle | undefined;
      let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      void ready.catch(() => {});
      const failProtocol = (error: unknown) => {
        if (closing) return;
        leaseFailure ??= error; phase = "failed"; rejectReady(error); peer?.destroy();
        queueMicrotask(() => { void closePartial!().catch(latch); });
      };
      const server = createServer(socket => {
        if (peer || closing) { socket.destroy(); failProtocol(new Error("NATIVE_SDK_CONTROL_DUPLICATE_CONNECTION")); return; }
        peer = socket;
        let input = "", frameCount = 0;
        socket.on("data", chunk => {
          if (closing) return;
          input += chunk.toString("utf8");
          if (Buffer.byteLength(input) > 16384) { failProtocol(new Error("NATIVE_SDK_CONTROL_ENVELOPE")); return; }
          while (input.includes("\n")) {
            if (++frameCount > 2) { failProtocol(new Error("NATIVE_SDK_CONTROL_DUPLICATE_FRAME")); return; }
            const end = input.indexOf("\n"), line = input.slice(0, end); input = input.slice(end + 1);
            protocol = protocol.then(async () => {
            if (closing) return;
            const receipt = JSON.parse(line);
            if (receipt.nonce !== nonce) failed();
            if (receipt.phase === "ready" && phase === "reserved") {
              supervisorPid = receipt.supervisorPid;
              if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) failed();
              const supervisor = await proc(supervisorPid);
              const command = (await readFile(`/proc/${supervisorPid}/cmdline`)).toString("utf8").split("\0");
              if (supervisor.parent !== process.pid || supervisor.network === hostNetwork
                || !command.includes(options.supervisor) || !command.includes(manifestFile) || !command.includes(nonce)
                || await realpath(`/proc/${supervisorPid}/exe`) !== options.python
                || !Array.isArray(receipt.interfaces) || receipt.interfaces.length !== 1 || receipt.interfaces[0] !== "lo"
                || JSON.stringify(receipt.initialFds) !== "[0,1,2]") failed();
              if (!new RegExp(`^Uid:\\s+${process.getuid!()}\\s+${process.getuid!()}\\s+${process.getuid!()}\\s+${process.getuid!()}$`, "m").test(supervisor.status)) failed();
              supervisorStart = supervisor.start;
              if (!receipt.blockedProbes || receipt.blockedProbes.hostLoopback !== 101
                || receipt.blockedProbes.externalTestNet !== 101 || receipt.blockedProbes.unixProxy !== 1) failed();
              const children = (await readFile(`/proc/${supervisorPid}/task/${supervisorPid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
              if (children.length !== 1) failed();
              initPid = Number(children[0]);
              const init = await proc(initPid);
              if (init.parent !== supervisorPid || init.network !== receipt.networkNamespace || init.network !== supervisor.network
                || init.pidNamespace === hostPidNamespace || init.pidNamespace !== receipt.pidNamespace
                || !/^NoNewPrivs:\s+1$/m.test(init.status) || !/^Seccomp:\s+2$/m.test(init.status)
                || !/^CapEff:\s+0+$/m.test(init.status) || !/^CapPrm:\s+0+$/m.test(init.status)) failed();
              initStart = init.start;
              const net = await readFile(`/proc/${initPid}/net/dev`, "utf8");
              if (net.trim().split("\n").slice(2).some(line => line.trim().split(":")[0] !== "lo")) failed();
              netHandle = await open(`/proc/${initPid}/ns/net`, "r");
              pidHandle = await open(`/proc/${initPid}/ns/pid`, "r");
              blockedProbes = receipt.blockedProbes;
              if (closing || closed || options.signal.aborted) failed();
              phase = "ready"; socket.write("go\n"); resolveReady();
            } else if (receipt.phase === "drained" && phase === "ready") phase = "drained";
            else failed();
            }).catch(failProtocol);
          }
        });
        socket.on("error", failProtocol);
        socket.on("close", () => {
          if (!closing && phase !== "drained") failProtocol(new Error("NATIVE_SDK_CONTROL_CLOSED_WITHOUT_DRAIN"));
        });
      });
      const clientOptions: CopilotClientOptions = { ...structuredClone(options.baseOptions), connection: {
        kind: "stdio", path: options.python, args: ["-I", "-B", options.supervisor, manifestFile, nonce],
      } };
      const close = () => {
        return disposal ??= (async () => {
          closing = true;
          const errors: unknown[] = [];
          if (leaseFailure) errors.push(leaseFailure);
          rejectReady(new OriginalSdkForwardingError("NATIVE_SDK_CANCELLED", "not-sent"));
          try {
            let stopTimer: NodeJS.Timeout | undefined;
            const stopped = (stopClient ? Promise.resolve().then(stopClient) : Promise.resolve()).catch(error => { errors.push(error); });
            if (phase === "ready" && !peer?.destroyed) peer?.write("stop\n");
            try {
              await Promise.race([stopped, new Promise<void>(resolve => {
                stopTimer = setTimeout(() => { errors.push(new Error("NATIVE_SDK_CHILD_STOP_TIMEOUT")); resolve(); }, 5000);
              })]);
            } finally { clearTimeout(stopTimer); }
            await protocol;
            const end = Date.now() + 5000;
            while (Date.now() < end && initPid && !await gone(initPid, initStart)) await pause(30);
            if (initPid && !await gone(initPid, initStart)) process.kill(initPid, "SIGKILL");
            if (supervisorPid) {
              const drain = Date.now() + 3000;
              while (Date.now() < drain && !await gone(supervisorPid, supervisorStart)) await pause(30);
              if (!await gone(supervisorPid, supervisorStart)) process.kill(supervisorPid, "SIGKILL");
            }
            if (initPid && !await gone(initPid, initStart)) errors.push(new Error("NATIVE_SDK_INIT_DRAIN_UNCONFIRMED"));
            if (supervisorPid && !await gone(supervisorPid, supervisorStart)) errors.push(new Error("NATIVE_SDK_SUPERVISOR_DRAIN_UNCONFIRMED"));
          } catch (error) { errors.push(error); }
          finally {
            peer?.destroy();
            await new Promise<void>(resolve => server.close(error => {
              if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") errors.push(error);
              resolve();
            }));
            for (const handle of [netHandle, pidHandle]) {
              try { await handle?.close(); } catch (error) { errors.push(error); }
            }
            try {
              if (directoryPin) {
                const named = await lstat(directory, { bigint: true });
                if (!named.isDirectory() || named.dev !== directoryPin.dev || named.ino !== directoryPin.ino) failed();
                await rm(directory, { recursive: true }); directoryPin = undefined;
              }
            } catch (error) { errors.push(error); }
            phase = errors.length ? "failed" : "closed";
            if (lease) leases.delete(lease);
          }
          if (errors.length) {
            const failure = new AggregateError(errors, "NATIVE_SDK_CLEANUP_UNCONFIRMED");
            latch(failure); throw failure;
          }
        })();
      };
      closePartial = close;
      server.on("error", failProtocol);
      await import("node:fs/promises").then(fs => fs.writeFile(manifestFile, bytes, { mode: 0o600, flag: "wx" }));
      current();
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(controlSocket, resolve));
      current();
      lease = Object.freeze({
        clientOptions,
        bindClient(stop: () => Promise<unknown>) { if (stopClient || phase !== "reserved") failed(); stopClient = stop; },
        async ready() {
          let timer: NodeJS.Timeout | undefined;
          try { await Promise.race([ready, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent")), 15000);
          })]); } finally { clearTimeout(timer); }
          lease!.assertCurrent();
        },
        assertCurrent() {
          current();
          if (phase !== "ready" || peer?.destroyed || !supervisorPid || !initPid) failed();
          const status = readFileSync(`/proc/${initPid}/status`, "utf8");
          const stat = readFileSync(`/proc/${initPid}/stat`, "utf8");
          const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
          const named = lstatSync(options.selection.runtimeFile, { bigint: true });
          const python = lstatSync(options.python, { bigint: true });
          if (readlinkSync("/proc/self/ns/net") !== hostNetwork
            || !netHandle || !pidHandle || start !== initStart
            || readlinkSync(`/proc/self/fd/${netHandle.fd}`) === hostNetwork
            || readlinkSync(`/proc/self/fd/${pidHandle.fd}`) === hostPidNamespace
            || !/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)
            || !/^CapEff:\s+0+$/m.test(status) || !/^CapPrm:\s+0+$/m.test(status)
            || digest(readFileSync(options.supervisor)) !== options.supervisorSha256
            || realpathSync(options.supervisor) !== options.supervisor
            || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key =>
              python[key as keyof typeof python] !== interpreter[key as keyof typeof interpreter])
            || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key =>
              String(named[key as keyof typeof named]) !== options.selection.runtimeIdentity[key as keyof typeof options.selection.runtimeIdentity])) failed();
        },
        observation() {
          const children = initPid && phase === "ready" ? readFileSync(`/proc/${initPid}/task/${initPid}/children`, "utf8")
            .trim().split(/\s+/).filter(Boolean).map(Number) : [];
          return Object.freeze({ phase, supervisorPid, initPid, hostNetworkNamespace: hostNetwork,
            isolatedNetworkNamespace: netHandle && phase === "ready" ? readlinkSync(`/proc/self/fd/${netHandle.fd}`) : null,
            initialFds: [0, 1, 2], blockedProbes, runtimeChildren: children.map(pid => {
              const status = readFileSync(`/proc/${pid}/status`, "utf8");
              return { pid, noNewPrivs: /^NoNewPrivs:\s+1$/m.test(status), seccomp: /^Seccomp:\s+2$/m.test(status),
                noEffectiveCapabilities: /^CapEff:\s+0+$/m.test(status) };
            }), drained: phase === "closed" });
        },
        close,
      });
      issued.set(lease, { check: lease.assertCurrent });
      leases.add(lease);
      return lease;
      } catch (error) {
        try {
          if (closePartial) await closePartial();
          else if (directoryPin) {
            const named = await lstat(directory, { bigint: true });
            if (!named.isDirectory() || named.dev !== directoryPin.dev || named.ino !== directoryPin.ino) failed();
            await rm(directory, { recursive: true });
          }
        } catch (cleanup) {
          const failure = new AggregateError([error, cleanup], "NATIVE_SDK_RESERVATION_AND_CLEANUP_FAILED", { cause: error });
          latch(failure); throw failure;
        }
        throw error;
      } finally { reservations.delete(reservation); finishReservation(); }
    },
    assertCurrent: current,
    close: ownerClose,
  };
  return Object.freeze(owner);
}
