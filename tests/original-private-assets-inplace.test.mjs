import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { originalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { seedOriginalPrivateResourcePublication } from "./original-private-resource-publication-fixture.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the actual isolated framework.");
assert(process.env.PKM_LEGACY_VSIX, "Pinned original release evidence is mandatory, not skipped.");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const areas = { note: "notes", skill: "skills", paper: "papers" };
async function files(root) {
  const result = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), relative = `${prefix}/${name}`, stat = await lstat(path);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) await walk(path, relative);
      else result.push({ path: relative, bytes: await readFile(path), identity:
        [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") });
    }
  }
  for (const area of Object.values(areas)) await walk(join(root, area), area);
  return result;
}
const mutate = `
  const kind=input.kind,area={note:"notes",skill:"skills",paper:"papers"}[kind];
  const key=kind==="skill"?"Before":"Old/Before",before=store[kind+"Get"](key);
  if(!before)throw new Error("Missing original public owner");
  const path=require("node:path").join(root,area,"Old/Before.md");
  const raw=require("node:fs").readFileSync(path,"utf8");
  if(input.writer==="upsert"){
    store[kind+"Upsert"]({...before,
      tags:input.mode==="metadata"?["verified-inplace"]:typeof before.tags==="string"?JSON.parse(before.tags):before.tags,
      content:input.mode==="content"?before.content.replace("Original private-resource owner","Verified original in-place body"):before.content});
  }else{
    let next=raw;
    if(input.mode==="content")next=raw.replace("Original private-resource owner","Verified original in-place body");
    else{
      if(/^tags:.*$/m.test(raw))next=raw.replace(/^tags:.*$/m,'tags: ["verified-inplace"]');
      else next=raw.replace("\\n---\\n",'\\ntags: ["verified-inplace"]\\n---\\n');
    }
    if(next===raw)throw new Error("The actual same-path write must change content or metadata");
    // Actual shared writer used by resources/knowledge_mutations.js for MCP write-markdown.
    store.writeKnowledgeMarkdown(area,"Old/Before.md","Old/Before.md",next);
  }
  const after=store[kind+"Get"](key);
  return {before,after,oldPathStillExists:require("node:fs").existsSync(path)};
`;
for (const writer of ["upsert", "mcp-shared-writer"])
for (const mode of ["content", "metadata"])
for (const [kind, area] of Object.entries(areas))
test(`pinned original ${writer} ${kind} same-path ${mode} update does not publish stored private legacy assets`, { timeout: 90000 }, async t => {
  const directory = resolve("tests", `.original-private-inplace-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [...Object.values(areas), ".pkm"]) await mkdir(join(root, name), { mode: 0o700 });
  const privacy = Buffer.from(JSON.stringify({ schema: 1, private: { notes: ["Private"], skills: ["Private"], papers: ["Private"] } }));
  await writeFile(join(root, ".pkm/content-privacy.json"), privacy, { mode: 0o600 });
  const original = originalKnowledgeWriterFixture(directory), rows = original.run(root, seedOriginalPrivateResourcePublication);
  const beforeFiles = await files(root), result = original.run(root, mutate, { writer, mode, kind });
  assert.equal(result.oldPathStillExists, true);
  assert.equal(result.before.knowledgeId, rows[kind].knowledgeId);
  assert.equal(result.after.knowledgeId, result.before.knowledgeId);
  // The real Upsert identity compiler increments once; the raw MCP shared writer does not invent a revision.
  assert.equal(result.after.revision, result.before.revision + (writer === "upsert" ? 1 : 0));
  assert.equal(result.after.category, "Old");
  if (kind !== "skill") assert.equal(result.after.slug, "Old/Before");
  assert.equal(kind === "skill" ? result.after.name : result.after.title, "Before");
  assert.equal(result.after.content, mode === "content"
    ? result.before.content.replace("Original private-resource owner", "Verified original in-place body") : result.before.content);
  if (mode === "metadata") assert.deepEqual(typeof result.after.tags === "string" ? JSON.parse(result.after.tags) : result.after.tags, ["verified-inplace"]);
  if (kind === "paper") assert.equal(result.after.file, result.before.file);
  const afterFiles = await files(root), owner = `${area}/Old/Before.md`;
  assert.notEqual(hash(afterFiles.find(file => file.path === owner).bytes), hash(beforeFiles.find(file => file.path === owner).bytes));
  assert.deepEqual(afterFiles.filter(file => file.path !== owner), beforeFiles.filter(file => file.path !== owner),
    "Private bytes/identity/referrers, existing pairs and unrelated owners must remain exact; no digest resource copy is created.");
  assert.deepEqual(await readFile(join(root, ".pkm/content-privacy.json")), privacy);
  assert(result.after.content.includes("../Private/_assets/a.PNG?q=1#view"));
  assert(result.after.content.includes('src="../Private/_assets/a.PNG?html=1#image"'));
  assert(result.after.content.includes("[legacy]: <../Private/_assets/b.BIN?definition=1#doc>"));
  for (const name of ["a.PNG", "b.BIN"]) {
    const source = beforeFiles.find(file => file.path === `${area}/Private/_assets/${name}`); assert(source);
    const target = `${hash(source.bytes).slice(0,16)}${name.slice(name.lastIndexOf(".")).toLowerCase()}`;
    await assert.rejects(readFile(join(root, area, "Old/Before.assets", target)), { code: "ENOENT" });
  }
  t.diagnostic(JSON.stringify({ originalPackageSha256: original.originalPackageSha256, writer, kind, mode,
    samePath: true, identityPreserved: true, revisionBefore: result.before.revision, revisionAfter: result.after.revision,
    storedPrivateLegacyPublication: false, privateSourcesAndReferrersExact: true }));
});
