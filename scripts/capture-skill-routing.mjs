import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const files = [];
async function capture(sourcePath, captured, transform) {
  const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declaration = name => {
    const found = parsed.statements.filter(node => node.name && ts.isIdentifier(node.name) && node.name.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
    if (found.length !== 1) throw new Error(`Skill routing capture boundary changed: ${name}`);
    return found[0].getText(parsed);
  };
  const content = await transform(source, declaration);
  await writeFile(resolve(packageRoot, captured), content);
  files.push({ source: sourcePath, captured, sourceSha256: hash(source), capturedSha256: hash(content) });
}
await capture("src/skills/skill-router-config.ts", "src/domain/skill-routing-sources.ts", source => source);
await capture("src/skills/pkm-skill-projection.ts", "src/domain/skill-routing-projection.ts", (_, get) => {
  const read = get("readSource");
  const start = read.indexOf("  const match =");
  if (start < 0) throw new Error("Router source parsing boundary changed.");
  const pureRead = `export function readProjectionSource(raw: string) {\n${read.slice(start)
    .replace("path: sourcePath, ", "")}`;
  const render = get("renderProjection")
    .replace(/function renderProjection\([^]*?\): \{ content: string; sourceHash: string; sourcePath: string \}/,
      "export function renderProjection(raw: string, target: { kind: PkmSkillTargetKind }, extensionVersion: string): { content: string; sourceHash: string }")
    .replace("const source = readSource(context, createSource);", "const source = readProjectionSource(raw);")
    .replace('String(context.extension?.packageJSON?.version || "unknown")', 'String(extensionVersion || "unknown")')
    .replace("sourcePath: source.path", "");
  return `import { createHash } from "node:crypto";\n` +
    ["PKM_SKILL_ROUTER_VERSION", "PKM_SKILL_MIN_MCP_VERSION", "PKM_SKILL_SOURCE_RELATIVE", "MARKER_PREFIX", "MARKER_SUFFIX",
      "PkmSkillTargetKind", "ProjectionMarker", "sha256", "markerLine", "parseMarker"]
      .map(name => get(name).replace('path.join("System", "PKM", "PKM Skills.md")', '"System/PKM/PKM Skills.md"')
        .replace(/^function parseMarker/, "export function parseMarker")).join("\n\n") +
    `\n\n${pureRead}\n\n${render}\n`;
});
await capture("src/chat/chat-memory.ts", "src/domain/skill-routing-terms.ts", (_, get) =>
  ["memoryTerms", "memoryMatchScore"].map(get).join("\n\n") + "\n");
await capture("src/chat/knowledge-reader.ts", "src/domain/skill-routing-selection.ts", (_, get) =>
  `import { createHash } from "node:crypto";\nimport { memoryTerms, memoryMatchScore } from "./skill-routing-terms.js";\nimport type { SkillRecord } from "../skill-contracts.js";\n
export function createAutomaticSkillSelection(records: SkillRecord[], list: () => Omit<SkillRecord, "content" | "_key">[]) {
  function skillList() { return list(); }
  function skillGet(name: string) { return records.find(record => record.name === name); }
${get("automaticChatSkills").replace(/^export /, "")}
  return automaticChatSkills;
}
\n${get("explicitlyMentionedKnowledgeTitle")}\n`);
await capture("src/chat/chat-retrieval-learning.ts", "src/domain/skill-routing-prompt.ts", (_, get) =>
  `import { explicitlyMentionedKnowledgeTitle } from "./skill-routing-selection.js";
export interface ApiChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string }
export interface ChatRetrievalCandidate {
  id: string; sourceId?: string; parentId?: string; level?: "l1-source" | "l2-passage";
  label: string; content?: string; score: number;
}
\n${["knowledgeCandidatePriority", "retrievalJudgmentInput", "parseRetrievalSelection"].map(get).join("\n\n")}\n`);
await capture("src/mcp/mcp.ts", "src/domain/skill-routing-original.ts", source => {
  const begin = source.indexOf("def _skill_id(row):");
  const end = source.indexOf('\n@_feature_tool("skillRouter")\ndef skill_feedback', begin);
  if (begin < 0 || end < 0) throw new Error("Original MCP metadata routing boundary changed.");
  return `// Original generated Python routing source: evidence only, never evaluated.\nexport const originalSkillRoutingSource = ${JSON.stringify(source.slice(begin, end))};\n`;
});
await capture("src/mcp/mcp.ts", "src/domain/skill-routing-casefold.ts", () => {
  const table = execFileSync("python3", ["-B", "-c",
    'import json,unicodedata; print(json.dumps({"unicodeVersion":unicodedata.unidata_version,"digits":"".join(chr(i) for i in range(0x110000) if chr(i).isdigit()),"mapping":{chr(i):chr(i).casefold() for i in range(0x110000) if chr(i).casefold()!=chr(i)}},ensure_ascii=True,separators=(",",":")))'],
  { cwd: packageRoot, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }).trim();
  return `// Frozen Python casefold table used by the original generated MCP metadata router.\nconst data = ${table};\n` +
    `export const skillRoutingUnicodeVersion = data.unicodeVersion;\n` +
    `const mapping: Record<string, string> = data.mapping;\n` +
    `const digits = new Set([...data.digits]);\n` +
    `export function skillRoutingIsDigit(value: string) { return !!value && [...value].every(character => digits.has(character)); }\n` +
    `export function skillRoutingCasefold(value: string) { return [...value].map(character => mapping[character] ?? character).join(""); }\n`;
});
await capture("src/mcp/mcp.ts", "src/domain/skill-routing-context.ts", async source => {
  if (!source.includes('weights = {"name": 12, "description": 8, "tag": 8, "category": 6, "source_project": 10}')
    || !source.includes('priority_boost = {"normal": 0, "high": 30, "highest": 60}[priority]')) {
    throw new Error("Metadata routing weights changed; review the TypeScript port and Python differential tests before recapturing.");
  }
  return readFile(resolve(packageRoot, "src/domain/skill-routing-context.ts"), "utf8");
});
await capture("tests/test-skill-router-config.js", "tests/skill-routing-legacy.test.mjs", source => source
  .replace('const assert = require(\'assert\');', 'import assert from "node:assert/strict";')
  .replace(/const \{([^]*?)\} = require\("\.\.\/dist\/skills\/skill-router-config\.js"\);/,
    'import {$1} from "../dist/domain/skill-routing-sources.js";'));
await capture("tests/test-chat-online-learning.js", "tests/skill-routing-prompt-legacy.test.mjs", source => {
  const parsed = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true);
  const tests = parsed.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(parsed) === "test" && ts.isStringLiteral(node.expression.arguments[0])
    && ["pre-answer selection is bounded, query-grounded, permits unknown and is explicitly model-attributed",
      "an explicitly named title wins a source-score tie without exceeding Memory priority"].includes(node.expression.arguments[0].text));
  const helpers = parsed.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ["source", "passage"].includes(item.name.getText(parsed))));
  if (tests.length !== 2 || helpers.length !== 2) throw new Error("Original relevance regression boundary changed.");
  return `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { retrievalJudgmentInput, parseRetrievalSelection, knowledgeCandidatePriority } from "../dist/domain/skill-routing-prompt.js";\n\n` +
    [...helpers, ...tests].map(node => node.getText(parsed)).join("\n\n") + "\n";
});
await writeFile(resolve(packageRoot, "migration/skill-routing-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1", files,
  transformation: "AST captures original source-priority normalization, raw router source parsing/rendering, automaticChatSkills, term scoring, ranked evidence priorities and pre-answer prompt/selection parsing. Only filesystem/host seams are replaced by bounded supplied values. The generated Python MCP metadata-threshold routing is retained as non-executable source evidence for the explicit TypeScript fallback port.",
  qualification: "Pure read-only projection/routing only. MCP fallback consumes validated legacy TS Skill projection fields, but normalizes raw priority as the original MCP does; no arbitrary YAML-type coercion is claimed. Casefold table is frozen from the capture Python Unicode version. No VS Code target discovery/injection, globalState/config writes, subscription cache, related_recipes state, retrieval worker/boundary generation, online learning, model or Skill execution parity is claimed. Related Recipe discovery is explicitly unavailable, not an assertion of no matches.",
}, null, 2) + "\n");
console.log("Captured original Skill routing/projection pure boundaries and source regression.");
