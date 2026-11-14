import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { httpCall, invocation, nativeWorkspace, sleep, syntheticManager, until } from "./batch06-manager-fixtures.mjs";

test("real Chromium renders native intermediate results, submits target-only feedback and observes automatic E2E acceptance", { timeout: 40_000 }, async t => {
  const manager = syntheticManager("feature", 4, { hold: true, publish: true, failIntegration: true });
  const f = await nativeWorkspace(t, { manager: manager.config });
  f.addCleanup(manager.release);
  const note = await f.runtime.core.dispatch("capability_call", invocation("knowledge.document.create", {
    operationId: randomUUID(), id: "browser-literal", title: "Inert source",
    content: '<script>window.pkmInjected=true</script><img src="https://outside.invalid/x" onerror="window.pkmInjected=true">',
  }), { id: "native:batch06-owner", canWrite: true });
  assert.ok(note.result, JSON.stringify(note));
  const url = await f.listen();
  const started = await httpCall(url, f.bearer, "capability_call", invocation("manager.runtime.start", manager.start("browser-live")));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await until(() => manager.calls.published === 1 && manager.calls.worker.length === 4);
  const concurrentFixtures = await Promise.all(Array.from({ length: 3 }, () => nativeWorkspace(t)));
  const concurrentHosts = await Promise.all(concurrentFixtures.map(fixture => fixture.listen()));
  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "batch06-browser-qualification.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "";
  let loading = true;
  const concurrentRequests = concurrentHosts.map(async (host, index) => {
    let count = 0;
    for (let attempt = 0; attempt < 120 && loading; attempt++) {
      const response = await httpCall(host, concurrentFixtures[index].bearer, "server_info", {}, {}, {
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200, "concurrent isolated native fixture remains responsive");
      count++;
      await sleep(50);
    }
    return count;
  });
  child.stdout.on("data", bytes => {
    output += bytes.toString();
    if (output.includes("FEEDBACK_QUEUED")) manager.release();
  });
  child.stderr.on("data", bytes => { diagnostics += bytes.toString(); });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.end(JSON.stringify({ url, root: f.root, token: f.bearer }) + "\n");
  let status, loadCounts;
  try {
    status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally {
    loading = false;
    clearTimeout(deadline);
    loadCounts = await Promise.all(concurrentRequests);
  }
  assert.equal(status, 0, diagnostics);
  assert(loadCounts.every(count => count > 0), "Chromium ran alongside three isolated responsive native fixtures");
  assert.match(output, /"sameOrigin": true/);
  for (const name of ["disconnected", "active-intermediate", "e2e-accepted"]) {
    const bytes = await readFile(resolve(f.root, `browser-${name}.png`));
    assert.equal(bytes.readUInt32BE(0), 0x89504e47, "real browser screenshot");
    assert(bytes.length > 10_000);
  }
  if (process.env.PKM_BATCH06_INSPECT === "1") {
    await copyFile(resolve(f.root, "browser-active-intermediate.png"), resolve(import.meta.dirname, ".batch06-browser-inspect.png"));
  }
  assert.deepEqual(manager.calls.worker.filter(call => call.feedback.length).map(call => call.taskId), ["worker-1"]);
  assert.deepEqual(manager.calls.worker.filter(call => call.repairReason && !call.feedback.length).map(call => call.taskId), ["worker-2"]);
  assert.equal(manager.calls.worker.filter(call => call.taskId === "worker-3").length, 1);
  assert.equal(manager.calls.verify.length, 1);
});

test("browser static allowlist and same-origin bearer APIs enforce Host, Origin, no CORS and CSP", async t => {
  const f = await nativeWorkspace(t);
  const url = await f.listen();
  for (const path of ["/", "/index.html", "/bootstrap.mjs", "/host-config.mjs", "/protocol.mjs", "/workspace.mjs", "/workspace.css"]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal((await response.text()).includes(f.bearer), false);
  }
  for (const path of ["/integration.mjs", "/src/native-runtime.ts", "/core.sqlite", "/migration/manifest.json", "/%2e%2e/package.json"]) {
    assert.notEqual((await fetch(url + path)).status, 200, path);
  }
  const same = await httpCall(url, f.bearer, "server_info", {}, { origin: url });
  assert.equal(same.status, 200);
  assert.equal((await httpCall(url, "wrong-token", "server_info", {}, { origin: url })).status, 401);
  for (const origin of ["null", "https://outside.invalid", `${url}.outside.invalid`, url.replace("127.0.0.1", "localhost")]) {
    const response = await httpCall(url, f.bearer, "server_info", {}, { origin });
    assert.equal(response.status, 403, origin);
  }
  const forgedHost = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { host: "outside.invalid" } }, response => { response.resume(); resolve(response.statusCode); });
    req.once("error", reject); req.end();
  });
  assert.equal(forgedHost, 403);
  assert.equal((await fetch(url + "/v1/server_info", { method: "OPTIONS", headers: { origin: "https://outside.invalid" } })).headers.get("access-control-allow-origin"), null);
});
