import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

// Implements the original Python helper signature and --invoke entry point. The socket
// is private host transport; the Action author continues to call the original API.
const helper = `import json, os, socket, sys

def invoke_from_environment(action_id, inputs, key):
    context = json.loads(os.environ["PKM_ACTION_CONTEXT"])
    endpoint = json.loads(os.environ["PKM_ACTION_BRIDGE"])
    request = {"store": context["store"], "run_id": context["run_id"], "capability": context["capability"],
               "action_id": action_id, "inputs": inputs, "key": key}
    encoded = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\\n"
    if len(encoded) > 65536:
        raise ValueError("Nested Action request exceeds its limit.")
    with socket.create_connection(("127.0.0.1", endpoint["port"]), timeout=300) as connection:
        connection.settimeout(300)
        connection.sendall(encoded)
        response = bytearray()
        while len(response) <= 65536 and b"\\n" not in response:
            part = connection.recv(4096)
            if not part:
                break
            response.extend(part)
    if len(response) > 65536 or b"\\n" not in response:
        raise RuntimeError("Nested Action host response is unavailable.")
    result = json.loads(bytes(response).split(b"\\n", 1)[0].decode("utf-8"))
    if result.get("ok") is not True:
        raise RuntimeError(result.get("error", "Nested Action failed."))
    return result["output"]

if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--invoke":
        raise SystemExit("Use the managed --invoke entry.")
    print(json.dumps(invoke_from_environment(sys.argv[2], json.load(sys.stdin), sys.argv[3])))
`;
const helperSha256 = "48966561281e303a59fd2f6a1b4b6c0570c257471d5e5e978f934135df36a7b8";

export async function createActionProgramInvocation(options: {
  root: string; runId: string; signal: AbortSignal;
  invoke(request: { actionId: string; inputs: Record<string, unknown>; key: string }): Promise<Record<string, unknown>>;
}) {
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  if (hash(helper) !== helperSha256) throw new Error("Packaged Action invocation helper failed its source hash.");
  const root = realpathSync(options.root);
  if (root !== options.root) throw new Error("Action invocation workspace is not canonical.");
  const base = join(root, ".pkm-action-builds");
  try { mkdirSync(base, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(base) !== base || (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("Action invocation helper directory is unsafe.");
  const directory = join(base, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const filename = join(directory, "action_modules.py");
  try {
    const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, helper, "utf8"); } finally { closeSync(fd); }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const verify = () => {
    const value = lstatSync(filename), parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !value.isFile() || value.isSymbolicLink()
      || value.nlink !== 1 || value.size > 65536)
      throw new Error("Action invocation helper changed.");
    const check = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(check);
      if (actual.dev !== value.dev || actual.ino !== value.ino || actual.size !== value.size
        || hash(readFileSync(check)) !== helperSha256) throw new Error("Action invocation helper changed.");
    } finally { closeSync(check); }
  };
  try { verify(); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  const capability = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let closed = false, inFlight = false, invoked = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(300_000, () => socket.destroy());
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 65536) return socket.destroy();
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      void (async () => {
        const request: unknown = JSON.parse(data.slice(0, newline));
        if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid nested Action request.");
        const value = request as Record<string, unknown>;
        if (closed || options.signal.aborted || inFlight || invoked
          || Object.keys(value).sort().join(",") !== "action_id,capability,inputs,key,run_id,store"
          || value.store !== root || value.run_id !== options.runId || value.capability !== capability || value.action_id !== "core.artifact.copy"
          || typeof value.key !== "string" || value.key.length < 1 || value.key.length > 200
          || !value.inputs || typeof value.inputs !== "object" || Array.isArray(value.inputs))
          throw new Error("Nested Action invocation is unavailable or unauthorized.");
        inFlight = true;
        invoked = true;
        const output = await options.invoke({ actionId: value.action_id, inputs: value.inputs as Record<string, unknown>, key: value.key });
        if (closed || options.signal.aborted) throw new Error("Nested Action invocation was revoked.");
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, output })}\n`);
      })().catch(error => {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : "Nested Action failed." })}\n`);
      });
    });
  });
  server.on("error", () => { for (const socket of sockets) socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Nested Action endpoint is unavailable.");
  return {
    env: { PYTHONPATH: directory, PYTHONDONTWRITEBYTECODE: "1",
      PKM_ACTION_CONTEXT: JSON.stringify({ store: root, run_id: options.runId, capability }),
      PKM_ACTION_BRIDGE: JSON.stringify({ port: address.port }) },
    verify,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
