import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const selected = [
  ["src/chat/api-chat-client.ts", ["ChatImage", "ApiChatMessage", "ApiChatTool", "ApiChatToolEvent"]],
  ["src/capabilities/registry.ts", ["Capability", "CapabilityError", "validateCapabilityInput", "CapabilityRegistry"]],
  ["src/chat/capability-tools.ts", ["coreTools", "nativeReads", "nativeToolCapabilities", "projectNativeCapabilityEvent", "capabilityTools"]],
  ["src/chat/chat-tool-execution.ts", ["boundedToolContext", "chatToolResultContext", "chatToolBatchContext", "ChatToolScheduler", "executeChatToolBatch", "cancellable"]],
];
const support = `
interface ApiChatRequest {
  tools?: ApiChatTool[];
  onTool?: (event: ApiChatToolEvent) => void;
  onToolResultContext?: (event: ApiChatToolEvent) => string | undefined;
  onToolResultsContext?: (events: readonly ApiChatToolEvent[]) => string | undefined;
  afterTools?: () => boolean;
}
interface ChatToolLoopGuard {
  summarizing: boolean;
  beforeRound(round: number, signal: AbortSignal): Promise<void>;
  reuse(name: string, args: string, messages: ApiChatMessage[], version?: string): {result: string; original: string} | undefined;
  record(tool: ApiChatTool | undefined, name: string, args: string, result: string, success?: boolean): void;
  remember(name: string, args: string, id: string, result: string, success: boolean, version?: string): void;
}
`;
const declarations = [];
for (const [source, names] of selected) {
  const text = await readFile(resolve(repository, source), "utf8");
  const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const matches = ast.statements.filter(node => node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(entry => entry.name.getText(ast) === name));
    if (matches.length !== 1) throw new Error(`Original tool gateway capture boundary changed: ${source}:${name}`);
    declarations.push(matches[0].getText(ast));
  }
}
const captured = "src/domain/tool-gateway-original.ts";
await writeFile(resolve(root, captured), "// Exact AST-selected original declarations; only external Host types are structurally narrowed below.\n"
  + 'import { createHash } from "node:crypto";\n' + support + "\n" + declarations.join("\n\n") + "\n");
const hash = data => createHash("sha256").update(data).digest("hex");
const files = await Promise.all(selected.map(async ([source, declarations]) => ({
  source, captured, declarations,
  sourceSha256: hash(await readFile(resolve(repository, source))),
  capturedSha256: hash(await readFile(resolve(root, captured))),
})));
await writeFile(resolve(root, "migration/tool-gateway-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1",
  transformation: "AST-selected original capability schema binding, discovery, native classification, context validation and batch scheduler/execution bodies are unchanged. Only ApiChatRequest and ChatToolLoopGuard dependency types are narrowed to the exact used members. New native gateway adds fixed authenticated actor/context, Core receipt identifiers, exact approval verifier, bounded steps/deadlines, redaction and unknown outcomes; it does not migrate filesystem/process executors or permit dynamic discovery authority.",
  files,
}, null, 2) + "\n");
