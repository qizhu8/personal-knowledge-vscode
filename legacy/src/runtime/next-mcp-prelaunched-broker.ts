import { ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, Socket } from "node:net";
import { ownNextMcpStdio } from "./next-mcp-owned-stdio";

type Launch = { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string };

/** Explicit prelaunch for one owned connection; it is not a root-adoption authority. */
export function createPrelaunchedNextMcpBroker(options: {
  launch(): Launch;
  assertCurrent(): void;
  verifyOwnedDescendantsExited(child: ChildProcess): Promise<void>;
  onStderr?(bytes: Buffer): void;
  startupTimeoutMs?: number;
}) {
  const timeout = options.startupTimeoutMs ?? 30_000;
  if (process.platform !== "linux" || typeof options.launch !== "function" || typeof options.assertCurrent !== "function"
    || typeof options.verifyOwnedDescendantsExited !== "function"
    || options.onStderr !== undefined && typeof options.onStderr !== "function"
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error("Linux owner and bounded startup are required.");
  options.assertCurrent();
  const launch = options.launch(), nonce = randomBytes(32).toString("hex");
  const name = `pkm-next-${randomBytes(24).toString("hex")}`, token = randomBytes(32).toString("hex");
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd, env: { ...process.env, ...launch.env, PKM_NEXT_OWNER_READY_NONCE: nonce },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  if (!child.pid) {
    child.once("error", () => {});
    throw new Error("The owned Next MCP process could not be started.");
  }
  child.stderr?.on("data", (bytes: Buffer) => {
    try { options.onStderr?.(bytes); } catch { /* Diagnostics cannot change ownership. */ }
  });
  let state: "starting" | "accepting" | "draining" | "stopped" | "unknown" = "starting";
  const owned = ownNextMcpStdio(child, () => options.verifyOwnedDescendantsExited(child), () => {
    if (state !== "accepting") throw new Error("Next MCP prelaunch admission is closed.");
    options.assertCurrent();
  });
  let client: Socket | undefined;
  const server = createServer(socket => {
    if (state !== "accepting" || client) { socket.destroy(); return; }
    socket.setTimeout(5000, () => socket.destroy());
    let handshake = Buffer.alloc(0);
    const accept = (data: Buffer) => {
      handshake = Buffer.concat([handshake, data]);
      const end = handshake.indexOf(10);
      if (end < 0 && handshake.length <= 128) return;
      const offered = handshake.subarray(0, end), expected = Buffer.from(token);
      if (end < 0 || end > 128 || offered.length !== expected.length || !timingSafeEqual(offered, expected)
        || state !== "accepting" || client) { socket.destroy(); return; }
      try {
        options.assertCurrent();
        socket.pause();
        socket.removeListener("data", accept);
        socket.setTimeout(0);
        client = socket;
        socket.write("OK\n");
        owned.attach(socket);
        if (handshake.length > end + 1) socket.unshift(handshake.subarray(end + 1));
        socket.resume();
      } catch {
        state = "unknown";
        owned.abandonDrain();
        socket.destroy();
        if (server.listening) server.close();
        if (!owned.status().admitted) child.stdin?.end();
      }
    };
    socket.on("error", () => {});
    socket.on("data", accept);
  });
  server.on("error", () => { state = "unknown"; owned.abandonDrain(); server.close(); });
  const closeServer = () => { if (server.listening) server.close(); };
  const ready = (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        let receipt = "", settled = false;
        const timer = setTimeout(() => finish(new Error("Next MCP startup timed out.")), timeout);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        child.once("error", error => finish(error));
        child.once("exit", () => finish(new Error("Next MCP exited before readiness.")));
        const channel = child.stdio[3];
        if (!channel || !("on" in channel)) return finish(new Error("Next MCP readiness channel is unavailable."));
        channel.on("data", (bytes: Buffer) => {
          receipt += bytes.toString();
          if (receipt.length > 65) finish(new Error("Invalid Next MCP readiness receipt."));
        });
        channel.once("end", () => finish(receipt === `${nonce}\n` ? undefined : new Error("Invalid Next MCP readiness receipt.")));
        channel.once("error", error => finish(error));
      });
      if (state !== "starting" || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Next MCP readiness is no longer current.");
      options.assertCurrent();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(`\0${name}`, () => { server.removeListener("error", reject); resolve(); });
      });
      if (state !== "starting" || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Next MCP ownership changed during startup.");
      options.assertCurrent();
      state = "accepting";
    } catch (error) {
      state = "unknown";
      closeServer();
      owned.abandonDrain();
      child.stdin?.end();
      throw error;
    }
  })();
  return {
    ready,
    child,
    status() {
      if (owned.status().state === "unknown") state = "unknown";
      return { state, connection: owned.status(), cutoverAuthorized: false as const };
    },
    definitionEnvironment(): Record<string, string> {
      if (state !== "accepting" || owned.status().state !== "accepting")
        throw new Error("Next MCP prelaunch admission is closed.");
      try { options.assertCurrent(); }
      catch (error) {
        state = "unknown";
        closeServer();
        owned.abandonDrain();
        if (!owned.status().admitted) child.stdin?.end();
        throw error;
      }
      return { ELECTRON_RUN_AS_NODE: "1", PKM_NEXT_MCP_BROKER: name, PKM_NEXT_MCP_BROKER_TOKEN: token };
    },
    async drainAndClose() {
      if (state !== "accepting") throw new Error("Next MCP prelaunch is not accepting.");
      state = "draining";
      closeServer();
      try {
        const result = await owned.drainAndClose();
        state = "stopped";
        return result;
      } catch (error) {
        state = "unknown";
        if (!owned.status().admitted) child.stdin?.end();
        throw error;
      }
    },
    dispose() {
      if (state === "stopped") return;
      state = "unknown";
      closeServer();
      owned.abandonDrain();
      if (!owned.status().admitted) child.stdin?.end();
    },
  };
}
