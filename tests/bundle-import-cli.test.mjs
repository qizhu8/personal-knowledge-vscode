import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { initialize } from "../dist/storage.js";
import { scanMarkdown } from "../dist/markdown.js";
import { Core } from "../dist/core.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { startMcp } from "../dist/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import vm from "node:vm";
import ts from "typescript";
import { capturedDeclarations } from "../dist/domain/knowledge-mutations-original.js";

const execute = promisify(execFile), cli = resolve(import.meta.dirname, "../dist/cli.js");
const require = createRequire(import.meta.url), originalModules = new Map();
const repositoryRoot = [resolve(import.meta.dirname, "../legacy"), resolve(import.meta.dirname, "../../..")]
  .find(path => existsSync(join(path, "src/knowledge/filestore.ts")));
if (!repositoryRoot) throw new Error("Cannot locate the original PKM source tree.");

function original(path) {
  if (originalModules.has(path)) return originalModules.get(path).exports;
  const module = { exports: {} };
  originalModules.set(path, module);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => {
    if (!name.startsWith(".")) return require(name);
    const candidate = resolve(dirname(path), name), file = `${candidate}.ts`;
    if (!file.startsWith(`${repositoryRoot}/`)) throw new Error(`Original fixture import escaped the repository: ${name}`);
    return original(file);
  };
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })
    (localRequire, module, module.exports, path, dirname(path));
  return module.exports;
}

function originalDeclaration(source, name) {
  const parsed = ts.createSourceFile(source, readFileSync(source, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(statement =>
    "name" in statement && statement.name?.getText(parsed) === name);
  assert.equal(declarations.length, 1, `Original source declaration ${name} is unique`);
  return declarations[0].getText(parsed);
}

async function fixture(t) {
  const parent = resolve(import.meta.dirname, `.bundle-cli-${randomUUID()}`);
  const workspace = join(parent, "workspace"), bundlePath = join(parent, "bundle.json");
  await mkdir(parent, { mode: 0o700 });
  await initialize(workspace);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const run = (...args) => execute(process.execPath, [cli, "bundle-import", ...args], { timeout: 30000 });
  const submit = () => run("--data", workspace, "--bundle", bundlePath);
  return { parent, workspace, bundlePath, run, submit };
}
function bundle() {
  const bytes = Buffer.from("figure");
  return { operationId: randomUUID(), prefix: "Incoming/Batch", from: "sender", version: "3",
    skills: [{ name: "Guide", content: "body", metadata: { category: "Tools", tags: ["ops"], description: "guide",
      schema: "pkm.knowledge/v1", knowledgeId: "knowledge_111111111111111111111111", revision: 4, aliases: ["skill:Old/Guide"] } }],
    notes: [{ slug: "Team/Note", title: "A Note", content: "hello", tags: '["note"]', type: "general", pinned: true,
      schema: "pkm.knowledge/v1", knowledgeId: "knowledge_222222222222222222222222", revision: 7, aliases: ["note:Old/Note"] }],
    papers: [{ slug: "Research/Paper", title: "Paper title", content: "paper body",
      authors: ["Author"], file: "_assets/paper.pdf", tags: ["study"], year: 2023,
      schema: "pkm.knowledge/v1", knowledgeId: "knowledge_333333333333333333333333", revision: 12, aliases: ["research:Old/Paper"] }],
    assets: [{ type: "papers", path: "Research/_assets/paper.pdf", data: bytes.toString("base64"),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }],
    scripts: [], prompts: [], packages: [], servers: [], recipes: [] };
}
test("CLI imports legacy-shaped bundle with metadata, prefix and exact receipt replay", async t => {
  const f = await fixture(t), input = bundle();
  await writeFile(f.bundlePath, JSON.stringify(input));
  const first = JSON.parse((await f.submit()).stdout).receipt;
  assert.equal(first.operationId, input.operationId);
  assert.equal(first.created, 1);
  assert.equal(first.documents.length, 3);
  assert.equal(await readFile(join(f.workspace, "papers/Incoming/Batch/Research/_assets/paper.pdf"), "utf8"), "figure");
  const records = scanMarkdown(f.workspace);
  const skill = records.find(r => r.record.area === "skills");
  const note = records.find(r => r.record.area === "notes");
  const paper = records.find(r => r.record.area === "papers");
  assert.equal(skill.record.path, "Incoming/Batch/Tools/Guide.md");
  assert.deepEqual(skill.metadata.toJS().tags, ["ops"]);
  assert.equal(skill.metadata.toJS().knowledgeId, "knowledge_111111111111111111111111");
  assert.equal(skill.record.revision, 4);
  assert(skill.metadata.toJS().aliases.includes("skill:Old/Guide"));
  assert(skill.metadata.toJS().aliases.includes("skill:Tools/Guide"));
  assert(skill.metadata.toJS().aliases.includes("skill:Incoming/Batch/Tools/Guide"));
  assert.equal(note.record.title, "A Note");
  assert.deepEqual(note.metadata.toJS().tags, ["note"]);
  assert.equal(note.metadata.toJS().pinned, true);
  assert.equal(note.metadata.toJS().knowledgeId, "knowledge_222222222222222222222222");
  assert.equal(note.record.revision, 7);
  assert(note.metadata.toJS().aliases.includes("note:Old/Note"));
  assert.notEqual(note.record.id, note.metadata.toJS().knowledgeId);
  assert.equal(paper.record.content, "paper body");
  assert.equal(paper.metadata.toJS().file, "_assets/paper.pdf");
  assert.deepEqual(paper.metadata.toJS().authors, ["Author"]);
  assert.equal(paper.metadata.toJS().knowledgeId, "knowledge_333333333333333333333333");
  assert.equal(paper.record.revision, 12);
  assert(paper.metadata.toJS().aliases.includes("research:Old/Paper"));
  assert.deepEqual(JSON.parse((await f.submit()).stdout).receipt, first);
  const differentMetadata = structuredClone(input);
  differentMetadata.operationId = randomUUID();
  differentMetadata.skills[0].metadata.description = "different";
  await writeFile(f.bundlePath, JSON.stringify(differentMetadata));
  await assert.rejects(f.submit(), /CONFLICT/);
  input.notes[0].content = "changed";
  await writeFile(f.bundlePath, JSON.stringify(input));
  await assert.rejects(f.submit(), /CONFLICT/);
});
test("CLI rejects malformed, oversized, symlink and non-regular bundle files", async t => {
  const f = await fixture(t);
  await writeFile(f.bundlePath, "{bad");
  await assert.rejects(f.submit(), /valid JSON/);
  await truncate(f.bundlePath, 96 * 1024 * 1024 + 1);
  await assert.rejects(f.submit(), /at most/);
  await rm(f.bundlePath);
  await symlink(join(f.parent, "target"), f.bundlePath);
  await assert.rejects(f.submit(), /non-symlink/);
  await rm(f.bundlePath);
  await mkdir(f.bundlePath);
  await assert.rejects(f.submit(), /regular/);
});
test("CLI requires absolute options and an existing isolated, non-symlink workspace", async t => {
  const f = await fixture(t);
  await writeFile(f.bundlePath, JSON.stringify(bundle()));
  await assert.rejects(f.run("--bundle", f.bundlePath), /Required option: --data/);
  await assert.rejects(f.run("--data", f.workspace), /Required option: --bundle/);
  await assert.rejects(f.run("--data", "relative", "--bundle", f.bundlePath), /absolute/);
  await assert.rejects(f.run("--data", f.workspace, "--bundle", "relative"), /absolute/);
  await assert.rejects(f.run("--data", f.workspace, "--data", f.workspace, "--bundle", f.bundlePath), /duplicate/);
  await assert.rejects(f.run("--data", join(f.parent, "absent"), "--bundle", f.bundlePath));
  const unsafe = join(f.parent, "unsafe");
  await mkdir(unsafe);
  await assert.rejects(f.run("--data", unsafe, "--bundle", f.bundlePath));
  const link = join(f.parent, "link");
  await symlink(f.workspace, link);
  await assert.rejects(f.run("--data", link, "--bundle", f.bundlePath), /symlink/i);
});
test("CLI rejects unsupported members and todo-board content without writes", async t => {
  const f = await fixture(t);
  for (const extra of [{ scripts: [{ name: "x" }] }, { unknown: ["x"] }, { notes: [{ slug: "b", documentKind: "todo-board" }] },
    { notes: [{ slug: "n", tags: "not-json" }] }]) {
    await writeFile(f.bundlePath, JSON.stringify({ ...bundle(), ...extra }));
    await assert.rejects(f.submit(), /Invalid or unsupported|tags must/);
    assert.equal(scanMarkdown(f.workspace).length, 0);
  }
});
test("CLI imports validated links and resolves paper citations against destination and relocated batch", async t => {
  const f = await fixture(t);
  const run = async input => {
    await writeFile(f.bundlePath, JSON.stringify(input));
    return JSON.parse((await f.submit()).stdout).receipt;
  };
  await run({ operationId: randomUUID(), papers: [
    { slug: "Existing/Shared", title: "Shared title", content: "existing" },
    { slug: "Existing/Z", title: "Duplicate title" },
    { slug: "Existing/A", title: "Duplicate title" },
  ] });
  const link = { relation: "references", target: "pkm://knowledge/knowledge_999999999999999999999999", mode: "pinned", required: true, targetRevision: "42" };
  const input = { operationId: randomUUID(), prefix: "Incoming",
    skills: [{ name: "Guide", metadata: { links: [link] } }],
    notes: [{ slug: "N", links: [link] }],
    papers: [
      { slug: "Sub/A", title: "First", links: [link], cites: [
        "sub/b.MD", { paper: "SUB/B", note: "again" }, { key: "Shared title", comment: "existing" },
        { target: "Existing/Shared.md", note: "slug" }, "missing", "First", "Duplicate title", "", null,
      ] },
      { slug: "Sub/B", title: "Second", cites: ["First", "Second"] },
    ] };
  const receipt = await run(input);
  const records = scanMarkdown(f.workspace);
  for (const [area, path] of [["skills", "Incoming/Guide.md"], ["notes", "Incoming/N.md"], ["papers", "Incoming/Sub/A.md"]])
    assert.deepEqual(records.find(r => r.record.area === area && r.record.path === path).metadata.toJS().links, [link]);
  assert.deepEqual(records.find(r => r.record.path === "Incoming/Sub/A.md").metadata.toJS().cites, [
    { paper: "Incoming/Sub/B", note: "" }, { paper: "Incoming/Sub/B", note: "again" },
    { paper: "Existing/Shared", note: "existing" }, { paper: "Existing/Shared", note: "slug" },
    { paper: "Existing/Z", note: "" },
  ]);
  assert.deepEqual(records.find(r => r.record.path === "Incoming/Sub/B.md").metadata.toJS().cites, [{ paper: "Incoming/Sub/A", note: "" }]);
  assert.deepEqual(await run(input), receipt);
  const second = structuredClone(input);
  second.operationId = randomUUID();
  assert.deepEqual((await run(second)).documents.map(item => item.created), [false, false, false, false]);
  second.operationId = randomUUID();
  second.papers[0].cites[1].note = "changed";
  await assert.rejects(run(second), /CONFLICT/);
  const bad = { operationId: randomUUID(), notes: [{ slug: "Bad", links: [{ ...link, mode: "floating" }] }] };
  await assert.rejects(run(bad), /Invalid Knowledge links/);
  assert.equal(scanMarkdown(f.workspace).some(r => r.record.path === "Bad.md"), false);
});

test("imported links and citations match original source, survive Core/MCP reads and relocated backup", async t => {
  const sourceFile = join(repositoryRoot, "src/knowledge/filestore.ts");
  const captured = capturedDeclarations.filestore;
  for (const name of ["noteUpsert", "normalizeCites", "buildPaperResolver", "paperUpsert"])
    assert.equal(originalDeclaration(sourceFile, name), captured[name], `captured oracle remains exact for ${name}`);

  const f = await fixture(t), sourceRoot = join(f.parent, "original-source");
  await mkdir(sourceRoot, { mode: 0o700 });
  const source = original(sourceFile);
  source.setStorePath(sourceRoot);
  const link = { relation: "supports", target: "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa",
    mode: "pinned", required: true, targetRevision: "source-revision" };
  source.noteUpsert({ slug: "", title: "Link Oracle", content: "private synthetic body", type: "general", tags: [], links: [link] });
  const sourceLink = source.parseStoreFrontmatter(await readFile(join(sourceRoot, "notes/Link Oracle.md"), "utf8")).fm.links;
  assert.deepEqual(sourceLink, [link]);
  assert.throws(() => source.noteUpsert({ slug: "", title: "Invalid Link", content: "", type: "general", tags: [],
    links: [{ ...link, target: "https://example.invalid/" }] }), /Invalid Knowledge links/);

  source.paperUpsert({ slug: "", title: "Shared", category: "Existing", content: "synthetic cited paper", cites: [] });
  source.paperUpsert({ slug: "", title: "Duplicate", category: "Existing/Z", content: "synthetic duplicate Z", cites: [] });
  source.paperUpsert({ slug: "", title: "Duplicate", category: "Existing/A", content: "synthetic duplicate A", cites: [] });
  await writeFile(f.bundlePath, JSON.stringify({ operationId: randomUUID(), papers: [
    { slug: "Existing/Shared", title: "Shared", content: "synthetic cited paper" },
    { slug: "Existing/Z/Duplicate", title: "Duplicate", content: "synthetic duplicate Z" },
    { slug: "Existing/A/Duplicate", title: "Duplicate", content: "synthetic duplicate A" },
  ] }));
  await f.submit();

  const papers = [
    { slug: "Sub/A", title: "A", content: "synthetic citing paper", file: "_assets/figure.bin",
      cites: ["Sub/B", { paper: "Sub/B", note: "duplicate" }, { key: "shared", comment: "title" },
        { target: "EXISTING/SHARED.MD", note: "slug" }, { paper: "duplicate", note: "duplicate title" },
        "missing", "Sub/A", "A"] },
    { slug: "Sub/B", title: "B", content: "synthetic cited paper", cites: ["Sub/A"] },
  ];
  const prefix = "Incoming";
  for (const paper of papers) source.paperUpsert({
    slug: `${prefix}/${paper.slug}`, title: paper.title,
    category: `${prefix}/${paper.slug.slice(0, paper.slug.lastIndexOf("/"))}`,
    content: paper.content, file: paper.file, cites: [],
  });
  const importedSlugs = new Set(papers.map(paper => paper.slug));
  const remap = reference => importedSlugs.has(reference) ? `${prefix}/${reference}` : reference;
  for (const paper of papers) {
    const current = source.paperGet(`${prefix}/${paper.slug}`);
    const cites = paper.cites.map(cite => {
      if (typeof cite === "string") return { paper: remap(cite), note: "" };
      return cite?.paper ? { paper: remap(cite.paper), note: cite.note || "" } : cite;
    });
    source.paperUpsert({ ...current, cites });
  }
  const sourceCitations = source.paperGet(`${prefix}/Sub/A`).cites;
  assert.deepEqual(sourceCitations, [
    { paper: "Incoming/Sub/B", note: "" }, { paper: "Incoming/Sub/B", note: "duplicate" },
    { paper: "Existing/Shared", note: "title" }, { paper: "Existing/Shared", note: "slug" },
    { paper: source.paperList().find(paper => paper.title === "Duplicate"
      && paper.slug !== "Incoming/Sub/A" && paper.slug !== "Incoming/Sub/B").slug, note: "duplicate title" },
  ]);

  const bytes = Buffer.from("synthetic private asset");
  await writeFile(f.bundlePath, JSON.stringify({
    operationId: randomUUID(), prefix,
    notes: [{ slug: "Link Oracle", title: "Link Oracle", content: "private synthetic body", links: [link] }],
    papers,
    assets: [{ type: "papers", path: "Sub/_assets/figure.bin", data: bytes.toString("base64"),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }],
  }));
  const receipt = JSON.parse((await f.submit()).stdout).receipt;
  const records = scanMarkdown(f.workspace);
  const note = records.find(item => item.record.area === "notes");
  const citing = records.find(item => item.record.path === "Incoming/Sub/A.md");
  assert.deepEqual(note.metadata.toJS().links, sourceLink);
  assert.deepEqual(citing.metadata.toJS().cites, sourceCitations);
  assert.equal(citing.metadata.toJS().links, undefined);

  let storage = await Storage.open(f.workspace);
  t.after(async () => { if (storage) await storage.close().catch(() => undefined); });
  const actor = { id: "local:owner", canWrite: false };
  const readThroughMcp = async activeStorage => {
    const core = new Core(activeStorage);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startMcp(core, actor, serverTransport);
    const client = new Client({ name: "asset-migration-fixture", version: "1.0.0" });
    try {
      await client.connect(clientTransport);
      const assets = await client.callTool({ name: "capability_read", arguments: {
        operation: "knowledge.asset.list", version: 1, arguments: { id: receipt.documents.find(item => item.path === "Incoming/Sub/A.md").id },
      } });
      const research = await client.callTool({ name: "capability_read", arguments: {
        operation: "knowledge.research.list", version: 1, arguments: { limit: 100 },
      } });
      assert.equal(assets.structuredContent.error, undefined);
      assert.equal(research.structuredContent.error, undefined);
      return {
        assets: assets.structuredContent.result.items.map(item => ({ path: item.path, digest: item.digest })),
        cites: research.structuredContent.result.items.find(item => item.slug === "Incoming/Sub/A").cites,
      };
    } finally { await client.close(); await server.close(); }
  };
  const before = await readThroughMcp(storage);
  assert.deepEqual(before.assets, [{ path: "Incoming/Sub/_assets/figure.bin",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }]);
  assert.deepEqual(before.cites, sourceCitations);

  const backupPath = join(f.parent, "backup"), restoredPath = join(f.parent, "restored");
  await createWorkspaceBackup(storage, backupPath, { acquireQuiescence: async () => ({
    assertHeld() {}, release() {},
  }) });
  await storage.close();
  storage = undefined;
  const authority = {
    actorId: actor.id,
    async authorize(request) {
      return { authorityId: "synthetic-private-fixture", actorId: request.actorId,
        requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
    },
  };
  await restoreWorkspaceBackup(backupPath, restoredPath, { nativeRestoreAuthority: authority });
  const restored = await Storage.open(restoredPath);
  try {
    const after = await readThroughMcp(restored);
    assert.deepEqual(after, before);
    assert.deepEqual(await readFile(join(restoredPath, "papers/Incoming/Sub/_assets/figure.bin")), bytes);
  } finally { await restored.close(); }
});

test("CLI rejects a document exceeding the journal per-file limit before writing", async t => {
  const f = await fixture(t);
  await writeFile(f.bundlePath, JSON.stringify({ operationId: randomUUID(), notes: [{ slug: "big", content: "x".repeat(16 * 1024 * 1024) }] }));
  await assert.rejects(f.submit(), /16 MiB/);
  assert.equal(scanMarkdown(f.workspace).length, 0);
});
