import { isolatedManagedLaunch } from "../../experimental/managed-launch-client.mjs";
import { publicName } from "../../src/public-identity";
import type { Disposable, Event, EventEmitter, Uri } from "vscode";

type Definition = {
  readonly label: string; command: string; args: string[]; env: Record<string, string | number | null>; cwd?: Uri;
  version?: string;
};
type NativeMcpApi = {
  EventEmitter: new () => EventEmitter<void>;
  Uri: { file(path: string): Uri };
  lm: { registerMcpServerDefinitionProvider(id: string, provider: {
    readonly onDidChangeMcpServerDefinitions: Event<void>;
    provideMcpServerDefinitions(): Promise<Definition[]>;
    resolveMcpServerDefinition(definition: Definition): Promise<Definition>;
  }): Disposable };
  McpStdioServerDefinition: new (
    label: string, command: string, args?: string[], env?: Record<string, string | number | null>,
  ) => Definition;
};

const objectLike = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

// Installed @types/vscode 1.90 predates this stable 1.101 API.
function supportsNativeMcp(api: unknown): api is NativeMcpApi {
  return objectLike(api) && objectLike(api.Uri) && typeof api.Uri.file === "function"
    && objectLike(api.lm) && typeof api.lm.registerMcpServerDefinitionProvider === "function"
    && typeof api.McpStdioServerDefinition === "function" && typeof api.EventEmitter === "function";
}

export class McpApiUnavailableError extends Error {
  readonly code = "MCP_API_UNAVAILABLE";
  constructor() {
    super("pkm-v5 native MCP is unavailable. Use VS Code 1.101.0 or later with the native MCP provider API enabled.");
  }
}

/** Publishes only an explicitly provisioned isolated generation, never the account's pkm binding. */
export function registerIsolatedMcp(
  api: unknown,
  root: () => string | undefined,
) {
  if (!supportsNativeMcp(api)) throw new McpApiUnavailableError();
  const Constructor = api.McpStdioServerDefinition;
  const changed = new api.EventEmitter();
  let active: { root: string; definition: Definition; signature: string } | undefined;
  let disposed = false;
  let revision = 0;
  const fields = new Set<PropertyKey>(["label", "command", "args", "env", "cwd", "version", "metadata"]);
  const signature = (definition: Definition) => {
    if (Reflect.ownKeys(definition).some(key => !fields.has(key)) || "uri" in definition) return undefined;
    if ("metadata" in definition) {
      const metadata = Object.getOwnPropertyDescriptor(definition, "metadata");
      if (!metadata || !("value" in metadata) || metadata.value !== undefined) return undefined;
    }
    const cwd = definition.cwd;
    return JSON.stringify({
      label: definition.label, command: definition.command, args: definition.args,
      env: definition.env, version: definition.version,
      // Native DTO conversion populates Uri.fsPath/toJSON caches without changing these components.
      cwd: cwd && { scheme: cwd.scheme, authority: cwd.authority, path: cwd.path,
        query: cwd.query, fragment: cwd.fragment },
    });
  };
  let registration: Disposable;
  try { registration = api.lm.registerMcpServerDefinitionProvider(publicName, {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      const current = ++revision;
      active = undefined;
      const selected = root();
      if (disposed || !selected) return [];
      const launch = await isolatedManagedLaunch(selected);
      if (typeof launch.command !== "string" || !Array.isArray(launch.args))
        throw new Error("Invalid isolated MCP launch.");
      if (disposed || current !== revision || root() !== selected) throw new Error("Isolated MCP root changed.");
      const definition = new Constructor(publicName, launch.command, [...launch.args], { ...launch.env });
      definition.cwd = api.Uri.file(selected);
      const pin = signature(definition);
      if (pin === undefined) throw new Error("Unsupported isolated MCP definition fields.");
      active = { root: selected, definition, signature: pin };
      return [definition];
    },
    async resolveMcpServerDefinition(definition) {
      const bound = active;
      if (disposed || !bound || bound.definition !== definition || root() !== bound.root
        || signature(definition) !== bound.signature) throw new Error("Isolated MCP definition is stale or changed.");
      const launch = await isolatedManagedLaunch(bound.root);
      if (disposed || active !== bound || root() !== bound.root || signature(definition) !== bound.signature
        || definition.command !== launch.command || JSON.stringify(definition.args) !== JSON.stringify(launch.args)
        || JSON.stringify(definition.env) !== JSON.stringify(launch.env))
        throw new Error("Isolated MCP launch changed.");
      return definition;
    },
  }); }
  catch (error) { changed.dispose(); throw error; }
  return {
    refresh() {
      if (disposed) return;
      revision++; active = undefined;
      changed.fire();
    },
    dispose() {
      if (disposed) return;
      disposed = true; revision++; active = undefined;
      registration.dispose(); changed.dispose();
    },
  };
}
