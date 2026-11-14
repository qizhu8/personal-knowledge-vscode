import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EnvironmentQueryTrace } from "./ordinary-environment-owner";

const supervisor = `
import base64,ctypes,json,os,selectors,signal,subprocess,sys
nonce,limit,program=sys.argv[1:4]
limit=int(limit)
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(36,1,0,0,0)!=0 or libc.prctl(4,0,0,0,0)!=0 or libc.prctl(38,1,0,0,0)!=0:
 sys.exit(125)
class Header(ctypes.Structure):
 _fields_=[("version",ctypes.c_uint32),("pid",ctypes.c_int)]
class Data(ctypes.Structure):
 _fields_=[("effective",ctypes.c_uint32),("permitted",ctypes.c_uint32),("inheritable",ctypes.c_uint32)]
if libc.capset(ctypes.byref(Header(0x20080522,0)),(Data*2)())!=0:
 sys.exit(125)
child=None
def terminate(_signal,_frame):
 if child is not None:
  try: os.kill(child.pid,signal.SIGTERM)
  except ProcessLookupError: pass
signal.signal(signal.SIGTERM,terminate)
try:
 child=subprocess.Popen([program]+sys.argv[4:],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
except Exception:
 sys.exit(125)
pid=child.pid
selector=selectors.DefaultSelector()
selector.register(child.stdout,selectors.EVENT_READ,"stdout")
selector.register(child.stderr,selectors.EVENT_READ,"stderr")
buffers={"stdout":bytearray(),"stderr":bytearray()}
overflow=False
while selector.get_map():
 for key,_events in selector.select():
  chunk=os.read(key.fileobj.fileno(),65536)
  if not chunk:
   selector.unregister(key.fileobj)
   key.fileobj.close()
   continue
  buffer=buffers[key.data]
  available=max(0,limit-len(buffer))
  buffer.extend(chunk[:available])
  if len(chunk)>available:
   overflow=True
   terminate(signal.SIGTERM,None)
code=None
while True:
 try: reaped,status=os.waitpid(-1,0)
 except InterruptedError: continue
 except ChildProcessError: break
 if reaped==pid:
  code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
  child=None
if code is None:
 sys.exit(125)
print(json.dumps({"nonce":nonce,"phase":"drained","managerPid":pid,"managerCode":code,"overflow":overflow,
 "stdout":base64.b64encode(buffers["stdout"]).decode("ascii"),
 "stderr":base64.b64encode(buffers["stderr"]).decode("ascii")}),flush=True)
`;

export interface PreparedLinuxEnvironmentQuery { readonly kind: "pkm.prepared-environment-query/v1" }
export interface ReservedLinuxEnvironmentLaunch { readonly kind: "pkm.reserved-environment-launch/v1" }
export interface LinuxEnvironmentDrainBinding {
  workspaceId: string; knowledgeRoot: string; globalStorageDirectory: string; requestId: string;
  environmentId: string; probe: EnvironmentQueryTrace["kind"];
}
export interface LinuxEnvironmentDrainProof extends LinuxEnvironmentDrainBinding {
  readonly kind: "pkm.environment-physical-drain/v1";
  readonly rootPin: string;
  readonly profilePin: string;
  readonly supervisorPid: number;
  readonly managerPid: number;
  readonly managerCode: number;
}
type Prepared = {
  trace: Readonly<EnvironmentQueryTrace>;
  python: string;
  args: readonly string[];
  nonce: string;
  timeoutMs: number;
  maxBuffer: number;
  pythonPin: string;
  rootPin: string;
  profilePin: string;
  started: boolean;
  reserved: boolean;
};
const preparedQueries = new WeakMap<PreparedLinuxEnvironmentQuery, Prepared>();
const reservations = new WeakMap<ReservedLinuxEnvironmentLaunch, PreparedLinuxEnvironmentQuery>();
const drainProofs = new WeakMap<LinuxEnvironmentDrainProof, PreparedLinuxEnvironmentQuery>();
const executions = new WeakMap<ChildProcess, {
  trace: Readonly<EnvironmentQueryTrace>; proof?: LinuxEnvironmentDrainProof;
}>();
function identity(filename: string): string {
  const stat = fs.statSync(filename, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function directoryPin(directory: string): string {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
    throw new Error("Environment supervisor requires canonical Root/profile directories.");
  return `${stat.dev}:${stat.ino}`;
}

/** Pure preparation; the actual helper/manager spawn still requires an independent execution fence. */
export function prepareLinuxEnvironmentQuery(trace: Readonly<EnvironmentQueryTrace>, options: {
  python: string; timeoutMs: number; maxBuffer: number;
}): PreparedLinuxEnvironmentQuery {
  if (process.platform !== "linux" || !path.isAbsolute(options.python)
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
    || !Number.isSafeInteger(options.maxBuffer) || options.maxBuffer <= 0 || options.maxBuffer > 16_777_216)
    throw new Error("A bounded installed Linux supervisor interpreter is required.");
  const python = fs.realpathSync(options.python), stat = fs.statSync(python);
  if (!stat.isFile() || stat.mode & 0o022) throw new Error("Supervisor interpreter is not a protected regular executable.");
  fs.accessSync(python, fs.constants.X_OK);
  const nonce = randomUUID(), args = Object.freeze(["-I", "-B", "-c", supervisor, nonce,
    String(options.maxBuffer), trace.program, ...trace.args]);
  const intent = Object.freeze({ ...trace.intent,
    environments: Object.freeze(trace.intent.environments.map(entry => Object.freeze({ ...entry }))) });
  const snapshot = Object.freeze({ ...trace, intent, args: Object.freeze([...trace.args]), environment: Object.freeze({ ...trace.environment }),
    launch: Object.freeze({ program: python, args }) });
  const token = Object.freeze({ kind: "pkm.prepared-environment-query/v1" as const });
  preparedQueries.set(token, { trace: snapshot, python, args, nonce, timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer, pythonPin: identity(python), rootPin: directoryPin(trace.intent.knowledgeRoot),
    profilePin: directoryPin(trace.intent.globalStorageDirectory), started: false, reserved: false });
  return token;
}

export function describePreparedLinuxEnvironmentQuery(prepared: PreparedLinuxEnvironmentQuery): Readonly<EnvironmentQueryTrace> {
  const entry = preparedQueries.get(prepared);
  if (!entry || entry.started) throw new Error("Prepared Environment query is invalid or consumed.");
  return entry.trace;
}

export function describePreparedLinuxEnvironmentPins(prepared: PreparedLinuxEnvironmentQuery): Readonly<{ rootPin: string; profilePin: string }> {
  const entry = preparedQueries.get(prepared);
  if (!entry || entry.started) throw new Error("Prepared Environment query is invalid or consumed.");
  return Object.freeze({ rootPin: entry.rootPin, profilePin: entry.profilePin });
}

/** Reserve before exposing the prepared token to registration callbacks; they cannot start it. */
export function reservePreparedLinuxEnvironmentQuery(prepared: PreparedLinuxEnvironmentQuery): ReservedLinuxEnvironmentLaunch {
  const entry = preparedQueries.get(prepared);
  if (!entry || entry.started || entry.reserved) throw new Error("Prepared Environment launch is already reserved or consumed.");
  entry.reserved = true;
  const reservation = Object.freeze({ kind: "pkm.reserved-environment-launch/v1" as const });
  reservations.set(reservation, prepared);
  return reservation;
}

/** Call only after independently authorizing and registering describePrepared's actual descriptor. */
export function startPreparedLinuxEnvironmentQuery(prepared: PreparedLinuxEnvironmentQuery, reservation: ReservedLinuxEnvironmentLaunch) {
  const entry = preparedQueries.get(prepared);
  if (!entry || entry.started || reservations.get(reservation) !== prepared || identity(entry.python) !== entry.pythonPin)
    throw new Error("Prepared Environment query is invalid, consumed or its interpreter changed.");
  entry.started = true;
  let settle: (error: Error | undefined, stdout: string) => void;
  const result = new Promise<string>((resolve, reject) => {
    settle = (error, stdout) => error ? reject(error) : resolve(stdout);
  });
  let settled = false;
  const finish = (error: Error | undefined, stdout = "") => {
    if (settled) return;
    settled = true; clearTimeout(timer); settle(error, stdout);
  };
  const child = execFile(entry.python, [...entry.args], {
    env: entry.trace.environment, maxBuffer: entry.maxBuffer * 3 + 8192, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error || child.exitCode !== 0) {
      finish(new Error(`UNKNOWN: Environment supervisor exited without physical drain proof: ${error?.message || stderr}`));
      return;
    }
    try {
      const value = JSON.parse(stdout);
      if (value.nonce !== entry.nonce || value.phase !== "drained" || !Number.isSafeInteger(value.managerPid)
        || value.managerPid <= 0 || !Number.isSafeInteger(value.managerCode) || typeof value.overflow !== "boolean"
        || typeof value.stdout !== "string" || typeof value.stderr !== "string")
        throw new Error("Malformed Environment supervisor completion.");
      const out = Buffer.from(value.stdout, "base64"), err = Buffer.from(value.stderr, "base64");
      if (out.length > entry.maxBuffer || err.length > entry.maxBuffer) throw new Error("Supervisor output exceeded its bound.");
      const proof = Object.freeze({ kind: "pkm.environment-physical-drain/v1" as const,
        workspaceId: entry.trace.intent.workspaceId, knowledgeRoot: entry.trace.intent.knowledgeRoot,
        globalStorageDirectory: entry.trace.intent.globalStorageDirectory, requestId: entry.trace.intent.requestId,
        environmentId: entry.trace.environmentId, probe: entry.trace.kind, rootPin: entry.rootPin,
        profilePin: entry.profilePin, supervisorPid: child.pid!, managerPid: value.managerPid, managerCode: value.managerCode });
      drainProofs.set(proof, prepared); executions.get(child)!.proof = proof;
      if (value.overflow) finish(new Error("Environment query output exceeded its bound."));
      else if (value.managerCode !== 0) finish(new Error(`Environment query exited with status ${value.managerCode}: ${err.toString("utf8")}`));
      else finish(undefined, out.toString("utf8"));
    } catch (failure) { finish(new Error(`UNKNOWN: ${failure instanceof Error ? failure.message : String(failure)}`)); }
  });
  executions.set(child, { trace: entry.trace });
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(new Error("UNKNOWN: Environment supervisor timed out; its descendants may still be running."));
  }, entry.timeoutMs);
  return { child, trace: entry.trace, result };
}

/** Proof remains available after intent/host revocation; UNKNOWN is never manufactured into completion. */
export function environmentDrainProof(child: ChildProcess, trace: Readonly<EnvironmentQueryTrace>): LinuxEnvironmentDrainProof {
  const entry = executions.get(child);
  if (!entry || !isDeepStrictEqual(entry.trace, trace) || !entry.proof)
    throw new Error("UNKNOWN: Environment child has no verified physical drain proof.");
  return entry.proof;
}

export function assertLinuxEnvironmentDrainProof(proof: LinuxEnvironmentDrainProof, binding: LinuxEnvironmentDrainBinding): void {
  if (!drainProofs.has(proof) || !isDeepStrictEqual({ workspaceId: proof.workspaceId, knowledgeRoot: proof.knowledgeRoot,
    globalStorageDirectory: proof.globalStorageDirectory, requestId: proof.requestId,
    environmentId: proof.environmentId, probe: proof.probe }, binding))
    throw new Error("Environment physical drain capability is invalid or belongs to another request.");
}

export function assertPreparedLinuxEnvironmentDrainProof(proof: LinuxEnvironmentDrainProof, prepared: PreparedLinuxEnvironmentQuery): void {
  const entry = preparedQueries.get(prepared);
  if (!entry || !entry.started || drainProofs.get(proof) !== prepared
    || proof.rootPin !== entry.rootPin || proof.profilePin !== entry.profilePin
    || directoryPin(entry.trace.intent.knowledgeRoot) !== entry.rootPin
    || directoryPin(entry.trace.intent.globalStorageDirectory) !== entry.profilePin)
    throw new Error("Physical drain proof is not for this exact prepared launch or its Root/profile directories changed.");
}
