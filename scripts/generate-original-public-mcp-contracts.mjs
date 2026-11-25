import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.at(-1) === "--check";
if (check) args.pop();
if (args.length !== 4 || args[0] !== "--metadata" || !isAbsolute(args[1])
  || args[2] !== "--sha256" || !/^[a-f0-9]{64}$/.test(args[3]))
  throw new Error("Usage: --metadata ABSOLUTE_CAPTURE --sha256 INDEPENDENT_SHA256 [--check]");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const input = await readFile(args[1]);
assert.equal(sha(input), args[3], "The independently retained metadata pin differs.");
const capture = JSON.parse(input);
assert.equal(capture.schema, "pkm.current-live-mcp-exact-contracts/v1");
assert.equal(capture.metadataOnly, true);
assert.equal(capture.contracts.length, 151);
assert.equal(capture.tools.tools.length, 9);
const numberSources = new WeakMap();
const contracts = capture.contracts.map(({ id, response }) => {
  assert.equal(response.isError, false);
  const text = response.content.find(item => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  const contract = JSON.parse(text, function (key, value, context) {
    if (typeof value === "number" && context?.source && context.source !== JSON.stringify(value)) {
      const entries = numberSources.get(this) ?? new Map();
      entries.set(key, context.source);
      numberSources.set(this, entries);
    }
    return value;
  });
  assert.equal(contract.revision, capture.producer.revision);
  assert.equal(contract.id, id);
  assert.equal(contract.id, `mcp.tool.${contract.transportName}`);
  assert.equal(contract.version, 1);
  assert.equal(typeof contract.readOnly, "boolean");
  delete contract.revision;
  return contract;
});
assert.equal(new Set(contracts.map(contract => contract.id)).size, contracts.length);
const numericLexemes = [];
function collect(value, path) {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const part = Array.isArray(value) ? Number(key) : key;
    const source = numberSources.get(value)?.get(key);
    if (source !== undefined) numericLexemes.push({ path: [...path, part], source });
    collect(entry, [...path, part]);
  }
}
for (const contract of contracts) collect(contract, [contract.id]);
function pythonJson(value, sorted = false, parent, key) {
  if (typeof value === "number") return numberSources.get(parent)?.get(String(key)) ?? JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry, index) => pythonJson(entry, sorted, value, index)).join(", ")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (sorted) keys.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map(key => `${JSON.stringify(key)}: ${pythonJson(value[key], sorted, value, key)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}
const revision = sha(Buffer.from(pythonJson(contracts, true)));
assert.equal(revision, capture.producer.revision, "Captured contracts do not reproduce the producer's revision.");
const decode = response => {
  assert.equal(response.isError, false);
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === "text").text);
};
const inventory = decode(capture.inventory);
assert.equal(inventory.total, 9);
assert.equal(inventory.nextOffset, null);
const names = contracts.map(contract => contract.transportName);
const variant = { names, revision };
const catalog = {
  schema: "pkm.original-public-mcp-contracts/v1",
  provenance: { metadataSha256: args[3], producer: capture.producer, discoveryGrantsAuthority: false },
  definitions: capture.tools.tools,
  wireDefinitions: capture.tools.tools,
  contracts, routing: {}, contractBytes: Object.fromEntries(contracts.map(contract =>
    [contract.id, Buffer.byteLength(pythonJson(contract))])),
  floatPaths: [], numericLexemes,
  variants: Object.fromEntries(["000", "100", "110", "101", "111"].map(key => [key, variant])),
  inventory: { revision: inventory.revision, schemaBytes: inventory.schemaBytes,
    measurement: inventory.measurement, tools: inventory.tools },
};
const content = "// Generated from independently pinned original MCP metadata; discovery grants no authority.\n"
  + `export const originalPublicMcpOperationIds: readonly string[] = Object.freeze(${JSON.stringify(contracts.map(contract => contract.id))});\n`
  + "let contracts: unknown;\nexport function originalPublicMcpContracts(): unknown {\n"
  + `  return contracts ??= JSON.parse(${JSON.stringify(JSON.stringify(catalog))});\n}\n`;
const target = resolve(root, "src/native-public-original-mcp-contracts.ts");
if (check) assert.equal(await readFile(target, "utf8"), content, "Original public MCP contracts are stale.");
else await writeFile(target, content);
const oracle = {
  schema: "pkm.original-public-mcp-discovery-oracle/v1",
  metadataSha256: args[3], producer: capture.producer,
  inventory: capture.inventory, wireDefinitions: capture.tools.tools,
  describes: capture.contracts.map(entry => ({ operation: entry.id, response: entry.response })),
  discovery: capture.discovery,
};
const fixture = resolve(root, "tests/fixtures/original-public-mcp-discovery.json");
const fixtureText = JSON.stringify(oracle, null, 2) + "\n";
if (check) assert.equal(await readFile(fixture, "utf8"), fixtureText, "Original public MCP oracle is stale.");
else {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(fixture), { recursive: true });
  await writeFile(fixture, fixtureText);
}
console.log(JSON.stringify({ schema: catalog.schema, contracts: contracts.length, tools: inventory.total,
  numericLexemes: numericLexemes.length, revision, metadataSha256: args[3], check }));
