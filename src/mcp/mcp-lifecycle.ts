import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";

export const MCP_LIFECYCLE_SCHEMA = "pkm.mcp.lifecycle/v1";
export interface ManagedMcpManifest {
  schema: typeof MCP_LIFECYCLE_SCHEMA;
  generation: string;
  managedRoot: string;
  version: string;
  components: Record<string, string>;
  extensionVersion: string;
  runtimeBuild: string;
  node: string;
  enabledFeatureDomains: string[];
  runtimeMaintenance?: string;
  files: Record<string, string>;
  compatibility?: { protocol: string; components: Record<string, string> };
}

function copyTree(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Managed MCP runtime cannot contain symlinks: ${entry.name}`);
    if (entry.isDirectory()) {
      if (!["__pycache__", ".git"].includes(entry.name)) copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    } else if (/\.(js|json|py|template)$/.test(entry.name)) {
      fs.copyFileSync(path.join(source, entry.name), path.join(destination, entry.name), fs.constants.COPYFILE_EXCL);
    }
  }
}

function fileHashes(directory: string, prefix = ""): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(hashes, fileHashes(path.join(directory, entry.name), relative));
    else if (entry.isFile()) hashes[relative] = createHash("sha256").update(fs.readFileSync(path.join(directory, entry.name))).digest("hex");
    else throw new Error(`Unsupported managed MCP generation entry: ${relative}`);
  }
  return hashes;
}

function buildDigest(files: Record<string, string>): string {
  const digest = createHash("sha256");
  Object.keys(files).sort().forEach(name => digest.update(name).update("\0").update(files[name]).update("\0"));
  return digest.digest("hex");
}

let bundledBuildCache: { key: string; digest: string } | undefined;
export function bundledMcpBuildIdentity(extensionRoot: string): string {
  const files: string[] = ["package.json"];
  const collect = (directory: string): void => {
    for (const entry of fs.readdirSync(path.join(extensionRoot, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Managed MCP build cannot contain symlinks: ${relative}`);
      if (entry.isDirectory() && !["__pycache__", ".git"].includes(entry.name)) collect(relative);
      else if (entry.isFile() && /\.(js|json|py|template)$/.test(entry.name)) files.push(relative);
    }
  };
  collect("dist"); collect("resources"); files.sort();
  const key = extensionRoot + "\0" + files.map(name => {
    const stat = fs.statSync(path.join(extensionRoot, name));
    return `${name}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join("\0");
  if (bundledBuildCache?.key === key) return bundledBuildCache.digest;
  const hashes = Object.fromEntries(files.map(name => [
    name, createHash("sha256").update(fs.readFileSync(path.join(extensionRoot, name))).digest("hex"),
  ]));
  const digest = buildDigest(hashes);
  bundledBuildCache = { key, digest };
  return digest;
}

export function readManagedMcpManifest(directory: string): ManagedMcpManifest | undefined {
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(directory, "active-generation.json"), "utf8"));
    const latestPath = path.join(directory, "latest-generation.json");
    const active = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : baseline;
    if (active.schema !== MCP_LIFECYCLE_SCHEMA || baseline.schema !== MCP_LIFECYCLE_SCHEMA
      || !/^[a-f0-9-]{36}$/.test(baseline.generation)
      || baseline.generation !== active.generation && baseline.compatibilityBaseline !== true) return undefined;
    return readManagedMcpGeneration(directory, active.generation);
  } catch { return undefined; }
}

export function readManagedMcpGeneration(directory: string, generation: string): ManagedMcpManifest | undefined {
  try {
    if (!/^[a-f0-9-]{36}$/.test(generation)) return undefined;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "generations", generation, "manifest.json"), "utf8"));
    if (manifest.schema !== MCP_LIFECYCLE_SCHEMA || manifest.generation !== generation
      || path.resolve(manifest.managedRoot) !== path.resolve(directory)
      || typeof manifest.version !== "string" || typeof manifest.extensionVersion !== "string"
      || typeof manifest.node !== "string" || !/^[a-f0-9]{64}$/.test(manifest.runtimeBuild)
      || !manifest.components || ["knowledge", "chat", "recipes", "agent_sessions"].some(key => typeof manifest.components[key] !== "string")
      || !Array.isArray(manifest.enabledFeatureDomains)
      || manifest.enabledFeatureDomains.some((domain: unknown) => !["knowledge", "automation", "skillRouter"].includes(String(domain)))
      || !manifest.files || Object.values(manifest.files).some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) return undefined;
    if (manifest.compatibility !== undefined && (!manifest.compatibility
      || typeof manifest.compatibility.protocol !== "string"
      || !manifest.compatibility.components || typeof manifest.compatibility.components !== "object"
      || Array.isArray(manifest.compatibility.components)
      || Object.entries(manifest.components).some(([name, version]) =>
        typeof version !== "string" || manifest.compatibility.components[name] !== version.split(".")[0]))) return undefined;
    return manifest;
  } catch { return undefined; }
}

export function managedMcpApiCompatible(previous: ManagedMcpManifest, next: ManagedMcpManifest): boolean {
  const contract = (manifest: ManagedMcpManifest) => manifest.compatibility || {
    protocol: "pkm.mcp.api/1",
    components: Object.fromEntries(Object.entries(manifest.components).map(([name, version]) => [name, version.split(".")[0]])),
  };
  const before = contract(previous), after = contract(next);
  return before.protocol === "pkm.mcp.api/1" && before.protocol === after.protocol
    && Object.keys(before.components).length > 0
    && Object.entries(before.components).every(([name, major]) => /^\d+$/.test(major) && after.components[name] === major)
    && previous.enabledFeatureDomains.every(domain => next.enabledFeatureDomains.includes(domain));
}

/** Publish only a complete generation. The caller holds the cross-window generation lock. */
export function stageManagedMcpGeneration(
  directory: string, extensionRoot: string,
  versions: { version: string; components: Record<string, string>; runtimeMaintenance?: string },
  generate: (generationDirectory: string) => void,
): ManagedMcpManifest {
  const generation = randomUUID();
  const target = path.join(directory, "generations", generation);
  fs.mkdirSync(target, { recursive: true });
  try {
    const runtime = path.join(target, "runtime");
    copyTree(path.join(extensionRoot, "dist"), path.join(runtime, "dist"));
    copyTree(path.join(extensionRoot, "resources"), path.join(runtime, "resources"));
    fs.copyFileSync(path.join(extensionRoot, "package.json"), path.join(runtime, "package.json"));
    generate(target);
    const manifest: ManagedMcpManifest = {
      schema: MCP_LIFECYCLE_SCHEMA, generation, managedRoot: path.resolve(directory), ...versions,
      extensionVersion: JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).version,
      runtimeBuild: buildDigest(fileHashes(runtime)),
      node: process.execPath,
      enabledFeatureDomains: fs.existsSync(path.join(target, "feature-domains.json"))
        ? JSON.parse(fs.readFileSync(path.join(target, "feature-domains.json"), "utf8")).enabled : [],
      compatibility: {
        protocol: "pkm.mcp.api/1",
        components: Object.fromEntries(Object.entries(versions.components).map(([name, version]) => {
          const match = /^(\d+)\.\d+\.\d+$/.exec(version);
          if (!match) throw new Error(`Invalid MCP component API version: ${name}`);
          return [name, match[1]];
        })),
      },
      files: fileHashes(target),
    };
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function publishManagedMcpGeneration(directory: string, manifest: ManagedMcpManifest): void {
  const baselinePath = path.join(directory, "active-generation.json");
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : undefined;
  const predecessor = baseline && readManagedMcpGeneration(directory, baseline.generation);
  const retainBaseline = predecessor && managedMcpApiCompatible(predecessor, manifest);
  const temporary = path.join(directory, `.active-${randomUUID()}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema:MCP_LIFECYCLE_SCHEMA,
      generation:retainBaseline ? predecessor.generation : manifest.generation,
      ...(retainBaseline ? { compatibilityBaseline:true } : {}) }) + "\n", { flag:"wx", mode:0o600 });
    fs.renameSync(temporary, baselinePath);
    fs.writeFileSync(temporary, JSON.stringify({ schema:MCP_LIFECYCLE_SCHEMA, generation:manifest.generation }) + "\n", { flag:"wx", mode:0o600 });
    fs.renameSync(temporary, path.join(directory, "latest-generation.json"));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function withManagedMcpGenerationLock<T>(directory: string, operation: () => T): T {
  fs.mkdirSync(directory, { recursive: true });
  return withCrossProcessLockSync(path.join(directory, ".generation-lock"), "Managed MCP generation", operation);
}

export function managedMcpLifecycleStatus(directory: string, now = Date.now()): {
  configuredGeneration: string; generation: string; connectionState: "unverified"; state: "unverified"; reason: string; action: string; instances: any[];
} {
  const manifest = readManagedMcpManifest(directory);
  const instances: any[] = [];
  const registry = path.join(directory, "instances");
  if (fs.existsSync(registry)) for (const name of fs.readdirSync(registry).filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(registry, name), "utf8"));
      if (record.schema !== MCP_LIFECYCLE_SCHEMA) continue;
      const age = now - record.heartbeatAt * 1000;
      const fresh = typeof record.heartbeatAt === "number" && age >= 0 && age < 3_000;
      instances.push({ ...record, observedState: fresh ? record.phase : "unknown", heartbeatFresh: fresh,
        completionVerified: fresh && ["drained", "retired"].includes(record.phase)
          && record.inFlight === 0 && record.uncertainCalls === 0 && !record.controlError });
    } catch { instances.push({ instanceId: name.slice(0, -5), observedState: "unknown", completionVerified: false }); }
  }
  return {
    configuredGeneration: manifest?.generation || "", generation: manifest?.generation || "",
    connectionState: "unverified", state: "unverified",
    reason: manifest
      ? "Managed runtime prepared; actual client connection not yet verified. Reconnect and complete the same-client version/build/generation/capability handshake."
      : "Managed runtime generation is not prepared. Legacy client drain state is unknown; explicit reconnect/action required.",
    action: "Reconnect the actual client and verify version, schemas, generation and tools. Legacy/uninstrumented or stale instances have unknown drain state; never replay uncertain writes.",
    instances,
  };
}

export function managedMcpLauncher(manifest: ManagedMcpManifest): string {
  return `#!/usr/bin/env python3
"""Stable PKM managed launcher. A running process never reloads its generation."""
SERVER_VERSION = ${JSON.stringify(manifest.version)}
KNOWLEDGE_SCHEMA_VERSION = ${JSON.stringify(manifest.components.knowledge)}
CHAT_SCHEMA_VERSION = ${JSON.stringify(manifest.components.chat)}
RECIPE_SCHEMA_VERSION = ${JSON.stringify(manifest.components.recipes)}
AGENT_SESSION_SCHEMA_VERSION = ${JSON.stringify(manifest.components.agent_sessions)}
import hashlib, json, pathlib, re, runpy, sys
root = pathlib.Path(__file__).resolve().parent
if (root / "runtime-maintenance.json").exists():
    raise SystemExit("PKM runtime maintenance is action-required; wait for repair to finish before reconnecting.")
baseline = json.loads((root / "active-generation.json").read_text(encoding="utf-8"))
latest = root / "latest-generation.json"
active = json.loads(latest.read_text(encoding="utf-8")) if latest.exists() else baseline
if baseline.get("schema") != "pkm.mcp.lifecycle/v1" or not re.fullmatch(r"[a-f0-9-]{36}", str(baseline.get("generation", ""))):
    raise SystemExit("PKM managed compatibility baseline is invalid.")
if baseline["generation"] != active.get("generation") and baseline.get("compatibilityBaseline") is not True:
    raise SystemExit("PKM managed API transition is incomplete; no tool was invoked.")
generation = active.get("generation", "")
if active.get("schema") != "pkm.mcp.lifecycle/v1" or not re.fullmatch(r"[a-f0-9-]{36}", generation):
    raise SystemExit("Invalid PKM managed generation; repair and reconnect.")
directory = root / "generations" / generation
manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
if manifest.get("runtimeMaintenance") and pathlib.Path(manifest["runtimeMaintenance"]).exists():
    raise SystemExit("Shared PKM Python runtime is under maintenance; reconnect after repair.")
if manifest.get("schema") != active["schema"] or manifest.get("generation") != generation or pathlib.Path(manifest["managedRoot"]).resolve() != root:
    raise SystemExit("PKM managed generation ownership mismatch.")
for name, digest in manifest["files"].items():
    target = directory / name
    if target.is_symlink() or not target.resolve().is_relative_to(directory.resolve()) or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise SystemExit("PKM managed runtime integrity mismatch: " + name)
sys.dont_write_bytecode = True
sys.path.insert(0, str(directory))
runpy.run_path(str(directory / "server.py"), run_name="__main__")
`;
}

export interface ManagedMcpHandshake {
  state: "ready" | "reconnect-required" | "incompatible";
  reason: string;
  generation?: string;
}

/** Evidence must come from the actual connected client, never generated source/process discovery. */
export function verifyManagedMcpHandshake(
  expected: ManagedMcpManifest | undefined, version: any, lifecycle: any, tools: readonly string[],
): ManagedMcpHandshake {
  if (!expected || !lifecycle || lifecycle.schema !== MCP_LIFECYCLE_SCHEMA) {
    return { state: "reconnect-required", reason: "This connection has no verified managed lifecycle. Reconnect explicitly; old uninstrumented calls cannot be safely drained." };
  }
  if (version?.version !== expected.version || lifecycle.generation !== expected.generation
    || lifecycle.runtimeBuild !== expected.runtimeBuild
    || lifecycle.phase !== "accepting" || !lifecycle.acceptingNewCalls
    || lifecycle.version !== expected.version
    || Object.entries(expected.components).some(([key, value]) => version.components?.[key] !== value || lifecycle.components?.[key] !== value)) {
    return { state: "incompatible", reason: "Connected runtime/version/schema/generation differs from the active managed runtime. Do not replay uncertain writes." };
  }
  const required = ["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"];
  const domains = expected.enabledFeatureDomains;
  if (!Array.isArray(version.enabled_feature_domains)
    || [...version.enabled_feature_domains].sort().join(",") !== [...domains].sort().join(",")) {
    return { state: "incompatible", reason: "Connected feature domains differ from the managed generation." };
  }
  if (domains.includes("knowledge")) required.push("add_skill", "update_skill", "delete_skill", "knowledge_file_trash");
  if (domains.includes("automation")) required.push("chat_capabilities", "chat_join", "chat_standby", "chat_post");
  if (!Array.isArray(version.capabilities) || !version.capabilities.includes("managed-lifecycle-v1")
    || required.some(name => !tools.includes(name))) {
    return { state: "incompatible", reason: "Successor is missing required advertised lifecycle/Skill/Chat capabilities or tools." };
  }
  return { state: "ready", reason: "Actual connected runtime verified; no prior calls were replayed.", generation: expected.generation };
}

export async function handshakeManagedMcpConnection(
  directory: string, invoke: (tool: string, arguments_: Record<string, never>) => Promise<any>, tools: readonly string[], timeoutMs = 10_000,
): Promise<ManagedMcpHandshake> {
  const expected = readManagedMcpManifest(directory);
  if (!expected) return verifyManagedMcpHandshake(undefined, undefined, undefined, tools);
  try {
    const [version, lifecycle] = await boundedLifecycleRead(
      Promise.all([invoke("check_version", {}), invoke("mcp_lifecycle_status", {})]), timeoutMs);
    const actual = typeof lifecycle?.generation === "string" ? readManagedMcpGeneration(directory, lifecycle.generation) : undefined;
    const result = verifyManagedMcpHandshake(actual, version, lifecycle, tools);
    if (actual && !managedMcpApiCompatible(actual, expected)) {
      return { state:"incompatible", reason:"The connected MCP API or enabled feature domains are not compatible with the configured runtime." };
    }
    if (readManagedMcpManifest(directory)?.generation !== expected.generation) {
      return { state: "incompatible", reason: "Managed generation changed during successor handshake. Reconnect explicitly; do not replay writes." };
    }
    return result;
  } catch {
    return { state: "reconnect-required", reason: "Actual connected runtime did not complete version/capability lifecycle verification. No prior call was replayed." };
  }
}

export async function boundedLifecycleRead<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Lifecycle observation timed out")), Math.max(1, timeoutMs));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function waitForManagedMcpDrain(
  invoke: (tool: string, arguments_: Record<string, never>) => Promise<any>, timeoutMs = 30_000, pollMs = 100,
): Promise<{ state: "drained" | "action-required"; reason: string; runtime?: any }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let runtime: any;
  try {
    do {
      runtime = await boundedLifecycleRead(invoke("mcp_lifecycle_status", {}), deadline - Date.now());
      if (runtime?.schema !== MCP_LIFECYCLE_SCHEMA || typeof runtime.generation !== "string"
        || !runtime.generation || runtime.acceptingNewCalls || !["draining", "drained", "action-required"].includes(runtime.phase)) {
        return { state: "action-required", reason: "Old connection has no verified admission fence. Legacy instances require explicit client reconnect; drain is unknown.", runtime };
      }
      if (runtime.phase === "drained" && runtime.inFlight === 0 && runtime.uncertainCalls === 0) {
        return { state: "drained", reason: "Actual instrumented calls completed; caller may close its owned connection and verify a successor.", runtime };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(1, pollMs), remaining)));
    } while (Date.now() < deadline);
  } catch { /* An unavailable transport is unknown, never a drain receipt. */ }
  return { state: "action-required", reason: "Drain observation expired or connection was lost. Review uncertain writes; no call was replayed and no process was terminated.", runtime };
}
