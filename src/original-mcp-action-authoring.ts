import { hostname, machine } from "node:os";
import { join, resolve } from "node:path";
import { CoreError, type Actor } from "./contracts.js";
import { z } from "zod";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { legacyActionRead, legacyActionReadRequest, legacyActionWrite, legacyActionWriteRequest } from "./legacy-action-mcp.js";
import { legacyActionCatalog, legacyActionCatalogWriteRequest, legacyActionCatalogSources,
  readLegacyActionCatalogSources } from "./legacy-action-catalog.js";
import { legacyActionArtifact, publishLegacyActionPackage } from "./legacy-action-artifacts.js";
import { actionComponents, builtinActionDefinitions, loadModuleSet, originalDigest,
  moduleSnapshotDefinitions, type ActionModuleSnapshot } from "./domain/action-compiler-validation.js";
import { encodeLegacyActionPackage } from "./legacy-action-package.js";
import { approveOriginalMcpActionPackageSource, approveOriginalMcpActionPackageDestination } from "./original-mcp-action-package-admission.js";
import { actionModuleFileBytes, nativeActionModuleSourceProtocol, type ActionModuleFileContent } from "./action-module-bytes.js";
import { createHash } from "node:crypto";
import { ORIGINAL_ACTION_COMPILER_CAPTURE } from "./domain/action-compiler-original.js";
import { readOriginalMcpActionAuthoringSources, originalMcpActionSourceIsAdmitted,
  readOriginalMcpActionSource, readOriginalMcpActionModuleSets } from "./original-mcp-action-domain.js";

import { originalMcpActionAuthoringTool } from "./original-mcp-action-tools.js";
export { originalMcpActionAuthoringTool, originalMcpActionAuthoringOperationIds } from "./original-mcp-action-tools.js";

/** Public approval is not source admission, workspace trust, a picker grant or effect consent. */
export async function dispatchOriginalMcpActionAuthoring(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Actor, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage);
  const catalog = originalPublicMcpContracts() as { contracts: { id: string; transportName: string; readOnly: boolean }[] };
  const contract = catalog.contracts.find(item => item.transportName === tool);
  if (!contract || !originalMcpActionAuthoringTool(tool)) throw new CoreError("NOT_AVAILABLE", "No typed Action authoring operation.");
  if (actor.id !== "mcp:external" || actor.boardWorker || actor.recipeProtocol || !contract.readOnly && !actor.canWrite)
    throw new CoreError("ACCESS_DENIED", "Action authoring requires the fixed external native principal.");
  const pinned = structuredClone(args);
  if (!originalMcpPublicRequestMatches(storage, host, { operation: contract.id, version: 1, tool,
    readOnly: contract.readOnly, arguments: pinned, argumentsDigest: originalMcpRequestDigest(pinned) }))
    throw new CoreError("ACCESS_DENIED", "The exact fresh native public Action request is required.");
  const check = () => { signal?.throwIfAborted(); assertRootOwner(owner); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage); };
  check();
  const service = runtime.services.hostServices;
  const sources = readOriginalMcpActionAuthoringSources(storage, host);
  const assertSources = () => {
    check();
    if (originalMcpRequestDigest(readOriginalMcpActionAuthoringSources(storage, host)) !== originalMcpRequestDigest(sources))
      throw new CoreError("CONFLICT", "Admitted original Action authoring sources changed.");
  };
  const readRegistered = async (principal: Actor, actionId: string) => originalMcpActionSourceIsAdmitted(storage, actionId)
    ? readOriginalMcpActionSource(storage, host, actionId) : service?.automaticActionTrustEnabled
      ? service.readRegisteredAction(principal, actionId) : undefined;
  let value: unknown;
  if (["action_register", "action_graph_save", "action_template_create"].includes(tool)) {
    value = await legacyActionWrite(storage, actor, legacyActionWriteRequest.parse({ tool, arguments: pinned }),
      service?.automaticActionTrustEnabled ? (principal, proposalId, contentHash) => {
        check(); return service.admitActionProposal(principal, proposalId, contentHash);
      } : undefined, sources, assertSources);
  } else if (tool === "action_module_sets") {
    const current = await legacyActionCatalog(storage, actor, { tool, arguments: {} }) as { module_sets: Record<string, unknown>[] };
    const archived = sources.length ? readOriginalMcpActionModuleSets(storage, host).module_sets as Record<string, unknown>[] : [];
    const selected = new Map<string, Record<string, unknown>>();
    for (const item of [...archived, ...current.module_sets]) {
      const key = `${item.module_set_id}/${item.version}`, previous = selected.get(key);
      if (previous && previous.package_hash !== item.package_hash)
        throw new CoreError("CONFLICT", "Conflicting immutable original and native ModuleSet hashes.");
      selected.set(key, item);
    }
    value = { ok: true, module_sets: [...selected.values()] };
  } else if (["action_module_set_import", "action_module_set_load", "action_module_set_remove"].includes(tool)) {
    if (tool === "action_module_set_import")
      await approveOriginalMcpActionPackageSource(storage, host, actor, resolve(String(pinned.local_path)), signal);
    value = await legacyActionCatalog(storage, actor, legacyActionCatalogWriteRequest.parse({ tool, arguments: pinned }));
  } else if (tool === "action_module_set_export") {
    const parsed = exportArguments.parse(pinned);
    const catalogSources = await legacyActionCatalogSources(storage);
    const registered = service?.automaticActionTrustEnabled
      ? await service.prepareRegisteredActionExport(actor, parsed.action_ids) : undefined;
    const nativeSources = registered?.definitions.map(registeredCompilerSource) ?? [];
    const source = exportModule(parsed, [...catalogSources, ...sources, ...nativeSources]);
    const bytes = encodeLegacyActionPackage(source);
    const destination = await approveOriginalMcpActionPackageDestination(storage, host, actor, {
      moduleSetId: parsed.module_set_id, version: parsed.version, actionIds: parsed.action_ids, destination: resolve(parsed.destination),
    }, bytes, signal);
    value = { ...await publishLegacyActionPackage(storage, actor, resolve(String(pinned.destination)), bytes, () => {
      check(); assertSources();
      registered?.assertCurrent();
      destination?.assertCurrent();
      const database = storage.connectNative();
      try {
        if (originalDigest(readLegacyActionCatalogSources(database, host.receipt.workspaceId)) !== originalDigest(catalogSources))
          throw new CoreError("CONFLICT", "Selected native ModuleSet catalog changed before export.");
      } finally { database.close(); }
    }, async () => { await registered?.refresh(); await destination?.refresh(); check(); assertSources(); }),
    manifest: source.manifest, host_state_exported: false };
  } else if (tool === "action_artifact_import" || tool === "action_artifact_export") {
    const authorizePicked = await service?.preparePickedArtifactAccess(actor);
    const authorizeManaged = tool === "action_artifact_export"
      ? await service?.prepareManagedArtifactExport(actor, String(pinned.artifact_id)) : undefined;
    value = await legacyActionArtifact(storage, actor, tool === "action_artifact_import"
      ? { tool, local_path: String(pinned.local_path) }
      : { tool, artifact_id: String(pinned.artifact_id), destination: String(pinned.destination) },
    { authorizePicked: authorizePicked && ((id, artifact) => { check(); return authorizePicked(id, artifact); }),
      authorizeManaged: authorizeManaged && (() => { check(); return authorizeManaged(); }) });
  } else if (tool === "action_capabilities") {
    const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
    value = {
      schema: "pkm.action.capabilities/v1", version: "1.0.0", registry: join(storage.workspaceRoot(), "actions"),
      authoring: { schema: "pkm.action.authoring/v1", definition_schema: structuredClone(ORIGINAL_ACTION_COMPILER_CAPTURE.schema),
        implementation_kinds: ["program", "pipeline", "mcp"], unsupported_kinds: ["command", "python", "http"],
        lifecycle: [
          { tool: "action_definition_check", effect: "No persistence, execution, qualification or grant." },
          { tool: "action_register", effect: "Exact immutable proposal; callable only after current native host admission." },
          { tool: "action_call", effect: "Exact revision, input, source and effect authority remain mandatory; unknown outcomes are never replayed." },
        ] },
      execution_host: { hostname: hostname(), platform, architecture: machine(),
        filesystem: "Paths refer to this MCP execution host, not the caller shell.",
        identity: "Execution host OS account; credentials stay on that host.",
        selection: "Operator-managed local workspace/toolchain settings; not a per-call host selector." },
      scheduler_error: null, workspace_setting: "personalKnowledge.actions.workspaceRoots",
      settings: { workspace_roots: [storage.workspaceRoot()] }, platform, trusted_host_execution_is_sandboxed: false,
      tools: catalog.contracts.filter(item => item.transportName.startsWith("action_")).map(item => item.transportName),
      builtins: [...builtinActionDefinitions().keys()], basic_components: actionComponents(), enabled_platform_actions: [],
    };
  } else {
    value = await legacyActionRead(storage, actor, legacyActionReadRequest.parse({ tool, arguments: pinned }),
      undefined, readRegistered, undefined, sources);
  }
  check();
  return value;
}

const exportArguments = z.strictObject({
  module_set_id: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/), version: z.number().safe().int().positive(),
  action_ids: z.array(z.string()).min(1).max(100), destination: z.string().min(1),
  name: z.string().default(""), provenance: z.record(z.string(), z.json()).nullable().default(null),
});
function registeredCompilerSource(definition: Record<string, unknown>): ActionModuleSnapshot {
  const member = `definitions/${definition.action_id}.json`;
  const body = Object.fromEntries(Object.entries(definition).filter(([key]) => !["content_hash", "implementation_hash", "source_id"].includes(key)));
  const content = JSON.stringify(body), unsigned = {
    schema: "pkm.action.module-set/v1", module_set_id: `native.registry-${originalDigest(definition.action_id).slice(0, 24)}`,
    version: 1, actions: [definition.action_id], files: { [member]: createHash("sha256").update(content).digest("hex") },
    resources: {}, provenance: { authority: "current native registration compiler representation; not invocation authority" },
  };
  return { kind: "moduleSet", manifest: { ...unsigned, package_hash: originalDigest(unsigned) },
    files: { [member]: content }, enabled: true };
}
function exportModule(input: unknown, sources: ActionModuleSnapshot[]): ActionModuleSnapshot {
  const args = exportArguments.parse(input), available = moduleSnapshotDefinitions(sources), files: Record<string, ActionModuleFileContent> = {},
    resources: Record<string, unknown> = {}, selected = new Set<string>(), executables = new Set<string>();
  const visit = (id: string, ancestors: Set<string>) => {
    if (ancestors.has(id)) throw new CoreError("INVALID_ARGUMENT", "Cyclic package dependencies.");
    if (selected.has(id) || builtinActionDefinitions().has(id)) return;
    const definition = available.get(id);
    if (!definition) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Export requires the exact separately admitted Action source closure.");
    const source = sources.find(item => loadModuleSet(item).definitions.has(id))!;
    for (const [child, pin] of Object.entries(definition.dependencies as Record<string, unknown> ?? {})) {
      if ((available.get(child) ?? builtinActionDefinitions().get(child))?.content_hash !== pin)
        throw new CoreError("CONFLICT", "Export dependency revision changed.");
      visit(child, new Set([...ancestors, id]));
    }
    const definitionText = source.files[`definitions/${id}.json`];
    if (typeof definitionText !== "string") throw new CoreError("INVALID_DOCUMENT", "Packaged definitions must remain UTF-8 JSON.");
    const raw = JSON.parse(definitionText) as Record<string, unknown>;
    const authored = Object.fromEntries(Object.entries(raw).filter(([key]) => !["content_hash", "implementation_hash", "source_id"].includes(key)));
    files[`definitions/${id}.json`] = JSON.stringify(authored, null, 2) + "\n";
    const bindings = (source.manifest as { resources?: Record<string, Record<string, string>> }).resources?.[id];
    const selectedBindings: Record<string, string> = {};
    for (const reference of declaredResources(raw)) {
      const member = reference.startsWith("${module_assets}/")
        ? `assets/${reference.slice("${module_assets}/".length)}` : bindings?.[reference];
      const content = member && source.files[member];
      if (!member || content === undefined) throw new CoreError("NATIVE_AUTHORITY_REQUIRED",
        "Export requires each exact declared resource in the separately admitted package inventory.");
      if (files[member] !== undefined && !actionModuleFileBytes(files[member]!).equals(actionModuleFileBytes(content)))
        throw new CoreError("CONFLICT", "Conflicting declared source asset.");
      files[member] = content;
      if (bindings?.[reference]) selectedBindings[reference] = member;
      if ((source.manifest as { executables?: string[] }).executables?.includes(member)) executables.add(member);
    }
    if (Object.keys(selectedBindings).length) resources[id] = selectedBindings;
    selected.add(id);
  };
  for (const id of args.action_ids) visit(id, new Set());
  const unsigned = { schema: "pkm.action.module-set/v1", module_set_id: args.module_set_id, version: args.version,
    name: args.name || args.module_set_id, actions: [...selected].sort(),
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, createHash("sha256").update(actionModuleFileBytes(content)).digest("hex")])),
    resources, provenance: args.provenance ?? {}, ...(executables.size ? { executables: [...executables].sort() } : {}) };
  const source: ActionModuleSnapshot = { kind: "moduleSet", manifest: { ...unsigned, package_hash: originalDigest(unsigned) }, files, enabled: false,
    ...(Object.values(files).some(value => typeof value !== "string") ? { fileEncoding: nativeActionModuleSourceProtocol } : {}) };
  loadModuleSet(source);
  return source;
}

function declaredResources(value: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const record = (input: unknown): Record<string, unknown> =>
    input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const steps = (input: unknown, depth: number) => {
    if (depth > 12) throw new CoreError("RESOURCE_LIMIT", "Resource step nesting exceeds 12 levels.");
    for (const item of Array.isArray(input) ? input : []) {
      const step = record(item); visit(step.component ?? step.action_id, record(step.inputs), depth);
    }
  };
  const visit = (component: unknown, owner: Record<string, unknown>, depth: number) => {
    if (component === "core.file-path" && typeof owner.path === "string") result.add(owner.path);
    const fields = component === "core.if-else" ? ["then_steps", "else_steps"] : component === "core.switch"
      ? ["default_steps"] : component === "core.for" || component === "core.while" ? ["body"] : [];
    for (const field of fields) steps(owner[field], depth + 1);
    if (component === "core.switch") for (const item of Array.isArray(owner.cases) ? owner.cases : [])
      steps(record(item).steps, depth + 1);
  };
  const typed = (owner: Record<string, unknown>) => {
    steps(owner.steps, 0);
    const nodes = record(owner.graph).nodes;
    for (const input of Array.isArray(nodes) ? nodes : []) {
      const node = record(input); visit(node.action_id, record(node.parameters), 0);
    }
  };
  typed(value);
  for (const input of Array.isArray(value.implementations) ? value.implementations : []) {
    const implementation = record(input); typed(implementation);
    for (const owner of [implementation, record(implementation.build), record(implementation.server)]) {
      for (const field of ["files", "source_files"]) for (const reference of Array.isArray(owner[field]) ? owner[field] as unknown[] : [])
        if (typeof reference === "string") result.add(reference);
      if (typeof owner.program === "string" && (owner.program.startsWith("pkm://") || owner.program.startsWith("${module_assets}/")))
        result.add(owner.program);
    }
  }
  return result;
}
