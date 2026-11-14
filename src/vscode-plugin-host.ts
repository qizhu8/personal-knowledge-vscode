import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { z } from "zod";
import { PluginRuntime, type PluginFactory } from "./plugin-runtime.js";
import type { Storage } from "./storage.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const configuration = z.strictObject({
  tenantId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  credentialRef: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
});
const grantSchema = z.strictObject({
  schema: z.literal("pkm.plugin.host-grant/v1"), workspaceId: z.string(), workspaceRoot: z.string(),
  actorId: z.string(), pluginId: z.literal("teams"), configuration,
  configurationSha256: digest, implementationSha256: digest.nullable(),
  revision: z.string().uuid(), enabled: z.boolean(),
});
const endpointSchema = z.strictObject({
  schema: z.literal("pkm.plugin.host-authority/v1"), host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535), token: digest,
  workspaceRoot: z.string(), workspaceId: z.string(), actorId: z.string(),
});
type Endpoint = z.infer<typeof endpointSchema>;

/** Packaged native code only. No path, environment, archive or request can register a factory. */
export interface NativePluginImplementation {
  implementationSha256: string;
  factory: PluginFactory;
}

function endpoint(root: string, workspaceId: string, actorId: string): Endpoint {
  const directory = path.join(root, ".pkm-plugin-authority");
  const filename = path.join(directory, "host-authority.json");
  for (const candidate of [root, directory, filename]) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate
      || (candidate === filename ? !stat.isFile() || stat.nlink !== 1 || stat.size > 8192 : !stat.isDirectory())
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
      throw new Error("Unsafe plugin authority endpoint.");
  }
  const value = endpointSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
  if (value.workspaceRoot !== root || value.workspaceId !== workspaceId || value.actorId !== actorId)
    throw new Error("Plugin authority identity mismatch.");
  return value;
}

function request(config: Endpoint, operation: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let input = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(operation === "invoke" || operation === "enable" ? 300_000 : 3000,
      () => finish(new Error("Plugin authority timed out.")));
    socket.on("error", error => finish(error));
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 8192) return finish(new Error("Oversized plugin authority response."));
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(input.slice(0, newline))); }
      catch { finish(new Error("Invalid plugin authority response.")); }
    });
    socket.on("end", () => { if (!settled) finish(new Error("Incomplete plugin authority response.")); });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      operation, token: config.token, workspaceRoot: config.workspaceRoot,
      workspaceId: config.workspaceId, actorId: config.actorId, pluginId: "teams", ...fields,
    })}\n`));
  });
}

/**
 * Fixed actor + explicit native implementation/configuration admission.
 * The shipped registry is deliberately empty: original Teams source/API is unavailable.
 */
export async function createVscodePluginRuntime(storage: Storage, options: {
  actorId: string;
  teams?: NativePluginImplementation;
}): Promise<PluginRuntime> {
  const root = storage.workspaceRoot(), workspaceId = await storage.workspaceId(), actorId = options.actorId;
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(actorId)) throw new Error("Invalid native plugin actor.");
  if (options.teams && (!digest.safeParse(options.teams.implementationSha256).success
    || typeof options.teams.factory !== "function")) throw new Error("Invalid packaged plugin implementation.");
  let grant: z.infer<typeof grantSchema> | undefined;
  try {
    const response = z.strictObject({ ok: z.literal(true), grant: grantSchema.nullable() })
      .parse(await request(endpoint(root, workspaceId, actorId), "configuration"));
    if (response.grant) {
      const candidate = response.grant;
      const configHash = createHash("sha256").update(JSON.stringify(candidate.configuration)).digest("hex");
      if (candidate.workspaceId !== workspaceId || candidate.workspaceRoot !== root || candidate.actorId !== actorId
        || candidate.configurationSha256 !== configHash) throw new Error("Invalid native plugin grant.");
      grant = candidate;
    }
  } catch { /* Missing or invalid authority never supplies a configuration or grant. */ }
  const admitted = !!options.teams && !!grant?.enabled
    && options.teams.implementationSha256 === grant.implementationSha256;
  return new PluginRuntime({
    factories: admitted ? { teams: options.teams!.factory } : {},
    configurations: grant ? { teams: grant.configuration } : {},
    async authorize(actor, binding) {
      if (!admitted || !grant || actor.id !== actorId || binding.actorId !== actorId) return false;
      try {
        const response = z.strictObject({ ok: z.boolean() }).parse(await request(endpoint(root, workspaceId, actorId), binding.action, {
          revision: grant.revision, implementationSha256: grant.implementationSha256,
          configurationSha256: grant.configurationSha256, capabilities: [...binding.capabilities],
          ...(binding.inputDigest ? { inputDigest: binding.inputDigest } : {}),
        }));
        return response.ok;
      } catch { return false; }
    },
  });
}
