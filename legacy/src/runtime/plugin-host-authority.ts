import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";

export interface PluginHostConfiguration {
  tenantId: string;
  clientId: string;
  credentialRef: string;
}
export interface PluginHostGrant {
  schema: "pkm.plugin.host-grant/v1";
  workspaceId: string;
  workspaceRoot: string;
  actorId: string;
  pluginId: "teams";
  configuration: PluginHostConfiguration;
  configurationSha256: string;
  implementationSha256: string | null;
  revision: string;
  enabled: boolean;
}
export interface PluginHostAuthorityOptions {
  workspaceRoot: string;
  workspaceId: string;
  actorId: string;
  isTrusted(): boolean;
  /** Only a packaged implementation registry may supply this pin, never a UI/MCP input. */
  implementationSha256?: string;
  load(): unknown;
  save(grant: PluginHostGrant): Promise<void>;
  confirmInvocation(request: Readonly<{ actorId: string; workspaceId: string; pluginId: "teams";
    action: "enable" | "invoke";
    revision: string; configurationSha256: string; implementationSha256: string;
    capability: "teams.notifications.read"; inputDigest: string }>): Promise<boolean>;
}
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9._:-]{1,256}$/;
const capability = "teams.notifications.read";
export function parsePluginHostConfiguration(value: unknown): PluginHostConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid non-secret plugin configuration.");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "clientId,credentialRef,tenantId"
    || ![config.clientId, config.tenantId, config.credentialRef].every(item => typeof item === "string" && identifier.test(item)))
    throw new Error("Use only non-secret opaque tenant, client and credential-reference identifiers.");
  return { tenantId: String(config.tenantId), clientId: String(config.clientId), credentialRef: String(config.credentialRef) };
}
export function pluginConfigurationSha256(config: PluginHostConfiguration): string {
  return createHash("sha256").update(JSON.stringify(parsePluginHostConfiguration(config))).digest("hex");
}

/** Host-owned consent authority. Configuration is not an implementation, credential, or grant. */
export class PluginHostAuthority {
  private readonly token = randomBytes(32).toString("hex");
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private filename = "";
  private closed = false;
  private updating = false;
  private lostTrust = false;
  private grant?: PluginHostGrant;

  constructor(private readonly options: PluginHostAuthorityOptions) {
    if (!path.isAbsolute(options.workspaceRoot) || path.resolve(options.workspaceRoot) !== options.workspaceRoot
      || fs.realpathSync(options.workspaceRoot) !== options.workspaceRoot
      || !identifier.test(options.workspaceId) || !identifier.test(options.actorId)
      || options.implementationSha256 !== undefined && !digest.test(options.implementationSha256))
      throw new Error("Invalid native plugin authority binding.");
    const stored = options.load();
    if (stored !== undefined) {
      try {
        const candidate = stored as PluginHostGrant;
        const configuration = parsePluginHostConfiguration(candidate.configuration);
        if (Object.keys(candidate).sort().join(",") !==
          "actorId,configuration,configurationSha256,enabled,implementationSha256,pluginId,revision,schema,workspaceId,workspaceRoot"
          || candidate.schema !== "pkm.plugin.host-grant/v1" || candidate.pluginId !== "teams"
          || candidate.workspaceRoot !== options.workspaceRoot || candidate.workspaceId !== options.workspaceId
          || candidate.actorId !== options.actorId || !identifier.test(candidate.revision)
          || candidate.configurationSha256 !== pluginConfigurationSha256(configuration)
          || typeof candidate.enabled !== "boolean"
          || candidate.implementationSha256 !== null && !digest.test(candidate.implementationSha256)) throw new Error();
        this.grant = { ...candidate, configuration };
      } catch { throw new Error("Stored plugin authority is invalid; preserve and explicitly reconcile it."); }
    }
    this.server = net.createServer(socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(300_000, () => socket.destroy());
      socket.setEncoding("utf8");
      let input = "", handled = false;
      socket.on("error", () => socket.destroy());
      socket.on("data", chunk => {
        if (handled) return socket.destroy();
        input += chunk;
        if (Buffer.byteLength(input) > 8192) return socket.destroy();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        void this.handle(input.slice(0, newline)).then(
          result => socket.end(`${JSON.stringify(result)}\n`),
          () => socket.end('{"ok":false}\n'),
        );
      });
    });
    this.server.on("error", () => { for (const socket of this.sockets) socket.destroy(); });
  }

  snapshot(): PluginHostGrant | undefined {
    return this.grant && { ...this.grant, configuration: { ...this.grant.configuration } };
  }

  async configure(value: unknown): Promise<PluginHostGrant> {
    if (!this.trusted() || this.updating) throw new Error("Plugin workspace authority is unavailable.");
    const configuration = parsePluginHostConfiguration(value);
    const grant: PluginHostGrant = {
      schema: "pkm.plugin.host-grant/v1", workspaceRoot: this.options.workspaceRoot,
      workspaceId: this.options.workspaceId, actorId: this.options.actorId, pluginId: "teams",
      configuration, configurationSha256: pluginConfigurationSha256(configuration),
      implementationSha256: this.options.implementationSha256 ?? null,
      revision: randomUUID(), enabled: this.options.implementationSha256 !== undefined,
    };
    await this.persist(grant);
    return this.snapshot()!;
  }

  async revoke(): Promise<void> {
    if (this.updating) throw new Error("Plugin authority is changing; retry revocation.");
    if (this.grant) await this.persist({ ...this.grant, enabled: false, revision: randomUUID() });
  }

  private async persist(grant: PluginHostGrant): Promise<void> {
    this.updating = true;
    // Deny immediately, including when durable persistence fails.
    this.grant = { ...grant, enabled: false };
    try { await this.options.save(structuredClone(grant)); this.grant = grant; }
    finally { this.updating = false; }
  }

  private trusted(): boolean {
    if (this.closed || !this.options.isTrusted()) { this.lostTrust = true; return false; }
    return !this.lostTrust;
  }

  async start(): Promise<void> {
    if (!this.trusted() || this.filename) throw new Error("Plugin authority cannot start.");
    const root = this.options.workspaceRoot;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()
      || process.platform !== "win32" && ((rootStat.mode & 0o077) !== 0
        || process.getuid && rootStat.uid !== process.getuid())) throw new Error("Plugin workspace must be private.");
    const directory = path.join(root, ".pkm-plugin-authority");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
      throw new Error("Unsafe plugin authority directory.");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Invalid plugin authority endpoint.");
    this.filename = path.join(directory, "host-authority.json");
    const staging = `${this.filename}.${randomUUID()}.pending`;
    try {
      fs.writeFileSync(staging, JSON.stringify({
        schema: "pkm.plugin.host-authority/v1", host: "127.0.0.1", port: address.port,
        token: this.token, workspaceRoot: root, workspaceId: this.options.workspaceId, actorId: this.options.actorId,
      }), { flag: "wx", mode: 0o600 });
      fs.renameSync(staging, this.filename);
    } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
  }

  private async handle(line: string): Promise<unknown> {
    if (!this.trusted() || this.updating) return { ok: false };
    const request = JSON.parse(line) as Record<string, unknown>;
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !["operation", "token", "workspaceRoot", "workspaceId", "actorId",
        "pluginId", "revision", "configurationSha256", "implementationSha256", "capabilities", "inputDigest"].includes(key))
      || request.token !== this.token || request.workspaceRoot !== this.options.workspaceRoot
      || request.workspaceId !== this.options.workspaceId || request.actorId !== this.options.actorId
      || request.pluginId !== "teams") return { ok: false };
    const grant = this.grant;
    if (request.operation === "configuration") return { ok: true, grant: this.snapshot() ?? null };
    if (!grant || !grant.enabled || grant.implementationSha256 !== this.options.implementationSha256
      || grant.revision !== request.revision || grant.configurationSha256 !== request.configurationSha256
      || grant.implementationSha256 !== request.implementationSha256
      || !Array.isArray(request.capabilities)
      || request.capabilities.length !== 1 || request.capabilities[0] !== capability) return { ok: false };
    if (request.operation === "disable") return { ok: true };
    if (request.operation !== "enable" && request.operation !== "invoke"
      || request.operation === "invoke" && (typeof request.inputDigest !== "string" || !digest.test(request.inputDigest)))
      return { ok: false };
    const consented = await this.options.confirmInvocation(Object.freeze({
      action: request.operation,
      actorId: grant.actorId, workspaceId: grant.workspaceId, pluginId: "teams", revision: grant.revision,
      configurationSha256: grant.configurationSha256, implementationSha256: grant.implementationSha256!,
      capability, inputDigest: request.operation === "enable" ? grant.configurationSha256 : String(request.inputDigest),
    }));
    return { ok: consented === true && this.trusted() && !this.updating && this.grant?.enabled === true
      && this.grant.revision === grant.revision };
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (this.filename) {
      try {
        const record = JSON.parse(fs.readFileSync(this.filename, "utf8"));
        if (record.token === this.token) fs.unlinkSync(this.filename);
      } catch { /* Another host may have replaced the endpoint. */ }
    }
  }
}
