import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export function connectSharedCoreBackend(options: {
  launch: StdioServerParameters; manifest: Record<string, any>;
  capture(owned: { child: ChildProcess; exited: Promise<void> }): void;
}) {
  const { manifest } = options, token = randomBytes(32).toString("hex"), nonce = randomBytes(32).toString("hex");
  const env = { ...options.launch.env, PKM_SHARED_CORE_INTERNAL_TOKEN: token, PKM_SHARED_CORE_READY_NONCE: nonce };
  for (const key of ["PKM_SHARED_MANAGEMENT_TOKEN", "PKM_SHARED_TOKEN"])
    delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn(options.launch.command, options.launch.args ?? [],
    { env, cwd: options.launch.cwd, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = new Promise<void>((ready, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? ready() : reject(new Error("Owned Core backend did not exit cleanly.")));
  });
  void exited.catch(() => {});
  options.capture({ child, exited });
  const waiting = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const wire: Transport = {
    async start() {},
    async send(message) {
      await new Promise<void>((ready, reject) => child.send({ type: "rpc", message }, error => error ? reject(error) : ready()));
    },
    async close() { wire.onclose?.(); },
  };
  let ready!: (value: any) => void, rejectReady!: (error: Error) => void;
  const readiness = new Promise<any>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error("Core child readiness deadline exceeded.")), 30_000);
  child.on("message", value => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, any>;
    if (message.type === "ready") ready(message);
    else if (message.type === "control-result") {
      const request = waiting.get(message.id);
      if (!request) return;
      waiting.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    } else if (message.type === "rpc") {
      const parsed = JSONRPCMessageSchema.safeParse(message.message);
      if (parsed.success) wire.onmessage?.(parsed.data);
    }
  });
  child.once("exit", () => {
    clearTimeout(timer); rejectReady(new Error("Core child exited before admission."));
    for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(new Error("Core child exited; control outcome unknown.")); }
    waiting.clear(); wire.onclose?.();
  });
  const connected = (async () => {
  let identity;
  try { identity = await readiness; } finally { clearTimeout(timer); }
  const url = new URL(identity.url);
  if (identity.nonce !== nonce || identity.schema !== "pkm.shared-core-status/v1"
    || identity.generation !== manifest.generation || identity.runtimeBuild !== manifest.runtimeBuild
    || identity.profileSha256 !== manifest.coreHostProfileSha256
    || identity.actorId !== "local:owner" || url.origin !== identity.url || url.hostname !== "127.0.0.1" || url.protocol !== "http:"
    || identity.backgroundChat?.active || identity.backgroundChat?.uncertain)
    throw new Error("Core child identity/readiness/background-work admission failed.");
  const client = new Client({ name: "pkm-shared-core-manager", version: "0.1.0" });
  await client.connect(wire, { timeout: 30_000 });
  const tools: Tool[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    if (tools.length > 512 || page.nextCursor && cursors.has(page.nextCursor)) throw new Error("Core tool discovery exceeded its bound.");
    cursor = page.nextCursor;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const control = (action: "status" | "quiesce" | "close" | "human-enrollment") => new Promise<any>((resolve, reject) => {
    const id = randomUUID(), deadline = setTimeout(() => {
      waiting.delete(id); reject(new Error("Core lifecycle deadline exceeded; outcome requires review."));
    }, 30_000);
    waiting.set(id, { resolve, reject, timer: deadline });
    child.send({ type: "control", id, action }, error => {
      if (error) { clearTimeout(deadline); waiting.delete(id); reject(error); }
    });
  });
  return { kind: "standalone-core" as const, client, transport: wire, child, exited, tools, control,
    generation: manifest.generation as string, runtimeBuild: manifest.runtimeBuild as string,
    url: identity.url as string, token, identity };
  })();
  void connected.catch(() => {});
  return { child, exited, ready: connected };
}
