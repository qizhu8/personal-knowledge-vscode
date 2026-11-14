import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type Launch = { executable: string; args: string[]; cwd?: string; env: Record<string, string>; stdin: boolean; graceMs: number; pinned?: boolean };
type LaunchInput = Omit<Launch, "pinned"> & { descriptors?: { executable: number; cwd: number } };
type Result = { code: number | null; signal: NodeJS.Signals | null; error?: string; notStarted?: boolean };
type Message = { type: string; id?: number; result?: Result; error?: string; launch?: Launch };
const modulePath = fileURLToPath(import.meta.url);

/**
 * An in-memory, host-only handle. An independent lifecycle owner outside the job
 * group holds its live session leader; no PID is reconstructed from storage.
 * A process which deliberately leaves the session/group is not contained.
 */
export class LinuxProcessGroup {
  readonly child: ChildProcess;
  readonly done: Promise<Result>;
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  private sequence = 0;
  private result?: Result;
  private stopped = false;

  constructor(input: LaunchInput) {
    if (process.platform !== "linux") throw new Error("Linux process groups are unavailable on this platform.");
    const { descriptors, ...launch } = input;
    this.child = spawn(process.execPath, [modulePath, "--guardian"], {
      env: {}, stdio: [launch.stdin ? "pipe" : "ignore", "pipe", "pipe", "ipc",
        ...(descriptors ? [descriptors.executable, descriptors.cwd] as const : [])], windowsHide: true,
    });
    this.done = new Promise(resolve => {
      this.child.on("message", (value: Message) => {
        if (value?.type === "result" && value.result) this.result = value.result;
        if (value?.type === "ack" && typeof value.id === "number") {
          const pending = this.pending.get(value.id);
          if (!pending) return;
          this.pending.delete(value.id);
          if (value.error) pending.reject(new Error(value.error)); else pending.resolve();
        }
      });
      this.child.once("error", error => { this.result = { code: null, signal: null, error: error.message }; });
      this.child.once("close", () => {
        this.stopped = true;
        for (const pending of this.pending.values()) pending.reject(new Error("Process guardian is no longer available."));
        this.pending.clear();
        resolve(this.result ?? { code: null, signal: null, error: "Process guardian ended without a result." });
      });
    });
    this.child.send({ type: "launch", launch: { ...launch, pinned: !!descriptors } }, error => {
      if (error) this.result = { code: null, signal: null, error: error.message };
    });
  }

  control(action: "pause" | "resume" | "cancel"): Promise<void> {
    if (this.stopped || !this.child.connected) return Promise.reject(new Error("Process guardian is no longer available."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ type: action, id }, error => {
        if (error && this.pending.delete(id)) reject(error);
      });
    });
  }
}

function relay(nextRole: "--anchor" | "--owner") {
  let anchor: ChildProcess | undefined;
  let launch: Launch | undefined;
  let stopping = false;
  let result: Result | undefined;
  let pipeDeadline: NodeJS.Timeout | undefined;
  const send = (message: Message) => { if (process.connected) process.send?.(message, () => {}); };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!anchor) { process.exitCode = 1; if (process.connected) process.disconnect?.(); return; }
    if (anchor.connected) anchor.send({ type: "cancel", id: 0 }, () => {});
  };
  process.on("disconnect", stop);
  process.stdout.on("error", stop);
  process.stderr.on("error", stop);
  process.on("message", (message: Message) => {
    if (message?.type === "launch" && message.launch && !launch && !stopping) {
      launch = message.launch;
      anchor = spawn(process.execPath, [modulePath, nextRole], {
        detached: false, env: {}, stdio: [launch.stdin ? "pipe" : "ignore", "pipe", "pipe", "ipc",
          ...(launch.pinned ? [4, 5] as const : [])],
      });
      if (launch.stdin) process.stdin.pipe(anchor.stdin!);
      anchor.stdout!.pipe(process.stdout);
      anchor.stderr!.pipe(process.stderr);
      anchor.on("message", (value: Message) => {
        if (value?.type === "result" && value.result && !result) result = value.result;
        if (value?.type === "ack" && value.id !== 0) send(value);
      });
      anchor.once("error", error => { result = { code: null, signal: null, error: error.message }; });
      anchor.once("exit", () => {
        pipeDeadline = setTimeout(() => {
          if (!anchor!.stdout?.readableEnded || !anchor!.stderr?.readableEnded)
            result = { code: null, signal: null, error: "Supervisor output remained open after exit." };
          anchor!.stdout?.destroy(); anchor!.stderr?.destroy();
        }, launch!.graceMs);
      });
      anchor.once("close", () => {
        if (pipeDeadline) clearTimeout(pipeDeadline);
        send({ type: "result", result: result ?? { code: null, signal: null, error: "Process group supervisor ended unexpectedly." } });
        if (process.connected) process.disconnect?.();
      });
      anchor.send({ type: "launch", launch }, error => { if (error) stop(); });
      return;
    }
    if (!["pause", "resume", "cancel"].includes(message?.type) || !Number.isSafeInteger(message.id)) return;
    if (!anchor?.connected || stopping || result) {
      send({ type: "ack", id: message.id, error: "The owned process group is not active." });
      return;
    }
    anchor.send(message, error => { if (error) send({ type: "ack", id: message.id, error: error.message }); });
  });
}

function lifecycleOwner() {
  let leader: ChildProcess | undefined;
  let launch: Launch | undefined;
  let result: Result | undefined;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let pipeDeadline: NodeJS.Timeout | undefined;
  const send = (message: Message) => { if (process.connected) process.send?.(message, () => {}); };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!leader?.pid || leader.exitCode !== null || leader.signalCode !== null)
      throw new Error("The owned process group is no longer live.");
    // The lifecycle owner owns this unreaped leader and is never part of its group.
    process.kill(-leader.pid, signal);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!leader) { process.exitCode = 1; if (process.connected) process.disconnect?.(); return; }
    try { signalGroup("SIGTERM"); signalGroup("SIGCONT"); }
    catch { result = { code: null, signal: null, error: "Owned group termination could not be requested." }; }
    timer = setTimeout(() => {
      try { signalGroup("SIGKILL"); }
      catch { result ??= { code: null, signal: null, error: "Owned group escalation could not be requested." }; }
    }, launch!.graceMs);
  };
  process.on("disconnect", stop);
  process.stdout.on("error", stop);
  process.stderr.on("error", stop);
  process.on("message", (message: Message) => {
    if (message?.type === "launch" && message.launch && !launch && !stopping) {
      launch = message.launch;
      leader = spawn(process.execPath, [modulePath, "--leader"], {
        detached: true, env: {}, stdio: [launch.stdin ? "pipe" : "ignore", "pipe", "pipe", "ipc",
          ...(launch.pinned ? [4, 5] as const : [])],
      });
      if (launch.stdin) process.stdin.pipe(leader.stdin!);
      leader.stdout!.pipe(process.stdout);
      leader.stderr!.pipe(process.stderr);
      leader.on("message", (value: Message) => {
        if (value?.type !== "result" || !value.result || result) return;
        result = value.result;
        try { signalGroup("SIGKILL"); }
        catch { result = { code: null, signal: null, error: "Owned group cleanup could not be requested." }; }
      });
      leader.once("error", error => { result = { code: null, signal: null, error: error.message, notStarted: true }; });
      leader.once("exit", () => {
        pipeDeadline = setTimeout(() => {
          if (!leader!.stdout?.readableEnded || !leader!.stderr?.readableEnded)
            result = { code: null, signal: null, error: "Process group output remained open after leader exit." };
          leader!.stdout?.destroy(); leader!.stderr?.destroy();
        }, launch!.graceMs);
      });
      leader.once("close", () => {
        if (timer) clearTimeout(timer);
        if (pipeDeadline) clearTimeout(pipeDeadline);
        send({ type: "result", result: result ?? { code: null, signal: null, error: "Process group leader ended unexpectedly." } });
        if (process.connected) process.disconnect?.();
      });
      leader.send({ type: "launch", launch }, error => { if (error) stop(); });
      return;
    }
    if (!["pause", "resume", "cancel"].includes(message?.type) || !Number.isSafeInteger(message.id)) return;
    try {
      if (!leader || stopping || result) throw new Error("The owned process group is not active.");
      if (message.type === "cancel") stop();
      else signalGroup(message.type === "pause" ? "SIGSTOP" : "SIGCONT");
      send({ type: "ack", id: message.id });
    } catch (error) { send({ type: "ack", id: message.id, error: (error as Error).message }); }
  });
}

function leader() {
  process.on("SIGTERM", () => {});
  let graceMs = 100;
  process.on("disconnect", () => {
    try { process.kill(-process.pid, "SIGTERM"); process.kill(-process.pid, "SIGCONT"); } catch { /* No live group. */ }
    setTimeout(() => {
      try { process.kill(-process.pid, "SIGKILL"); } catch { /* No live group. */ }
    }, graceMs);
  });
  process.on("message", (message: Message) => {
    if (message?.type !== "launch" || !message.launch) return;
    const { executable, args, cwd, env, stdin, pinned } = message.launch;
    graceMs = message.launch.graceMs;
    const child = spawn(pinned ? "/proc/self/fd/4" : executable, args, { cwd: pinned ? "/proc/self/fd/5" : cwd, env, shell: false,
      stdio: [stdin ? "pipe" : "ignore", "inherit", "inherit", ...(pinned ? ["ignore", 4, 5] as const : [])] });
    if (stdin) process.stdin.pipe(child.stdin!);
    child.once("error", error => process.send?.({ type: "result", result: { code: null, signal: null, error: error.message, notStarted: true } }));
    child.once("exit", (code, signal) => process.send?.({ type: "result", result: { code, signal } }));
  });
}

if (process.argv[1] === modulePath && process.argv[2] === "--guardian") relay("--anchor");
if (process.argv[1] === modulePath && process.argv[2] === "--anchor") relay("--owner");
if (process.argv[1] === modulePath && process.argv[2] === "--owner") lifecycleOwner();
if (process.argv[1] === modulePath && process.argv[2] === "--leader") leader();
