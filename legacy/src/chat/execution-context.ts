import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { accountMcpIdentity } from "../mcp/mcp-account-binding";

export const executionHostId = randomUUID();

export interface ChatExecutionContext {
  schema: "pkm.chat.execution/v1";
  hostId: string;
  targetId: string;
  accountId: string;
  knowledgeRoot: string;
  workspaceUris: string[];
  workspacePaths: string[];
  cwd: string | null;
  trusted: boolean;
  permissionMode: "protective" | "ask" | "read-only" | "allow-all";
  contextId: string;
  digest: string;
}

function hashes(context: Omit<ChatExecutionContext, "contextId" | "digest">) {
  const { permissionMode, ...environment } = context;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const contextId = hash(environment);
  return { contextId, digest: hash({ ...environment, permissionMode }) };
}

export function captureExecutionContext(hostId: string, folders: readonly { uri: { scheme: string; fsPath: string; toString(): string } }[], root: string,
  trusted: boolean, permissionMode: ChatExecutionContext["permissionMode"]): ChatExecutionContext {
  const workspacePaths = folders.map(folder => fs.realpathSync(folder.uri.fsPath));
  const workspaceUris = folders.map(folder => {
    const uri = folder.uri.toString();
    return uri.startsWith(`${folder.uri.scheme}:`) ? uri : pathToFileURL(folder.uri.fsPath).toString();
  });
  const context = { schema: "pkm.chat.execution/v1" as const, hostId, ...accountMcpIdentity(), knowledgeRoot: fs.realpathSync(root),
    workspaceUris, workspacePaths, cwd: workspacePaths[0] || null, trusted, permissionMode };
  const result = { ...context, ...hashes(context) };
  if (!validExecutionContext(result)) throw new Error("The sending window has no valid execution context.");
  Object.freeze(result.workspaceUris); Object.freeze(result.workspacePaths);
  return Object.freeze(result);
}

export function validExecutionContext(value: unknown): value is ChatExecutionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as ChatExecutionContext;
  if (Object.keys(context).length !== 12 || context.schema !== "pkm.chat.execution/v1" || typeof context.hostId !== "string" || !/^[a-f0-9-]{36}$/.test(context.hostId)
    || ![context.targetId, context.accountId, context.contextId, context.digest].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
    || typeof context.knowledgeRoot !== "string" || context.knowledgeRoot.length > 4096 || !path.isAbsolute(context.knowledgeRoot)
    || typeof context.trusted !== "boolean" || !["protective", "ask", "read-only", "allow-all"].includes(context.permissionMode)
    || !Array.isArray(context.workspaceUris) || !Array.isArray(context.workspacePaths) || context.workspaceUris.length !== context.workspacePaths.length || context.workspacePaths.length > 128
    || context.workspaceUris.some(uri => typeof uri !== "string" || uri.length > 4096 || !/^(file|vscode-remote):/.test(uri))
    || context.workspacePaths.some(root => typeof root !== "string" || root.length > 4096 || !path.isAbsolute(root))
    || context.cwd !== (context.workspacePaths[0] || null)) return false;
  const payload = { schema: context.schema, hostId: context.hostId, targetId: context.targetId, accountId: context.accountId, knowledgeRoot: context.knowledgeRoot,
    workspaceUris: context.workspaceUris, workspacePaths: context.workspacePaths, cwd: context.cwd, trusted: context.trusted, permissionMode: context.permissionMode };
  const expected = hashes(payload);
  return expected.contextId === context.contextId && expected.digest === context.digest;
}