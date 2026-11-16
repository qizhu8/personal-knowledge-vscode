import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--capture"].includes(mode))
  throw new Error("Usage: node scripts/capture-legacy-mcp-contracts.mjs --check|--capture");
const captures = [
  {
    source: "legacy/src/capabilities/registry.ts", target: "src/domain/legacy-mcp-registry.ts",
    transform: text => text.replace('from "../knowledge/todo-api-contract"', 'from "./todo-api-contract.js"'),
  },
  {
    source: "legacy/src/capabilities/memory-contract.ts", target: "src/domain/legacy-mcp-memory-contract.ts",
    transform: text => text.slice(text.indexOf("const text = "), text.indexOf("export function repositoryMemoryScope"))
      .replace(/^/u, 'import type { Capability } from "./legacy-mcp-registry.js";\n\n'),
  },
];
for (const capture of captures) {
  const expected = capture.transform(await readFile(resolve(root, capture.source), "utf8"));
  const target = resolve(root, capture.target);
  if (mode === "--capture") await writeFile(target, expected);
  else if (await readFile(target, "utf8") !== expected)
    throw new Error(`Legacy MCP contract capture changed: ${capture.source} -> ${capture.target}`);
}
console.log(`Legacy MCP contracts: ${captures.length} source-matched captures (${mode}).`);
