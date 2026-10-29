import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { spawn, execFile } from "child_process";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";

export const processOutputLimit = 64 * 1024 * 1024;
export interface ChatProcessSpec { program: string; arguments: string[]; cwd: string; timeoutSeconds: number; }
export interface ChatProcessRecord {
  schema: "pkm.chat.process/v1";
  handle: string;
  spec: ChatProcessSpec;
  state: "launching" | "running" | "complete" | "failed" | "cancelled" | "timed-out" | "output-limit" | "unknown";
  createdAt: number;
  updatedAt: number;
  runnerPid?: number;
  childPid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  detail?: string;
}

export function isChatProcessRecord(value: unknown): value is ChatProcessRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChatProcessRecord>, spec = record.spec;
  return record.schema === "pkm.chat.process/v1" && typeof record.handle === "string" && /^process_[a-f0-9]{64}$/.test(record.handle)
    && typeof record.state === "string" && ["launching", "running", "complete", "failed", "cancelled", "timed-out", "output-limit", "unknown"].includes(record.state)
    && typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
    && typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
    && typeof record.stdoutBytes === "number" && Number.isSafeInteger(record.stdoutBytes) && record.stdoutBytes >= 0
    && typeof record.stderrBytes === "number" && Number.isSafeInteger(record.stderrBytes) && record.stderrBytes >= 0
    && !!spec && typeof spec.program === "string" && !!spec.program && !spec.program.includes("\0") && spec.program.length <= 1024
    && Array.isArray(spec.arguments) && spec.arguments.length <= 32 && spec.arguments.every(argument => typeof argument === "string" && !argument.includes("\0"))
    && JSON.stringify(spec.arguments).length <= 8000 && typeof spec.cwd === "string" && path.isAbsolute(spec.cwd)
    && Number.isSafeInteger(spec.timeoutSeconds) && spec.timeoutSeconds >= 1 && spec.timeoutSeconds <= 86400;
}

export function chatProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function processDirectory(root: string, handle: string): string {
  if (!/^process_[a-f0-9]{64}$/.test(handle)) throw new Error("Choose an exact process handle returned by run_process.");
  const directory = path.join(root, "processes", handle);
  for (const candidate of [root, path.join(root, "processes"), directory]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Process evidence directories cannot be symbolic links or files.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return directory;
}

export function writeChatProcessRecord(directory: string, record: ChatProcessRecord): void {
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Windows briefly denies replacing a file that a reader, indexer or antivirus has open.
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, path.join(directory, "record.json")); break; }
      catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code || "") || attempt >= 9) throw error;
        Atomics.wait(waitArray, 0, 0, 20 * (attempt + 1));
      }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}

function loadRecord(directory: string): ChatProcessRecord {
  const file = path.join(directory, "record.json");
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 32000) throw new Error("Invalid process evidence record.");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isChatProcessRecord(value) || value.handle !== path.basename(directory)) {
    throw new Error("Invalid process evidence record; preserve it for recovery.");
  }
  return value;
}

export function getChatProcess(root: string, handle: string): ChatProcessRecord {
  const record = loadRecord(processDirectory(root, handle));
  if (["launching", "running"].includes(record.state) && Date.now() - record.updatedAt > 10000) {
    return { ...record, state: "unknown", detail: "The process supervisor heartbeat is stale. Execution may still have effects; do not relaunch or signal a historical PID." };
  }
  return record;
}

export async function launchChatProcess(root: string, key: string, spec: ChatProcessSpec): Promise<ChatProcessRecord> {
  if (typeof key !== "string" || !key.trim() || key.length > 200) throw new Error("Background execution requires an explicit idempotency_key of 1-200 characters; reuse it only for the same invocation.");
  if (!spec.program || spec.program.includes("\0") || spec.program.length > 1024 || !Array.isArray(spec.arguments)
    || spec.arguments.length > 32 || spec.arguments.some(item => typeof item !== "string" || item.includes("\0"))
    || JSON.stringify(spec.arguments).length > 8000 || !path.isAbsolute(spec.cwd)
    || !Number.isSafeInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 86400) {
    throw new Error("Invalid background process specification; choose an absolute working directory and a 1-86400 second deadline.");
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(spec.program)) throw new Error("Use a native executable instead of a Windows batch wrapper.");
  const handle = "process_" + createHash("sha256").update(key).digest("hex");
  const directory = processDirectory(root, handle);
  const created = withCrossProcessLockSync(path.join(root, "processes.lock"), "background process launch", () => {
    if (fs.existsSync(path.join(directory, "record.json"))) {
      const record = loadRecord(directory);
      if (JSON.stringify(record.spec) !== JSON.stringify(spec)) throw new Error("This idempotency key already belongs to different process inputs. No process was launched.");
      return false;
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeChatProcessRecord(directory, { schema: "pkm.chat.process/v1", handle, spec, state: "launching",
      createdAt: Date.now(), updatedAt: Date.now(), stdoutBytes: 0, stderrBytes: 0 });
    return true;
  });
  if (created) {
    const worker = spawn(process.execPath, [path.join(__dirname, "chat-process-runtime.js"), "--pkm-process-worker", directory], {
      detached: true, windowsHide: true, stdio: "ignore", env: { ...chatProcessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", error => reject(new Error(`Cannot start the background supervisor: ${error.message}. The original handle remains; do not blindly relaunch.`)));
    });
    worker.unref();
  }
  return getChatProcess(root, handle);
}

export function cancelChatProcess(root: string, handle: string): ChatProcessRecord {
  const directory = processDirectory(root, handle);
  const record = getChatProcess(root, handle);
  if (!["launching", "running"].includes(record.state)) {
    if (record.state === "unknown") throw new Error(record.detail);
    return record;
  }
  const marker = path.join(directory, "cancel");
  try { fs.writeFileSync(marker, "Cancellation requested by the owning Chat.\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { ...record, detail: "Cancellation requested; completion is not yet confirmed. Query the same handle." };
}

/** Requests cancellation of every launching/running process under one Chat's evidence root. */
export function cancelAllChatProcesses(root: string, startedBefore = Infinity): { cancelled: string[]; errors: string[] } {
  const cancelled: string[] = []; const errors: string[] = [];
  let handles: string[];
  try { handles = fs.readdirSync(path.join(root, "processes")).filter(name => /^process_[a-f0-9]{64}$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cancelled, errors }; throw error; }
  for (const handle of handles) {
    try {
      const record = getChatProcess(root, handle);
      if (record.createdAt > startedBefore) continue;
      if (record.state === "unknown") throw new Error(record.detail || "Process termination cannot be confirmed.");
      if (!["launching", "running"].includes(record.state)) continue;
      cancelChatProcess(root, handle); cancelled.push(handle);
    } catch (error) { errors.push(`${handle}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { cancelled, errors };
}

export function readChatProcessOutput(root: string, handle: string, stream: "stdout" | "stderr", start: number, length: number) {
  if (!["stdout", "stderr"].includes(stream) || !Number.isSafeInteger(start) || start < 0
    || !Number.isSafeInteger(length) || length < 1 || length > 12000) throw new Error("Choose stdout/stderr, a non-negative byte offset and 1-12000 bytes.");
  const foreground = /^foreground_(\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(handle);
  if (foreground) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Process evidence directories cannot be symbolic links or files.");
  }
  const directory = foreground ? root : processDirectory(root, handle);
  const record = foreground ? { state:"foreground-log" } : getChatProcess(root, handle);
  const filename = path.join(directory, foreground ? `${foreground[1]}.${stream}.log` : `${stream}.log`);
  let fd: number;
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("Process output cannot be a symbolic link.");
    fd = fs.openSync(filename, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !["launching", "cancelled"].includes(record.state)) throw error;
    return { handle, stream, start, end: start, availableBytes: 0, text: "", state: record.state, pending: true };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (start > size) throw new Error("Output byte offset is beyond the currently available evidence.");
    const buffer = Buffer.alloc(Math.min(length, size - start));
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const result = (bytes: number) => ({ handle, stream, start, end: start + bytes, availableBytes: size, text: buffer.subarray(0, bytes).toString("utf8"),
      state: record.state, more: start + bytes < size, encoding: "utf8",
      note: "Offsets are bytes; ranges may be shortened to fit the tool-result envelope. A split UTF-8 boundary may display a replacement character. Full bytes remain in the local log." });
    let bytes = read;
    while (JSON.stringify(result(bytes)).length > 15000 && bytes > 0) bytes = Math.floor(bytes / 2);
    return result(bytes);
  } finally { fs.closeSync(fd); }
}

async function supervise(directory: string): Promise<void> {
  let record = withCrossProcessLockSync(path.join(directory, "claim.lock"), "background supervisor claim", () => {
    const current = loadRecord(directory);
    if (current.state !== "launching" || current.runnerPid !== undefined) throw new Error("The original supervisor already claimed this process. Refusing duplicate launch.");
    const claimed = { ...current, runnerPid: process.pid, updatedAt: Date.now() };
    writeChatProcessRecord(directory, claimed);
    return claimed;
  });
  if (fs.existsSync(path.join(directory, "cancel"))) {
    writeChatProcessRecord(directory, { ...record, state: "cancelled", updatedAt: Date.now(), detail: "Cancelled before program launch; no program was started." });
    return;
  }
  const stdout = fs.openSync(path.join(directory, "stdout.log"), "wx", 0o600);
  let stderr: number;
  try { stderr = fs.openSync(path.join(directory, "stderr.log"), "wx", 0o600); }
  catch (error) { fs.closeSync(stdout); throw error; }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(record.spec.program, record.spec.arguments, { cwd: record.spec.cwd, env: chatProcessEnvironment(),
        shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stopping: ChatProcessRecord["state"] | undefined;
      let termination: Promise<void> | undefined;
      let completed = false;
      const persist = () => { record.updatedAt = Date.now(); writeChatProcessRecord(directory, record); };
      const stop = (state: ChatProcessRecord["state"], detail: string) => {
        if (stopping || completed) return;
        stopping = state;
        record.detail = detail;
        if (!child.pid) return;
        if (process.platform === "win32") {
          termination = new Promise(resolve => execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, error => {
              if (error) { stopping = record.state = "unknown"; record.detail += ` Process-tree termination could not be confirmed: ${error.message}`; }
              resolve();
            }));
        } else {
          const kill = (signal: NodeJS.Signals) => {
            try { process.kill(-child.pid!, signal); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                stopping = record.state = "unknown";
                record.detail += ` Process-tree termination was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
              }
            }
          };
          kill("SIGTERM");
          termination = new Promise(resolve => setTimeout(() => { kill("SIGKILL"); resolve(); }, 1000));
        }
      };
      const started = Date.now();
      let heartbeatFailures = 0;
      const heartbeat = setInterval(() => {
        try {
          persist();
          heartbeatFailures = 0;
          if (fs.existsSync(path.join(directory, "cancel"))) stop("cancelled", "Explicit process cancellation requested.");
          else if (Date.now() - started >= record.spec.timeoutSeconds * 1000) stop("timed-out", "Approved process deadline reached.");
        } catch (error) {
          if (++heartbeatFailures >= 5) stop("unknown", `Supervisor evidence failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 200);
      const append = (chunk: Buffer, error: boolean) => {
        try {
          const total = record.stdoutBytes + record.stderrBytes;
          const bytes = chunk.subarray(0, Math.max(0, processOutputLimit - total));
          for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(error ? stderr : stdout, bytes, offset, bytes.length - offset);
          if (error) record.stderrBytes += bytes.length; else record.stdoutBytes += bytes.length;
          if (chunk.length > bytes.length) stop("output-limit", "Combined stdout/stderr reached the separate 64 MiB storage limit; model-visible output size did not cause termination.");
        } catch (error) { stop("unknown", `Output persistence failed: ${error instanceof Error ? error.message : String(error)}`); }
      };
      child.stdout.on("data", chunk => append(chunk, false));
      child.stderr.on("data", chunk => append(chunk, true));
      child.once("spawn", () => {
        record.state = "running"; record.childPid = child.pid;
        try { persist(); } catch (error) { stop("unknown", `Launch receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`); }
      });
      child.once("error", error => { record.detail = `Program launch failed: ${error.message}`; stopping = "failed"; });
      child.once("close", async (code, signal) => {
        completed = true; clearInterval(heartbeat);
        try {
          await termination;
          record.state = stopping || (code === 0 ? "complete" : "failed");
          record.exitCode = code; record.exitSignal = signal;
          fs.fsyncSync(stdout); fs.fsyncSync(stderr); persist(); resolve();
        } catch (error) { reject(error); }
      });
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
}

if (require.main === module && process.argv[2] === "--pkm-process-worker") {
  const directory = process.argv[3];
  void supervise(directory).catch(error => {
    try {
      const record = loadRecord(directory);
      if (record.runnerPid === process.pid) writeChatProcessRecord(directory, { ...record, state: "unknown", updatedAt: Date.now(),
        detail: `Supervisor failed; execution may have effects. ${error instanceof Error ? error.message : String(error)}` });
    } finally { process.exitCode = 1; }
  });
}
