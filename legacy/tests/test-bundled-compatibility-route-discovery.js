"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");
const { test } = require("node:test");

test("Settings reads and managed peer definitions never start or acquire backend custody", async () => {
  const base = fs.mkdtempSync(path.join(__dirname, ".pkm-bundled-discovery-"));
  const root = path.join(base, "knowledge"), managed = path.join(root, "mcp-server");
  const extensionPath = path.join(base, "extension"), payload = path.join(extensionPath, "next-runtime");
  const storage = path.join(base, "control");
  for (const directory of [managed, path.join(extensionPath, "resources"), path.join(payload, "server/dist"), storage])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const filename of [path.join(managed, "server.py"), path.join(extensionPath, "resources/next_mcp_subreaper.py"),
    path.join(payload, "server/dist/compatibility-mcp-cli.js")]) fs.writeFileSync(filename, "", { mode: 0o600 });
  const original = { generation: randomUUID(), runtimeBuild: "1".repeat(64), version: "2.19.0", components: {} };
  let allowed = 0, backendAttempts = 0;
  const source = fs.readFileSync(path.join(__dirname, "../src/mcp/bundled-compatibility-route.ts"), "utf8");
  const exports = {};
  const forbidden = () => { backendAttempts++; throw Error("Metadata must not start/acquire a backend"); };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, {
    exports, process, Buffer,
    require(name) {
      if (name === "./mcp-lifecycle") return { MCP_LIFECYCLE_SCHEMA: "pkm.mcp.lifecycle/v1", readManagedMcpManifest: () => original };
      if (name === "../runtime/next-payload-verifier") return { verifyNextPayload: () => ({
        root: payload, buildId: "2".repeat(64), version: "0.1.0",
      }) };
      if (name === "../runtime/linux-root-writer-fence") return {
        acquireLinuxRootWriterFence: forbidden, assertLinuxRootStillLegacyWritable: forbidden,
      };
      if (name === "./mcp-attribution") return { managedMcpAttributionEnv: forbidden };
      if (name === "../runtime/pkm-service") return { withPkmServiceNativeAdmission: forbidden };
      return require(name);
    },
  });
  const route = exports.createBundledCompatibilityRoute({
    extensionPath, storage, root: () => root, managed: () => managed, python: () => "/verified/python",
    assertAllowed() { allowed++; }, live: {
      assertAdmittedRoot() {}, hasActiveChatWork: () => false, confirm: forbidden,
    },
  });
  try {
    const responses = [];
    await route.handleSettings({ command: "mcpBackendSwitchRead", requestId: 1 }, response => responses.push(response));
    assert.equal(responses[0].data.error, "notAdmitted");
    assert.equal(allowed, 0, "pre-start Settings reads must not even construct a selection");
    assert.deepEqual(fs.readdirSync(storage), []);
    const described = route.describeLaunch();
    const cli = await route.managedPeerDefinition();
    assert.equal(described.env.PKM_SHARED_TOKEN, undefined);
    assert.equal(cli.args.at(-1), "--writable");
    assert.equal(cli.args[1], root);
    assert.equal(cli.args[2], original.generation);
    assert.equal(cli.args[3], original.runtimeBuild);
    assert.equal(fs.existsSync(path.join(root, ".pkm")), false, "metadata cannot reserve Original custody");
    await route.handleSettings({ command: "mcpBackendSwitchRead", requestId: 2 }, response => responses.push(response));
    assert.equal(responses[1].data.error, "notAdmitted");
    assert.equal(route.status().phase, "pending");
    assert.equal(backendAttempts, 0);
  } finally {
    await route.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
