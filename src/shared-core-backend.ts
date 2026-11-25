import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { startStandaloneHost } from "./standalone-host.js";
import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { createBrowserReview } from "./host-composition-review.js";
import { parseSharedCoreProfile } from "./shared-core-profile.js";

const { values } = parseArgs({ options: { "managed-generation": { type: "string" },
  profile: { type: "string" }, data: { type: "string" } }, allowPositionals: false, strict: true });
const directory = values["managed-generation"];
const token = process.env.PKM_SHARED_CORE_INTERNAL_TOKEN, nonce = process.env.PKM_SHARED_CORE_READY_NONCE;
delete process.env.PKM_SHARED_CORE_INTERNAL_TOKEN; delete process.env.PKM_SHARED_CORE_READY_NONCE;
if (!directory || resolve(directory) !== directory || !process.connected || !token || !nonce)
  throw new Error("A private manager-owned Core process is required.");
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
if (values.profile !== join(directory, "core-host.json")) throw new Error("Exact immutable Core profile path required.");
const profileBytes = await readFile(values.profile);
const profileSha256 = createHash("sha256").update(profileBytes).digest("hex");
if (manifest.schema !== "pkm.mcp.lifecycle/v1" || manifest.backendKind !== "standalone-core"
  || manifest.backendAbi !== "pkm.shared-core-http/v1" || manifest.coreHostProfileSha256 !== profileSha256
  || manifest.files?.["core-host.json"] !== profileSha256
  || await realpath(process.execPath) !== manifest.interpreters?.node?.path)
  throw new Error("Immutable Core profile/interpreter admission changed.");
const profile = parseSharedCoreProfile(JSON.parse(profileBytes.toString("utf8")));
const launch = JSON.parse(await readFile(join(directory, "launch.json"), "utf8"));
if (launch.allowWrites !== true || values.data !== launch.data || Object.keys(launch).sort().join(",") !== "allowWrites,data")
  throw new Error("Configured standalone Core requires explicit isolated write authority and no implicit background scheduler.");
const configPath = join(directory, "core-host-config.json");
const configBytes = await readFile(configPath);
if (manifest.files?.["core-host-config.json"] !== createHash("sha256").update(configBytes).digest("hex")
  || JSON.stringify(JSON.parse(configBytes.toString("utf8"))) !== JSON.stringify(profile.config))
  throw new Error("Immutable standalone configuration changed.");
const evidence = Object.freeze({});
let host: Awaited<ReturnType<typeof startStandaloneHost>>;
host = await startStandaloneHost({
  dataPath: launch.data, configPath, policy: { ...profile.policy, authorizedConfigPath: configPath },
  resolveSecret: async reference => {
    const name = profile.secretEnvironment[reference];
    return name === undefined ? undefined : process.env[name];
  },
  authenticateHuman: candidate => candidate === evidence
    ? { workspaceId: host.workspaceId, actorId: "local:owner", readOnly: false, authorities: ["approval"] } : null,
});
const configuredChatTurns = host.services.chatTurns;
if (!configuredChatTurns) {
  await host.close();
  throw new Error("Configured standalone Core requires its actual Chat turn service.");
}
const chatTurns = configuredChatTurns;
const human = createBrowserReview(host.humanReview, evidence);
const http = await startHttp(host.core, token, { id: "local:owner", canWrite: true }, 0, human, undefined, chatTurns);
let accepting = true, mcpInFlight = 0, closing: Promise<void> | undefined;
const wire: Transport = {
  async start() {},
  async send(message) {
    if (!process.connected) throw new Error("Owning shared manager disconnected.");
    await new Promise<void>((ready, reject) => process.send!({ type: "rpc", message }, error => error ? reject(error) : ready()));
  },
  async close() { wire.onclose?.(); },
};
const mcp = await startMcp({
  async dispatch(method, input, actor) {
    if (!accepting) throw new Error("Core child ingress is quiesced.");
    mcpInFlight++;
    try { return await host.core.dispatch(method, input, actor); } finally { mcpInFlight--; }
  },
} as typeof host.core, { id: "local:owner", canWrite: true }, wire);
const status = () => ({ schema: "pkm.shared-core-status/v1", generation: manifest.generation,
  runtimeBuild: manifest.runtimeBuild, profileSha256, workspaceId: host.workspaceId, actorId: "local:owner",
  phase: accepting ? "accepting" : "draining", inFlight: mcpInFlight, backgroundChat: chatTurns.activity() });
function post(message: unknown, sent?: () => void) {
  if (process.connected) process.send?.(message, error => { if (!error) sent?.(); });
}
async function quiesce() {
  accepting = false;
  try {
    if (mcpInFlight) throw new Error("BUSY: Core MCP dispatches are still in flight.");
    await http.quiesce();
    return { ...status(), phase: "drained" };
  } catch (error) { accepting = true; throw error; }
}
async function close() {
  return closing ??= (async () => {
    await quiesce();
    await new Promise<void>((ready, reject) => http.server.close(error => error ? reject(error) : ready()));
    human.close(); await mcp.close(); await host.close();
  })().catch(error => { closing = undefined; throw error; });
}
process.on("message", async value => {
  if (!value || typeof value !== "object") return;
  const request = value as Record<string, any>;
  if (request.type === "rpc") {
    const parsed = JSONRPCMessageSchema.safeParse(request.message);
    if (parsed.success) wire.onmessage?.(parsed.data);
  } else if (request.type === "control" && typeof request.id === "string") {
    try {
      const result = request.action === "status" ? status()
        : request.action === "human-enrollment" ? { schema: "pkm.shared-human-enrollment/v1", generation: manifest.generation,
          code: human.renewEnrollment(), expiresInMs: 120000, path: "/human-review" }
        : request.action === "quiesce" ? await quiesce()
        : request.action === "close" ? await close() : (() => { throw new Error("Unknown Core lifecycle action."); })();
      post({ type: "control-result", id: request.id, result: result ?? { closed: true } }, () => {
        if (request.action === "close" && process.connected) process.disconnect?.();
      });
    } catch (error) {
      post({ type: "control-result", id: request.id, error: error instanceof Error ? error.message : "Core lifecycle refused." });
    }
  }
});
function retireAfterDisconnect() {
  if (closing) return;
  accepting = false;
  const retire = async () => {
    while (chatTurns.activity().active || mcpInFlight) await new Promise(ready => setTimeout(ready, 50));
    await new Promise<void>(ready => http.server.close(() => ready()));
    human.close(); await mcp.close(); await host.close();
  };
  void retire().catch(error => { console.error(error); process.exitCode = 1; });
}
process.once("disconnect", retireAfterDisconnect);
if (!process.connected) retireAfterDisconnect();
post({ type: "ready", nonce, ...status(), url: http.url });
