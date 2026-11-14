import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { initialize } from "../dist/storage.js";
import { bindManagedClientHost, startManagedClientHost } from "../dist/managed-client-host.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

const directory = dirname(fileURLToPath(import.meta.url));

test("explicit managed document host binds a fixed actor and persists a local document journey", { timeout: 60000 }, async t => {
  const root = join(directory, `.managed-client-${randomUUID()}`);
  const workspace = join(root, "workspace"), configDir = join(root, "config"), configPath = join(configDir, "host.json");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  let host, failChild = false;
  t.after(async () => { failChild = false; await host?.close(); await rm(root, { recursive: true, force: true }); });
  await initialize(workspace);
  const { id: workspaceId } = JSON.parse(await readFile(join(workspace, ".pkm-next-workspace"), "utf8"));
  const endpoint = "http://127.0.0.1:12345/v1";
  await writeFile(configPath, JSON.stringify({
    schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"],
  }), { mode: 0o600 });
  const options = {
    optIn: true, dataPath: workspace, configPath, expectedWorkspaceId: workspaceId,
    policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
      allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
    resolveSecret: async () => { throw Error("document operations must not access the provider secret"); },
  };
  await assert.rejects(startManagedClientHost({ ...options, optIn: false }), /explicit opt-in/);
  await assert.rejects(startManagedClientHost({ ...options, expectedWorkspaceId: "incorrect" }), /binding mismatch/);
  host = await startManagedClientHost(options);
  assert.deepEqual(host.writerCoverage, { inProcessCalls: "tracked", external: "unknown", cutoverAuthorized: false });
  const operationId = randomUUID();
  const input = { id: "synthetic", operationId, title: "Synthetic", content: "Original" };
  const created = (await host.invoke("create", input)).result;
  assert.equal(created.content, "Original");
  assert.deepEqual((await host.invoke("create", input)).result, created);
  assert.equal((await host.invoke("create", { ...input, actorId: "attacker" })).error.code, "INVALID_ARGUMENT");
  assert.equal((await host.invoke("list", {})).result.items[0].id, "synthetic");
  const updated = (await host.invoke("update", { id: "synthetic", operationId: randomUUID(),
    expectedRevision: created.revision, expectedSha256: created.sha256, title: "Updated", content: "Changed" })).result;
  assert.equal(updated.content, "Changed");
  assert.equal((await host.invoke("update", { id: "synthetic", operationId: randomUUID(),
    expectedRevision: created.revision, expectedSha256: created.sha256, title: "Stale", content: "Overwrite" })).error.code, "CONFLICT");
  await assert.rejects(host.invoke("server_info", {}), /Invalid managed document request/);
  let selected = true, childCloses = 0;
  failChild = true;
  const selection = { workspaceId, actorId: "local:owner", assertCurrent() {
    if (!selected) throw new Error("Selection revoked.");
  } };
  assert.throws(() => host.selectedOwnerContext({ ...selection, workspaceId: "wrong" }), /unavailable/);
  const owner = host.selectedOwnerContext(selection);
  selected = false;
  assert.throws(() => owner.assertCurrent(), /Selection revoked/);
  selected = true;
  owner.registerChildClose(async () => { childCloses++; if (failChild) throw new Error("Still running."); });
  await assert.rejects(host.close(), /child operations did not drain/);
  assert.throws(() => owner.assertCurrent(), /unavailable|admission closed/);
  owner.storage.assertWorkspaceLease();
  failChild = false;
  await host.close();
  assert.equal(childCloses, 2);
  await assert.rejects(host.invoke("get", { id: "synthetic" }), /admission is closed/);
  host = await startManagedClientHost(options);
  assert.equal((await host.invoke("get", { id: "synthetic" })).result.content, "Changed");
  await host.close();

  const crashInput = { id: "crash", operationId: randomUUID(), title: "Crash", content: "Committed" };
  const child = spawn(process.execPath, ["-e", `
    (async () => {
    const { startManagedClientHost } = await import(process.argv[1]);
    const options = JSON.parse(process.argv[2]);
    const host = await startManagedClientHost({ ...options, resolveSecret: async () => undefined });
    const result = await host.invoke("create", JSON.parse(process.argv[3]));
    if (result.error) throw Error(result.error.code);
    process.stdout.write("committed\\n");
    setInterval(() => {}, 1000);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, new URL("../dist/managed-client-host.js", import.meta.url).href,
    JSON.stringify({ ...options, resolveSecret: undefined }), JSON.stringify(crashInput)],
    { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const childExit = new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    void childExit.then(({ code, stderr }) => reject(new Error(`child exited before commit: ${code}: ${stderr}`)));
  });
  if (process.platform === "linux")
    await assert.rejects(acquireLinuxRootWriterFence(workspace, 150), /timed out|acquire.*fence/i);
  child.kill("SIGKILL");
  assert.equal((await childExit).signal, "SIGKILL");
  if (process.platform !== "linux") {
    await assert.rejects(startManagedClientHost(options), /startup failed/);
    await new Promise(resolve => setTimeout(resolve, 31_000));
  }
  host = await startManagedClientHost(options);
  assert.equal((await host.invoke("get", { id: "crash" })).result.content, "Committed");
  assert.equal((await host.invoke("create", crashInput)).result.content, "Committed");
  await host.close();
});

test("closing rejects new calls and waits for admitted work, even after shutdown failure", async () => {
  let finish, calls = 0, closeCalls = 0, fail = true;
  const gate = new Promise(resolve => { finish = resolve; });
  const host = bindManagedClientHost({
    workspaceId: "fixture",
    core: { async dispatch(method, request, actor) {
      calls++;
      assert.equal(method, "capability_call");
      assert.equal(request.operation, "knowledge.document.create");
      assert.deepEqual(actor, { id: "local:owner", canWrite: true });
      await gate;
      return { result: {} };
    } },
    selectedOwnerContext(selection) { return { assertCurrent: () => selection.assertCurrent() }; },
    async close() { closeCalls++; if (fail) throw Error("close failed"); },
  }, "fixture");
  const owner = host.selectedOwnerContext({ workspaceId: "fixture", actorId: "local:owner", assertCurrent() {} });
  owner.assertCurrent();
  const action = host.invoke("create", {});
  const closing = host.close();
  assert.equal(closing, host.close());
  assert.throws(() => owner.assertCurrent(), /admission closed/);
  await assert.rejects(host.invoke("create", {}), /admission is closed/);
  assert.equal(closeCalls, 0);
  finish();
  await action;
  await assert.rejects(closing, /close failed/);
  await assert.rejects(host.invoke("create", {}), /admission is closed/);
  fail = false;
  await host.close();
  await host.close();
  assert.equal(calls, 1);
  assert.equal(closeCalls, 2);
});
