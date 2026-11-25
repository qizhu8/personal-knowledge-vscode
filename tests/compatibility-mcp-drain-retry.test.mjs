import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compatibilityMcpFixture } from "./compatibility-mcp-fixture.mjs";

test("a failed drain observation can be retried without reopening admission", { timeout: 120000 }, async t => {
  const f = await compatibilityMcpFixture(t);
  const config = JSON.parse(await readFile(f.target.args[0]));
  const entry = join(f.base, "drain-adapter-api.mjs");
  await build({ entryPoints: [resolve("src/compatibility-mcp.ts")], outfile: entry,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
    banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' } });
  const { connectCompatibilityMcp } = await import(pathToFileURL(entry).href);
  const launcher = join(f.base, "drain-fixture.py");
  await writeFile(launcher, `
import json, signal, sys
signal.alarm(30)
legacy = json.loads(${JSON.stringify(JSON.stringify(config.legacy))})
runtime = {"generation": legacy["generation"], "runtimeBuild": legacy["runtimeBuild"], "instanceId": "drain-fixture",
           "phase": "accepting", "acceptingNewCalls": True, "inFlight": 0, "uncertainCalls": 0}
revision = "a" * 64
names = ["capabilities_list", "capabilities_search", "capabilities_describe", "capabilities_inventory",
         "capability_read", "capability_call", "check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"]
quiesce_count = 0
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    if method == "initialize":
        result = {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "drain-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "inputSchema": {"type": "object"}} for name in names]}
    elif method == "tools/call":
        name, args = params["name"], params.get("arguments", {})
        if name == "check_version":
            payload = {"version": legacy["version"], "components": legacy["components"], "runtime": runtime}
        elif name == "capabilities_list":
            payload = {"revision": revision, "total": 1, "offset": 0, "nextOffset": None,
                       "operations": [{"id": "mcp.tool.fixture_read"}]}
        elif name == "capabilities_describe":
            payload = {"id": args["operation"], "version": 1, "transportName": "fixture_read",
                       "description": "Fixture read", "readOnly": True, "revision": revision,
                       "inputSchema": {"type": "object"}, "outputSchema": None}
        elif name == "mcp_lifecycle_quiesce":
            quiesce_count += 1
            runtime.update({"phase": "drained", "acceptingNewCalls": False})
            payload = {**runtime, "controlError": "injected-unverified" if quiesce_count == 1 else ""}
        else:
            raise RuntimeError("Unexpected drain-fixture call")
        result = {"content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload, "isError": False}
    else:
        raise RuntimeError("Unexpected drain-fixture method")
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
`);
  config.legacy.launcher = { path: launcher, sha256: createHash("sha256").update(await readFile(launcher)).digest("hex") };
  const adapter = await connectCompatibilityMcp(config);
  f.retainCleanup(async () => { await adapter.close(); });
  const first = adapter.close();
  assert.equal(adapter.close(), first);
  await assert.rejects(first, /COMPATIBILITY_ADAPTER_DRAIN_UNKNOWN/);
  assert.equal(adapter.identity.health.phase, "draining");
  await assert.rejects(adapter.backend.invoke("original_mcp_public", { tool: "fixture_read", arguments: {} }),
    /COMPATIBILITY_ADAPTER_CLOSED/);
  const retry = adapter.close();
  assert.equal(adapter.close(), retry);
  await retry;
  assert.equal(adapter.identity.health.phase, "closed");
});
