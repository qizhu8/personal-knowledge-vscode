const assert = require("assert");
const { hasNewerMcpRuntime, newerMcpRuntimeComponents } = require("../dist/mcp-version-policy");

const bundled = {
  unified: "2.13.0",
  knowledge: "1.5.0",
  chat: "2.3.5",
  recipe: "1.6.0",
  agentSession: "1.5.0",
};

assert.strictEqual(hasNewerMcpRuntime(bundled, bundled), false, "equal versions must be safe to regenerate");
assert.strictEqual(hasNewerMcpRuntime({ ...bundled, unified: "2.12.0" }, bundled), false,
  "an older installed runtime may be upgraded");
assert.deepStrictEqual(
  newerMcpRuntimeComponents({ ...bundled, recipe: "1.7.0" }, bundled),
  ["recipe"],
  "a newer component must block overwrite even when the unified version is equal",
);
assert.strictEqual(hasNewerMcpRuntime({ ...bundled, unified: "2.14.0" }, bundled), true,
  "a newer unified runtime must block overwrite");
assert.strictEqual(hasNewerMcpRuntime({ ...bundled, chat: "2.4.0-beta.1" }, bundled), true,
  "a newer prerelease component must block overwrite");
assert.strictEqual(hasNewerMcpRuntime({ ...bundled, recipe: "legacy" }, bundled), false,
  "unparseable legacy versions must not be mistaken for a newer runtime");

console.log("MCP runtime version policy tests passed.");
