import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { prepareLegacySync } = require("../legacy/tests/next-trial-electron/legacy-sync-actual-fixture.cjs");
const dist = process.env.PKM_NEXT_TEST_DIST
  ? pathToFileURL(path.resolve(process.env.PKM_NEXT_TEST_DIST) + "/").href : new URL("../dist/", import.meta.url).href;
const { adoptLegacyRootInPlaceExperimental } = await import(new URL("legacy-root-adoption.js", dist));
const { Storage } = await import(new URL("storage.js", dist));
const { openExperimentalLegacySyncHost } = await import(new URL("legacy-github-sync-experimental-host.js", dist));
const { localFixtureGitProvider } = await import(new URL("legacy-github-sync-fixture-provider.js", dist));

test("retained legacy pushed receipt reconciles offline on the same adopted root using loopback HTTP", { timeout: 120000 }, async t => {
  const fixture = path.resolve(".migration-test-work", `legacy-sync-recovery-${randomUUID()}`);
  const root = path.join(fixture, "legacy-root"), profile = path.join(fixture, "profile");
  for (const dir of ["legacy-root/skills", "legacy-root/notes", "profile", "provider", "t"])
    fs.mkdirSync(path.join(fixture, dir), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const name of ["InstallAlpha", "InstallBeta"])
    fs.writeFileSync(path.join(root, "skills", `${name}.md`), `---\nname: ${name}\n---\nbase\n`);
  const note = "---\ntitle: Keep\ndocumentId: fixture-keep\nrevision: 1\n---\nlegacy note\n";
  fs.writeFileSync(path.join(root, "notes/Keep.md"), note);
  const previous = await prepareLegacySync({ fixture, root, globalStorage: profile,
    legacyDist: process.env.PKM_LEGACY_SYNC_DIST ? path.resolve(process.env.PKM_LEGACY_SYNC_DIST) : undefined, pending: true });
  const identity = fs.statSync(root, { bigint: true });
  const configPath = path.join(profile, "github-sync/targets.json");
  const receiptPath = path.join(profile, "github-sync/checkouts/fixture-target/transactions/latest.json");
  const originalConfig = fs.readFileSync(configPath), originalReceipt = fs.readFileSync(receiptPath);
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  const provider = localFixtureGitProvider(path.join(fixture, "provider"), previous.bare, policy);
  let casExpected, requests = 0, patchCount = 0, reads = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 32 * 1024 * 1024) throw new Error("Request too large");
      requests++;
      const init = { method: req.method, headers: req.headers,
        ...(body.length ? { body: body.toString("utf8") } : {}) };
      const operation = () => provider.host.fetch(new URL(req.url, "https://api.github.com"), init);
      const result = req.method === "PATCH"
        ? await provider.host.withExpectedCommitCAS(policy, String(req.headers["x-pkm-fixture-expected"]), operation)
        : await operation();
      if (req.method === "PATCH") patchCount++;
      res.writeHead(result.status, { "content-type": "application/json" }); res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const transport = { ...provider.host, fetch: async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init.headers);
    if (init.method === "PATCH") {
      if (!casExpected) throw new Error("CAS boundary missing");
      headers.set("x-pkm-fixture-expected", casExpected);
    }
    return fetch(endpoint + url.pathname + url.search, { ...init, headers });
  }, async withExpectedCommitCAS(_policy, expected, work) {
    assert.equal(casExpected, undefined); casExpected = expected;
    try { return await work(); } finally { casExpected = undefined; }
  } };
  let storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage, host;
  t.after(async () => { if (host) await host.close(); if (storage) await storage.close(); });
  const openHost = () => openExperimentalLegacySyncHost({ mode: "isolated-experiment", storage, globalStorage: profile,
    targetId: "fixture-target", actorId: "legacy-recovery-fixture", transport,
    publisherPolicy: { policyId: policy.policyId, enforcement: "all-repository-ref-writers" },
    readSecret: async key => { assert.equal(key, "personalKnowledge.githubSync.vscode.fixture-target"); reads++;
      return JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }); } });
  const conflictRoot = path.join(profile, "github-sync/conflicts/fixture-target");
  fs.mkdirSync(conflictRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(conflictRoot, "conflict.json"), "{\"unresolved\":true}\n");
  await assert.rejects(openHost(), /legacy conflict requires recovery/);
  fs.rmSync(conflictRoot, { recursive: true });
  const repair = path.join(profile, "github-sync/content-repairs/fixture-target.json");
  fs.mkdirSync(path.dirname(repair), { recursive: true, mode: 0o700 });
  fs.writeFileSync(repair, "{\"pending\":true}\n");
  await assert.rejects(openHost(), /legacy content repair requires recovery/);
  assert.equal(fs.readFileSync(repair, "utf8"), "{\"pending\":true}\n");
  fs.rmSync(repair);

  const journal = path.join(profile, "github-sync/experimental-next/fixture-target.json");
  fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
  const digest = data => createHash("sha256").update(data).digest("hex");
  fs.writeFileSync(journal, JSON.stringify({ schema: "pkm.experimental-legacy-sync/v1",
    workspaceId: await storage.workspaceId(), configHash: digest(originalConfig), targetId: "fixture-target",
    policyId: policy.policyId, baseline: previous.receipt.pushedCommit, phase: "idle",
    legacyRecovery: { receiptSha256: digest(originalReceipt), baseCommit: previous.receipt.baseCommit,
      pushedCommit: previous.receipt.pushedCommit } }));
  await assert.rejects(openHost(), /no durable native receipt/);
  fs.rmSync(journal);

  const changedReceipt = JSON.parse(originalReceipt);
  const outbox = JSON.parse(changedReceipt.outbox.find(item => item.entity === "skills\0InstallAlpha").snapshot);
  outbox[0].digest = "0".repeat(64);
  changedReceipt.outbox.find(item => item.entity === "skills\0InstallAlpha").snapshot = JSON.stringify(outbox);
  fs.writeFileSync(receiptPath, JSON.stringify(changedReceipt));
  host = await openHost();
  await assert.rejects(host.resume(), /outbox does not match/);
  await host.close(); host = undefined;
  fs.writeFileSync(receiptPath, originalReceipt);

  const incompleteReceipt = JSON.parse(originalReceipt);
  incompleteReceipt.outbox = incompleteReceipt.outbox.filter(item => item.entity !== "skills\0InstallBeta");
  fs.writeFileSync(receiptPath, JSON.stringify(incompleteReceipt));
  host = await openHost();
  await assert.rejects(host.resume(), /outbox is incomplete/);
  await host.close(); host = undefined;
  fs.writeFileSync(receiptPath, originalReceipt);

  host = await openHost();
  await assert.rejects(host.sync(), /explicit recovery/);
  const alpha = path.join(root, "skills/InstallAlpha.md"), actualSkill = fs.readFileSync(alpha);
  fs.appendFileSync(alpha, "concurrent local edit\n");
  await assert.rejects(host.resume(), /local effects require review/);
  fs.writeFileSync(alpha, actualSkill);
  const env = { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file" };
  execFileSync("git", ["--git-dir", previous.bare, "update-ref", "refs/heads/main", previous.receipt.baseCommit], { env });
  await assert.rejects(host.resume(), /branch advanced/);
  execFileSync("git", ["--git-dir", previous.bare, "update-ref", "refs/heads/main", previous.receipt.pushedCommit], { env });
  fs.appendFileSync(receiptPath, " ");
  await assert.rejects(host.resume(), /configuration changed/);
  fs.writeFileSync(receiptPath, originalReceipt);
  const recovered = await host.resume();
  assert.deepEqual(recovered, { state: "legacy-pushed-recovered", commit: previous.receipt.pushedCommit });
  assert.equal(patchCount, 0); assert(reads > 0 && requests > 0);
  await host.close(); host = undefined; await storage.close(); storage = undefined;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./legacy-github-sync-actual-restart-child.mjs", import.meta.url)),
    root, profile, JSON.stringify(policy)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { errors += bytes; });
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve(code ?? signal); });
  });
  assert.equal(status, 0, errors);
  assert.deepEqual(JSON.parse(output), { state: "idle", baseline: previous.receipt.pushedCommit });
  storage = await Storage.open(root);
  host = await openHost();
  assert.deepEqual(await host.resume(), { state: "idle", baseline: previous.receipt.pushedCommit });
  fs.appendFileSync(path.join(root, "skills/InstallAlpha.md"), "next after recovery\n");
  assert.equal((await host.sync()).state, "published"); assert.equal(patchCount, 1);
  await host.close(); host = undefined; await storage.close(); storage = undefined;
  storage = await Storage.open(root); host = await openHost();
  assert.equal((await host.resume()).state, "idle");
  assert.equal(fs.readFileSync(path.join(root, "notes/Keep.md"), "utf8"), note);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(receiptPath), originalReceipt);
  assert.equal(fs.statSync(root, { bigint: true }).ino, identity.ino);
  assert.match(execFileSync("git", ["--git-dir", previous.bare, "show", "main:skills/InstallAlpha.md"], { env, encoding: "utf8" }), /next after recovery/);
  assert.match(execFileSync("git", ["--git-dir", previous.bare, "show", "main:notes/Keep.md"], { env, encoding: "utf8" }), /legacy note/);
});
