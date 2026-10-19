import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { parse, ParseError, visit } from "jsonc-parser";
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

function readConfig(filename: string): { text?: string; config: Record<string, unknown>; revision: string } {
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
  const config: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  assertUniqueProperties(text);
  if (!object(config) || ("mcpServers" in config && !object(config.mcpServers))) {
    throw new Error("Expected a JSON object with an mcpServers object. Existing configuration was not changed.");
  }
  return { text, config, revision: createHash("sha256").update(text).digest("hex") };
}

export function inspectCopilotMcpRegistration(
  definition: CopilotMcpDefinition,
  filename = copilotMcpConfigPath(),
): CopilotMcpRegistration {
  try {
    const { config, revision } = readConfig(filename);
    const servers = (config.mcpServers || {}) as Record<string, unknown>;
    for (const [name, server] of Object.entries(servers)) {
      if (name !== "pkm" && name.toLowerCase() === "pkm") {
        return { path: filename, state: "conflict", revision, detail: `A differently cased PKM entry "${name}" already exists. Review it before adding a registration.` };
      }
      if (name === "pkm" || !object(server)) continue;
      if (canonical(server) === canonical(definition)
        || (Array.isArray(server.args) && server.args.includes(definition.args[definition.args.length - 1]))) {
        return { path: filename, state: "conflict", revision, detail: `An equivalent PKM launch is already registered as "${name}". Review it; no duplicate will be added.` };
      }
    }
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

/** Explicit user action only. The reviewed revision fences edits made while the confirmation was open. */
export async function registerCopilotMcp(
  definition: CopilotMcpDefinition,
  reviewedRevision: string,
  filename = copilotMcpConfigPath(),
): Promise<{ changed: boolean; backup?: string; registration: CopilotMcpRegistration }> {
  const directory = path.dirname(filename);
  assertSafeParents(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeEntry(directory, true);
  return withCrossProcessLock(path.join(directory, ".pkm-mcp-config.lock"), "PKM Copilot CLI registration", 5_000, async () => {
    const inspection = inspectCopilotMcpRegistration(definition, filename);
    if (inspection.state === "invalid" || inspection.state === "conflict") throw new Error(inspection.detail);
    if (inspection.revision !== reviewedRevision) throw new Error("Copilot MCP configuration changed after review. Review and confirm again; nothing was written.");
    if (inspection.state === "matching") return { changed: false, registration: inspection };
    const original = readConfig(filename);
    const config = { ...original.config, mcpServers: { ...(original.config.mcpServers as Record<string, unknown> || {}), pkm: definition } };
    const temporary = path.join(directory, `.pkm-mcp-config.${randomUUID()}.tmp`);
    let backup: string | undefined;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      if (original.text !== undefined) {
        backup = `${filename}.pkm-backup-${randomUUID()}`;
        fs.writeFileSync(backup, original.text, { mode: 0o600, flag: "wx" });
      }
      if (readConfig(filename).revision !== reviewedRevision) throw new Error("Copilot MCP configuration changed during registration. Nothing was replaced; review and confirm again.");
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { changed: true, backup, registration: inspectCopilotMcpRegistration(definition, filename) };
  });
}
