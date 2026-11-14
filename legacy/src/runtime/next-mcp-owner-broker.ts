import { ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, Server, Socket } from "node:net";
import { ownNextMcpStdio } from "./next-mcp-owned-stdio";
import { prepareOwnedLegacyNativeMcpHandoffExperimental } from "./legacy-native-mcp-handoff";

type Launch = { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string };

/** Per-host broker for one controlled stdio connection, not a root-wide adoption authority. */
export async function createNextMcpOwnerBroker(options: {
  launch(): Launch;
  assertCurrent(): void;
  verifyOwnedDescendantsExited(child: ChildProcess): Promise<void>;
}) {
  if (process.platform !== "linux" || typeof options.launch !== "function" || typeof options.assertCurrent !== "function"
    || typeof options.verifyOwnedDescendantsExited !== "function") throw new Error("Linux owner and exact child verifier required.");
  options.assertCurrent();
  const name = `pkm-next-${randomBytes(24).toString("hex")}`, token = randomBytes(32).toString("hex");
  let state: "accepting" | "draining" | "stopped" | "unknown" = "accepting";
  let legacyHandoffInProgress = false;
  let owner: ReturnType<typeof ownNextMcpStdio> | undefined;
  let client: Socket | undefined;
  const server: Server = createServer(socket => {
    if (state !== "accepting" || owner || client) { socket.destroy(); return; }
    socket.setTimeout(5000, () => socket.destroy());
    let handshake = Buffer.alloc(0);
    const accept = (data: Buffer) => {
      handshake = Buffer.concat([handshake, data]);
      const end = handshake.indexOf(10);
      if (end < 0 && handshake.length <= 128) return;
      if (end < 0 || end > 128) { socket.destroy(); return; }
      const offered = handshake.subarray(0, end);
      const expected = Buffer.from(token);
      if (offered.length !== expected.length || !timingSafeEqual(offered, expected)
        || state !== "accepting" || owner || client) { socket.destroy(); return; }
      socket.pause();
      socket.removeListener("data", accept);
      socket.setTimeout(0);
      try {
        options.assertCurrent();
        const definition = options.launch();
        options.assertCurrent();
        const child = spawn(definition.command, [...definition.args], {
          cwd: definition.cwd,
          env: { ...process.env, ...definition.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", () => { state = "unknown"; socket.destroy(); });
        child.stderr?.resume();
        owner = ownNextMcpStdio(child, () => options.verifyOwnedDescendantsExited(child), options.assertCurrent);
        client = socket;
        const remainder = handshake.subarray(end + 1);
        socket.write("OK\n");
        owner.attach(socket);
        if (remainder.length) socket.unshift(remainder);
        socket.resume();
      } catch {
        state = "unknown";
        socket.destroy();
      }
    };
    socket.on("error", () => {});
    socket.on("data", accept);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`\0${name}`, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => { state = "unknown"; server.close(); });
  const closeServer = () => { if (server.listening) server.close(); };
  const reconcile = () => { if (owner?.status().state === "unknown") state = "unknown"; };
  return {
    definitionEnvironment(): Record<string, string> {
      reconcile();
      if (state !== "accepting") throw new Error("Next MCP broker admission is closed.");
      options.assertCurrent();
      return { ELECTRON_RUN_AS_NODE: "1", PKM_NEXT_MCP_BROKER: name, PKM_NEXT_MCP_BROKER_TOKEN: token };
    },
    status() {
      reconcile();
      return { state, connection: owner?.status() ?? null, cutoverAuthorized: false as const };
    },
    async drainAndClose() {
      reconcile();
      if (state !== "accepting" || legacyHandoffInProgress) throw new Error("Next MCP broker state is not accepting.");
      state = "draining";
      closeServer();
      try {
        const result = owner ? await owner.drainAndClose() : undefined;
        state = "stopped";
        return { state, connection: result ?? null, cutoverAuthorized: false as const };
      } catch (error) {
        state = "unknown";
        throw error;
      }
    },
    async drainLegacyAndClose(approve: (signal: AbortSignal) => Promise<boolean>, timeoutMs = 30_000) {
      reconcile();
      if (state !== "accepting" || legacyHandoffInProgress || !owner || !client)
        throw new Error("An admitted owned legacy MCP connection is required.");
      legacyHandoffInProgress = true;
      const current = owner;
      const assertOwned = () => {
        options.assertCurrent();
        if (owner !== current || !client || client.destroyed || !["accepting", "draining"].includes(state)
          || !["accepting", "draining"].includes(current.status().state))
          throw new Error("Legacy MCP connection ownership is unavailable.");
      };
      const call = async (name: "mcp_lifecycle_status" | "mcp_lifecycle_quiesce", signal: AbortSignal) => {
        assertOwned();
        const value = await current.callLegacyLifecycleTool(name, signal);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lifecycle result.");
        const result = value as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
        if (result.isError) throw new Error("Legacy MCP lifecycle failed.");
        if (result.structuredContent !== undefined) return result.structuredContent;
        if (!Array.isArray(result.content) || result.content.some(item => item.type !== "text" || typeof item.text !== "string"))
          throw new Error("Invalid lifecycle content.");
        return JSON.parse(result.content.map(item => item.text).join(""));
      };
      try {
        const outcome = await prepareOwnedLegacyNativeMcpHandoffExperimental({
          assertOwned,
          status: signal => call("mcp_lifecycle_status", signal),
          quiesce: signal => call("mcp_lifecycle_quiesce", signal),
          async stopAndVerify(signal) {
            assertOwned();
            const abort = () => current.abandonDrain();
            signal.addEventListener("abort", abort, { once: true });
            try {
              if (signal.aborted) { abort(); throw new Error("Drain cancelled."); }
              await current.drainAndClose(timeoutMs);
            } finally { signal.removeEventListener("abort", abort); }
          },
        }, async signal => {
          if (!await approve(signal)) return false;
          if (signal.aborted) throw new Error("Handoff approval expired.");
          assertOwned();
          current.beginDrain();
          state = "draining";
          closeServer();
          return true;
        }, timeoutMs);
        if (outcome.state === "drained-and-stopped") state = "stopped";
        else if (outcome.state === "unknown") { state = "unknown"; closeServer(); current.abandonDrain(); }
        return outcome;
      } finally { legacyHandoffInProgress = false; }
    },
    dispose() {
      if (state !== "stopped") { state = "unknown"; owner?.abandonDrain(); }
      closeServer();
    },
  };
}
