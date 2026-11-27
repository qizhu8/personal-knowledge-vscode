import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { applyEdits, modify, parse, ParseError, visit } from "jsonc-parser";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { McpStdioCommand } from "./mcp-stdio-command";

export interface CopilotMcpDefinition extends McpStdioCommand {
  type: "local";
  tools: string[];
}

export interface CopilotMcpRegistration {
  path: string;
  state: "missing" | "matching" | "conflict" | "invalid";
  detail: string;
  revision?: string;
}

export function copilotMcpConfigPath(): string {
  return path.join(os.homedir(), ".copilot", "mcp-config.json");
}

export function copilotMcpDefinition(launch: McpStdioCommand): CopilotMcpDefinition {
  return {
    type: "local", command: launch.command, args: [...launch.args],
    ...(launch.env ? { env: { ...launch.env } } : {}), tools: ["*"],
  };
}

export function assertNoManualPkm(
  config: unknown,
  launch: McpStdioCommand,
): void {
  if (!object(config)) throw new Error("Expected an MCP configuration object.");
  if (config.servers === undefined) return;
  if (!object(config.servers)) throw new Error("Expected an MCP servers object.");
  for (const [name, server] of Object.entries(config.servers)) {
    if (name.toLowerCase() === "pkm"
      || (object(server) && Array.isArray(server.args) && server.args.includes(launch.args[launch.args.length - 1]))) {
      throw new Error(`Manual VS Code MCP entry "${name}" conflicts with the native PKM provider. Back up and remove that entry explicitly before selecting native discovery. No configuration was changed.`);
    }
  }
}

export function parseNativeMcpConfiguration(text: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid VS Code MCP JSONC configuration; no registration was changed.");
  assertUniqueProperties(text);
  return result;
}

export function vscodeMcpConfiguration(text: string, launch: McpStdioCommand & { cwd: string }): string {
  const source = text || "{}\n";
  const config = parseNativeMcpConfiguration(source);
  const definition = { type: "stdio", command: launch.command, args: launch.args, cwd: launch.cwd, ...(launch.env ? { env: launch.env } : {}) };
  if (object(config) && object(config.servers) && canonical(config.servers.pkm) === canonical(definition)) return text;
  assertNoManualPkm(config, launch);
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(bom.length);
  return bom + applyEdits(body, modify(body, ["servers", "pkm"], definition, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: body.includes("\r\n") ? "\r\n" : "\n" },
  }));
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertSafeEntry(filename: string, directory: boolean): void {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error(`Unsafe MCP configuration path: ${filename}. Symlinks and non-regular files are not modified.`);
  }
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) {
    throw new Error(`MCP configuration is not owned by this OS account: ${filename}`);
  }
}

function assertSafeParents(filename: string): void {
  let directory = path.dirname(filename);
  while (true) {
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe MCP configuration directory: ${directory}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function assertUniqueProperties(text: string): void {
  const objectKeys: Set<string>[] = [];
  visit(text.replace(/^\uFEFF/, ""), {
    onObjectBegin: () => { objectKeys.push(new Set()); },
    onObjectEnd: () => { objectKeys.pop(); },
    onObjectProperty: key => {
      const keys = objectKeys[objectKeys.length - 1];
      if (keys.has(key)) throw new Error("Duplicate JSON properties in MCP configuration. Review them manually; nothing was changed.");
      keys.add(key);
    },
  });
}

function readConfig(filename: string, vscode = false): { text?: string; config: Record<string, unknown>; revision: string } {
  assertSafeParents(filename);
  const directory = path.dirname(filename);
  if (fs.existsSync(directory)) assertSafeEntry(directory, true);
  try { fs.lstatSync(filename); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, revision: "missing" };
    throw error;
  }
  assertSafeEntry(filename, false);
  if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error("MCP configuration is too large to safely edit.");
  const text = fs.readFileSync(filename, "utf8");
  const errors: ParseError[] = [];
  const config: unknown = vscode ? parseNativeMcpConfiguration(text)
    : parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid Copilot MCP JSONC configuration; no registration was changed.");
  assertUniqueProperties(text);
  if (!object(config) || ("mcpServers" in config && !object(config.mcpServers))) {
    throw new Error("Expected a JSON object with an mcpServers object. Existing configuration was not changed.");
  }
  return { text, config, revision: createHash("sha256").update(text).digest("hex") };
}

export function inspectVscodeMcpRegistration(filename: string, launch: McpStdioCommand & { cwd: string }): { revision: string; text: string } {
  const current = readConfig(filename, true);
  return { revision: current.revision, text: vscodeMcpConfiguration(current.text || "", launch) };
}

export async function registerVscodeMcp(filename: string, launch: McpStdioCommand & { cwd: string }, reviewedRevision: string): Promise<void> {
  assertSafeParents(filename);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeEntry(directory, true);
  await withCrossProcessLock(path.join(directory, ".pkm-mcp-config.lock"), "PKM VS Code MCP registration", 5_000, async () => {
    const current = readConfig(filename, true);
    if (current.revision !== reviewedRevision) throw new Error("MCP configuration changed after review. Review and confirm again; nothing was written.");
    const text = vscodeMcpConfiguration(current.text || "", launch);
    if (text === current.text) return;
    const temporary = path.join(directory, `.pkm-mcp-config.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      if (current.text !== undefined) fs.writeFileSync(`${filename}.pkm-backup-${randomUUID()}`, current.text, { mode: 0o600, flag: "wx" });
      if (readConfig(filename, true).revision !== reviewedRevision) throw new Error("MCP configuration changed during registration. Nothing was replaced.");
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
  });
}

export function inspectCopilotMcpRegistration(
  definition: CopilotMcpDefinition,
  filename = copilotMcpConfigPath(),
): CopilotMcpRegistration {
  try {
    const { config, revision } = readConfig(filename);
    const servers = (config.mcpServers || {}) as Record<string, unknown>;
    const alias = conflictingCopilotAlias(servers, definition);
    if (alias) return { path: filename, state: "conflict", revision, detail: alias };
    if (Object.prototype.hasOwnProperty.call(servers, "pkm")) {
      if (canonical(servers.pkm) === canonical(definition)) {
        return { path: filename, state: "matching", revision, detail: "Matching user configuration exists. Client discovery, trust, connection and tool access have not been verified." };
      }
      return { path: filename, state: "conflict", revision, detail: "An existing pkm entry differs from this host's managed launch. Back up and review it manually; PKM will not replace it or change its tool approvals." };
    }
    return { path: filename, state: "missing", revision, detail: "No pkm entry exists in this default Copilot CLI user configuration. The account binding is not a CLI registration." };
  } catch (error: unknown) {
    return { path: filename, state: "invalid", detail: error instanceof Error ? error.message : String(error) };
  }
}

function conflictingCopilotAlias(servers: Record<string, unknown>, definition: CopilotMcpDefinition): string | undefined {
  const target = path.basename(definition.args[0] || "") === "compatibility-gateway-peer-cli.js"
    ? definition.args[1] : definition.args[definition.args.length - 1];
  for (const [name, server] of Object.entries(servers)) {
    if (name !== "pkm" && name.toLowerCase() === "pkm") {
      return `A differently cased PKM entry "${name}" already exists. Review it before adding a registration.`;
    }
    if (name === "pkm" || !object(server)) continue;
    if (canonical(server) === canonical(definition)
      || (target && Array.isArray(server.args) && server.args.includes(target))) {
      return `An equivalent PKM launch is already registered as "${name}". Review it; no duplicate will be added.`;
    }
  }
}

export function reviewCopilotMcpReplacement(filename = copilotMcpConfigPath()): CopilotMcpDefinition {
  const { config } = readConfig(filename);
  const existing = (config.mcpServers as Record<string, unknown> | undefined)?.pkm;
  if (!object(existing) || existing.type !== "local" || typeof existing.command !== "string"
    || !Array.isArray(existing.args) || !existing.args.every(arg => typeof arg === "string")
    || !Array.isArray(existing.tools) || !existing.tools.every(tool => typeof tool === "string")
    || existing.env !== undefined && (!object(existing.env) || !Object.values(existing.env).every(value => typeof value === "string"))) {
    throw new Error("Existing PKM registration is not a reviewed local launch with explicit tool selections. Review it manually; nothing was changed.");
  }
  const definition: CopilotMcpDefinition = {
    type: "local", command: existing.command, args: existing.args, tools: existing.tools,
    ...(object(existing.env) ? { env: Object.fromEntries(Object.entries(existing.env).map(([key, value]) => [key, String(value)])) } : {}),
  };
  if (canonical(existing) !== canonical(definition)) {
    throw new Error("Existing PKM registration contains additional settings. Review them manually before migration; nothing was changed.");
  }
  const inspection = inspectCopilotMcpRegistration(definition, filename);
  if (inspection.state !== "matching") throw new Error(inspection.detail);
  return definition;
}

/** Explicit user action only. The reviewed revision fences edits made while the confirmation was open. */
export async function registerCopilotMcp(
  definition: CopilotMcpDefinition,
  reviewedRevision: string,
  filename = copilotMcpConfigPath(),
  reviewedExisting?: CopilotMcpDefinition,
): Promise<{ changed: boolean; backup?: string; registration: CopilotMcpRegistration }> {
  const directory = path.dirname(filename);
  assertSafeParents(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeEntry(directory, true);
  return withCrossProcessLock(path.join(directory, ".pkm-mcp-config.lock"), "PKM Copilot CLI registration", 5_000, async () => {
    const original = readConfig(filename);
    let effectiveDefinition = definition;
    if (reviewedExisting) {
      const existing = (original.config.mcpServers as Record<string, unknown> | undefined)?.pkm;
      if (canonical(existing) !== canonical(reviewedExisting) || reviewedExisting.type !== "local"
        || !Array.isArray(reviewedExisting.tools) || !reviewedExisting.tools.every(tool => typeof tool === "string")) {
        throw new Error("Existing PKM registration changed or its tool approvals cannot be preserved. Review and confirm again; nothing was written.");
      }
      effectiveDefinition = { ...definition, tools: [...reviewedExisting.tools] };
      const existingInspection = inspectCopilotMcpRegistration(reviewedExisting, filename);
      if (existingInspection.state !== "matching") throw new Error(existingInspection.detail);
      const alias = conflictingCopilotAlias(original.config.mcpServers as Record<string, unknown>, effectiveDefinition);
      if (alias) throw new Error(alias);
    }
    const inspection = inspectCopilotMcpRegistration(effectiveDefinition, filename);
    if (inspection.state === "invalid" || inspection.state === "conflict" && !reviewedExisting) throw new Error(inspection.detail);
    if (inspection.revision !== reviewedRevision) throw new Error("Copilot MCP configuration changed after review. Review and confirm again; nothing was written.");
    if (inspection.state === "matching") return { changed: false, registration: inspection };
    const source = original.text || "{}\n";
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = source.slice(bom.length);
    const text = bom + applyEdits(body, modify(body, ["mcpServers", "pkm"], effectiveDefinition, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: body.includes("\r\n") ? "\r\n" : "\n" },
    }));
    const temporary = path.join(directory, `.pkm-mcp-config.${randomUUID()}.tmp`);
    let backup: string | undefined;
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      if (original.text !== undefined) {
        backup = `${filename}.pkm-backup-${randomUUID()}`;
        fs.writeFileSync(backup, original.text, { mode: 0o600, flag: "wx" });
      }
      if (readConfig(filename).revision !== reviewedRevision) throw new Error("Copilot MCP configuration changed during registration. Nothing was replaced; review and confirm again.");
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { changed: true, backup, registration: inspectCopilotMcpRegistration(effectiveDefinition, filename) };
  });
}
