import { isolatedManagedLaunch } from "../../experimental/managed-launch-client.mjs";
import { publicName } from "../../src/public-identity";
import { verifyOriginalMcpBrokerDescriptor } from "../../src/original-mcp-broker-descriptor.js";
import type { OriginalMcpEnrollment } from "./original-mcp-enrollment.js";
import { dirname } from "node:path";
import { originalPublicMcpOperationIds } from "../../src/native-public-original-mcp-contracts.js";
import type { Disposable, Event, EventEmitter, Uri } from "vscode";
import { sharedManagedRequest } from "../../src/shared-managed-client.js";

export interface SharedMcpEnrollment {
  origin: string; serviceId: string; token: string; relayPath: string;
  backendKind?: "native-public-mcp" | "standalone-core";
}

type Definition = {
  readonly label: string; command: string; args: string[]; env: Record<string, string | number | null>; cwd?: Uri;
  version?: string;
};
type NativeMcpApi = {
  extensions?: { getExtension(id: string): unknown };
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

/** Publish an isolated generation or an explicitly enrolled, already-owned original-library broker. */
export function registerIsolatedMcp(
  api: unknown,
  root: () => string | undefined,
  original?: () => Readonly<OriginalMcpEnrollment> | undefined,
  shared?: () => Promise<Readonly<SharedMcpEnrollment> | undefined>,
) {
  if (!supportsNativeMcp(api)) throw new McpApiUnavailableError();
  const Constructor = api.McpStdioServerDefinition;
  const changed = new api.EventEmitter();
  type Selection = { kind: "isolated"; root: string } | { kind: "original"; enrollment: Readonly<OriginalMcpEnrollment> }
    | { kind: "shared"; enrollment: Readonly<SharedMcpEnrollment> };
  let active: { selection: string; definition: Definition; signature: string } | undefined;
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
  const selection = async (): Promise<Selection | undefined> => {
    const enrolled = original?.(), selected = root(), stable = await shared?.();
    if (stable && (enrolled || selected)) throw new Error("SHARED_MCP_CONFIGURATION_CONFLICT");
    if (stable) return { kind: "shared", enrollment: stable };
    if (enrolled && selected) throw new Error("ORIGINAL_MCP_CONFIGURATION_CONFLICT");
    if (enrolled) {
      if (!api.extensions || typeof api.extensions.getExtension !== "function")
        throw new Error("ORIGINAL_MCP_NATIVE_INVENTORY_UNAVAILABLE");
      if (api.extensions.getExtension("Uone.personal-knowledge"))
        throw new Error("ORIGINAL_MCP_LEGACY_EXTENSION_PRESENT");
      return { kind: "original", enrollment: enrolled };
    }
    return selected ? { kind: "isolated", root: selected } : undefined;
  };
  const launch = async (selected: Selection): Promise<{
    command: string; args: string[]; env: Record<string, string>; cwd: string; label: string; version?: string;
  }> => {
    if (selected.kind === "isolated") {
      const current = await isolatedManagedLaunch(selected.root);
      if (!current.args || !current.env) throw new Error("Invalid isolated MCP launch.");
      return { command: current.command, args: current.args, env: current.env,
        cwd: selected.root, label: publicName };
    }
    if (selected.kind === "shared") {
      const enrollment = selected.enrollment;
      const status = await sharedManagedRequest(enrollment, "/shared/status");
      const core = enrollment.backendKind === "standalone-core";
      if (status.serviceId !== enrollment.serviceId
        || status.backendKind !== (enrollment.backendKind ?? "native-public-mcp")
        || status.scope !== (core ? "isolated-standalone-core/v1" : "isolated-native-knowledge/v1")
        || status.protocols?.mcp !== (core ? "canonical-core" : "native-compact") || status.phase !== "accepting")
        throw new Error("SHARED_MCP_NOT_READY");
      return { command: process.execPath, args: [enrollment.relayPath],
        env: { ELECTRON_RUN_AS_NODE: "1", PKM_SHARED_ORIGIN: enrollment.origin,
          PKM_SHARED_SERVICE_ID: enrollment.serviceId, PKM_SHARED_TOKEN: enrollment.token },
        cwd: dirname(enrollment.relayPath), label: `${publicName} (shared isolated)`,
        version: enrollment.serviceId };
    }
    const enrollment = selected.enrollment;
    const verified = await verifyOriginalMcpBrokerDescriptor(enrollment.descriptorPath,
      enrollment.descriptorSha256, enrollment.profileSha256);
    const admitted = new Set(verified.enabledOperationIds), disabled = new Set(verified.disabledOperationIds);
    if (!verified.writable || originalPublicMcpOperationIds.some(id => !admitted.has(id) || disabled.has(id)))
      throw new Error("ORIGINAL_MCP_FULL_PARITY_REQUIRED");
    return {
      command: verified.nodePath,
      args: [verified.relayPath, "relay", "--descriptor", enrollment.descriptorPath, "--pin", enrollment.descriptorSha256],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      cwd: dirname(enrollment.descriptorPath),
      label: `${publicName} (original library)`,
      version: enrollment.descriptorSha256,
    };
  };
  let registration: Disposable;
  try { registration = api.lm.registerMcpServerDefinitionProvider(publicName, {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      const current = ++revision;
      active = undefined;
      const selected = await selection();
      if (disposed || !selected) return [];
      const pinSelection = JSON.stringify(selected), currentLaunch = await launch(selected);
      if (typeof currentLaunch.command !== "string" || !Array.isArray(currentLaunch.args))
        throw new Error("Invalid isolated MCP launch.");
      if (disposed || current !== revision || JSON.stringify(await selection()) !== pinSelection)
        throw new Error("Native MCP selection changed.");
      const definition = new Constructor(currentLaunch.label, currentLaunch.command, [...currentLaunch.args], { ...currentLaunch.env });
      definition.cwd = api.Uri.file(currentLaunch.cwd);
      if (currentLaunch.version !== undefined) definition.version = currentLaunch.version;
      const pin = signature(definition);
      if (pin === undefined) throw new Error("Unsupported isolated MCP definition fields.");
      active = { selection: pinSelection, definition, signature: pin };
      return [definition];
    },
    async resolveMcpServerDefinition(definition) {
      const bound = active;
      const selected = await selection();
      if (disposed || !bound || !selected || bound.definition !== definition || JSON.stringify(selected) !== bound.selection
        || signature(definition) !== bound.signature) throw new Error("Isolated MCP definition is stale or changed.");
      const currentLaunch = await launch(selected);
      if (disposed || active !== bound || JSON.stringify(await selection()) !== bound.selection || signature(definition) !== bound.signature
        || definition.command !== currentLaunch.command || JSON.stringify(definition.args) !== JSON.stringify(currentLaunch.args)
        || JSON.stringify(definition.env) !== JSON.stringify(currentLaunch.env))
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
