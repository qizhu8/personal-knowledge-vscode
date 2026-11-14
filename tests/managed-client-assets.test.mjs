import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function snapshot(root) {
  const files = {};
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else files[path] = hash(await readFile(join(directory, entry.name)));
    }
  }
  await walk(root);
  return files;
}

test("production client reads preserved legacy resources across Notes/Skills/Papers before and after controlled restart", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-assets-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source");
  const parent = join(root, "parent"), legacy = join(root, "legacy");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* Unknown sessions remain failed, never replayed. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const path of [root, extension, source, parent, legacy]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(legacy, "fixture-sentinel.txt"), "Untouched synthetic legacy root.");
  await cp(join(project, "package.json"), join(extension, "package.json"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project,
    "--outDir", join(extension, "dist"), "--sourceMap", "false"], { stdio: "pipe", timeout: 120000 });
  require(join(project, "scripts/next-rehearsal-runtime.js")).stage(join(extension, "next-runtime"), { production: true });
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const image = Buffer.alloc(140003);
  for (let index = 0; index < image.length; index++) image[index] = index % 251;
  const sharedName = "0123456789abcdef.bin", ignoredName = "fedcba9876543210.bin";
  const shared = Buffer.from([255, 0, 3, 10, 128]), diagram = Buffer.from("graph LR\nLegacy-->Preserved\n");
  const documents = [];
  for (const area of ["notes", "skills", "papers"]) {
    const sharedLinks = `![shared](_assets/${sharedName})\n\`![code](_assets/${ignoredName})\`\n![missing](_assets/0000000000000000.bin)\n`
      + (area === "skills" ? "![nested](_assets/diagrams/skill%20image.bin)\n" : "");
    const content = `![image](Design.assets/plot%20one.png)\n${sharedLinks}![outside](../../scripts/private.bin)\n`;
    const id = `knowledge_${hash(area).slice(0, 24)}`;
    const raw = `---\nschema: pkm.knowledge/v1\nknowledgeId: ${id}\nrevision: 2\naliases: []\ntitle: ${area} original\ncustomMetadata: keep-me\n---\n${content}`;
    await mkdir(join(source, area, "Team/Design.assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, area, "Team/Design.md"), raw);
    await writeFile(join(source, area, "Team/Design.assets/plot one.png"), image);
    await writeFile(join(source, area, "Team/Design.assets/diagram.mmd"), diagram);
    await writeFile(join(source, area, "Team/Design.assets/empty.bin"), Buffer.alloc(0));
    await mkdir(join(source, area, "Team/_assets"), { mode: 0o700 });
    await writeFile(join(source, area, `Team/_assets/${sharedName}`), shared);
    await writeFile(join(source, area, `Team/_assets/${ignoredName}`), "not referenced outside code");
    if (area === "skills") {
      await mkdir(join(source, area, "Team/_assets/diagrams"), { mode: 0o700 });
      await writeFile(join(source, area, "Team/_assets/diagrams/skill image.bin"), image);
      await writeFile(join(source, area, "Team/_assets/unreferenced.bin"), "Preserve even when not discoverable as a referenced resource.");
    }
    documents.push({ id, area, raw, expectedCount: area === "skills" ? 5 : 4 });
  }
  const sourceBefore = await snapshot(source), legacyBefore = await snapshot(legacy);
  const client = new NextManagedClient(); clients.push(client);
  const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
  const plan = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal((await client.confirmImport(plan.planSha256)).outcome.status, "published");
  assert.equal((await client.importStatus()).outcome.status, "published");
  await client.attachImport();
  const targetBefore = await snapshot(plan.target);
  await assert.rejects(client.invoke("update", {}), /read-only/);

  async function readResources(active) {
    for (const document of documents) {
      const record = (await active.invoke("get", { id: document.id })).result;
      assert.equal(record.area, document.area);
      const first = (await active.invoke("asset-list", { id: document.id, limit: 1 })).result;
      assert.equal(first.total, document.expectedCount);
      assert.equal(first.area, document.area);
      assert.equal(first.documentSha256, record.sha256);
      assert.equal(first.nextOffset, 1);
      assert(first.diagnostics.some(item => item.code === "outside-area"));
      assert(first.diagnostics.some(item => item.code === "missing-resource"));
      const later = (await active.invoke("asset-list", { id: document.id, offset: 1, limit: 100, revision: first.revision })).result;
      const items = [...first.items, ...later.items];
      assert.equal(later.nextOffset, null);
      assert(items.some(item => item.path.endsWith("diagram.mmd")), "Unreferenced owned diagrams remain discoverable.");
      assert(!items.some(item => item.path.endsWith(ignoredName)), "Fenced/inline-code references do not grant resource membership.");
      const imageEntry = items.find(item => item.path.endsWith("plot one.png"));
      const empty = items.find(item => item.path.endsWith("empty.bin"));
      const emptyChunk = (await active.invoke("asset-get", { id: document.id, path: empty.path,
        expectedDocumentSha256: record.sha256, expectedDigest: empty.digest })).result;
      assert.equal(emptyChunk.data, "");
      assert.equal(emptyChunk.size, 0);
      assert.equal(emptyChunk.nextOffset, null);
      assert.equal(imageEntry.digest, `sha256:${hash(image)}`);
      const pins = { id: document.id, path: imageEntry.path, expectedDocumentSha256: record.sha256, expectedDigest: imageEntry.digest };
      const chunks = [];
      let offset = 0;
      do {
        const response = await active.invoke("asset-get", { ...pins, offset });
        assert(!response.error, JSON.stringify(response.error));
        const chunk = response.result, bytes = Buffer.from(chunk.data, "base64");
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.documentSha256, record.sha256);
        assert.equal(chunk.digest, imageEntry.digest);
        assert.equal(chunk.area, document.area);
        assert.equal(chunk.size, image.length);
        assert(bytes.length <= 65536);
        chunks.push(bytes);
        offset = chunk.nextOffset;
      } while (offset !== null);
      assert.deepEqual(Buffer.concat(chunks), image);
      assert.equal((await active.invoke("asset-list", { id: document.id, revision: "0".repeat(64) })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, expectedDocumentSha256: "0".repeat(64) })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, expectedDigest: `sha256:${"0".repeat(64)}` })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, length: 65537 })).error.code, "INVALID_ARGUMENT");
      assert.equal((await active.invoke("asset-get", { ...pins, path: "../../private.bin" })).error.code, "INVALID_ARGUMENT");
      assert.equal((await active.invoke("asset-get", { ...pins, path: "Team/Design.assets/pkm-todo-board.json" })).error.code, "ACCESS_DENIED");
      assert.equal((await active.invoke("asset-get", { ...pins, path: `Team/_assets/${ignoredName}` })).error.code, "NOT_FOUND");
      {
        const entry = items.find(item => item.path.endsWith(sharedName));
        assert.deepEqual(Buffer.from((await active.invoke("asset-get", { id: document.id, path: entry.path,
          expectedDocumentSha256: record.sha256, expectedDigest: entry.digest })).result.data, "base64"), shared);
      }
      if (document.area === "skills") {
        const entry = items.find(item => item.path.endsWith("diagrams/skill image.bin"));
        const chunk = (await active.invoke("asset-get", { id: document.id, path: entry.path,
          expectedDocumentSha256: record.sha256, expectedDigest: entry.digest })).result;
        assert.deepEqual(Buffer.from(chunk.data, "base64"), image.subarray(0, 65536));
        assert.equal(chunk.nextOffset, 65536);
      }
      assert.equal(await readFile(join(plan.target, document.area, "Team/Design.md"), "utf8"), document.raw);
    }
  }
  await readResources(client);
  assert.deepEqual(await snapshot(plan.target), targetBefore, "Readonly resource discovery/chunks must not write database, assets or Markdown.");
  const prepared = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(prepared.authorizationDigest, prepared.target);
  await readResources(client);
  await client.close();
  const restarted = new NextManagedClient(); clients.push(restarted);
  await restarted.resumeImport(extension, credential, process.execPath, legacy);
  await readResources(restarted);
  await restarted.close();
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
  for (const [path, digest] of Object.entries(sourceBefore)) assert.equal(hash(await readFile(join(plan.target, path))), digest);
  const changedParent = join(root, "changed-parent");
  await mkdir(changedParent, { mode: 0o700 });
  const changed = new NextManagedClient(); clients.push(changed);
  const changedPlan = await changed.planImport(extension, changedParent, process.execPath, legacy, source, python);
  await changed.confirmImport(changedPlan.planSha256);
  await changed.attachImport();
  const resourceList = (await changed.invoke("asset-list", { id: documents[0].id })).result;
  const resource = resourceList.items.find(item => item.path.endsWith("plot one.png"));
  const targetAsset = join(changedPlan.target, "notes", resource.path);
  await writeFile(targetAsset, "unexpected external writer");
  const pins = { id: documents[0].id, path: resource.path,
    expectedDocumentSha256: resourceList.documentSha256, expectedDigest: resource.digest };
  await assert.rejects(changed.invoke("asset-get", pins), /outcome unknown/);
  await writeFile(targetAsset, image);
  await assert.rejects(changed.invoke("asset-get", pins), /previously failed/);
  await changed.close();
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
});
