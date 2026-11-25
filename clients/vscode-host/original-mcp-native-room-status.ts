import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { originalNativeRoomStatusArguments } from "../../src/original-mcp-native-room-contracts.js";

const originalTemplateSha256 = "0834131c634962e3526540eac35fdba35beb28cefa6de1f17dce8ac586e4a722";
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function retainedBytes(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes
    || realpathSync(path) !== path) fail("NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const pin = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(":");
  try {
    if (pin(fstatSync(descriptor)) !== pin(before)) fail("NATIVE_ROOM_STATUS_PRODUCER_CHANGED");
    const bytes = readFileSync(descriptor);
    if (pin(fstatSync(descriptor)) !== pin(before) || pin(lstatSync(path)) !== pin(before))
      fail("NATIVE_ROOM_STATUS_PRODUCER_CHANGED");
    return bytes;
  } finally { closeSync(descriptor); }
}

// Execute the actual pinned producer, not reconstructed JSON or a mock connection.
// Only chat_status is callable; writes, sockets and subprocesses are denied in its process.
const bootstrap = String.raw`
import asyncio, contextlib, hashlib, json, os, runpy, sys
directory, template_hash, guard_hash = sys.argv[1:]
raw = sys.stdin.buffer.read(65537)
if len(raw) > 65536:
    raise RuntimeError("status request exceeds its bound")
request = json.loads(raw)
if not isinstance(request, dict) or set(request) - {"name"} or not isinstance(request.get("name", ""), str):
    raise RuntimeError("invalid status request")
def audit(event, arguments):
    if event == "open":
        mode = arguments[1]
        flags = arguments[2]
        if isinstance(mode, str) and any(value in mode for value in "wax+") or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            raise RuntimeError("native Room status is read only")
    if event.startswith("socket.") and not (event == "socket.__new__" and arguments[1] == 1):
        raise RuntimeError("native Room status cannot use a network")
    if event.startswith(("subprocess.", "os.exec", "os.spawn")) or event in {
        "os.system", "os.fork", "os.forkpty", "os.mkdir", "os.remove", "os.rmdir", "os.rename",
        "os.link", "os.symlink", "os.chmod", "os.chown", "os.truncate", "os.utime"}:
        raise RuntimeError("native Room status cannot create a writer, network or child process")
sys.addaudithook(audit)
for name, expected in (("chat_server.py.template", template_hash), ("mcp_call_guard.py", guard_hash)):
    with open(os.path.join(directory, name), "rb") as source:
        if hashlib.sha256(source.read()).hexdigest() != expected:
            raise RuntimeError("retained Room producer changed")
sys.path.insert(0, directory)
with contextlib.redirect_stdout(sys.stderr):
    module = runpy.run_path(os.path.join(directory, "chat_server.py.template"), run_name="pkm_native_room_status")
    if module.get("_connections") != {}:
        raise RuntimeError("status-only producer must not invent or restore a joined client")
    method = module["chat_status"]
    method = getattr(method, "fn", method)
    result = asyncio.run(method(name=request.get("name", "")))
if not isinstance(result, str):
    raise RuntimeError("original Room status returned a non-string")
sys.stdout.write(json.dumps({"result": result}, ensure_ascii=True))
`;

function resources(extensionPath: string) {
  if (typeof extensionPath !== "string") fail("NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE");
  const directory = join(extensionPath, "next-runtime/server/legacy/resources");
  const manifestPath = join(extensionPath, "next-runtime/manifest.json");
  let template: Buffer, manifest: Buffer, guard: Buffer, guardSha256: string;
  try {
    template = retainedBytes(join(directory, "chat_server.py.template"), 131072);
    guard = retainedBytes(join(directory, "mcp_call_guard.py"), 262144);
    manifest = retainedBytes(manifestPath, 16777216);
    const parsed = z.object({ files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(JSON.parse(manifest.toString("utf8")));
    guardSha256 = hash(guard);
    if (hash(template) !== originalTemplateSha256
      || parsed.files["server/legacy/resources/chat_server.py.template"] !== originalTemplateSha256
      || parsed.files["server/legacy/resources/mcp_call_guard.py"] !== guardSha256)
      fail("NATIVE_ROOM_STATUS_PRODUCER_CHANGED");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("NATIVE_ROOM_")) throw error;
    fail("NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE");
  }
  return { directory, manifestPath, template, manifest, guard, guardSha256 };
}
export function originalMcpNativeRoomStatusAvailable(extensionPath: string): boolean {
  try { resources(extensionPath); return true; } catch { return false; }
}

/** Native-only exact original status producer. It receives no root path or credential bytes. */
export async function readOriginalMcpNativeRoomStatus(extensionPath: string, input: unknown, signal: AbortSignal) {
  const args = originalNativeRoomStatusArguments.parse(input);
  if (signal.aborted) fail("NATIVE_ROOM_CANCELLED");
  const { directory, manifestPath, template, manifest, guard, guardSha256 } = resources(extensionPath);
  const timeout = AbortSignal.timeout(15000), combined = AbortSignal.any([signal, timeout]);
  const result = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("python3", ["-I", "-B", "-u", "-c", bootstrap, directory, originalTemplateSha256, guardSha256],
      { cwd: directory, stdio: ["pipe", "pipe", "pipe"], signal: combined,
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" } });
    const stdout: Buffer[] = [];
    let bytes = 0, oversized = false, launchError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) { oversized = true; child.kill("SIGTERM"); return; }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", error => { launchError = error; });
    child.once("close", code => {
      if (combined.aborted) reject(Object.assign(new Error("NATIVE_ROOM_CANCELLED"), { code: "NATIVE_ROOM_CANCELLED" }));
      else if (launchError) reject(Object.assign(new Error("NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE"),
        { code: "NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE", cause: launchError }));
      else if (oversized) reject(Object.assign(new Error("NATIVE_ROOM_STATUS_RESULT_TOO_LARGE"), { code: "NATIVE_ROOM_STATUS_RESULT_TOO_LARGE" }));
      else if (code !== 0) reject(Object.assign(new Error("NATIVE_ROOM_STATUS_PRODUCER_FAILED"), { code: "NATIVE_ROOM_STATUS_PRODUCER_FAILED" }));
      else resolve(Buffer.concat(stdout));
    });
    child.stdin.end(JSON.stringify(args));
  });
  if (combined.aborted) fail("NATIVE_ROOM_CANCELLED");
  if (!retainedBytes(manifestPath, 16777216).equals(manifest)
    || !retainedBytes(join(directory, "chat_server.py.template"), 131072).equals(template)
    || !retainedBytes(join(directory, "mcp_call_guard.py"), 262144).equals(guard))
    fail("NATIVE_ROOM_STATUS_PRODUCER_CHANGED");
  return Object.freeze(z.strictObject({ result: z.string().max(65536) }).parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result))));
}
