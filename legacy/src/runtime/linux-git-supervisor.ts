import { spawn, spawnSync } from "child_process";
import type { Readable } from "stream";
import * as path from "path";
import { legacyLinuxRootWriterChild } from "./linux-root-writer-fence";
import { beginManagedWriterOperation, currentManagedWriterRoot } from "./managed-writer-session";

const supervisor = `
import ctypes, json, os, signal, subprocess, sys
control = 3
node, module, root, registration = sys.argv[1:5]
git_args = sys.argv[5:]
os.set_inheritable(control, False)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    os.write(control, b'{"error":"subreaper-unavailable"}\\n')
    sys.exit(125)
child = None
def terminate(_signal, _frame):
    if child is not None:
        try: os.kill(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
signal.signal(signal.SIGTERM, terminate)
try:
    child = subprocess.Popen(git_args, close_fds=True)
except Exception as error:
    os.write(control, (json.dumps({"error": str(error)}) + "\\n").encode())
    sys.exit(125)
successful = True
while True:
    try: pid, status = os.waitpid(-1, 0)
    except InterruptedError: continue
    except ChildProcessError: break
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        successful = False
    if child is not None and pid == child.pid:
        child = None
        record = {"code": os.waitstatus_to_exitcode(status)}
        try: os.write(control, (json.dumps(record) + "\\n").encode())
        except BrokenPipeError: pass
        os.close(control)
        os.close(1)
        os.close(2)
if registration and successful:
    script = "require(process.argv[1]).completeManagedWriterOperation(process.argv[2],JSON.parse(process.argv[3]))"
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    try:
        subprocess.run([node, "-e", script, module, root, registration], env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30, check=True)
    except Exception:
        pass
`;

const capabilities = new Map<string, boolean>();

function supportsSubreaper(env: NodeJS.ProcessEnv): boolean {
  const key = env.PATH || "";
  const cached = capabilities.get(key);
  if (cached !== undefined) return cached;
  const probe = spawnSync("python3", ["-c",
    "import ctypes,sys; sys.exit(0 if ctypes.CDLL(None).prctl(36,1,0,0,0)==0 else 1)"],
  { env, stdio: "ignore", timeout: 5000 });
  const supported = !probe.error && probe.status === 0;
  capabilities.set(key, supported);
  return supported;
}

/** Returns undefined when this process has no enrolled writer scope or subreaper support. */
export function supervisedLegacyGit(
  args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; awaitDescendants?: boolean },
): Promise<{ stdout: string; stderr: string }> | undefined {
  if (process.platform !== "linux") return undefined;
  const root = currentManagedWriterRoot();
  const probe = legacyLinuxRootWriterChild("python3", []);
  if (probe.command !== "flock" || !supportsSubreaper(options.env)) {
    if (root) return Promise.reject(new Error("Managed Git cannot establish descendant supervision; no command was started."));
    return undefined;
  }
  const registration = root ? beginManagedWriterOperation(root, "github-sync") : undefined;
  const wrapped = legacyLinuxRootWriterChild("python3", ["-c", supervisor, process.execPath,
    path.join(__dirname, "managed-writer-session.js"), root || "", registration ? JSON.stringify(registration) : "", "git", ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as Readable;
    let stdout = "", stderr = "", controlData = "", status: number | undefined;
    let outEnded = false, errEnded = false, childClosed = false, finished = false;
    const release = () => {
      child.unref();
      for (const stream of [child.stdout, child.stderr, control]) {
        (stream as unknown as { unref?: () => void }).unref?.();
      }
    };
    const fail = (message: string, code: string | number | null, signal?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      release();
      const error = Object.assign(new Error(message), { code, signal, stdout, stderr });
      reject(error);
    };
    const finish = () => {
      if (finished || status === undefined || !outEnded || !errEnded || options.awaitDescendants && !childClosed) return;
      if (status !== 0) {
        fail(`git exited with status ${status}`, status < 0 ? null : status, status < 0 ? `signal ${-status}` : undefined);
        return;
      }
      finished = true;
      clearTimeout(timer);
      release();
      resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail("git timed out", null, "SIGTERM");
    }, options.timeout);
    child.once("error", error => fail(error.message, (error as NodeJS.ErrnoException).code || null));
    child.once("close", () => { childClosed = true; finish(); });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > options.maxBuffer) {
        child.kill("SIGTERM");
        fail("git stdout exceeded maxBuffer", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > options.maxBuffer) {
        child.kill("SIGTERM");
        fail("git stderr exceeded maxBuffer", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      }
    });
    child.stdout!.once("end", () => { outEnded = true; finish(); });
    child.stderr!.once("end", () => { errEnded = true; finish(); });
    control.on("data", chunk => {
      controlData += chunk.toString();
      if (controlData.length > 4096) { fail("Invalid Git supervisor result.", null); return; }
      if (!controlData.includes("\n")) return;
      try {
        const record = JSON.parse(controlData.slice(0, controlData.indexOf("\n")));
        if (!Number.isInteger(record.code)) throw new Error("Missing Git exit status");
        status = record.code;
        finish();
      } catch { fail("Git supervisor did not report a verified Git exit; outcome is unknown.", null); }
    });
    control.once("end", () => {
      if (status === undefined) fail("Git supervisor exited without a result; outcome is unknown.", null);
    });
  });
}
