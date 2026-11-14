import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs/promises";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Core } from "../dist/core.js";
import { CoreError } from "../dist/contracts.js";
import { startHttp } from "../dist/http.js";
import { scanMarkdown } from "../dist/markdown.js";
import { startMcp } from "../dist/mcp.js";
import { Storage, initialize } from "../dist/storage.js";
import { createLegacyReadSnapshot, withLegacyReadPreflight } from "../dist/legacy-read-race.js";

const packageRoot = resolve(import.meta.dirname, "..");
const reportPath = join(packageRoot, "tests", "legacy-read-race.report.json");
const writerPath = join(packageRoot, "tests", "legacy-read-race-writer.mjs");
const actor = { id: "batch13-reader", canWrite: true };
const token = "batch13-isolated-read-token-000000000000000000000000";
const hash = value => createHash("sha256").update(value).digest("hex");
const sourceDigestPattern = /^[a-f0-9]{64}$/;
const invoke = (operation, arguments_) => ({ operation, version: 1, arguments: arguments_ });
const rows = [];

async function captureSources(root) {
  const pins = scanMarkdown(root).map(({ record }) => ({
    area: record.area, path: record.path, identity: record.id,
    revision: String(record.revision), sha256: record.sha256,
  }));
  async function walk(area, directory, prefix = "") {
    const names = await readdir(directory);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      if (name === ".trash" || /^\.pkm-write-/i.test(name)) continue;
      const full = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const metadata = await lstat(full);
      assert.equal(metadata.isSymbolicLink(), false, `unexpected symlink in isolated fixture: ${relative(root, full)}`);
      if (metadata.isDirectory()) {
        await walk(area, full, relativePath);
      } else if (!name.toLowerCase().endsWith(".md")) {
        const content = await readFile(full);
        pins.push({
          area, path: relativePath, identity: `asset:${relativePath}`,
          revision: String(content.length), sha256: hash(content),
        });
      }
    }
  }
  for (const area of ["notes", "skills", "papers"]) {
    try { await walk(area, join(root, area)); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return createLegacyReadSnapshot(pins);
}

async function waitForPaused(directory) {
  const marker = join(directory, "paused");
  if (existsSync(marker)) return;
  const watcher = watch(directory, { signal: AbortSignal.timeout(15_000) });
  if (existsSync(marker)) {
    await watcher.return();
    return;
  }
  try {
    for await (const _event of watcher) {
      if (existsSync(marker)) return;
    }
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error("The storage reader did not reach the deterministic race barrier.", { cause: error });
    }
    if (error?.code === "ENOSPC") {
      console.error("Filesystem watcher capacity exhausted; waiting for the persistent race marker by polling.");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(marker)) return;
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      throw new Error("The storage reader did not reach the deterministic race barrier after watcher exhaustion.", { cause: error });
    }
    throw error;
  }
}

function runWriter(root, action, target) {
  const child = spawnSync(process.execPath, [writerPath, root, action, target], {
    cwd: packageRoot, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `external writer failed\n${child.stdout}\n${child.stderr}`);
  assert.equal(child.stdout, `external-${action}-complete\n`);
}

async function writeDocument(root, index) {
  const documentId = `item-${String(index).padStart(2, "0")}`;
  const path = `${String(index).padStart(2, "0")}.md`;
  const content = [
    "---",
    `documentId: ${documentId}`,
    `title: "Marker ${documentId}"`,
    "revision: 1",
    'type: "general"',
    'tags: ["race"]',
    'created_at: "2025-01-01T00:00:00.000Z"',
    'updated_at: "2025-01-01T00:00:00.000Z"',
    "---",
    `body-marker-${String(index).padStart(2, "0")}`,
    "",
  ].join("\n");
  await writeFile(join(root, "notes", path), content);
}

async function fixture(scenario) {
  const parent = join(packageRoot, "tests", `.legacy-read-race-${randomUUID()}`);
  const root = join(parent, "workspace");
  const barrier = join(parent, "barrier");
  await mkdir(barrier, { recursive: true });
  await initialize(root);
  for (let index = 0; index < 3; index++) await writeDocument(root, index);
  await mkdir(join(root, "notes", "00.assets"), { recursive: true });
  await writeFile(join(root, "notes", "00.assets", "diagram.bin"), Buffer.from("asset-v1"));
  process.env.PKM_LEGACY_READ_RACE_ROOT = root;
  process.env.PKM_LEGACY_READ_RACE_TARGET = scenario.hookTarget;
  process.env.PKM_LEGACY_READ_RACE_BARRIER = barrier;
  let storage;
  try {
    storage = await Storage.open(root);
    const core = new Core(storage);
    const guardedCore = {
      async dispatch(method, input, requestActor) {
        if (method !== "capability_read" || input?.operation !== scenario.operation) {
          return core.dispatch(method, input, requestActor);
        }
        try {
          return await withLegacyReadPreflight(
            () => captureSources(root),
            () => core.dispatch(method, input, requestActor),
          );
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== "CONFLICT") throw error;
          return {
            schema: "pkm.next-result/v1", requestId: randomUUID(),
            error: { code: "CONFLICT", message: error.message, effect: "not-committed" },
          };
        }
      },
    };
    return {
      parent, root, barrier, storage, core: guardedCore,
      async close() {
        await storage?.close();
        storage = undefined;
        delete process.env.PKM_LEGACY_READ_RACE_ROOT;
        delete process.env.PKM_LEGACY_READ_RACE_TARGET;
        delete process.env.PKM_LEGACY_READ_RACE_BARRIER;
        await rm(parent, { recursive: true, force: true });
      },
    };
  } catch (error) {
    delete process.env.PKM_LEGACY_READ_RACE_ROOT;
    delete process.env.PKM_LEGACY_READ_RACE_TARGET;
    delete process.env.PKM_LEGACY_READ_RACE_BARRIER;
    await storage?.close();
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function baseline(fixture_, scenario) {
  if (scenario.protocol === "http") {
    const http = await startHttp(fixture_.core, token, actor);
    const call = async args => {
      const response = await fetch(`${http.url}/v1/capability_read`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(invoke(scenario.operation, args)),
      });
      return { status: response.status, envelope: await response.json() };
    };
    return {
      call,
      close: () => new Promise((resolveClose, reject) =>
        http.server.close(error => error ? reject(error) : resolveClose())),
    };
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcp(fixture_.core, actor, serverTransport);
  const client = new Client({ name: "batch13-legacy-read-race", version: "1" });
  await client.connect(clientTransport);
  return {
    call: async args => ({ status: 200, envelope: await client.callTool({
      name: "capability_read", arguments: invoke(scenario.operation, args),
    }) }),
    close: async () => { await client.close(); await server.close(); },
  };
}

function assertStablePins(result, operation) {
  if (operation === "knowledge.document.list") {
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 3);
    assert.equal(result.nextOffset, 2);
    assert.match(result.workspaceRevision, /^[a-f0-9]{64}$/);
    const records = scanMarkdown(activeRoot).map(({ record }) => record);
    assert.equal(result.workspaceRevision, hash(JSON.stringify(records.map(record =>
      [record.id, record.area, record.path, record.sha256]))));
    for (const item of result.items) {
      const source = records.find(record => record.id === item.id);
      assert(source);
      assert.deepEqual([item.id, item.path, item.revision, item.sha256],
        [source.id, source.path, source.revision, source.sha256]);
    }
  } else if (operation === "knowledge.document.get") {
    const source = scanMarkdown(activeRoot).find(({ record }) => record.id === result.id)?.record;
    assert(source);
    assert.deepEqual([result.id, result.path, result.revision, result.sha256],
      [source.id, source.path, source.revision, source.sha256]);
    assert.equal(result.content, "body-marker-00\n");
  } else if (operation === "knowledge.note.list" || operation === "knowledge.note.search") {
    assert.match(result.snapshotRevision, /^[a-f0-9]{64}$/);
    assert(result.items.length > 0);
    for (const item of result.items) {
      const source = scanMarkdown(activeRoot).find(({ record }) => record.id === item.documentId)?.record;
      assert(source);
      assert.deepEqual([item.documentId, item.path, item.documentSha256],
        [source.id, source.path, source.sha256]);
      assert.equal(item.title, `Marker ${source.id}`);
      assert.equal(item.type, "general");
      assert.deepEqual(JSON.parse(item.tags), ["race"]);
      if (operation === "knowledge.note.search") assert.equal("content" in item, false);
    }
  } else if (operation === "knowledge.asset.list") {
    const source = scanMarkdown(activeRoot).find(({ record }) => record.id === result.id)?.record;
    assert(source);
    assert.equal(result.documentSha256, source.sha256);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.items.map(item => [item.path, item.digest, item.size]), [
      ["00.assets/diagram.bin", `sha256:${hash(Buffer.from("asset-v1"))}`, 8],
    ]);
    assert.equal(result.revision, hash(JSON.stringify([source.sha256, result.items])));
  } else if (operation === "knowledge.asset.get") {
    const source = scanMarkdown(activeRoot).find(({ record }) => record.id === result.id)?.record;
    assert(source);
    assert.equal(result.documentSha256, source.sha256);
    assert.equal(result.path, "00.assets/diagram.bin");
    assert.equal(result.digest, `sha256:${hash(Buffer.from("asset-v1"))}`);
    assert.equal(Buffer.from(result.data, "base64").toString("utf8"), "asset-v1");
    assert.equal(result.offset, 0);
    assert.equal(result.nextOffset, null);
  }
}

let activeRoot;

const scenarios = [
  {
    id: "http-paginated-document-list-update",
    protocol: "http", operation: "knowledge.document.list", hookTarget: "notes/00.md",
    target: "notes/02.md", action: "update",
    args: { offset: 0, limit: 2 },
  },
  {
    id: "mcp-document-read-rename",
    protocol: "mcp", operation: "knowledge.document.get", hookTarget: "notes/00.md",
    target: "notes/02.md", action: "rename", args: { id: "item-00" },
  },
  {
    id: "http-note-search-delete",
    protocol: "http", operation: "knowledge.note.search", hookTarget: "notes/00.md",
    target: "notes/02.md", action: "delete", args: { query: "Marker", limit: 1 },
  },
  {
    id: "http-note-state-page-delete",
    protocol: "http", operation: "knowledge.note.list", hookTarget: "notes/00.md",
    target: "notes/02.md", action: "delete", args: { offset: 0, limit: 2 },
  },
  {
    id: "mcp-asset-list-write",
    protocol: "mcp", operation: "knowledge.asset.list", hookTarget: "notes/00.md",
    target: "notes/00.assets/diagram.bin", action: "asset", args: { id: "item-00", offset: 0, limit: 2 },
  },
  {
    id: "http-asset-chunk-write",
    protocol: "http", operation: "knowledge.asset.get", hookTarget: "notes/00.md",
    target: "notes/00.assets/diagram.bin", action: "asset",
    args: root => ({
      id: "item-00", path: "00.assets/diagram.bin",
      expectedDocumentSha256: scanMarkdown(root).find(({ record }) => record.id === "item-00").record.sha256,
      expectedDigest: `sha256:${hash(Buffer.from("asset-v1"))}`,
      offset: 0, length: 8,
    }),
  },
];

async function qualifyScenario(scenario) {
  const instance = await fixture(scenario);
  activeRoot = instance.root;
  let transport;
  try {
    await assert.rejects(Storage.open(instance.root), error => error?.code === "BUSY",
      "the read qualifier must not admit a second native workspace owner");
    const requestArgs = typeof scenario.args === "function" ? scenario.args(instance.root) : scenario.args;
    transport = await baseline(instance, scenario);
    const first = await transport.call(requestArgs);
    assert.equal(first.status, 200);
    const successful = first.envelope.structuredContent ?? first.envelope;
    assert.equal(successful.error, undefined);
    const baselineResult = successful.result;
    assertStablePins(baselineResult, scenario.operation);
    const args = { ...requestArgs };
    if (scenario.operation === "knowledge.document.list") args.workspaceRevision = baselineResult.workspaceRevision;
    if (scenario.operation === "knowledge.note.list" || scenario.operation === "knowledge.note.search") {
      args.snapshotRevision = baselineResult.snapshotRevision;
    }

    await writeFile(join(instance.barrier, "armed"), "armed");
    const racingRead = transport.call(args);
    await waitForPaused(instance.barrier);
    runWriter(instance.root, scenario.action, scenario.target);
    await writeFile(join(instance.barrier, "release"), "release");
    const raced = await racingRead;
    const envelope = raced.envelope.structuredContent ?? raced.envelope;
    assert.equal(scenario.protocol === "http" ? raced.status : 200,
      scenario.protocol === "http" ? 409 : 200);
    assert.equal(envelope.error?.code, "CONFLICT",
      `${scenario.id} returned something other than an explicit retry conflict: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.error.effect, "not-committed");
    rows.push({
      id: scenario.id,
      protocol: scenario.protocol,
      operation: scenario.operation,
      externalMutation: scenario.action,
      interleaving: "writer completed after a source read was paused and before the request finished",
      stableBaselinePins: ["identity", "revision", "sha256"],
      racedOutcome: "CONFLICT",
      mixedOrPartialResultReturned: false,
    });
  } finally {
    await transport?.close();
    delete process.env.PKM_LEGACY_READ_RACE_ROOT;
    delete process.env.PKM_LEGACY_READ_RACE_TARGET;
    delete process.env.PKM_LEGACY_READ_RACE_BARRIER;
    await instance.close();
    activeRoot = undefined;
  }
}

async function rejectMixedAggregate() {
  const parent = join(packageRoot, "tests", `.legacy-read-race-mix-${randomUUID()}`);
  const root = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(root);
  for (let index = 0; index < 3; index++) await writeDocument(root, index);
  let mixed;
  try {
    await assert.rejects(withLegacyReadPreflight(
      () => captureSources(root),
      async () => {
        const first = await readFile(join(root, "notes", "00.md"), "utf8");
        runWriter(root, "update", "notes/02.md");
        const last = await readFile(join(root, "notes", "02.md"), "utf8");
        mixed = { first: first.includes("body-marker-00"), last: last.includes("body-marker-02-updated") };
        return mixed;
      },
    ), error => error?.code === "CONFLICT" && error?.effect === "not-committed");
    assert.deepEqual(mixed, { first: true, last: true },
      "the fixture must actually construct an old/new mixed aggregate before the helper rejects it");
    rows.push({
      id: "helper-rejects-explicit-old-new-mix",
      protocol: "helper-seam",
      operation: "multi-source-read",
      externalMutation: "update",
      interleaving: "first source read before update; later source read after atomic replacement",
      racedOutcome: "CONFLICT",
      mixedAggregateWasConstructed: true,
      mixedAggregateWasReturned: false,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function validateReportSources(report, label, base, aggregateFormula) {
  assert(report.nativeSources && typeof report.nativeSources === "object" && !Array.isArray(report.nativeSources),
    `${label} must contain a native source map`);
  assert(report.originalSources && typeof report.originalSources === "object" && !Array.isArray(report.originalSources),
    `${label} must contain an original source map`);
  const nativeEntries = Object.entries(report.nativeSources);
  const sortedNativeEntries = [...nativeEntries].sort(([left], [right]) => left.localeCompare(right));
  assert(nativeEntries.length > 0, `${label} native source map must not be empty`);
  for (const [path, expected] of nativeEntries) {
    assert(sourceDigestPattern.test(expected), `${label} has an invalid native digest for ${path}`);
    assert.equal(hash(await readFile(join(base, path))), expected, `${label} native source changed: ${path}`);
  }
  for (const [path, expected] of Object.entries(report.originalSources)) {
    assert(sourceDigestPattern.test(expected), `${label} has an invalid original digest for ${path}`);
    assert.equal(hash(await readFile(resolve(packageRoot, "..", path))), expected,
      `${label} original source changed: ${path}`);
  }
  assert.equal(report.nativeSourceSetSha256, aggregateFormula(nativeEntries, sortedNativeEntries),
    `${label} native source-set aggregate changed`);
  for (const row of report.rows) {
    assert.equal(row.originalSourceSha256, report.originalSources[row.originalFile],
      `${label} row original source pin changed: ${row.originalFile}`);
    for (const source of row.nativeImplementationSources ?? []) {
      assert.equal(source.sha256, report.nativeSources[source.path],
        `${label} row native source pin changed: ${source.path}`);
    }
  }
}

async function pinOriginalOracle() {
  const oraclePath = join(packageRoot, "tests", "legacy-regression-oracle.report.json");
  const oracleBytes = await readFile(oraclePath);
  const oracle = JSON.parse(oracleBytes.toString("utf8"));
  assert.equal(oracle.schema, "pkm.next-server.legacy-regression-oracle/v1");
  assert.equal(oracle.result, "passed");
  assert.deepEqual(oracle.totals, {
    verifiedRows: 15, unsupportedRows: 1, passedRows: 15, assertions: 109,
  });
  assert.equal(oracle.execution?.workingDirectory, "next-server");
  assert.equal(oracle.execution?.testFile, "tests/legacy-regression-oracle.test.mjs");
  assert(sourceDigestPattern.test(oracle.execution?.testSourceSha256));
  assert.equal(hash(await readFile(join(packageRoot, oracle.execution.testFile))), oracle.execution.testSourceSha256,
    "Original oracle qualification test changed after report generation.");
  await validateReportSources(
    oracle,
    "Original oracle report",
    packageRoot,
    (_entries, sortedEntries) => hash(JSON.stringify(sortedEntries)),
  );
  const row = oracle.rows.find(value =>
    value.originalFile === "tests/test-todo-board.js" &&
    value.originalTestcase === "competing Board commands across processes have exactly one CAS winner");
  const readRow = oracle.rows.find(value =>
    value.originalFile === "tests/test-knowledge-contracts.js" &&
    value.originalTestcase === "top-level original knowledge identity/revision assertions");
  assert(row);
  assert(readRow);
  assert.equal(row.originalSourceSha256, "c8f9bbdcad4d9c375b5dc727a9581b433504b24076669104b05e93f7c371df17");
  assert.deepEqual(row.nativeOperations, ["todo.workitem.create", "todo.workitem.list"]);
  assert.equal(row.scenario, "The native transport performs a stale-digest conflict check in a single writer process, but cannot execute the original simultaneous multi-process race.");
  assert.equal(row.result, "unsupported");
  assert.equal(row.assertions, 0);
  assert.deepEqual(row.evidence, ["Only sequential stale-digest behavior ran; simultaneous process race deliberately not claimed."]);
  assert.equal(row.unsupportedReason, "The enforced single-writer lease prevents an HTTP and an MCP server from concurrently opening the same workspace; only sequential stale-CAS behavior was verified.");
  assert.equal(readRow.originalSourceSha256, "bf7f6631653c86882373cd94a19009573490410ccbd5c72f1bc2ac98fd4178a8");
  assert.deepEqual(readRow.nativeOperations, ["knowledge.note.list", "knowledge.note.get"]);
  assert.equal(readRow.scenario, "An external body edit invalidates the previously issued Note snapshot; conflicting id+path selectors and an escaping path fail with exact INVALID_ARGUMENT errors.");
  assert.equal(readRow.result, "passed");
  assert.equal(readRow.assertions, 3);
  assert.deepEqual(readRow.evidence, [
    "knowledge.note.list(snapshotRevision=pre-edit) returned CONFLICT after direct external body edit.",
    "knowledge.note.get({id,path}) and knowledge.note.get({path:'../unsafe.md'}) each returned INVALID_ARGUMENT.",
  ]);
  assert.equal(readRow.unsupportedReason, null);
  const batch12Bytes = await readFile(join(packageRoot, "tests", "legacy-regression-batch12.report.json"));
  const batch12 = JSON.parse(batch12Bytes.toString("utf8"));
  assert.equal(batch12.schema, "pkm.next-server.legacy-regression-batch12/v1");
  assert.equal(batch12.result, "passed");
  assert.equal(batch12.execution?.workingDirectory, "next-server");
  assert.equal(batch12.execution?.testFile, "tests/legacy-regression-batch12.test.mjs");
  assert.equal(batch12.execution?.testSourceSha256, undefined,
    "Batch12 report format must not claim a standalone testSourceSha256 it did not publish.");
  await validateReportSources(
    batch12,
    "Batch12 report",
    packageRoot,
    (entries, sortedEntries) => {
      assert.deepEqual(entries.map(([path]) => path), sortedEntries.map(([path]) => path),
        "Batch12 native source map must remain in deterministic sorted order.");
      return hash(entries.map(([path, digest]) => `${path}:${digest}`).join("\n"));
    },
  );
  assert.equal(batch12.nativeSources[batch12.execution.testFile], hash(
    await readFile(join(packageRoot, batch12.execution.testFile)),
  ), "Batch12 report's native source map does not pin its qualification test.");
  assert.deepEqual(batch12.totals, { newCases: 17, verifiedRows: 16, unsupportedRows: 1, mismatchedRows: 0, assertions: 68 });
  assert(batch12.scopeDifferences.includes(
    "The prior cross-process Board race remains unsupported: the enforced single-writer lease prevents HTTP and MCP servers from concurrently opening one workspace; no other conflict check is substituted for that race.",
  ));
  return {
    path: "tests/legacy-regression-oracle.report.json",
    sha256: hash(oracleBytes),
    priorBatch12Report: {
      path: "tests/legacy-regression-batch12.report.json",
      sha256: hash(batch12Bytes),
      totals: batch12.totals,
    },
    originalFile: row.originalFile,
    originalTestcase: row.originalTestcase,
    originalSourceSha256: row.originalSourceSha256,
    nativeOperations: row.nativeOperations,
    result: row.result,
    assertions: row.assertions,
    scenario: row.scenario,
    evidence: row.evidence,
    unsupportedReason: row.unsupportedReason,
    originalReadContract: {
      originalFile: readRow.originalFile,
      originalTestcase: readRow.originalTestcase,
      originalSourceSha256: readRow.originalSourceSha256,
      nativeOperations: readRow.nativeOperations,
      result: readRow.result,
      assertions: readRow.assertions,
      scenario: readRow.scenario,
      evidence: readRow.evidence,
      unsupportedReason: readRow.unsupportedReason,
      nativeImplementationSources: readRow.nativeImplementationSources,
    },
  };
}

async function sourceHashes() {
  const sources = [
    "src/assets.ts", "src/contracts.ts", "src/core.ts", "src/domain/knowledge-contracts.ts",
    "src/domain/knowledge-index.ts", "src/http.ts", "src/knowledge-snapshot.ts",
    "src/legacy-read-race.ts", "src/links.ts", "src/markdown.ts", "src/mcp.ts",
    "src/metadata.ts", "src/note-contracts.ts", "src/notes.ts", "src/research-contracts.ts",
    "src/search-contracts.ts", "src/search.ts", "src/skill-contracts.ts",
    "src/skill-routing-contracts.ts", "src/storage-worker.ts", "src/storage.ts",
    "tests/legacy-read-race-hook.mjs", "tests/legacy-read-race-runner.mjs",
    "tests/legacy-read-race-writer.mjs", "tests/legacy-read-race.test.mjs",
    "tests/legacy-regression-batch12.test.mjs",
  ];
  const result = {};
  for (const path of sources.sort()) result[path] = hash(await readFile(join(packageRoot, path)));
  return result;
}

async function main() {
  const originalOracle = await pinOriginalOracle();
  for (const scenario of scenarios) await qualifyScenario(scenario);
  await rejectMixedAggregate();
  const report = {
    schema: "pkm.legacy-read-race-qualification/v1",
    sourceHashes: await sourceHashes(),
    originalOracle,
    readConsistency: {
      finding: "Client revision pins are preserved, but scan and asset re-reads are not atomic against non-PKM external writers; the native owner lease excludes competing native owners only.",
      helper: {
        path: "src/legacy-read-race.ts",
        seam: "Wrap the existing read dispatch with withLegacyReadPreflight(captureExactSourcePins, readDispatch).",
        failure: "CONFLICT with effect not-committed; callers restart pagination from its first page.",
        existingReadRevisionContractsChanged: false,
        noSilentFallback: true,
        writesOrRetriesPerformed: false,
      },
      nativeOwnership: {
        unchanged: true,
        secondNativeOwnerRejected: true,
        externalFileWriterDoesNotAcquireOrBypassNativeLease: true,
        nativeOwnerConcurrencyClaim: "single native workspace owner only",
      },
      limitations: [
        "Preflight/postflight digest comparison detects source changes observed across the read; it is not an atomic filesystem snapshot or a lock.",
        "An external writer that changes and restores identical bytes between both captures (ABA) is not detected.",
        "This does not qualify production storage SLOs, physical faults, or native-owner concurrent writes.",
        "No original oracle testcase claims this external Markdown-writer read guarantee; the separately listed original simultaneous Board command race remains unsupported.",
      ],
    },
    cases: rows,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
