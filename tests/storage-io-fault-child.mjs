import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { sha256 } from "../dist/file-write.js";
import { installProjectMutationTransportFixture, projectMutationFixtureRequests } from "./project-mutations-fixtures.mjs";
import { deserializeResourceLifecyclePlan } from "../dist/resource-lifecycle.js";
import { deserializeProjectMutationPlan } from "../dist/project-mutations.js";
import { qualification, uuid } from "./storage-io-fault-cases.mjs";

const parent = resolve(process.env.PKM_STORAGE_IO_FAULT_FIXTURE);
const root = join(parent, "workspace"), control = join(parent, "control.json"), trace = join(parent, "trace.jsonl");
const { domain, fault, tamper, transport } = JSON.parse(process.argv[2]);
const journal = { document: "pending_write", upload: "pending_asset", resource: "pending_resource", project: "pending_project_mutation" }[domain];
const owner = { id: qualification.fixture.owner, canWrite: true };
const measurements = { latenciesMs: [], closeMs: [], rssBytes: 0, peakRssBytes: 0, files: 0, bytes: 0, fds: 0 };
let store, http, mcp, client;
const token = "synthetic-batch12-local-loopback-token";
async function start() {
  store = await Storage.open(root);
  const core = new Core(store);
  http = await startHttp(core, token, owner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(core, owner, serverTransport);
  client = new Client({ name: "batch12-fixture", version: "1" });
  await client.connect(clientTransport);
}
async function close() {
  const active = !!store || !!http || !!mcp || !!client, started = performance.now();
  await client?.close(); client = undefined;
  await mcp?.close(); mcp = undefined;
  if (http) {
    const server = http.server; http = undefined;
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  }
  await store?.close(); store = undefined;
  if (active) measurements.closeMs.push(performance.now() - started);
}
async function call(operation, args, method = "capability_call", via = transport) {
  const input = { operation, version: 1, arguments: args }, started = performance.now();
  try {
    if (via === "mcp") {
      const result = await client.callTool({ name: method, arguments: input }, undefined, { timeout: 10000 });
      const envelope = result.structuredContent;
      assert.equal(result.isError, !!envelope.error);
      assert.deepEqual(JSON.parse(result.content[0].text), envelope);
      return envelope;
    }
    const result = await fetch(`${http.url}/v1/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
    });
    const envelope = await result.json();
    assert.equal(result.status, envelope.error ? ({ STORAGE_ERROR: 500, RECOVERY_CONFLICT: 409, BUSY: 503 }[envelope.error.code] ?? 400) : 200);
    return envelope;
  } finally { measurements.latenciesMs.push(performance.now() - started); }
}
async function success(operation, args, method = "capability_call", via) {
  const result = await call(operation, args, method, via);
  assert(!result.error, JSON.stringify(result.error));
  assert(result.result);
  return result.result;
}
function inspect(operationId) {
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try {
    const row = db.prepare(`SELECT * FROM ${journal} WHERE singleton=1`).get();
    return {
      row, pending: Number(db.prepare(`SELECT count(*) AS n FROM ${journal}`).get().n),
      receipts: Number(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(operationId).n),
      receipt: db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(operationId),
      schema: db.prepare("PRAGMA user_version").get().user_version,
    };
  } finally { db.close(); }
}
async function arm() {
  await writeFile(control, JSON.stringify({ ...fault, enabled: true, matches: 0, hits: 0 }));
  await writeFile(trace, "");
}
async function disable() {
  const rule = JSON.parse(await readFile(control, "utf8"));
  rule.enabled = false;
  await writeFile(control, JSON.stringify(rule));
}
async function bytes(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function walk(path) {
  for (const name of (await readdir(path)).sort()) {
    const full = join(path, name), stat = await lstat(full);
    assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) await walk(full);
    else { measurements.files++; measurements.bytes += stat.size; }
  }
}
try {
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: uuid(99) }));
  if (domain === "project") await installProjectMutationTransportFixture(root);
  const documentFile = join(root, "notes", "Doc.md");
  await writeFile(documentFile, "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000012\naliases:\n  - note:fault-document\ndocumentId: fault-document\ntitle: Fault fixture\nrevision: 1\ndeleted: false\n---\nSynthetic original body");
  await start();
  const document = await success("knowledge.document.get", { id: qualification.fixture.document.id }, "capability_read");
  const originalMarkdown = await readFile(documentFile);
  const uploadBytes = Buffer.from(qualification.fixture.uploadHex, "hex");
  const assetDirectory = join(root, "notes", "Doc.assets");
  await mkdir(assetDirectory);
  const argsId = uuid(10);
  let operation, args, target, source, sourceBytes;
  if (domain === "document") {
    operation = "knowledge.document.update";
    args = { id: document.id, operationId: argsId, expectedRevision: document.revision,
      expectedSha256: document.sha256, title: document.title, content: "Synthetic replacement body" };
    target = documentFile; sourceBytes = originalMarkdown;
  } else if (domain === "upload") {
    const began = await success("knowledge.upload.begin", { id: document.id, operationId: uuid(2),
      expectedRevision: document.revision, expectedSha256: document.sha256,
      name: "source.bin", size: uploadBytes.length, digest: `sha256:${sha256(uploadBytes)}` });
    await success("knowledge.upload.append", { operationId: uuid(3), uploadId: began.uploadId,
      offset: 0, data: uploadBytes.toString("base64") });
    // Reservation pressure is real Core/HTTP/MCP admission, not synthetic delay.
    for (let i = 0; i < 3; i++) await success("knowledge.upload.begin", {
      id: document.id, operationId: uuid(20 + i), expectedRevision: document.revision,
      expectedSha256: document.sha256, name: `reserved-${i}.bin`, size: 1, digest: `sha256:${sha256("x")}`,
    });
    const pressure = await call("knowledge.upload.begin", { id: document.id, operationId: uuid(24),
      expectedRevision: document.revision, expectedSha256: document.sha256,
      name: "overflow.bin", size: 1, digest: `sha256:${sha256("x")}` });
    assert.equal(pressure.error.code, "BUSY");
    assert.equal(pressure.error.effect, "not-committed"); assert(!pressure.result);
    assert.equal((await success("knowledge.upload.list", {}, "capability_read")).total, 4);
    operation = "knowledge.upload.commit"; args = { operationId: argsId, uploadId: began.uploadId };
    target = join(assetDirectory, "source.bin");
  } else if (domain === "resource") {
    source = join(assetDirectory, "source.bin"); sourceBytes = uploadBytes;
    await writeFile(source, sourceBytes);
    const pins = { id: document.id, area: "notes", documentPath: document.path,
      expectedRevision: document.revision, expectedSha256: document.sha256,
      path: "Doc.assets/source.bin", expectedDigest: `sha256:${sha256(sourceBytes)}`, expectedSize: sourceBytes.length };
    const preview = await success("knowledge.asset.lifecycle.preview", { ...pins, action: "rename", newName: "renamed.bin" }, "capability_read");
    operation = "knowledge.asset.rename";
    args = { ...pins, operationId: argsId, newName: "renamed.bin",
      expectedDestinationDigest: null, expectedScanRevision: preview.scanRevision };
    target = join(assetDirectory, "renamed.bin");
  } else {
    const snapshot = await success("project.list", { offset: 0, limit: 100 }, "capability_read");
    const request = projectMutationFixtureRequests(snapshot.snapshotRevision).createProject;
    operation = request.operation; args = { ...request.args, operationId: argsId };
    // Native planning is read-only; the actual intent must be generated by Core.
    const { planProjectMutation } = await import("../dist/project-mutations.js");
    const plan = planProjectMutation(root, { operation, args, actorId: owner.id });
    target = join(root, plan.files[0].relativePath);
  }
  const initialTarget = await bytes(target);
  await arm();
  // Same patched API, but outside the workspace grant (still inside this child fixture).
  const sentinel = join(parent, ".pkm-write-" + argsId), sentinelAfter = join(parent, "scope-sentinel.bin");
  const sentinelFd = openSync(sentinel, "wx");
  try { writeFileSync(sentinelFd, "Synthetic out-of-scope sentinel"); fsyncSync(sentinelFd); }
  finally { closeSync(sentinelFd); }
  renameSync(sentinel, sentinelAfter);
  assert.equal(await readFile(sentinelAfter, "utf8"), "Synthetic out-of-scope sentinel");
  const { renameNoReplaceSync } = await import("../dist/rename-no-replace.js");
  renameNoReplaceSync(sentinelAfter, sentinel);
  assert.equal(await readFile(sentinel, "utf8"), "Synthetic out-of-scope sentinel");
  assert.equal(JSON.parse(await readFile(control, "utf8")).hits, 0);
  const failed = await call(operation, args);
  assert(failed.error, `injected native boundary returned success: ${JSON.stringify({ domain, fault: fault.name, tamper, transport })}`);
  assert(!Object.hasOwn(failed, "result"), "no success-shaped fallback");
  assert.equal(failed.error.effect, "unknown");
  assert.equal(failed.error.code, ["project", "resource"].includes(domain) ? "RECOVERY_CONFLICT" : "STORAGE_ERROR");
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  const event = events[0], rule = JSON.parse(await readFile(control, "utf8"));
  for (const key of ["syscall", "code", "phase", "ordinal"]) assert.equal(event[key], fault[key]);
  assert.equal(event.hits, 1); assert.equal(event.matches, fault.ordinal); assert.equal(rule.hits, 1);
  assert.equal(event.storageWorker, true, "fault must hit the actual native storage worker, not fixture code");
  assert(!event.path.startsWith("/") && !event.path.split("/").includes(".."));
  assert.equal(event.partialBytes, fault.phase === "partial" ? 7 : 0);
  const pending = inspect(argsId);
  assert.equal(pending.schema, qualification.databaseSchema); assert.equal(pending.pending, 1); assert.equal(pending.receipts, 0);
  assert.equal(pending.row.operation_id, argsId);
  measurements.activeFds = (await readdir("/proc/self/fd")).length;
  if (!fault.published) assert.deepEqual(await bytes(target), initialTarget);
  else assert.notDeepEqual(await bytes(target), initialTarget);
  if (domain !== "document") assert.deepEqual(await readFile(documentFile), originalMarkdown);
  if (source) assert.deepEqual(await readFile(source), sourceBytes);
  if (domain === "upload") {
    const db = new DatabaseSync(join(root, "core.sqlite"));
    try {
      const chunks = db.prepare("SELECT content FROM upload_chunks WHERE upload_id=? ORDER BY offset").all(args.uploadId);
      assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.content))), uploadBytes);
    } finally { db.close(); }
  }
  await disable();
  await close();
  let recovery, finalHash, restartError = null;
  const reopenStart = performance.now();
  if (tamper) {
    await mkdir(join(target, ".."), { recursive: true });
    const external = Buffer.from(qualification.fixture.tamper);
    await writeFile(target, external);
    await assert.rejects(Storage.open(root), error => {
      restartError = { code: error.code, effect: error.effect, message: error.message };
      assert.equal(error.effect, "unknown");
      assert.equal(error.code, "RECOVERY_CONFLICT");
      return true;
    });
    measurements.recoveryOpenMs = performance.now() - reopenStart;
    const unchanged = inspect(argsId);
    assert.equal(unchanged.pending, 1); assert.equal(unchanged.receipts, 0);
    assert.deepEqual(unchanged.row, pending.row);
    assert.deepEqual(await readFile(target), external);
    if (source) assert.deepEqual(await readFile(source), sourceBytes);
    recovery = "unrecognized-target-fail-closed";
    finalHash = sha256(external);
  } else {
    await start();
    measurements.recoveryOpenMs = performance.now() - reopenStart;
    const recovered = inspect(argsId);
    assert.equal(recovered.pending, 0); assert.equal(recovered.receipts, 1);
    assert.equal(recovered.receipt.actor_id, owner.id); assert.equal(recovered.receipt.operation, operation);
    assert.equal(recovered.receipt.fingerprint, pending.row.fingerprint);
    const committed = JSON.parse(recovered.receipt.result), finalBytes = await readFile(target);
    if (domain === "document") {
      assert.deepEqual(finalBytes, Buffer.from(pending.row.after_markdown));
      assert.equal(committed.sha256, sha256(finalBytes));
      assert.equal(committed.revision, document.revision + 1);
      assert.equal(committed.content, args.content);
    }
    if (domain === "upload") {
      assert.deepEqual(finalBytes, Buffer.from(pending.row.content));
      assert.equal(committed.resource.digest, `sha256:${sha256(finalBytes)}`);
      assert.equal(committed.status, "committed");
      assert.equal((await success("knowledge.upload.list", {}, "capability_read")).total, 3);
      const db = new DatabaseSync(join(root, "core.sqlite"));
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM upload_chunks WHERE upload_id=?").get(args.uploadId).n, 0); }
      finally { db.close(); }
    }
    if (domain === "resource") {
      const plan = deserializeResourceLifecyclePlan(pending.row.plan);
      for (const change of plan.changes) {
        assert.deepEqual(await bytes(join(root, change.area, change.path)), change.after);
      }
      assert.deepEqual(committed, plan.result);
    }
    if (domain === "project") {
      const plan = deserializeProjectMutationPlan(pending.row.plan);
      for (const file of plan.files) {
        assert.deepEqual(await bytes(join(root, file.relativePath)), file.afterBase64 === null ? null : Buffer.from(file.afterBase64, "base64"));
      }
      assert.deepEqual(committed, plan.result);
    }
    await arm();
    for (const via of ["http", "mcp"]) assert.deepEqual(await success(operation, args, "capability_call", via), committed);
    assert.equal((await readFile(trace, "utf8")), "");
    assert.equal(JSON.parse(await readFile(control, "utf8")).hits, 0);
    assert.deepEqual(await readFile(target), finalBytes);
    assert.equal(inspect(argsId).receipts, 1);
    await disable();
    if (domain === "upload") assert.deepEqual(finalBytes, uploadBytes);
    if (domain === "resource") { assert.deepEqual(finalBytes, sourceBytes); assert.equal(await bytes(source), null); }
    if (domain !== "document") assert.deepEqual(await readFile(documentFile), originalMarkdown);
    recovery = "recognized-recovery-single-receipt-dual-transport-idempotent";
    finalHash = sha256(finalBytes);
  }
  measurements.reopenMs = performance.now() - reopenStart;
  await close();
  await walk(parent);
  measurements.rssBytes = process.memoryUsage().rss;
  measurements.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  measurements.cpuMicros = process.cpuUsage();
  measurements.fds = (await readdir("/proc/self/fd")).length;
  assert(measurements.files <= qualification.bounds.childFixtureFiles);
  assert(measurements.bytes <= qualification.bounds.childFixtureBytes);
  assert(measurements.peakRssBytes <= qualification.bounds.childPeakRssBytes);
  assert(measurements.activeFds <= qualification.bounds.childFileDescriptors);
  assert(measurements.fds <= qualification.bounds.childFileDescriptors);
  assert(measurements.closeMs.every(ms => ms <= qualification.bounds.requestTimeoutMs));
  assert(measurements.latenciesMs.every(ms => ms <= qualification.bounds.requestTimeoutMs));
  process.stdout.write(JSON.stringify({
    report: { domain, fault: fault.name, transport, tamper, event, scopeSentinel: "outside-workspace-write-fsync-rename-unaffected", surfacedCode: failed.error.code,
      effect: failed.error.effect, beforeRecovery: { journal, pending: 1, receipts: 0 },
      intentBytesSha256: sha256(pending.row.plan ?? pending.row.after_markdown ?? pending.row.content),
      initialTargetSha256: initialTarget === null ? null : sha256(initialTarget),
      sourceMarkdownSha256: sha256(originalMarkdown), recovery, restartError, finalHash,
      uploadBackpressure: domain === "upload" ? "four-active-fifth-BUSY-not-committed" : null },
    measurements,
  }) + "\n");
} finally { await close(); }
