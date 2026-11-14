import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, rm, symlink, unlink, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { sha256 } from "../dist/markdown.js";
import { rebaseMarkdownAssets } from "../dist/domain/markdown-assets.js";

async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.assets-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  const storage = await Storage.open(directory), core = new Core(storage);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const call = (operation, args, actor = { id: "local:owner", canWrite: false }) =>
    core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
  async function create(area = "notes", path = "Doc.md", content = "# Document") {
    const response = await core.dispatch("capability_call", {
      operation: "knowledge.document.create", version: 1,
      arguments: { operationId: randomUUID(), id: `${area}-doc`, area, path, title: area, content },
    }, { id: "local:owner", canWrite: true });
    assert(!response.error, JSON.stringify(response.error));
    return response.result;
  }
  return { directory, storage, core, call, create };
}

for (const area of ["notes", "skills", "papers"]) {
  test(`${area} resource discovery preserves original ownership, legacy shared references and bounded binary reads`, async t => {
    const { directory, call, create } = await fixture(t);
    const content = "![plot](Design.assets/plot%20one.png)\n![legacy](_assets/legacy.bin)\n`![code](_assets/ignored.bin)`";
    const document = await create(area, "Team/Design.md", content);
    await mkdir(join(directory, area, "Team/Design.assets"), { recursive: true });
    await mkdir(join(directory, area, "Team/_assets"), { recursive: true });
    const image = Buffer.alloc(130_000);
    for (let index = 0; index < image.length; index++) image[index] = index % 251;
    await writeFile(join(directory, area, "Team/Design.assets/plot one.png"), image);
    await writeFile(join(directory, area, "Team/Design.assets/diagram.mmd"), "graph LR\nA-->B");
    await writeFile(join(directory, area, "Team/_assets/legacy.bin"), Buffer.from([0, 255, 1]));
    await writeFile(join(directory, area, "Team/_assets/ignored.bin"), "Code is not an attachment reference");
    const raw = await readFile(join(directory, area, "Team/Design.md"), "utf8");
    const first = await call("knowledge.asset.list", { id: document.id, limit: 1 });
    assert(!first.error, JSON.stringify(first.error));
    assert.equal(first.result.total, 3);
    assert.equal(first.result.nextOffset, 1);
    assert.deepEqual(first.result.diagnostics, []);
    const later = (await call("knowledge.asset.list", { id: document.id, offset: 1, limit: 100, revision: first.result.revision })).result;
    const items = [...first.result.items, ...later.items];
    assert(items.some(item => item.path.endsWith("diagram.mmd")), "Unreferenced owned diagrams remain resources.");
    assert(!items.some(item => item.path.endsWith("ignored.bin")), "Code-only references do not grant shared-resource membership.");
    const asset = items.find(item => item.path.endsWith("plot one.png"));
    assert.equal(asset.area, area);
    assert.equal(asset.digest, `sha256:${sha256(image)}`);
    const args = { id: document.id, path: asset.path, expectedDocumentSha256: document.sha256, expectedDigest: asset.digest };
    const one = (await call("knowledge.asset.get", args)).result;
    assert.equal(Buffer.from(one.data, "base64").length, 65_536);
    assert.equal(one.nextOffset, 65_536);
    const two = (await call("knowledge.asset.get", { ...args, offset: one.nextOffset })).result;
    assert.equal(two.nextOffset, null);
    assert.deepEqual(Buffer.concat([Buffer.from(one.data, "base64"), Buffer.from(two.data, "base64")]), image);
    assert.equal((await call("knowledge.asset.get", { ...args, offset: image.length + 1 })).error.code, "INVALID_ARGUMENT");
    assert.equal((await call("knowledge.asset.get", { ...args, path: "Team/_assets/ignored.bin" })).error.code, "NOT_FOUND");
    assert.equal(await readFile(join(directory, area, "Team/Design.md"), "utf8"), raw);
    assert.deepEqual(await readdir(join(directory, area, "Team/Design.assets")), ["diagram.mmd", "plot one.png"]);
  });
}

test("original resource parser handles nested labels, encoded special names, HTML, definitions and fenced-code exclusions", async t => {
  const { directory, create, call } = await fixture(t);
  const content = [
    "![nested [label]](Doc.assets/plot(1)%23one.png)",
    '<img src="Doc.assets/space%20one.png">',
    "[resource]: Doc.assets/reference.bin",
    "```markdown", "![not real](_assets/ignored.bin)", "```",
  ].join("\n");
  const document = await create("notes", "Doc.md", content);
  await mkdir(join(directory, "notes/Doc.assets"));
  await mkdir(join(directory, "notes/_assets"));
  for (const name of ["plot(1)#one.png", "space one.png", "reference.bin"]) await writeFile(join(directory, "notes/Doc.assets", name), name);
  await writeFile(join(directory, "notes/_assets/ignored.bin"), "not referenced");
  const result = await call("knowledge.asset.list", { id: document.id });
  assert.equal(result.result.total, 3);
  const rebased = rebaseMarkdownAssets(join(directory, "notes"), "Doc.md", "Moved/New.md", content);
  assert(rebased.includes("New.assets/plot%281%29%23one.png"));
  assert(rebased.includes("New.assets/space%20one.png"));
  assert(rebased.includes("![not real](_assets/ignored.bin)"), "The captured rebaser preserves fenced examples.");
});

test("missing and escaping references are diagnosed without accessing unrelated bytes or changing Markdown", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create("notes", "Doc.md", "![missing](_assets/missing.bin)\n![outside](../papers/_assets/private.bin)");
  await mkdir(join(directory, "papers/_assets"), { recursive: true });
  await writeFile(join(directory, "papers/_assets/private.bin"), "private other-area bytes");
  const raw = await readFile(join(directory, "notes/Doc.md"), "utf8");
  const result = await call("knowledge.asset.list", { id: document.id });
  assert.equal(result.result.total, 0);
  assert.deepEqual(result.result.diagnostics.map(item => item.code).sort(), ["missing-resource", "outside-area"]);
  assert.equal(await readFile(join(directory, "notes/Doc.md"), "utf8"), raw);
});

test("resource reads reject symlinks, unsafe paths and Todo backing authority", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create();
  await mkdir(join(directory, "notes/Doc.assets"));
  await writeFile(join(directory, "notes/Doc.assets/real.bin"), "original");
  await writeFile(join(directory, "notes/Doc.assets/pkm-todo-board.json"), '{"schema":"pkm.todo-board/v1","items":[]}');
  const listing = (await call("knowledge.asset.list", { id: document.id })).result;
  assert.equal(listing.total, 1);
  const base = { id: document.id, expectedDocumentSha256: document.sha256, expectedDigest: listing.items[0].digest };
  assert.equal((await call("knowledge.asset.get", { ...base, path: "Doc.assets/pkm-todo-board.json" })).error.code, "ACCESS_DENIED");
  for (const path of ["../escape.bin", "/absolute.bin", "Doc.assets/.hidden", "Doc.assets/CON.bin", "Doc.assets/a\\b.bin"]) {
    assert.equal((await call("knowledge.asset.get", { ...base, path })).error.code, "INVALID_ARGUMENT");
  }
  for (const destination of ["real.bin", "missing.bin"]) {
    await symlink(join(directory, "notes/Doc.assets", destination), join(directory, "notes/Doc.assets/link.bin"));
    assert.equal((await call("knowledge.asset.list", { id: document.id })).error.code, "INVALID_DOCUMENT");
    await unlink(join(directory, "notes/Doc.assets/link.bin"));
  }
});

test("resource digest and document pins invalidate both pagination and stale chunk requests", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create();
  await mkdir(join(directory, "notes/Doc.assets"));
  const path = "Doc.assets/data.bin";
  await writeFile(join(directory, "notes", path), "first");
  const before = (await call("knowledge.asset.list", { id: document.id })).result;
  const args = { id: document.id, path, expectedDocumentSha256: document.sha256, expectedDigest: before.items[0].digest };
  await writeFile(join(directory, "notes", path), "external");
  assert.equal((await call("knowledge.asset.list", { id: document.id, revision: before.revision })).error.code, "CONFLICT");
  assert.equal((await call("knowledge.asset.get", args)).error.code, "CONFLICT");
  const current = (await call("knowledge.asset.list", { id: document.id })).result;
  await writeFile(join(directory, "notes/Doc.md"), (await readFile(join(directory, "notes/Doc.md"), "utf8")) + "\nExternal body edit");
  assert.equal((await call("knowledge.asset.get", { ...args, expectedDigest: current.items[0].digest })).error.code, "CONFLICT");
});

test("resource limits accept exactly 16 MiB per file and 64 MiB total, then reject larger catalogs before returning data", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create();
  await mkdir(join(directory, "notes/Doc.assets"));
  for (let index = 0; index < 4; index++) {
    const path = join(directory, `notes/Doc.assets/${index}.bin`);
    await writeFile(path, ""); await truncate(path, 16_777_216);
  }
  const exact = await call("knowledge.asset.list", { id: document.id, limit: 1 });
  assert.equal(exact.result.total, 4);
  assert.equal(exact.result.items[0].size, 16_777_216);
  await writeFile(join(directory, "notes/Doc.assets/extra.bin"), "x");
  assert.equal((await call("knowledge.asset.list", { id: document.id })).error.code, "INVALID_DOCUMENT");
  await unlink(join(directory, "notes/Doc.assets/extra.bin"));
  await truncate(join(directory, "notes/Doc.assets/0.bin"), 16_777_217);
  assert.equal((await call("knowledge.asset.list", { id: document.id })).error.code, "INVALID_DOCUMENT");
});

test("resource traversal accepts 32 nested directories and rejects a 33rd level", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create();
  const deep = join(directory, "notes/Doc.assets", ...Array(32).fill("nested"));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "data.bin"), "deep bytes");
  assert.equal((await call("knowledge.asset.list", { id: document.id })).result.total, 1);
  await mkdir(join(deep, "too-deep"));
  assert.equal((await call("knowledge.asset.list", { id: document.id })).error.code, "INVALID_DOCUMENT");
});

test("resource traversal counts its root and accepts exactly 2048 entries, not 2049", async t => {
  const { directory, create, call } = await fixture(t);
  const document = await create();
  const assets = join(directory, "notes/Doc.assets");
  await mkdir(assets);
  await Promise.all(Array.from({ length: 2047 }, (_, index) => writeFile(join(assets, `${index}.bin`), "x")));
  const exact = await call("knowledge.asset.list", { id: document.id, limit: 1 });
  assert.equal(exact.result.total, 2047);
  assert.equal(exact.result.items.length, 1);
  await writeFile(join(assets, "extra.bin"), "x");
  assert.equal((await call("knowledge.asset.list", { id: document.id })).error.code, "INVALID_DOCUMENT");
});
