import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import contracts from "./native-public-mcp-contracts.js";
import { NativePublicMcpLifecycle } from "./native-public-mcp-lifecycle.js";
import { todoCapabilities } from "./domain/legacy-mcp-registry.js";
import { publicName } from "./public-identity.js";
import { createNativePublicStdio } from "./native-public-mcp-stdio.js";
import type { DeploymentIntegrity } from "./deployment-integrity.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { directModuleInstructions, directModuleTools } from "./native-public-mcp-module-tools.js";

type JsonObject = Record<string, any>;
interface Contract {
  id: string; version: number; transportName: string; description: string;
  inputSchema: JsonObject; outputSchema: JsonObject | null; readOnly: boolean;
}
export interface NativePublicCatalog {
  definitions: JsonObject[]; wireDefinitions: Tool[]; contracts: Contract[];
  routing: Record<string, JsonObject>; contractBytes: Record<string, number>;
  floatPaths: (string | number)[][];
  numericLexemes?: { path: (string | number)[]; source: string }[];
  inventory?: { revision: string; schemaBytes: number; measurement: string;
    tools: { name: string; readOnly: boolean; schemaBytes: number }[] };
  variants: Record<string, { names: string[]; revision: string }>;
}
type Catalog = NativePublicCatalog;
const catalog = contracts as Catalog;
const discoveryPageLimit = 10;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
function boundedDiscoverySchema(schema: Tool["inputSchema"]): Tool["inputSchema"] {
  const properties = schema.properties;
  if (!properties || !object(properties.offset) || !object(properties.limit))
    throw new Error("INVALID_CONFIGURATION: Discovery pagination schema is unavailable.");
  return { ...schema, properties: { ...properties,
    offset: { ...properties.offset, minimum: 0 },
    limit: { ...properties.limit, minimum: 1, maximum: discoveryPageLimit },
  } };
}
const floatProperties = new WeakMap<object, Set<string | number>>();
for (const [id, ...path] of catalog.floatPaths) {
  let parent: any = catalog.contracts.find(contract => contract.id === id);
  for (const key of path.slice(0, -1)) parent = parent[key];
  const keys = floatProperties.get(parent) ?? new Set();
  keys.add(path.at(-1)!); floatProperties.set(parent, keys);
}
const numericLexemes = new WeakMap<object, Map<string, string>>();
const initializedCatalogs = new WeakSet<Catalog>();
function initializeNumericLexemes(selected: Catalog) {
  if (initializedCatalogs.has(selected)) return;
  for (const { path: [id, ...path], source } of selected.numericLexemes ?? []) {
    let parent: unknown = selected.contracts.find(contract => contract.id === id);
    for (const key of path.slice(0, -1)) {
      if (!parent || typeof parent !== "object") throw new Error("Invalid release metadata number path.");
      parent = Reflect.get(parent, String(key));
    }
    if (!parent || typeof parent !== "object" || !path.length)
      throw new Error("Invalid release metadata number path.");
    const values = numericLexemes.get(parent) ?? new Map<string, string>();
    values.set(String(path.at(-1)), source);
    numericLexemes.set(parent, values);
  }
  initializedCatalogs.add(selected);
}

export interface NativePublicBackend {
  invoke(name: string, arguments_: unknown): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function pythonMetadataJson(value: unknown, sorted = false): string {
  if (Array.isArray(value)) return `[${value.map(item => pythonMetadataJson(item, sorted)).join(", ")}]`;
  if (object(value)) {
    const keys = Object.keys(value);
    if (sorted) keys.sort();
    return `{${keys.map(key => `${JSON.stringify(key)}: ${pythonMetadataJson(value[key], sorted)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function result(value: unknown): CallToolResult {
  if (value === null || value === undefined) return { content: [], isError: false };
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(object(value) ? { structuredContent: value } : {}),
    isError: false,
  };
}

function encodeMetadata(item: unknown, cache?: WeakMap<object, string>, remember = false): string {
  const cached = item !== null && typeof item === "object" ? cache?.get(item) : undefined;
  if (cached !== undefined) return cached;
  let text: string;
  if (Array.isArray(item)) text = `[${item.map((value, index) =>
    numericLexemes.get(item)?.get(String(index)) ?? encodeMetadata(value, cache, remember)).join(",")}]`;
  else if (!object(item)) return JSON.stringify(item);
  else text = `{${Object.entries(item).map(([key, entry]) => {
      const encoded = numericLexemes.get(item)?.get(key) ?? (floatProperties.get(item)?.has(key) && Number.isInteger(entry)
        ? `${entry}.0` : encodeMetadata(entry, cache, remember));
      return `${JSON.stringify(key)}:${encoded}`;
    }).join(",")}}`;
  if (remember) cache?.set(item, text);
  return text;
}

function metadataResult(value: unknown, cache?: WeakMap<object, string>): CallToolResult {
  return { content: [{ type: "text", text: encodeMetadata(value, cache) }],
    ...(object(value) ? { structuredContent: value } : {}), isError: false };
}

const validators = new AjvJsonSchemaValidator();
const unionValidators = new WeakMap<JsonObject, WeakMap<JsonObject, JsonSchemaValidator<unknown>>>();
function unionValidator(schema: JsonObject, root: JsonObject) {
  let roots = unionValidators.get(schema);
  if (!roots) { roots = new WeakMap(); unionValidators.set(schema, roots); }
  let validator = roots.get(root);
  if (!validator) {
    validator = validators.getValidator({ ...schema, $defs: root.$defs });
    roots.set(root, validator);
  }
  return validator;
}
function normalized(value: unknown, schema: JsonObject, root = schema, strict = false): unknown {
  if (schema.$ref) {
    const ref = String(schema.$ref);
    if (!ref.startsWith("#/")) throw new Error("Unsupported public schema reference.");
    const target = ref.slice(2).split("/").reduce((node, key) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
    return normalized(value, target, root, strict);
  }
  if (Array.isArray(schema.anyOf)) {
    const variants: JsonObject[] = [...schema.anyOf].sort((a, b) =>
      Number(b.type === (value === null ? "null" : typeof value)) - Number(a.type === (value === null ? "null" : typeof value)));
    for (const variant of variants) {
      try {
        const candidate = normalized(value, variant, root, strict);
        if (unionValidator(variant, root)(candidate).valid) return candidate;
      } catch { /* The next union member may accept this value. */ }
    }
    return value;
  }
  if (schema.type === "object" && object(value)) {
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const property = schema.properties?.[key]
        ?? (object(schema.additionalProperties) ? schema.additionalProperties : undefined);
      Object.defineProperty(output, key, { value: property ? normalized(entry, property, root, strict) : entry,
        enumerable: true, configurable: true, writable: true });
    }
    for (const [key, property] of Object.entries(schema.properties ?? {}) as [string, JsonObject][])
      if (!(key in output) && "default" in property) output[key] = structuredClone(property.default);
    return output;
  }
  if (schema.type === "array" && Array.isArray(value) && object(schema.items))
    return value.map(item => normalized(item, schema.items, root, strict));
  if (!strict && (schema.type === "integer" || schema.type === "number")) {
    if (typeof value === "boolean") return Number(value);
    if (typeof value === "string" && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  if (!strict && schema.type === "boolean") {
    if (value === 0 || value === 1) return !!value;
    if (typeof value === "string") {
      if (["true", "1", "yes", "on", "y", "t"].includes(value.toLowerCase())) return true;
      if (["false", "0", "no", "off", "n", "f"].includes(value.toLowerCase())) return false;
    }
  }
  return value;
}

/** Shared execution/admission routing; a registration alone is never authorization or parity evidence. */
export function nativePublicBackendRoute(name: string, args: JsonObject, readOnly: boolean): string {
  const todo = todoCapabilities.find(item => item.transportName === name);
  if (todo) return todo.readOnly ? "legacy_capability_read" : "legacy_capability_call";
  if (name === "list_notes") return name;
  if (name === "subscription_broker_share_markers") return "legacy_subscription_share_markers";
  if (name === "action_capabilities") return "legacy_action_capabilities_read";
  if (name === "action_run_get" || name === "action_retrieve") return "legacy_action_read";
  const flags = catalog.routing[name];
  if (!flags) throw new Error("NOT_AVAILABLE: Missing enabled operation executor.");
  const indexed = ["get_knowledge", "get_script", "search_knowledge", "search_scripts", "retrieval_status"].includes(name)
    || ["get_note", "get_skill", "get_paper", "get_research"].includes(name)
      && /^(?:pkm:\/\/(?:knowledge|script|subscriptions)\/|knowledge_|script_)/.test(String(args.id || args.slug || args.name || ""))
    || ["search_notes", "search_skills", "search_research", "search_papers"].includes(name)
      && (args.detail === "standard" || (args.route ?? "lexical") !== "lexical");
  return flags.trash ? "legacy_knowledge_trash"
    : flags.assetClassification ? readOnly ? "legacy_asset_classification_preview" : "legacy_asset_classification_write"
    : ["action_artifact_import", "action_artifact_export"].includes(name) ? "legacy_action_artifact_write"
    : ["action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"].includes(name)
      ? readOnly ? "legacy_action_catalog_read" : "legacy_action_catalog_write"
    : flags.snapshot ? readOnly ? "legacy_snapshot_read" : "legacy_snapshot_write"
    : flags.action ? readOnly ? "legacy_action_read" : "legacy_action_write"
    : flags.recovery ? readOnly ? "legacy_knowledge_recovery_preview" : "legacy_knowledge_recovery_apply"
    : name === "retrieval_feedback" ? "legacy_indexed_knowledge_feedback"
    : flags.native ? readOnly ? "legacy_native_read" : "legacy_native_write"
    : ["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"].includes(name) ? "legacy_knowledge_write"
    : ["skill_feedback", "propose_skill_update"].includes(name) ? "legacy_skill_maintenance"
    : indexed ? "legacy_indexed_knowledge_read" : "legacy_knowledge_read";
}

export function createNativePublicFacade(backend: NativePublicBackend, options: {
  writable: boolean; assetClassification?: boolean; snapshotScheduler?: boolean;
  manifest: JsonObject; closeBackend(): Promise<void>; profile?: string;
  deployment?: DeploymentIntegrity;
  catalogProfile?: "compatibility" | "original-full";
  adapterCatalog?: NativePublicCatalog;
  adapterIdentity?: Readonly<Record<string, unknown>>;
  toolSurface?: "compact" | "hybrid";
  availability?: { enabledOperationIds: string[]; disabledOperationIds: string[]; limitations: string[] };
}) {
  if ((options.profile ?? process.env.PKM_CAPABILITY_PROFILE ?? "compact") !== "compact")
    throw new Error("Native public MCP supports PKM_CAPABILITY_PROFILE=compact only; use the explicit Python compatibility fixture for legacy profile.");
  if (options.toolSurface !== undefined && !["compact", "hybrid"].includes(options.toolSurface))
    throw new Error("INVALID_CONFIGURATION: Native public tool surface must be compact or hybrid.");
  if (options.adapterCatalog && options.catalogProfile !== "original-full")
    throw new Error("INVALID_CONFIGURATION: A live adapter catalog requires explicit original-operation dispatch.");
  const selectedCatalog = options.adapterCatalog
    ?? (options.catalogProfile === "original-full" ? originalPublicMcpContracts() as Catalog : catalog);
  initializeNumericLexemes(selectedCatalog);
  const selectedVariant = selectedCatalog.variants[`${Number(options.writable)}${Number(!!options.assetClassification)}${Number(!!options.snapshotScheduler)}`];
  if (!selectedVariant) throw new Error("Unsupported native MCP admission combination.");
  const enabled = new Set(selectedVariant.names);
  const allowed = options.availability && new Set(options.availability.enabledOperationIds);
  const availableLeaves = selectedCatalog.contracts.filter(contract => enabled.has(contract.transportName));
  const leaves = availableLeaves.filter(contract => !allowed || allowed.has(contract.id));
  const selectedAvailability = options.availability && (options.catalogProfile !== "original-full" || leaves.length !== availableLeaves.length) ? { ...selectedVariant,
    revision: createHash("sha256").update(JSON.stringify([selectedVariant.revision, options.availability])).digest("hex"),
  } : selectedVariant;
  const byId = new Map(leaves.map(contract => [contract.id, contract]));
  const hybrid = (options.toolSurface ?? (options.catalogProfile === "original-full" ? "hybrid" : "compact")) === "hybrid";
  const shortcuts = hybrid ? directModuleTools(selectedCatalog.contracts, new Set(byId.keys()), options.writable) : [];
  const shortcutMap = new Map(shortcuts.map(shortcut => [shortcut.tool.name, shortcut]));
  if (shortcuts.some(shortcut => selectedCatalog.wireDefinitions.some(tool => tool.name === shortcut.tool.name)))
    throw new Error("INVALID_CONFIGURATION: A direct module tool collides with a public tool.");
  const variant = hybrid ? { ...selectedAvailability, revision: createHash("sha256")
    .update(JSON.stringify([selectedAvailability.revision, "pkm.direct-module-tools/v1",
      shortcuts.map(shortcut => [shortcut.tool.name, shortcut.operationId])])).digest("hex") } : selectedAvailability;
  const exposed = [...selectedCatalog.wireDefinitions.map(tool => {
    if (!hybrid) return tool;
    if (tool.name === "capabilities_search") return { ...tool, inputSchema: boundedDiscoverySchema(tool.inputSchema), description: `${tool.description ?? ""}
Action discovery, not content search. Prefer visible module tools for common content tasks.
Use module + verb keywords (for example 'recipe run'); if unsure, browse capabilities_list instead.` };
    if (tool.name === "capabilities_list") return { ...tool, inputSchema: boundedDiscoverySchema(tool.inputSchema), description: `${tool.description ?? ""}
Browse this paged action catalog when search keywords are unknown. For document lists, use the visible module *_list tools.` };
    return tool;
  }), ...shortcuts.map(shortcut => shortcut.tool)];
  const definitions = hybrid ? exposed : selectedCatalog.definitions;
  const capturedInventory = hybrid ? undefined : selectedCatalog.inventory;
  const validation = new Map<string, JsonSchemaValidator<JsonObject>>();
  const lifecycle = new NativePublicMcpLifecycle(options.manifest, async () => {
    try { await options.deployment?.close(); await backend.close(); } finally { await options.closeBackend(); }
  }, { deployment: options.deployment });
  const definitionMap = new Map(definitions.map(definition => [definition.name, definition]));
  const metadataCache = new WeakMap<object, string>();
  const searchable = leaves.map(item => {
    const summary = { id: item.id, version: item.version, transportName: item.transportName,
      description: [...item.description].slice(0, 200).join(""), readOnly: item.readOnly };
    const aliases = shortcuts.filter(shortcut => shortcut.operationId === item.id).map(shortcut => shortcut.tool.name);
    return { item, summary, text: `${item.id} ${item.description} ${aliases.join(" ")}`.toLowerCase(),
      names: new Set([item.transportName.toLowerCase(), ...aliases]), fullBytes: selectedCatalog.contractBytes[item.id],
      summaryBytes: Buffer.byteLength(pythonMetadataJson(summary)) };
  });
  const encodedDefinitions = pythonMetadataJson([...definitions].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), true);
  const inventoryRevision = capturedInventory?.revision ?? createHash("sha256").update(encodedDefinitions).digest("hex");
  const inventoryTools = capturedInventory?.tools ?? [...definitions].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(definition => ({ name: definition.name, readOnly: !!definition.annotations?.readOnlyHint,
      schemaBytes: Buffer.byteLength(pythonMetadataJson(definition)) }));

  function parse(name: string, schema: JsonObject, input: unknown, strict = false): JsonObject {
    let validator = validation.get(name);
    if (!validator) { validator = validators.getValidator<JsonObject>(schema); validation.set(name, validator); }
    const args = normalized(input, schema, schema, strict), checked = validator(args);
    if (!checked.valid) throw new Error(`INVALID_ARGUMENT: Invalid arguments for ${name}: ${checked.errorMessage}`);
    return args as JsonObject;
  }

  async function canonical(action: string, args: JsonObject, workerToken?: unknown) {
    if (action === "call" && !options.writable) throw new Error("ACCESS_DENIED: This isolated MCP process is read-only.");
    const response = await backend.invoke(action === "call" ? "legacy_capability_call" : "legacy_capability_read", {
      action, args, ...(workerToken !== null && workerToken !== undefined ? { workerToken } : {}),
    });
    if (response.isError || !object(response.structuredContent))
      throw new Error(response.content.filter(item => item.type === "text").map(item => item.text).join("\n")
        || "The isolated canonical server returned an invalid result.");
    return response.structuredContent;
  }

  function discover(args: JsonObject, search: boolean) {
    const { offset, limit } = args, path = args.path ?? "", query = args.query ?? "";
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > discoveryPageLimit
      || typeof query !== "string" || query.length > 200 || typeof path !== "string" || path.length > 200)
      throw new Error("Provide bounded discovery arguments: offset >= 0, limit 1-10, query <= 200 characters");
    if (args.revision !== null && args.revision !== undefined && args.revision !== variant.revision)
      throw new Error("CONFLICT: Tool catalog changed; restart discovery");
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const exact = query.trim().toLowerCase();
    const matches = searchable.filter(entry => (!path || entry.item.id === path || entry.item.id.startsWith(`${path}.`))
      && words.every((word: string) => entry.text.includes(word)));
    matches.sort((a, b) => Number(!a.names.has(exact)) - Number(!b.names.has(exact))
      || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    const page: JsonObject = { schema: "pkm.capabilities/v1", revision: variant.revision, total: matches.length,
      offset, nextOffset: null, children: matches.length ? ["mcp.tool"] : [], operations: [] };
    let bytes = Buffer.byteLength(pythonMetadataJson(page));
    for (const entry of matches.slice(offset, offset + limit)) {
      const nextBytes = bytes + (search ? entry.fullBytes : entry.summaryBytes) + (page.operations.length ? 2 : 0);
      if (nextBytes > 15000) {
        if (!page.operations.length) throw new Error("Tool contract exceeds discovery result limit; no schema was truncated");
        break;
      }
      const operation = search ? entry.item : entry.summary;
      encodeMetadata(operation, metadataCache, true);
      page.operations.push(operation);
      bytes = nextBytes;
    }
    const next = offset + page.operations.length;
    page.nextOffset = next < matches.length ? next : null;
    return page;
  }

  async function leaf(operation: Contract, input: JsonObject): Promise<CallToolResult> {
    const name = operation.transportName, args = parse(name, operation.inputSchema, input);
    if (options.catalogProfile === "original-full") {
      if (!operation.readOnly && !options.writable)
        throw new Error("ACCESS_DENIED: This isolated MCP process is read-only.");
      return backend.invoke("original_mcp_public", { tool: name, arguments: args });
    }
    const todo = todoCapabilities.find(item => item.transportName === name);
    if (todo) {
      const { worker_token, ...rest } = args;
      const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null));
      const response = await canonical(todo.readOnly ? "read" : "call",
        { operation: todo.id, version: 1, arguments: fields }, worker_token);
      return result(response.result);
    }
    if (name === "list_notes") {
      const response = await backend.invoke(name, args);
      if (!object(response.structuredContent)) throw new Error("The isolated Note server returned an invalid result.");
      return result(response.structuredContent);
    }
    if (name === "subscription_broker_share_markers") {
      const { expectedRevision, ...rest } = args;
      const response = await backend.invoke("legacy_subscription_share_markers",
        { ...rest, ...(expectedRevision !== null ? { expectedRevision } : {}) });
      const envelope = response.structuredContent;
      if (response.isError || !object(envelope) || "error" in envelope) {
        const error = envelope?.error;
        throw new Error(object(error) ? `${error.code ?? "INTERNAL"}: ${error.message ?? "Subscription read failed."} (effect: ${error.effect ?? "unknown"})`
          : "The native Subscription read failed.");
      }
      if (!object(envelope.result)) throw new Error("The native Subscription server returned an invalid result.");
      return result(envelope.result);
    }
    const flags = catalog.routing[name];
    const route = nativePublicBackendRoute(name, args, operation.readOnly);
    const response = await backend.invoke(route, { tool: name, arguments: args });
    if (response.isError) throw new Error(response.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    const envelope = response.structuredContent;
    if (!object(envelope)) throw new Error("The isolated Knowledge server returned an invalid result.");
    if (name === "action_capabilities" || name === "action_run_get" || name === "action_retrieve"
      || flags?.native || flags?.dictionary || flags?.typed) return result(envelope.value);
    if (typeof envelope.text !== "string") throw new Error("The isolated Knowledge server returned an invalid result.");
    if (["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"].includes(name)) {
      const text = pythonMetadataJson(JSON.parse(envelope.text)).replace(/[\u007f-\uffff]/g,
        character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
      return result(text);
    }
    return result(envelope.text);
  }

  async function invoke(name: string, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const shortcut = shortcutMap.get(name);
    if (shortcut) return invoke(shortcut.readOnly ? "capability_read" : "capability_call",
      { operation: shortcut.operationId, version: 1, arguments: input ?? {} }, signal);
    const definition = definitionMap.get(name);
    if (!definition) throw new Error(hybrid
      ? "NOT_AVAILABLE: Tool is not exposed here. Use the visible module tools or capabilities_search; discovery grants no additional permissions."
      : "NOT_AVAILABLE: Tool is not in the compact public profile.");
    const control = ["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"].includes(name);
    if (!control) options.deployment?.assertAdmitted();
    const work = () => lifecycle.message(() => lifecycle.run(name, async () => {
      if (!control) options.deployment?.assertAdmitted();
      if ((name === "capability_read" || name === "capability_call")
        && (!object(input) || !Number.isInteger(input.version) || input.version !== 1))
        throw new Error("INVALID_ARGUMENT: Pin version 1 and provide object arguments");
      const args = parse(name, definition.inputSchema, input ?? {});
      if (name === "check_version") return result({
        name: publicName, version: "0.1.0", components: options.manifest.components,
        enabled_feature_domains: [], capabilities: ["managed-lifecycle-v1"], experimental: true, runtime: lifecycle.status(),
        ...(options.availability ? { availability: options.availability } : {}),
        ...(options.adapterIdentity ? { backend: options.adapterIdentity } : {}),
      });
      if (name === "mcp_lifecycle_status") return result(await lifecycle.drainedStatus());
      if (name === "mcp_lifecycle_quiesce") { lifecycle.quiesce(); return result(await lifecycle.drainedStatus()); }
      if (name === "capabilities_inventory") {
        if (!Number.isInteger(args.offset) || args.offset < 0 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)
          throw new Error("Inventory requires offset >= 0 and limit from 1 to 50");
        return result({ schema: "pkm.capability-inventory/v1", total: definitions.length, offset: args.offset,
          nextOffset: args.offset + args.limit < definitions.length ? args.offset + args.limit : null,
          revision: inventoryRevision, schemaBytes: capturedInventory?.schemaBytes ?? Buffer.byteLength(encodedDefinitions),
          measurement: capturedInventory?.measurement ?? "Serialized exposed MCP schemas; not provider tokens or invocation latency.",
          tools: inventoryTools.slice(args.offset, args.offset + args.limit) });
      }
      if (name === "capabilities_list" || name === "capabilities_search") {
        const search = name === "capabilities_search";
        if (!args.path.startsWith("todo") && !args.path.startsWith("memory")) return metadataResult(discover(args, search), metadataCache);
        const { revision, ...rest } = args;
        return result(await canonical(search ? "search" : "list", { ...rest, ...(revision !== null ? { revision } : {}) }));
      }
      if (name === "capabilities_describe") {
        if (!args.operation.startsWith("mcp.tool.")) return result(await canonical("describe", args));
        const page = discover({ path: args.operation, query: "", offset: 0, limit: 1 }, true);
        if (!page.operations.length) throw new Error("NOT_AVAILABLE: Operation is not in the enabled catalog");
        return metadataResult({ revision: page.revision, ...page.operations[0] }, metadataCache);
      }
      const readOnly = name === "capability_read";
      if (!args.operation.startsWith("mcp.tool.")) {
        const { worker_token, ...rest } = args;
        return result(await canonical(readOnly ? "read" : "call", rest, worker_token));
      }
      const operation = byId.get(args.operation);
      if (!operation) throw new Error("NOT_AVAILABLE: Operation is not in the enabled catalog");
      if (operation.readOnly !== readOnly) throw new Error("ACCESS_DENIED: Choose the matching read or mutation entry point");
      const fields = { ...args.arguments };
      if (args.worker_token !== null) {
        if (!("worker_token" in (operation.inputSchema.properties ?? {})))
          throw new Error("INVALID_ARGUMENT: This operation has no worker_token argument");
        if ("worker_token" in fields && fields.worker_token !== args.worker_token)
          throw new Error("INVALID_ARGUMENT: Conflicting worker tokens");
        fields.worker_token = args.worker_token;
      }
      return leaf(operation, fields);
    }, signal)).then(response => {
      if (!control) options.deployment?.assertAdmitted();
      return response;
    });
    return options.deployment ? options.deployment.foreground(work) : work();
  }

  return { lifecycle, definitions: exposed, invoke, close: () => lifecycle.close(),
    instructions: hybrid ? directModuleInstructions(shortcuts) : undefined };
}

export async function startNativePublicMcp(backend: NativePublicBackend,
  options: Parameters<typeof createNativePublicFacade>[1], transport?: Transport,
  boundary?: ReturnType<typeof createNativePublicStdio>) {
  const stdio = transport ? boundary : createNativePublicStdio();
  const wire = transport ?? stdio!.transport;
  const facade = createNativePublicFacade(backend, options);
  const server = new Server({ name: publicName, version: "0.1.0" },
    { capabilities: { tools: {} }, ...(facade.instructions ? { instructions: facade.instructions } : {}) });
  server.oninitialized = () => options.deployment?.initialized();
  server.setRequestHandler(ListToolsRequestSchema, async () => options.deployment
    ? options.deployment.foreground(async () => ({ tools: facade.definitions })) : { tools: facade.definitions });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await facade.invoke(request.params.name, request.params.arguments, extra.signal);
    }
    catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Native public MCP refused." }] };
    }
  });
  let closing: Promise<void> | undefined;
  let connected = false, transportClosed = false;
  const close = () => closing ??= (async () => {
    try { await facade.close(); } finally { await server.close(); }
  })();
  const monitored: Transport = {
    start: async () => {
      wire.onmessage = (message, extra) => { void facade.lifecycle.message(async () => monitored.onmessage?.(message, extra)); };
      wire.onerror = error => monitored.onerror?.(error);
      wire.onclose = () => {
        transportClosed = true; options.deployment?.cancel();
        monitored.onclose?.();
        if (connected) void close().catch(() => { process.exitCode = 1; });
      };
      await wire.start();
      stdio?.connectInput();
    },
    send: (message, extra) => {
      const work = () => facade.lifecycle.message(() => wire.send(message, extra));
      return options.deployment ? options.deployment.foreground(work) : work();
    },
    close: async () => { stdio?.disconnectInput(); await wire.close(); },
  };
  try {
    await server.connect(monitored);
    connected = true;
    if (transportClosed) throw new Error("Native MCP input closed during startup.");
  } catch (error) { await close(); throw error; }
  facade.lifecycle.startRetirement(close);
  return { ...facade, server, close };
}
