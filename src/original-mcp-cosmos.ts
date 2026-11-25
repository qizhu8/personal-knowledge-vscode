import { z } from "zod";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { Storage } from "./storage.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { readNativePrivateCosmosConfiguration } from "./original-mcp-action-maintenance.js";
import { originalDefinitionValue } from "./domain/action-compiler-validation.js";
import { resolveActionExecutable } from "./action-program-build.js";
import { pinRegisteredActionPath, registeredActionPathExists } from "./original-mcp-registered-action-path.js";
import { pinRegisteredActionExecutable } from "./original-mcp-registered-action-executable.js";

export const originalCosmosActions = ["cosmos.directory.list", "cosmos.artifact.upload", "cosmos.artifact.download"] as const;
export const originalCosmosAction = (id: string) => originalCosmosActions.some(value => value === id);
const common = { uri: z.string().url().max(4096) };
const transfer = z.strictObject({ ...common, local_path: z.string().min(1).max(4096),
  overwrite: z.boolean().default(false), timeout_seconds: z.number().int().min(1).max(86400).default(300),
  thread_count: z.number().int().min(1).max(32).optional() });
export function nativeCosmosDefinition(storage: Storage, host: OriginalMcpNativeHost, id: string) {
  if (!originalCosmosAction(id)) throw new Error("UNKNOWN_COSMOS_ACTION");
  const config = readNativePrivateCosmosConfiguration(storage, host), executable = resolveActionExecutable("az");
  if (!executable) throw new Error("COSMOS_AZ_EXECUTABLE_REQUIRED");
  const cli = pinRegisteredActionExecutable(executable), listing = id === "cosmos.directory.list";
  return originalDefinitionValue({ schema: "pkm.action.definition/v1", action_id: id, version: config.version,
    description: `Private native az dls fs ${id}; configuration ${config.sha256}; executable closure ${JSON.stringify(cli.map(file => [file.path, file.sha256]))}.`,
    effects: [listing ? "remote-read" : id.endsWith("upload") ? "remote-write" : "local-write"],
    dependencies: {}, casts: {}, examples: [],
    input_schema: { type: "object", properties: { uri: { type: "string", format: "uri" },
      ...(!listing ? { local_path: { type: "string" }, overwrite: { type: "boolean", default: false },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400, default: 300 },
        thread_count: { type: "integer", minimum: 1, maximum: 32 } } : {}) },
      required: listing ? ["uri"] : ["uri", "local_path"], additionalProperties: false },
    output_schema: { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false },
    implementations: [{ id: "native-az-dls-fs", kind: "program", platforms: ["Linux"],
      program: executable, args: ["dls", "fs"] }],
  });
}
export function prepareNativeCosmos(storage: Storage, host: OriginalMcpNativeHost, id: string,
  input: Record<string, unknown>) {
  const config = readNativePrivateCosmosConfiguration(storage, host), listing = id === "cosmos.directory.list";
  const args = listing ? z.strictObject(common).parse(input) : transfer.parse(input);
  if (args.uri !== input.uri || /[\\\u0000-\u0020]/u.test(args.uri)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|[?#])/i.test(args.uri)
    || /%(?:2f|5c)/i.test(args.uri)) throw new Error("COSMOS_URI_INVALID");
  const uri = new URL(args.uri), decoded = decodeURIComponent(uri.pathname), parts = decoded.split("/");
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.port && uri.port !== "443" || uri.search || uri.hash
    || parts.length < 5 || parts[1] !== "cosmos" || parts[3] !== "shares"
    || parts.some(part => part === "." || part === "..") || /[\\\u0000-\u001f]/u.test(decoded)
    || /%(?:2e|2f|5c)/i.test(uri.pathname)) throw new Error("COSMOS_URI_INVALID");
  const binding = config.bindings.find(value => value.host === uri.hostname && value.vc === parts[2]!.toLowerCase());
  if (!binding) throw new Error("COSMOS_PRIVATE_BINDING_REQUIRED");
  const remote = posix.normalize("/" + parts.slice(3).join("/")), argv = ["dls", "fs"];
  let local: { kind: "source" | "destination"; path: string; parentPin: string;
    entryKind: "file" | "directory" | null; sha256: string | null } | null = null;
  if (listing) argv.push("list", "--account", binding.account, "--path", remote);
  else {
    const transferArgs = transfer.parse(args), path = resolve(storage.workspaceRoot(), transferArgs.local_path);
    const member = relative(storage.workspaceRoot(), path), parent = lstatSync(dirname(path));
    if (!member || isAbsolute(member) || member === ".." || member.startsWith(`..${sep}`)
      || realpathSync(dirname(path)) !== dirname(path) || !parent.isDirectory() || parent.isSymbolicLink()
      || parent.mode & 0o022 || parent.uid !== 0 && parent.uid !== process.getuid?.())
      throw new Error("COSMOS_LOCAL_PATH_CUSTODY_REQUIRED");
    const upload = id.endsWith("upload"), existing = registeredActionPathExists(path);
    if (!upload && existing && !transferArgs.overwrite) throw new Error("COSMOS_OVERWRITE_APPROVAL_REQUIRED");
    const pin = upload || existing ? pinRegisteredActionPath(path) : undefined;
    local = { kind: upload ? "source" : "destination", path,
      parentPin: [parent.dev, parent.ino, parent.uid, parent.mode].join(":"),
      entryKind: pin?.entryKind ?? null, sha256: pin?.sha256 ?? null };
    argv.push(upload ? "upload" : "download", "--account", binding.account, "--source-path",
      upload ? path : remote, "--destination-path", upload ? remote : path);
    if (transferArgs.overwrite) argv.push("--overwrite");
    if (transferArgs.thread_count !== undefined) argv.push("--thread-count", String(transferArgs.thread_count));
  }
  argv.push("--output", "json", "--only-show-errors");
  return { args: argv, local, configurationSha256: config.sha256 };
}
