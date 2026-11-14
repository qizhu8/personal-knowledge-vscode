import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originalRoot = resolve(root, "legacy");
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const originalPaths = ["src/chat/api-chat-client.ts", "src/chat/api-chat-models.ts", "src/chat/api-chat-vscode.ts", "tests/test-api-chat.js"];
const sourceFiles = [];
for (const path of originalPaths) {
  const text = await readFile(resolve(originalRoot, path), "utf8");
  sourceFiles.push({ path, sha256: hash(text), text });
}
function capture(path, name, startMarker, endMarker) {
  const file = sourceFiles.find(file => file.path === path);
  const start = file.text.indexOf(startMarker);
  const end = endMarker ? file.text.indexOf(endMarker, start + startMarker.length) : file.text.length;
  if (start < 0 || end < start) throw Error(`Missing original capture ${path}#${name}`);
  const text = file.text.slice(start, end);
  return { source: path, name, startLine: file.text.slice(0, start).split("\n").length,
    endLine: file.text.slice(0, end).split("\n").length - (text.endsWith("\n") ? 1 : 0), sha256: hash(text), text };
}
const declarations = [
  capture(originalPaths[0], "streamApiChat", "export async function streamApiChat(", undefined),
  capture(originalPaths[0], "chatTransportReceipt", "export function chatTransportReceipt(", "\nexport interface ChatModelActivity"),
  capture(originalPaths[1], "model-functions", "export interface ChatModelProfile", undefined),
  capture(originalPaths[3], "delta-and-done-fixtures", "const delta = text =>", "const testImage ="),
  capture(originalPaths[3], "http-fragmentation-and-usage-fixtures", "  let body;\n  let output", "  assert.deepStrictEqual([\"900\""),
];
const fixture = { schema: "pkm.model-provider-original-fixtures/v1", declarations };
await writeFile(resolve(root, "tests/model-provider-original-fixtures.mjs"),
  "// Exact original source captures. Regenerate with scripts/capture-model-provider.mjs.\nexport default " + JSON.stringify(fixture, null, 2) + ";\n");
const capturedPaths = [
  "src/model-provider-contracts.ts", "src/model-provider.ts", "src/domain/model-provider.ts",
  "tests/model-provider.test.mjs", "tests/model-provider-original.test.mjs", "tests/model-provider-original-fixtures.mjs",
  "scripts/capture-model-provider.mjs",
];
const capturedFiles = [];
for (const path of capturedPaths) capturedFiles.push({ path, sha256: hash(await readFile(resolve(root, path), "utf8")) });
const mappings = [
  ["src/chat/api-chat-client.ts", "src/model-provider.ts"],
  ["src/chat/api-chat-models.ts", "src/domain/model-provider.ts"],
  ["src/chat/api-chat-vscode.ts", "src/model-provider-contracts.ts"],
  ["tests/test-api-chat.js", "tests/model-provider-original-fixtures.mjs"],
];
const manifest = {
  schema: "pkm.model-provider-provenance/v1",
  roots: { original: ".. (relative to next-server)", captured: ". (next-server)" },
  sourceFiles: sourceFiles.map(({ text: _text, ...file }) => file),
  capturedFiles,
  files: mappings.map(([source, captured]) => ({
    source, sourceSha256: sourceFiles.find(file => file.path === source).sha256,
    captured, capturedSha256: capturedFiles.find(file => file.path === captured).sha256,
  })),
  captures: declarations.map(({ text: _text, ...entry }) => entry),
  behavior: {
    original: ["OpenAI chat/completions with stream=true; Azure deployment path and 2024-06-01 default version.",
      "Original explicitly disables SDK retries (maxRetries:0).",
      "Original maps tool messages with tool_call_id, assistant tool_calls, public content/refusal/reasoning_summary, never hidden reasoning_content.",
      "Original limits 16 streamed tool calls, 32000 argument characters and 100000 inference output bytes.",
      "Original output budget counts all reported completion tokens absent an explicit thinking allowance."],
    intentionalBoundaries: ["One inference only; no tool execution, tool loop, approval, durable turn orchestration, images, SDK, VS Code or native model discovery.",
      "Length is surfaced as a terminal partial-output event without tool proposals; other invalid completions throw sanitized classifications.",
      "No thinkingBudget parameter: hidden reasoning always counts against maxOutputTokens.",
      "Host-only injected config, transport, secret handle resolver and authorization; no default provider or ambient fetch.",
      "Exact endpoint allowlist, redirect:error, bounded SSE events/chunks/wire bytes/count/lifetime, strict UTF8 and explicit DONE required.",
      "Tool schema supports only documented bounded subset; unsupported keywords fail closed. No remote schema references.",
      "Transport errors are uncertain after open is invoked; retryability is advisory only and never permits automatic replay.",
      "Catalog configuration readiness is not proof of remote model availability. HTTP fetch behavior is tested in memory only."],
  },
};
await writeFile(resolve(root, "migration/model-provider-provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Captured ${sourceFiles.length} original files, ${declarations.length} exact spans, ${capturedFiles.length} isolated files.`);
