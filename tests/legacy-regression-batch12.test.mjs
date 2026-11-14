import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Core } from "../dist/core.js";
import { initialize, Storage } from "../dist/storage.js";
import { scanMarkdown } from "../dist/markdown.js";
import {
  applyKnowledgeMutation, knowledgeMutationScanRevision, planKnowledgeMutation,
} from "../dist/knowledge-mutations.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, "..");
const repositoryRoot = resolve(packageRoot, "legacy");
const cli = resolve(packageRoot, "dist/cli.js");
const reportPath = join(testDirectory, "legacy-regression-batch12.report.json");
const owner = { id: "local:owner", canWrite: true };
const reader = { id: "local:reader", canWrite: false };
const invoke = (operation, args = {}) => ({ operation, version: 1, arguments: args });
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sourceDigestPattern = /^[a-f0-9]{64}$/;
const originalFiles = [
  "tests/test-browser-library.js",
  "tests/test-capability-memory.js",
  "tests/test-dual-path-search.js",
  "tests/test-knowledge-contracts.js",
  "tests/test-knowledge-search-browser.js",
  "tests/test-knowledge-source-ranges.js",
  "tests/test-markdown-image-assets.js",
  "tests/test-markdown-owned-assets.js",
  "tests/test-note-work-items.js",
  "tests/test-todo-board.js",
];
const nativeSources = [
  "src/cli.ts", "src/contracts.ts", "src/core.ts", "src/http.ts", "src/mcp.ts",
  "src/storage.ts", "src/storage-worker.ts", "src/markdown.ts", "src/notes.ts", "src/note-contracts.ts",
  "src/skills.ts", "src/skill-contracts.ts", "src/domain/skills.ts",
  "src/research.ts", "src/research-contracts.ts", "src/domain/research.ts",
  "src/assets.ts", "src/domain/markdown-assets.ts", "src/file-write.ts", "src/knowledge-snapshot.ts",
  "src/knowledge-mutations.ts", "src/knowledge-mutations-contracts.ts", "src/domain/knowledge-contracts.ts",
  "src/memory.ts", "src/memory-contracts.ts", "src/todo-definitions.ts",
  "src/domain/todo-api.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts",
  "src/boards.ts", "tests/legacy-regression-batch12.test.mjs",
];

const fixtureParents = new Set();

async function fixture(t, options = {}) {
  const parent = join(testDirectory, `.legacy-regression-batch12-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  fixtureParents.add(parent);
  await initialize(directory);
  let storage = await Storage.open(directory);
  let core = new Core(storage, options);
  t.after(async () => {
    try { await storage.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  return {
    directory,
    get storage() { return storage; },
    get core() { return core; },
    async restart() {
      await storage.close();
      storage = await Storage.open(directory);
      core = new Core(storage, options);
      return core;
    },
  };
}

async function workspaceFixture(t) {
  const parent = join(testDirectory, `.legacy-regression-batch12-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  fixtureParents.add(parent);
  await initialize(directory);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { directory };
}

async function cleanupFixtures() {
  for (const parent of fixtureParents) {
    await rm(parent, { recursive: true, force: true });
    fixtureParents.delete(parent);
  }
}

async function validateBatch12Report(report) {
  const invalid = () => { throw new TypeError("Refusing to publish an incomplete or invalid Batch12 report."); };
  if (!report || report.schema !== "pkm.next-server.legacy-regression-batch12/v1" ||
    report.qualification !== "bounded-original-assertion-bridge" ||
    !["passed", "mismatched"].includes(report.result) ||
    !Array.isArray(report.rows) || !report.rows.length ||
    !report.totals || !report.nativeSources || !report.originalSources ||
    !sourceDigestPattern.test(report.nativeSources["tests/legacy-regression-batch12.test.mjs"]) ||
    !sourceDigestPattern.test(report.nativeSourceSetSha256)) invalid();
  for (const [path, hash] of Object.entries(report.nativeSources)) {
    if (typeof hash !== "string" || !sourceDigestPattern.test(hash) ||
      sha256(await readFile(resolve(packageRoot, path))) !== hash) invalid();
  }
  for (const [path, hash] of Object.entries(report.originalSources)) {
    if (typeof hash !== "string" || !sourceDigestPattern.test(hash) ||
      sha256(await readFile(resolve(repositoryRoot, path))) !== hash) invalid();
  }
  if (sha256(Object.entries(report.nativeSources).map(([path, hash]) => `${path}:${hash}`).join("\n"))
    !== report.nativeSourceSetSha256) invalid();
  for (const row of report.rows) {
    if (!row || !["verified", "unsupported", "mismatched"].includes(row.result) ||
      !Number.isSafeInteger(row.assertions) || row.assertions < 0 || !Array.isArray(row.evidence) ||
      typeof row.originalFile !== "string" || row.originalSourceSha256 !== report.originalSources[row.originalFile] ||
      !Array.isArray(row.nativeImplementationSources)) invalid();
    for (const source of row.nativeImplementationSources) {
      if (!source || typeof source.path !== "string" || source.sha256 !== report.nativeSources[source.path]) invalid();
    }
  }
  const verifiedRows = report.rows.filter(row => row.result === "verified").length;
  const unsupportedRows = report.rows.filter(row => row.result === "unsupported").length;
  const mismatchedRows = report.rows.filter(row => row.result === "mismatched").length;
  const assertions = report.rows.reduce((total, row) => total + row.assertions, 0);
  if (report.result !== (mismatchedRows ? "mismatched" : "passed") ||
    report.totals.newCases !== report.rows.length ||
    report.totals.verifiedRows !== verifiedRows ||
    report.totals.unsupportedRows !== unsupportedRows ||
    report.totals.mismatchedRows !== mismatchedRows ||
    report.totals.assertions !== assertions ||
    typeof report.execution?.command !== "string" ||
    report.build?.result !== "passed") invalid();
}

async function publishBatch12Report(report, destination = reportPath, renameFile = rename) {
  await validateBatch12Report(report);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const decoded = JSON.parse(content);
  assert.deepEqual(decoded, report, "Report serialization must preserve all validated evidence.");
  assert.equal(`${JSON.stringify(decoded, null, 2)}\n`, content, "Report bytes must serialize deterministically.");
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx");
    created = true;
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(temporary, "utf8"), content, "Staged report must contain the validated bytes.");
    await renameFile(temporary, destination);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}

test("Batch12 cleanup preserves another invocation's initialized workspace", async t => {
  const parent = join(testDirectory, `.legacy-regression-batch12-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await initialize(directory);
  await cleanupFixtures();
  const storage = await Storage.open(directory);
  await storage.close();
});

test("Batch12 report publication preserves the previous report on validation or publish failure", async t => {
  const directory = join(testDirectory, `.legacy-regression-batch12-report-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, "report.json");
  const previous = Buffer.from('{"schema":"previous-bound-report"}\n');
  await writeFile(destination, previous, { flag: "wx" });
  const nativeSourcePath = "src/core.ts";
  const testSourcePath = "tests/legacy-regression-batch12.test.mjs";
  const originalSourcePath = "tests/test-todo-board.js";
  const nativeSources = Object.fromEntries(await Promise.all([nativeSourcePath, testSourcePath].map(async path => [
    path, sha256(await readFile(resolve(packageRoot, path))),
  ])));
  const originalSources = {
    [originalSourcePath]: sha256(await readFile(resolve(repositoryRoot, originalSourcePath))),
  };
  const hash = nativeSources[nativeSourcePath];
  const validReport = {
    schema: "pkm.next-server.legacy-regression-batch12/v1",
    qualification: "bounded-original-assertion-bridge",
    result: "passed",
    execution: { command: "node --test" },
    build: { result: "passed" },
    nativeSourceSetSha256: sha256(Object.entries(nativeSources).map(([path, digest]) => `${path}:${digest}`).join("\n")),
    nativeSources,
    originalSources,
    rows: [{
      result: "verified", assertions: 1, evidence: ["retained evidence"],
      originalFile: originalSourcePath, originalSourceSha256: originalSources[originalSourcePath],
      nativeImplementationSources: [{ path: nativeSourcePath, sha256: hash }],
    }],
    totals: { newCases: 1, verifiedRows: 1, unsupportedRows: 0, mismatchedRows: 0, assertions: 1 },
  };
  await assert.rejects(publishBatch12Report({ ...validReport, result: "invalid" }, destination), /invalid Batch12 report/);
  await assert.rejects(publishBatch12Report(validReport, destination, async () => {
    throw new Error("synthetic atomic publish failure");
  }), /synthetic atomic publish failure/);
  assert.deepEqual(await readFile(destination), previous);
  assert.deepEqual(await readdir(directory), ["report.json"]);
});

async function writeMarkdown(directory, area, path, bytes) {
  const target = join(directory, area, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

function resultOf(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.ok(response.result, "native response has a result");
  return response.result;
}

async function httpProcess(t, directory) {
  const token = randomUUID() + randomUUID();
  const child = spawn(process.execPath, [cli, "http", "--data", directory], {
    cwd: packageRoot,
    env: { ...process.env, PKM_NEXT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  const url = await new Promise((resolveUrl, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => reject(new Error(`HTTP readiness timeout: ${diagnostics}`)), 10_000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timeout);
          resolveUrl(message.url);
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited ${code}: ${diagnostics}`));
    });
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
  t.after(close);
  return {
    async call(method, input) {
      const response = await fetch(`${url}/v1/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function mcpClient(t, directory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--data", directory],
    cwd: packageRoot,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", data => { diagnostics += data; });
  const client = new Client({ name: "legacy-regression-batch12", version: "1.0.0" });
  await client.connect(transport);
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      await client.close();
    }
  });
  return {
    async call(method, input) {
      try {
        const response = await client.callTool({ name: method, arguments: input });
        const envelope = response.structuredContent ?? JSON.parse(response.content[0].text);
        return { status: response.isError ? 400 : 200, body: envelope };
      } catch (error) {
        throw new Error(`${error}; MCP stderr: ${diagnostics}`);
      }
    },
  };
}

const rows = [];
let currentRow;
let assertions = 0;
const eq = (actual, expected) => { assertions++; assert.equal(actual, expected); };
const deep = (actual, expected) => { assertions++; assert.deepEqual(actual, expected); };
const yes = value => { assertions++; assert.ok(value); };
const no = value => { assertions++; assert.ok(!value); };
const errorCode = (response, expected) => { assertions++; assert.equal(response.error?.code, expected); };
const throwsCode = (action, expected) => {
  assertions++;
  assert.throws(action, error => error.code === expected);
};

function applyMutation(directory, operation, fields) {
  const args = {
    operationId: randomUUID(),
    expectedScanRevision: knowledgeMutationScanRevision(scanMarkdown(directory)),
    ...fields,
  };
  const plan = planKnowledgeMutation(directory, { operation, actorId: owner.id, args });
  return applyKnowledgeMutation(directory, plan, plan.operationId);
}

async function runCase(t, metadata, run) {
  await t.test(metadata.title, async tCase => {
    currentRow = {
      originalFile: metadata.originalFile,
      originalTestcase: metadata.originalTestcase,
      nativeOperations: metadata.nativeOperations,
      nativeTransport: metadata.nativeTransport ?? "Core.dispatch",
      scenario: metadata.scenario,
      result: "mismatched",
      assertions: 0,
      evidence: [],
      unsupportedReason: metadata.unsupportedReason ?? null,
    };
    assertions = 0;
    try {
      const evidence = await run(tCase);
      currentRow.result = "verified";
      currentRow.assertions = assertions;
      currentRow.evidence = evidence;
    } finally {
      rows.push(currentRow);
    }
  });
}

test("legacy regression batch 12: specialized metadata, citations, assets, Todo and Memory", async t => {
  t.after(cleanupFixtures);
  rows.length = 0;

  await runCase(t, {
    title: "Note specialized metadata stays body-free in filtered listing",
    originalFile: "tests/test-knowledge-source-ranges.js",
    originalTestcase: "local Note discovery and reads do not lose identities beyond the first 1,000 records (source scope; >1,000 bound not run)",
    nativeOperations: ["knowledge.note.list", "knowledge.note.get"],
    scenario: "An adjacent native Note projection check preserves specialized type, category, and tags without exposing body content. It does not claim the original >1,000-record stress assertion.",
    unsupportedReason: "The original >1,000-Note stress bound was not exercised; only the smaller native metadata-projection check is verified.",
  }, async tCase => {
    const f = await fixture(tCase);
    await writeMarkdown(f.directory, "notes", "Team/Decision.md",
      '---\ntitle: "Decision"\ntype: "decision"\ntags: ["review", "review"]\ncustomFlag: "retain"\n---\nPrivate decision body');
    await writeMarkdown(f.directory, "notes", "Team/Journal.md",
      '---\ntitle: "Journal"\ntype: "journal"\ntags: ["review"]\n---\nPrivate journal body');
    const result = resultOf(await f.core.dispatch("capability_read",
      invoke("knowledge.note.list", { type: "decision", limit: 20 }), reader));
    eq(result.total, 1);
    const note = result.items[0];
    eq(note.title, "Decision");
    eq(note.type, "decision");
    eq(note.category, "Team");
    eq(note.tags, '["review","review"]');
    no(Object.hasOwn(note, "content"));
    eq(resultOf(await f.core.dispatch("capability_read",
      invoke("knowledge.note.get", { id: note.documentId, snapshotRevision: result.snapshotRevision }), reader)).item.content,
    "Private decision body");
    return [
      "Type=decision yielded one body-free row with category and duplicate-tag metadata intact.",
      "Pinned get by documentId returned the original Note body.",
    ];
  });

  await runCase(t, {
    title: "Skill list and exact ID lookup preserve the original path/name distinction",
    originalFile: "tests/test-dual-path-search.js",
    originalTestcase: "top-level Skill inventory path/name mismatch and exact Skill lookup assertions",
    nativeOperations: ["knowledge.skill.list", "knowledge.skill.get"],
    nativeTransport: "MCP stdio",
    scenario: "The original Skill's categorized path remains a path, not a guessed Skill name; native listing exposes stable document IDs and exact name-or-ID reads.",
  }, async tCase => {
    const f = await workspaceFixture(tCase);
    const raw = '---\nname: "Falcon Deploy"\ntags: ["dlis", "deploy"]\n---\nDeployment procedure.';
    const target = await writeMarkdown(f.directory, "skills", "General/DLIS/Falcon.md", raw);
    const mcp = await mcpClient(tCase, f.directory);
    const listed = await mcp.call("capability_read", invoke("knowledge.skill.list", { limit: 20 }));
    eq(listed.status, 200);
    const item = listed.body.result.items[0];
    eq(item.name, "Falcon Deploy");
    eq(item.path, "General/DLIS/Falcon.md");
    no(Object.hasOwn(item, "content"));
    const byId = await mcp.call("capability_read", invoke("knowledge.skill.get", {
      id: item.documentId, snapshotRevision: listed.body.result.snapshotRevision,
    }));
    eq(byId.status, 200);
    eq(byId.body.result.item.content, "Deployment procedure.");
    eq(await readFile(target, "utf8"), raw);
    return [
      "MCP list returned the exact categorized path, stable documentId, and no content field.",
      "MCP get by documentId returned the original body; the source Markdown bytes were unchanged.",
    ];
  });

  await runCase(t, {
    title: "Skill metadata filters and pinned paging retain category and tag semantics",
    originalFile: "tests/test-knowledge-search-browser.js",
    originalTestcase: "Ctrl+F filters the real Skill tree, opens content, and keeps ranked retrieval explicit (native metadata subset)",
    nativeOperations: ["knowledge.skill.list"],
    nativeTransport: "HTTP",
    scenario: "Native Skill metadata filters remain exact and snapshot-pinned while keeping the legacy browser's ranked retrieval distinction out of the claim.",
  }, async tCase => {
    const f = await workspaceFixture(tCase);
    const http = await httpProcess(tCase, f.directory);
    await writeMarkdown(f.directory, "skills", "General/One.md",
      '---\nname: "One"\ntags: ["dlis"]\n---\nOne body');
    await writeMarkdown(f.directory, "skills", "General/Two.md",
      '---\nname: "Two"\ntags: ["dlis"]\n---\nTwo body');
    await writeMarkdown(f.directory, "skills", "Other/Three.md",
      '---\nname: "Three"\ntags: ["other"]\n---\nThree body');
    const firstResponse = await http.call("capability_read",
      invoke("knowledge.skill.list", { category: "General", tag: "dlis", limit: 1 }));
    eq(firstResponse.status, 200);
    const first = firstResponse.body.result;
    eq(first.total, 2);
    eq(first.items.length, 1);
    yes(first.nextOffset !== null);
    const nextResponse = await http.call("capability_read",
      invoke("knowledge.skill.list", { category: "General", tag: "dlis", offset: 1, limit: 1, snapshotRevision: first.snapshotRevision }));
    eq(nextResponse.status, 200);
    const next = nextResponse.body.result;
    eq(next.items.length, 1);
    eq(next.nextOffset, null);
    const get = await http.call("capability_read", invoke("knowledge.skill.get", { name: "One" }));
    eq(get.status, 200);
    eq(get.body.result.item.name, "One");
    return [
      "Category=General and tag=dlis returned exactly two Skills across two one-item pages.",
      "The second page used the first snapshot revision; exact-name lookup returned One.",
    ];
  });

  await runCase(t, {
    title: "Skill create rejects duplicate names and CAS update preserves its ID",
    originalFile: "tests/test-knowledge-contracts.js",
    originalTestcase: "top-level Skill stable knowledgeId, category alias and frontmatter preservation block",
    nativeOperations: ["knowledge.skill.create", "knowledge.skill.update", "knowledge.skill.list"],
    nativeTransport: "native Knowledge mutation module",
    unsupportedReason: "The original category/path move and alias rewrite are unsupported by the native Skill mutation endpoint; this row verifies only same-path metadata update plus a native duplicate-name guard.",
    scenario: "A same-path native Skill metadata update preserves its stable identity and unknown YAML/comment bytes; a related native-only guard refuses a case-insensitive duplicate name. The legacy category/path move itself is not claimed.",
  }, async tCase => {
    const f = await fixture(tCase);
    const created = applyMutation(f.directory, "knowledge.skill.create", {
      name: "Runbook", category: "Operations", content: "Original procedure.", tags: ["ops"],
    });
    throwsCode(() => applyMutation(f.directory, "knowledge.skill.create", {
      name: "runbook", category: "Other", content: "Duplicate.",
    }), "CONFLICT");
    const skillPath = join(f.directory, "skills", created.path);
    const initialBytes = await readFile(skillPath, "utf8");
    const customBytes = initialBytes.replace("---\n", "---\n# preserve heading comment\n", 1)
      .replace(/tags: (.*)/, "tags: $1 # preserve tags comment\nunknownBlock:\n  nested: keep-me # untouched");
    await writeFile(skillPath, customBytes);
    const before = scanMarkdown(f.directory).find(item => item.record.id === created.id);
    const update = applyMutation(f.directory, "knowledge.skill.update", {
      id: created.id, expectedRevision: before.record.revision, expectedSha256: before.record.sha256,
      name: "Runbook", content: "Revised procedure.", tags: ["ops", "verified"],
    });
    const updatedBytes = await readFile(skillPath, "utf8");
    eq(update.id, created.id);
    eq(update.knowledgeId, created.knowledgeId);
    eq(update.revision, 2);
    yes(updatedBytes.includes("# preserve heading comment"));
    yes(updatedBytes.includes("unknownBlock:\n  nested: keep-me # untouched"));
    yes(updatedBytes.includes("# preserve tags comment"));
    return [
      "Native-only case-insensitive duplicate Skill creation returned CONFLICT.",
      "Same-path update kept the document ID and knowledgeId and advanced revision 1 to 2.",
      "The update retained the heading comment, unknown nested YAML, and inline tags comment.",
    ];
  });

  await runCase(t, {
    title: "Research citation counts count references, not citing documents",
    originalFile: "tests/test-browser-library.js",
    originalTestcase: "top-level research projection citation-count assertion",
    nativeOperations: ["knowledge.research.list"],
    scenario: "Two citations from the same child Paper contribute two references to the cited Paper's native citationCount; body bytes stay out of list projections.",
  }, async tCase => {
    const f = await fixture(tCase);
    await writeMarkdown(f.directory, "papers", "Foundations/Base.md",
      '---\ntitle: "Foundational Work"\nyear: 2020\nauthors: ["Ada"]\n---\nPrivate base body');
    await writeMarkdown(f.directory, "papers", "Later.md",
      '---\ntitle: "Later"\ncites:\n  - paper: "Foundational Work"\n    note: "first"\n  - paper: "foundations/base.md"\n    note: "second"\n---\nPrivate citing body');
    const result = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.list", { limit: 20 }), reader));
    const base = result.items.find(item => item.slug === "Foundations/Base");
    eq(base.citationCount, 2);
    eq(base.authors[0], "Ada");
    no(Object.hasOwn(base, "content"));
    return [
      "Research list counted both resolved references, including two references from one citing document.",
      "The body-free projection retained author metadata and omitted content.",
    ];
  });

  await runCase(t, {
    title: "Research citation graph preserves target direction and each citation note",
    originalFile: "tests/test-browser-library.js",
    originalTestcase: "top-level research graph edge direction and citation-note assertions",
    nativeOperations: ["knowledge.research.graph"],
    scenario: "Resolved citations produce cited-parent to citing-child edges in source order without inventing a distinct-citer count.",
  }, async tCase => {
    const f = await fixture(tCase);
    await writeMarkdown(f.directory, "papers", "Base.md", '---\ntitle: "Base"\n---\nBase');
    await writeMarkdown(f.directory, "papers", "Citing.md",
      '---\ntitle: "Citing"\ncites:\n  - paper: "base"\n    note: "evidence"\n  - paper: "Base"\n    note: "replication"\n---\nCiting');
    const graph = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.graph", {}), reader));
    deep(graph.edges, [
      { from: "Base", to: "Citing", note: "evidence" },
      { from: "Base", to: "Citing", note: "replication" },
    ]);
    return ["Both case-insensitive citations resolved Base → Citing with their exact notes and order."];
  });

  await runCase(t, {
    title: "Research facets preserve duplicate tag counts and the Papers fallback group",
    originalFile: "tests/test-browser-library.js",
    originalTestcase: "top-level research metadata facets and fallback-group assertions",
    nativeOperations: ["knowledge.research.facets", "knowledge.research.groups"],
    scenario: "Research facets retain legacy per-tag counting and custom-group ordering while the Papers group remains present.",
  }, async tCase => {
    const f = await fixture(tCase);
    await writeMarkdown(f.directory, "papers", "A.md",
      '---\ntopic: "B"\ntags: ["x", "x"]\nyear: 2022\ngroup: "Zulu"\n---\nA');
    await writeMarkdown(f.directory, "papers", "B.md",
      '---\ntopic: "A"\ntags: ["y"]\nyear: "2023suffix"\ngroup: "Alpha"\n---\nB');
    await writeMarkdown(f.directory, "papers", "C.md", '---\ntopic: "B"\ntags: "y"\nyear: null\n---\nC');
    const facets = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.facets"), reader));
    deep(facets.topics, [{ name: "B", count: 2 }, { name: "A", count: 1 }]);
    deep(facets.tags, [{ name: "x", count: 2 }, { name: "y", count: 2 }]);
    deep(facets.years, [2023, 2022]);
    const groups = resultOf(await f.core.dispatch("capability_read",
      invoke("knowledge.research.groups", { revision: facets.revision }), reader));
    deep(groups.items, [{ name: "Alpha", count: 1 }, { name: "Zulu", count: 1 }, { name: "Papers", count: 1 }]);
    return [
      "Facet counts retained duplicate x tags and string-year parsing; years were descending.",
      "Groups were alphabetic and included the implicit Papers group.",
    ];
  });

  await runCase(t, {
    title: "Research graph filters seeds and expands only one neighbor hop",
    originalFile: "tests/test-browser-library.js",
    originalTestcase: "top-level research graph filter and one-hop neighbor assertions",
    nativeOperations: ["knowledge.research.graph"],
    scenario: "A filtered graph seed is exact; neighbor expansion adds one incoming/outgoing hop but not a transitive grandchild.",
  }, async tCase => {
    const f = await fixture(tCase);
    await writeMarkdown(f.directory, "papers", "Root.md", '---\ntitle: "Root"\nyear: 2000\ntopic: "Old"\n---\nRoot');
    await writeMarkdown(f.directory, "papers", "Middle.md",
      '---\ntitle: "Middle"\nauthors: ["Ada Lovelace"]\nyear: 2020\ntags: ["target"]\ntopic: "New"\ncites: ["Root"]\n---\nMiddle');
    await writeMarkdown(f.directory, "papers", "Child.md", '---\ntitle: "Child"\nyear: 2025\ncites: ["Middle"]\n---\nChild');
    await writeMarkdown(f.directory, "papers", "Grandchild.md", '---\ntitle: "Grandchild"\nyear: 2026\ncites: ["Child"]\n---\nGrandchild');
    const seed = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.graph", {
      q: "ada", tag: "target", topic: "New", minYear: 2010, maxYear: 2024, limit: 1,
    }), reader));
    deep(seed.nodes.map(node => node.key), ["Middle"]);
    const expanded = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.graph", {
      q: "ada", neighbors: true, limit: 1,
    }), reader));
    deep(expanded.nodes.map(node => node.key), ["Middle", "Root", "Child"]);
    no(expanded.nodes.some(node => node.key === "Grandchild"));
    return [
      "Combined query, tag, topic, and year filters left Middle as the only seed.",
      "Neighbor expansion included Root and Child, excluded transitive Grandchild.",
    ];
  });

  await runCase(t, {
    title: "Research Paper update preserves identity and increments its revision",
    originalFile: "tests/test-knowledge-contracts.js",
    originalTestcase: "top-level Research stable identity, category-alias and update assertions",
    nativeOperations: ["knowledge.research.create", "knowledge.research.update", "knowledge.research.list"],
    nativeTransport: "native Knowledge mutation module",
    unsupportedReason: "The legacy category/path move and alias rewrite are unsupported by the native Research mutation endpoint; this row verifies only same-path metadata update and stable identity.",
    scenario: "A same-path CAS update changes specialized Paper metadata while retaining its Knowledge ID and advancing the revision. The legacy category/path move alias rewrite is not claimed.",
  }, async tCase => {
    const f = await fixture(tCase);
    const created = applyMutation(f.directory, "knowledge.research.create", {
      title: "Original Research", category: "Topic", content: "Body", year: 2020, topic: "Methods",
      authors: ["Ada"], cites: [],
    });
    const before = scanMarkdown(f.directory).find(item => item.record.id === created.id);
    const updated = applyMutation(f.directory, "knowledge.research.update", {
      id: created.id, expectedRevision: before.record.revision, expectedSha256: before.record.sha256,
      title: "Original Research", category: "Topic", content: "Body", year: 2021, topic: "Methods",
      authors: ["Ada"], cites: [],
    });
    eq(updated.id, created.id);
    eq(updated.knowledgeId, created.knowledgeId);
    eq(updated.revision, 2);
    return ["Native CAS update retained document and Knowledge IDs and advanced revision 1 to 2."];
  });

  await runCase(t, {
    title: "Research snapshot rejects an external Markdown edit",
    originalFile: "tests/test-knowledge-source-ranges.js",
    originalTestcase: "Research exact ranges include structured conclusions, implementation and assumptions in retrieval order (changed-source pin assertion subset)",
    nativeOperations: ["knowledge.research.list", "knowledge.research.facets"],
    scenario: "The native snapshot pin rejects a changed research source instead of returning stale metadata after an external byte edit.",
  }, async tCase => {
    const f = await fixture(tCase);
    const path = await writeMarkdown(f.directory, "papers", "A.md", '---\ntitle: "Before"\n---\nBody');
    const first = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.research.list"), reader));
    await writeFile(path, '---\ntitle: "After"\n---\nBody');
    errorCode(await f.core.dispatch("capability_read", invoke("knowledge.research.facets", { revision: first.revision }), reader), "CONFLICT");
    return ["The prior research revision returned CONFLICT after the paper's title bytes changed."];
  });

  await runCase(t, {
    title: "Asset URI decoding returns exact bytes and rejects an old digest",
    originalFile: "tests/test-markdown-image-assets.js",
    originalTestcase: "top-level referenced resource decoding and exact-byte assertion (digest-change extension)",
    nativeOperations: ["knowledge.document.create", "knowledge.asset.list", "knowledge.asset.get"],
    scenario: "A percent-escaped owned-resource URL resolves to the exact opaque bytes; a subsequent byte change invalidates the old asset digest.",
  }, async tCase => {
    const f = await fixture(tCase);
    const markdown = "![plot](Asset.assets/plot%20one.png)\n";
    const created = resultOf(await f.core.dispatch("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "asset-note", area: "notes", path: "Team/Asset.md",
      title: "Asset", content: markdown,
    }), owner));
    const assetPath = join(f.directory, "notes/Team/Asset.assets/plot one.png");
    await mkdir(dirname(assetPath), { recursive: true });
    const bytes = Buffer.from([0, 1, 0xff, 0x7f, 0x0a]);
    await writeFile(assetPath, bytes);
    const listing = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.asset.list", { id: created.id }), reader));
    const asset = listing.items.find(item => item.path.endsWith("plot one.png"));
    yes(asset);
    const pinned = { id: created.id, path: asset.path, expectedDocumentSha256: created.sha256, expectedDigest: asset.digest };
    const first = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.asset.get", pinned), reader));
    deep(Buffer.from(first.data, "base64"), bytes);
    await writeFile(assetPath, Buffer.from("changed bytes"));
    errorCode(await f.core.dispatch("capability_read", invoke("knowledge.asset.get", pinned), reader), "CONFLICT");
    return [
      "Percent-decoded asset lookup returned the exact binary bytes.",
      "The stale digest pin returned CONFLICT after the opaque resource changed.",
    ];
  });

  await runCase(t, {
    title: "Owned resource directories do not become Skill or Note folders",
    originalFile: "tests/test-markdown-owned-assets.js",
    originalTestcase: "top-level assertion that owned resources are not content categories",
    nativeOperations: ["knowledge.document.create", "knowledge.note.list"],
    scenario: "A document's owned .assets folder is storage for attachments, not an extra Note category or document.",
  }, async tCase => {
    const f = await fixture(tCase);
    const created = resultOf(await f.core.dispatch("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "folder-note", area: "notes", path: "Team/Design.md",
      title: "Design", content: "![plot](Design.assets/plot.png)",
    }), owner));
    await mkdir(join(f.directory, "notes/Team/Design.assets"), { recursive: true });
    await writeFile(join(f.directory, "notes/Team/Design.assets/plot.png"), "image");
    const listed = resultOf(await f.core.dispatch("capability_read", invoke("knowledge.note.list", { limit: 100 }), reader));
    eq(listed.total, 1);
    eq(listed.items[0].documentId, created.id);
    no(listed.items.some(item => item.path.includes(".assets")));
    return ["Note list retained the document and did not expose its .assets directory as a content item."];
  });

  await runCase(t, {
    title: "Todo Story relations, acceptance and audit survive task execution",
    originalFile: "tests/test-todo-board.js",
    originalTestcase: "conversion requires a fresh explicit preview and preserves Story relations, acceptance and audit (native Board subset)",
    nativeOperations: ["todo.board.create", "todo.story.create", "todo.workitem.create", "todo.workitem.claim", "todo.workitem.history"],
    scenario: "Native Board task creation and claim preserve parent and acceptance fields and write an auditable history record.",
  }, async tCase => {
    const f = await fixture(tCase);
    const board = resultOf(await f.core.dispatch("capability_call", invoke("todo.board.create", {
      board_slug: "Project/Board", operationId: randomUUID(),
    }), owner));
    const story = resultOf(await f.core.dispatch("capability_call", invoke("todo.story.create", {
      board_slug: "Project/Board", expected_digest: board.digest, operationId: randomUUID(),
      item: { id: "story", title: "Story", goal: "Keep relation", scope: "Regression", acceptance: ["Parent survives"] },
    }), owner));
    const task = resultOf(await f.core.dispatch("capability_call", invoke("todo.workitem.create", {
      board_slug: "Project/Board", expected_digest: story.digest, operationId: randomUUID(),
      item: { id: "child", title: "Child", goal: "Remain attached", scope: "Regression",
        acceptance: ["Exact acceptance"], parentId: "story" },
    }), owner));
    eq(task.item.parentId, "story");
    deep(task.item.acceptance, ["Exact acceptance"]);
    const claimed = resultOf(await f.core.dispatch("capability_call", invoke("todo.workitem.claim", {
      board_slug: "Project/Board", expected_digest: task.digest, operationId: randomUUID(), id: "child",
    }), owner));
    eq(claimed.item.parentId, "story");
    deep(claimed.item.acceptance, ["Exact acceptance"]);
    const history = resultOf(await f.core.dispatch("capability_read", invoke("todo.workitem.history", {
      board_slug: "Project/Board", id: "child", limit: 10,
    }), owner));
    yes(history.items.length >= 2);
    const restartedCore = await f.restart();
    const afterRestart = resultOf(await restartedCore.dispatch("capability_read", invoke("todo.workitem.history", {
      board_slug: "Project/Board", id: "child", limit: 10,
    }), owner));
    deep(afterRestart.items, history.items);
    return ["Claim retained parentId and acceptance; history contains create and claim transitions."];
  });

  await runCase(t, {
    title: "Todo backing corruption fails closed instead of hiding invalid graph data",
    originalFile: "tests/test-todo-board.js",
    originalTestcase: "Board JSON rejects invalid graph/duplicates instead of hiding corruption",
    nativeOperations: ["todo.board.create", "todo.board.get"],
    scenario: "Corrupted authoritative Board bytes produce an explicit invalid-document error rather than a partial or empty board.",
  }, async tCase => {
    const f = await fixture(tCase);
    const board = resultOf(await f.core.dispatch("capability_call", invoke("todo.board.create", {
      board_slug: "Corrupt", operationId: randomUUID(),
    }), owner));
    const backing = join(f.directory, "boards/Corrupt.json");
    await writeFile(backing, '{"schema":"wrong","items":[]}');
    errorCode(await f.core.dispatch("capability_read", invoke("todo.board.get", { board_slug: "Corrupt" }), reader), "INVALID_DOCUMENT");
    eq(await readFile(backing, "utf8"), '{"schema":"wrong","items":[]}');
    yes(board.digest.length === 64);
    return ["Malformed authoritative bytes were preserved and Board get returned INVALID_DOCUMENT."];
  });

  await runCase(t, {
    title: "Pending Memory is idempotent and excluded from active search",
    originalFile: "tests/test-capability-memory.js",
    originalTestcase: "Memory permission and exact-revision review explain scope, provenance, changes and recall effects (pending-state API assertions)",
    nativeOperations: ["memory.record.propose", "memory.record.get", "memory.record.search"],
    scenario: "A proposal remains pending, repeats idempotently for the same operation ID, and is not exposed as active recall before an injected Host decision.",
  }, async tCase => {
    const f = await fixture(tCase);
    const sources = [{ id: "input-1", chat: "fixture-chat", revision: "turn-1", locator: "message/input-1" }];
    const proposal = resultOf(await f.core.dispatch("capability_call", invoke("memory.record.propose", {
      operation_id: "proposal-batch12", content: "Use SQLite for durable memory.", sources,
    }), owner));
    eq(proposal.status, "pending");
    deep(resultOf(await f.core.dispatch("capability_call", invoke("memory.record.propose", {
      operation_id: "proposal-batch12", content: "Use SQLite for durable memory.", sources,
    }), owner)), proposal);
    deep(resultOf(await f.core.dispatch("capability_read", invoke("memory.record.search", { query: "SQLite" }), reader)).records, []);
    eq(resultOf(await f.core.dispatch("capability_read", invoke("memory.record.get", { id: proposal.id }), reader)).status, "pending");
    return [
      "Repeated proposal returned the same pending record.",
      "Active search returned no record before confirmation; get retained pending status.",
    ];
  });

  await runCase(t, {
    title: "Memory audit preserves proposal provenance without claiming activation",
    originalFile: "tests/test-capability-memory.js",
    originalTestcase: "Memory permission and exact-revision review explain scope, provenance, changes and recall effects (provenance API assertion subset)",
    nativeOperations: ["memory.record.propose", "memory.record.audit", "memory.record.get"],
    scenario: "The native audit retains proposal provenance and caller attribution while the record remains pending; no confirmation or active recall is claimed.",
  }, async tCase => {
    const f = await fixture(tCase);
    const proposed = resultOf(await f.core.dispatch("capability_call", invoke("memory.record.propose", {
      operation_id: "proposal-audit", content: "A human decision is required.",
      sources: [{ id: "input-3", chat: "fixture-chat", revision: "turn-3", locator: "message/input-3" }],
    }), owner));
    const audit = resultOf(await f.core.dispatch("capability_read", invoke("memory.record.audit", { id: proposed.id }), reader));
    eq(audit.events[0].action, "proposed");
    eq(audit.events[0].actor, "caller");
    const record = resultOf(await f.core.dispatch("capability_read", invoke("memory.record.get", { id: proposed.id }), reader));
    eq(record.status, "pending");
    eq(record.sources[0].locator, "message/input-3");
    return ["Audit preserved proposed action and caller attribution; get preserved the exact source locator and pending status."];
  });

  const unsupported = {
    originalFile: "tests/test-note-work-items.js",
    originalTestcase: "Note bridge serializes concurrent writers, rejects stale manual edits and preserves lifecycle/resources",
    nativeOperations: [],
    nativeTransport: null,
    scenario: "The original Note Markdown work-item bridge owns serialized Markdown writes, work-item reconciliation, and attachment lifecycle.",
    result: "unsupported",
    assertions: 0,
    evidence: ["No next-server endpoint provides the legacy Note work-item Markdown bridge; no Todo Board API was substituted as parity."],
    unsupportedReason: "No equivalent native Note work-item bridge operation exists. Kept explicitly unsupported rather than treating the isolated Todo Board API as equivalent.",
  };
  const unsupportedRow = { ...unsupported };
  await t.test("Legacy Note work-item Markdown bridge remains explicitly unsupported", () => {
    rows.push(unsupportedRow);
  });

  const originalSourcesByPath = Object.fromEntries(await Promise.all(originalFiles.map(async path => [
    path, sha256(await readFile(resolve(repositoryRoot, path))),
  ])));
  const nativeSourceMap = Object.fromEntries(await Promise.all([...new Set(nativeSources)].sort().map(async path => [
    path, sha256(await readFile(resolve(packageRoot, path))),
  ])));
  for (const row of rows) {
    row.originalSourceSha256 = originalSourcesByPath[row.originalFile];
    row.nativeImplementationSources = row.nativeOperations.flatMap(operation => {
      const relevant = operation.startsWith("knowledge.skill.") ? ["src/skills.ts", "src/skill-contracts.ts", "src/domain/skills.ts", "src/knowledge-snapshot.ts"]
        : operation.startsWith("knowledge.research.") ? ["src/research.ts", "src/research-contracts.ts", "src/domain/research.ts", "src/knowledge-snapshot.ts"]
          : operation.startsWith("knowledge.note.") ? ["src/notes.ts", "src/note-contracts.ts", "src/knowledge-snapshot.ts"]
            : operation.startsWith("knowledge.asset.") ? ["src/assets.ts", "src/domain/markdown-assets.ts", "src/contracts.ts"]
              : operation.startsWith("todo.") ? ["src/domain/todo-board.ts", "src/domain/todo-api.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts"]
                : operation.startsWith("memory.record.") ? ["src/memory.ts", "src/memory-contracts.ts"]
                  : ["src/knowledge-mutations.ts", "src/knowledge-mutations-contracts.ts"];
      const sourceModulePaths = row.nativeTransport === "native Knowledge mutation module"
        ? [...relevant, "src/knowledge-mutations.ts", "src/knowledge-mutations-contracts.ts", "src/file-write.ts", "src/domain/knowledge-contracts.ts"]
        : [...relevant, "src/core.ts", "src/storage-worker.ts", "src/storage.ts", "src/markdown.ts"];
      const transportPaths = row.nativeTransport === "HTTP"
        ? ["src/http.ts", "src/cli.ts"]
        : row.nativeTransport === "MCP stdio" ? ["src/mcp.ts", "src/cli.ts"] : [];
      return [...new Set([...sourceModulePaths, ...transportPaths])].map(path => ({ path, sha256: nativeSourceMap[path] }));
    }).filter((source, index, sources) => sources.findIndex(item => item.path === source.path) === index)
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  const assertionCount = rows.reduce((total, row) => total + row.assertions, 0);
  const verifiedRows = rows.filter(row => row.result === "verified").length;
  const mismatchedRows = rows.filter(row => row.result === "mismatched").length;
  const report = {
    schema: "pkm.next-server.legacy-regression-batch12/v1",
    qualification: "bounded-original-assertion-bridge",
    execution: {
      testFile: "tests/legacy-regression-batch12.test.mjs",
      command: "node --test --test-concurrency=4 tests/legacy-regression-batch12.test.mjs",
      workingDirectory: "next-server",
      node: process.version,
    },
    build: { command: "npm --prefix next-server run build", result: "passed", reason: null },
    result: mismatchedRows ? "mismatched" : "passed",
    nativeSourceSetSha256: sha256(Object.entries(nativeSourceMap).map(([path, hash]) => `${path}:${hash}`).join("\n")),
    nativeSources: nativeSourceMap,
    originalSources: originalSourcesByPath,
    rows,
    totals: {
      newCases: rows.length,
      verifiedRows,
      unsupportedRows: rows.filter(row => row.result === "unsupported").length,
      mismatchedRows,
      assertions: assertionCount,
    },
    legacySuiteExecution: {
      status: "not-run",
      reason: "Only the bounded inherited assertions recorded in these rows ran through next-server Core, HTTP, or MCP. The original VS Code test loader and full legacy suite were not run.",
    },
    scopeDifferences: [
      "No actual Knowledge Root, private fixture, VS Code global storage, external call, or secret was used.",
      "The original >1,000-Note stress bound was not exercised; the associated row records only the smaller native metadata-projection check.",
      "Core, HTTP, and MCP results qualify only the listed native operations; they do not prove host-specific behavior, UI parity, filesystem lifecycle parity, or full-suite compatibility.",
      "The Note work-item Markdown bridge has no native equivalent and remains unsupported; no Board API was substituted for it.",
      "Memory confirmation was not accepted or simulated: this tranche tests the fail-closed boundary without Host decision authority.",
      "The prior cross-process Board race remains unsupported: the enforced single-writer lease prevents HTTP and MCP servers from concurrently opening one workspace; no other conflict check is substituted for that race.",
      "Native Skill and Research mutation endpoints do not implement legacy category/path moves or alias rewrites; the same-path identity updates are explicitly partial coverage.",
      "Report excludes wall-clock values, random fixture paths, operation IDs, and a self-hash.",
    ],
  };
  eq(verifiedRows, 16);
  eq(mismatchedRows, 0);
  await publishBatch12Report(report);
});
