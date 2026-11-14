import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  resourceLifecycleDefinitions, resourceLifecycleLimits, readResourceLifecycle, planResourceLifecycle,
  applyResourceLifecycle, recoverResourceLifecycle, serializeResourceLifecyclePlan, deserializeResourceLifecyclePlan,
} from "../dist/resource-lifecycle.js";
import { decodeMarkdown, sha256 } from "../dist/markdown.js";
import { atomicFileCreateNoReplace } from "../dist/file-write.js";
import { resourceLifecycleOriginalRules } from "../dist/domain/resource-lifecycle-original.js";
import { checkCaptureRecords, packageRoot } from "../scripts/migration.mjs";
import { spawnSync } from "node:child_process";

test("schema-only definitions and executor exports work in either direct ESM import order", () => {
  for (const first of ["resource-lifecycle", "resource-lifecycle-contracts", "contracts"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      await import("./dist/${first}.js");
      const executor = await import("./dist/resource-lifecycle.js");
      const schema = await import("./dist/resource-lifecycle-contracts.js");
      const registry = await import("./dist/contracts.js");
      assert.equal(executor.resourceLifecycleDefinitions, schema.resourceLifecycleDefinitions);
      for (const definition of schema.resourceLifecycleDefinitions) {
        assert(registry.definitions.some(item => item.id === definition.id));
      }
    `], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  }
});

async function fixture(t, area = "notes", body = "No references", path = "Team/Doc.md", content = Buffer.from([0, 255, 1])) {
  const root = resolve("tests", `.resource-lifecycle-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = [];
  async function document(area, path, body, id = `doc-${documents.length}`) {
    const raw = `---\ndocumentId: ${id}\nrevision: 3\n---\n${body}`;
    await mkdir(join(root, area, path, ".."), { recursive: true });
    await writeFile(join(root, area, path), raw);
    const record = decodeMarkdown(id, raw, path, area);
    documents.push(record);
    return record;
  }
  const owner = await document(area, path, body, "owner");
  const resourcePath = `${path.replace(/\.md$/i, ".assets")}/source.bin`;
  await mkdir(join(root, area, resourcePath, ".."), { recursive: true });
  await writeFile(join(root, area, resourcePath), content);
  const pins = {
    id: owner.record.id, area, documentPath: path, expectedRevision: 3, expectedSha256: owner.record.sha256,
    path: resourcePath, expectedDigest: `sha256:${sha256(content)}`, expectedSize: content.length,
  };
  function preview(action = "rename", extras = {}) {
    return readResourceLifecycle(root, documents, { operation: "knowledge.asset.lifecycle.preview", actorId: "local:owner", args: {
      ...pins, action, ...(action === "rename" ? { newName: "renamed.bin" } : {}), ...extras,
    } });
  }
  function plan(action = "rename", extras = {}) {
    return planResourceLifecycle(root, documents, {
      operation: `knowledge.asset.${action}`, actorId: "local:owner", args: {
        ...pins, operationId: randomUUID(), expectedScanRevision: preview(action).scanRevision,
        ...(action === "rename" ? { newName: "renamed.bin", expectedDestinationDigest: null } : {}), ...extras,
      },
    });
  }
  return { root, documents, document, owner, content, pins, preview, plan };
}
const errorCode = (code, effect) => error => {
  assert.equal(error.code, code, error.message);
  if (effect) assert.equal(error.effect, effect);
  assert(!error.message.includes("/home/"), "Errors must not expose host paths.");
  return true;
};

test("asset destination publication cannot replace a target created during its final race window", async t => {
  const root = resolve("tests", `.resource-publication-race-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "destination.bin"), competing = Buffer.from("external target");
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, options) {
    if (Array.isArray(args) && args[0] === "-c" && String(args[1]).includes("renameat2")) writeFileSync(destination, competing);
    return originalExecFileSync.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => atomicFileCreateNoReplace(destination, Buffer.from("planned asset"), randomUUID()),
      errorCode("RECOVERY_CONFLICT", "unknown"),
    );
    assert.deepEqual(await readFile(destination), competing);
    assert.deepEqual(await readdir(root), ["destination.bin"]);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    syncBuiltinESMExports();
  }
});

for (const area of ["notes", "skills", "papers"]) {
  for (const action of ["rename", "delete"]) {
    test(`${area} ${action}: pinned plan is pure, serializable, guarded and replayable`, async t => {
      const f = await fixture(t, area);
      const plan = f.plan(action);
      assert.equal(plan.changes.length, action === "rename" ? 2 : 1);
      assert.equal(plan.requiresCompoundJournal, false);
      assert.deepEqual(await readFile(join(f.root, area, f.pins.path)), f.content);
      assert.equal(await readFile(join(f.root, area, f.pins.documentPath), "utf8"), f.owner.raw);
      const replay = deserializeResourceLifecyclePlan(serializeResourceLifecyclePlan(plan));
      assert.deepEqual(replay, plan);
      assert.deepEqual(applyResourceLifecycle(f.root, replay, plan.operationId), plan.result);
      await assert.rejects(readFile(join(f.root, area, f.pins.path)), { code: "ENOENT" });
      if (action === "rename") assert.deepEqual(await readFile(join(f.root, area, plan.result.after.path)), f.content);
      assert.deepEqual(recoverResourceLifecycle(f.root, replay, plan.operationId), plan.result);
      assert(resourceLifecycleDefinitions.find(item => item.id === `knowledge.asset.${action}`).output.safeParse(plan.result).success);
    });
  }
}

test("referenced rename is explicit and reproduces original inline/HTML/definition/file rewrite without metadata edits", async t => {
  const body = [
    "![nested [label]](Doc.assets/source.bin?view=1#anchor)",
    '<img src="Doc.assets/source.bin">',
    "[resource]: <Doc.assets/source.bin>",
    'file: "Doc.assets/source.bin"',
    "`![ignored](Doc.assets/source.bin)`",
    "```md\n![example](Doc.assets/source.bin)\n```",
  ].join("\n");
  const f = await fixture(t, "notes", body);
  assert.equal(f.preview().markdownRewriteRequired, true);
  assert.throws(() => f.plan(), errorCode("UNSUPPORTED_OPERATION"));
  assert.throws(() => f.preview("delete"), errorCode("CONFLICT"));
  const plan = f.plan("rename", { rewriteMarkdown: true });
  assert.equal(plan.requiresCompoundJournal, true);
  const doc = plan.changes[2];
  assert.equal(doc.before.toString(), f.owner.raw);
  const raw = doc.after.toString();
  assert(raw.includes("Doc.assets/renamed.bin?view=1#anchor"));
  assert(raw.includes('file: "Doc.assets/renamed.bin"'));
  assert(raw.includes("`![ignored](Doc.assets/source.bin)`"));
  assert(raw.includes("```md\n![example](Doc.assets/source.bin)\n```"));
  assert(raw.startsWith("---\ndocumentId: owner\nrevision: 3\n---\n"), "Original raw frontmatter/revision stay unchanged.");
  assert.deepEqual(await readFile(join(f.root, "notes", f.pins.path)), f.content);
  applyResourceLifecycle(f.root, plan, plan.operationId);
  assert.equal(await readFile(join(f.root, "notes", f.pins.documentPath), "utf8"), raw);
  assert.equal(plan.result.document.afterSha256, sha256(raw));
  assert(resourceLifecycleOriginalRules.editMarkdownAssetUnlocked.includes("assertMarkdownAssetsUnshared"));
});

for (const referrerArea of ["notes", "skills", "papers"]) {
  test(`original whole-owned-tree shared protection includes ${referrerArea} body references to sibling resources`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.root, "notes/Team/Doc.assets/sibling.bin"), "sibling");
    const pointer = referrerArea === "notes" ? "Doc.assets/sibling.bin" : "../../notes/Team/Doc.assets/sibling.bin";
    await f.document(referrerArea, "Team/Other.md", `![other](${pointer})`);
    for (const action of ["rename", "delete"]) assert.throws(() => f.preview(action), errorCode("CONFLICT"));
    assert.deepEqual(await readFile(join(f.root, "notes", f.pins.path)), f.content);
  });
}

test("fenced/inline examples and missing sibling targets do not invent original shared ownership", async t => {
  const f = await fixture(t);
  await f.document("skills", "Other.md", [
    "`![code](../notes/Team/Doc.assets/source.bin)`",
    "```md\n![code](../notes/Team/Doc.assets/source.bin)\n```",
    "![missing](../notes/Team/Doc.assets/missing.bin)",
  ].join("\n"));
  assert(f.plan("delete"));
});

test("the original derived .md owner and resource-directory references protect whole owned trees", async t => {
  const f = await fixture(t, "notes", "No refs", "Doc.MD");
  await f.document("notes", "Doc.md", "Different existing owner");
  assert.throws(() => f.preview(), errorCode("CONFLICT"));
  const g = await fixture(t);
  await g.document("papers", "Other.md", "[whole tree](../notes/Team/Doc.assets)");
  assert.throws(() => g.preview("delete"), errorCode("CONFLICT"));
});

test("CAS refuses stale document identity/address/revision/digest, binary size/digest and scan snapshots", async t => {
  const f = await fixture(t);
  for (const extras of [
    { area: "skills" }, { documentPath: "Other.md" }, { expectedRevision: 2 }, { expectedSha256: "0".repeat(64) },
    { expectedDigest: `sha256:${"0".repeat(64)}` }, { expectedSize: f.content.length + 1 },
  ]) assert.throws(() => f.preview("rename", extras), errorCode("CONFLICT"));
  const scan = f.preview().scanRevision;
  await f.document("papers", "Other.md", "Unrelated body");
  assert.throws(() => f.plan("rename", { expectedScanRevision: scan }), errorCode("CONFLICT"));
  assert.throws(() => readResourceLifecycle(f.root, f.documents.slice(0, 1), {
    operation: "knowledge.asset.lifecycle.preview", actorId: "owner", args: { ...f.pins, action: "delete" },
  }), errorCode("CONFLICT"));
  const plan = f.plan();
  await writeFile(join(f.root, "papers/Other.md"), "External change after planning");
  assert.throws(() => applyResourceLifecycle(f.root, plan, plan.operationId), errorCode("CONFLICT", "not-committed"));
  assert.deepEqual(await readFile(join(f.root, "notes", f.pins.path)), f.content);
});

test("legacy/shared/unknown paths, Todo authority, existing destinations, traversal and malformed requests fail closed", async t => {
  const f = await fixture(t);
  for (const path of ["Team/_assets/source.bin", "Team/Other.assets/source.bin"]) {
    assert.throws(() => f.preview("rename", { path }), errorCode("ACCESS_DENIED"));
  }
  for (const path of ["../escape.bin", "/absolute.bin", "Team/Doc.assets/.hidden"]) {
    assert.throws(() => f.preview("rename", { path }), errorCode("INVALID_ARGUMENT"));
  }
  assert.throws(() => f.preview("rename", { newName: "pkm-todo-board.json" }), errorCode("ACCESS_DENIED"));
  assert.throws(() => f.preview("rename", { path: "Team/Doc.assets/pkm-todo-board.json" }), errorCode("ACCESS_DENIED"));
  assert.throws(() => f.plan("rename", { expectedDestinationDigest: `sha256:${sha256(f.content)}` }), errorCode("INVALID_ARGUMENT"));
  await writeFile(join(f.root, "notes/Team/Doc.assets/renamed.bin"), "unknown destination");
  assert.throws(() => f.preview(), errorCode("CONFLICT"));
  assert.equal(await readFile(join(f.root, "notes/Team/Doc.assets/renamed.bin"), "utf8"), "unknown destination");
});

test("a rename target created after planning is never replaced and leaves the source/document intact", async t => {
  const f = await fixture(t, "notes", "![resource](Doc.assets/source.bin)");
  const plan = f.plan("rename", { rewriteMarkdown: true });
  const destination = join(f.root, "notes", plan.result.after.path);
  const competing = Buffer.from("external target");
  await writeFile(destination, competing);
  assert.throws(() => applyResourceLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
  assert.deepEqual(await readFile(destination), competing);
  assert.deepEqual(await readFile(join(f.root, "notes", f.pins.path)), f.content);
  assert.equal(await readFile(join(f.root, "notes", f.pins.documentPath), "utf8"), f.owner.raw);
});

test("symlink roots, ancestors, Markdown, resources, parent directories and referrers are never followed", async t => {
  const f = await fixture(t);
  const resource = join(f.root, "notes", f.pins.path);
  await unlink(resource);
  await symlink(join(f.root, "notes", f.pins.documentPath), resource);
  assert.throws(() => f.preview(), errorCode("INVALID_DOCUMENT"));
  await unlink(resource);
  await writeFile(resource, f.content);
  await symlink(join(f.root, "notes/Team/Doc.assets"), join(f.root, "notes/link"));
  assert.throws(() => f.preview(), errorCode("INVALID_DOCUMENT"));
  await unlink(join(f.root, "notes/link"));
  await symlink(join(f.root, "notes", f.pins.documentPath), join(f.root, "notes/referrer.md"));
  assert.throws(() => f.preview(), errorCode("INVALID_DOCUMENT"));
  await unlink(join(f.root, "notes/referrer.md"));
  const linkedRoot = `${f.root}-link`;
  await symlink(f.root, linkedRoot);
  t.after(() => unlink(linkedRoot));
  assert.throws(() => readResourceLifecycle(linkedRoot, f.documents, {
    operation: "knowledge.asset.lifecycle.preview", actorId: "owner", args: { ...f.pins, action: "delete" },
  }), errorCode("INVALID_DOCUMENT"));
});

test("recovery rolls forward partial compound effects without original scan guards and rejects unknown changes before further effects", async t => {
  const f = await fixture(t, "notes", "![resource](Doc.assets/source.bin)");
  const plan = f.plan("rename", { rewriteMarkdown: true });
  const target = join(f.root, "notes", plan.result.after.path);
  await writeFile(target, f.content); // Crash after target publication.
  await f.document("papers", "Later.md", "![new](../notes/Team/Doc.assets/source.bin)");
  assert.deepEqual(recoverResourceLifecycle(f.root, plan, plan.operationId), plan.result);
  assert.equal(await readFile(join(f.root, "notes", f.pins.documentPath), "utf8"), plan.changes[2].after.toString());
  assert.deepEqual(recoverResourceLifecycle(f.root, plan, plan.operationId), plan.result);
  await writeFile(target, "unknown external bytes");
  assert.throws(() => recoverResourceLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
  assert.equal(await readFile(target, "utf8"), "unknown external bytes");
});

test("every reachable rename crash state resumes; changed document or poisoned staging is preserved", async t => {
  for (const stage of ["destination", "markdown", "source-removed"]) {
    const f = await fixture(t, "notes", "![resource](Doc.assets/source.bin)");
    const plan = f.plan("rename", { rewriteMarkdown: true });
    await writeFile(join(f.root, "notes", plan.result.after.path), f.content);
    if (stage !== "destination") await writeFile(join(f.root, "notes", f.pins.documentPath), plan.changes[2].after);
    if (stage === "source-removed") await unlink(join(f.root, "notes", f.pins.path));
    assert.deepEqual(recoverResourceLifecycle(f.root, plan, plan.operationId), plan.result);
  }
  const f = await fixture(t);
  const plan = f.plan();
  await writeFile(join(f.root, "notes", f.pins.documentPath), "unknown Markdown");
  assert.throws(() => recoverResourceLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
  await writeFile(join(f.root, "notes", f.pins.documentPath), f.owner.raw);
  const staging = join(f.root, "notes/Team/Doc.assets", `.pkm-write-${plan.operationId}`);
  await writeFile(staging, "unknown staging");
  assert.throws(() => recoverResourceLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT", "unknown"));
  assert.equal(await readFile(staging, "utf8"), "unknown staging");
  assert.deepEqual(await readFile(join(f.root, "notes", f.pins.path)), f.content);
});

test("serialized intents reject modified bytes, noncanonical base64, foreign targets, extra writes and mismatched operationId", async t => {
  const f = await fixture(t);
  const plan = f.plan();
  for (const alter of [
    value => { value.changes[0].before = "AA=="; },
    value => { value.changes[0].before += "\n"; },
    value => { value.changes[1].path = "Team/Other.assets/renamed.bin"; },
    value => { value.changes.push(value.changes[0]); },
    value => { value.result.operationId = randomUUID(); },
  ]) {
    const json = JSON.parse(serializeResourceLifecyclePlan(plan));
    alter(json);
    assert.throws(() => deserializeResourceLifecyclePlan(JSON.stringify(json)));
  }
  assert.throws(() => applyResourceLifecycle(f.root, plan, randomUUID()), errorCode("INVALID_WORKSPACE"));
});

test("encoded rename names preserve suffixes; expanded rewrites have no Markdown size ceiling", async t => {
  const f = await fixture(t, "notes", "![resource](Doc.assets/source.bin?download=1#anchor)");
  const plan = f.plan("rename", { newName: "renamed #one.bin", rewriteMarkdown: true });
  assert(plan.changes[2].after.toString().includes("Doc.assets/renamed%20%23one.bin?download=1#anchor"));
  assert.equal(plan.result.after.path, "Team/Doc.assets/renamed #one.bin");
  const g = await fixture(t, "notes", "![x](Doc.assets/source.bin)\n".repeat(600));
  const expanded = g.plan("rename", { newName: `${"a".repeat(190)}.bin`, rewriteMarkdown: true });
  assert(expanded.changes.some(change => change.after?.toString().length > 100_000));
});

test("known complete staging is replayed, while altered source after target publication blocks all further effects", async t => {
  const f = await fixture(t);
  const plan = f.plan();
  const staging = join(f.root, "notes/Team/Doc.assets", `.pkm-write-${plan.operationId}`);
  await writeFile(staging, f.content);
  assert.deepEqual(recoverResourceLifecycle(f.root, plan, plan.operationId), plan.result);
  await assert.rejects(readFile(staging), { code: "ENOENT" });
  const g = await fixture(t, "notes", "![resource](Doc.assets/source.bin)");
  const compound = g.plan("rename", { rewriteMarkdown: true });
  await writeFile(join(g.root, "notes", compound.result.after.path), g.content);
  await writeFile(join(g.root, "notes", g.pins.path), "unknown source");
  assert.throws(() => recoverResourceLifecycle(g.root, compound, compound.operationId), errorCode("RECOVERY_CONFLICT", "unknown"));
  assert.equal(await readFile(join(g.root, "notes", g.pins.path), "utf8"), "unknown source");
  assert.equal(await readFile(join(g.root, "notes", g.pins.documentPath), "utf8"), g.owner.raw);
});

test("exact resource byte limit is accepted; limit+1 refused without mutations", async t => {
  const f = await fixture(t, "notes", "No refs", "Doc.md", Buffer.alloc(resourceLifecycleLimits.resourceBytes, 7));
  assert.equal(f.preview("delete").resource.size, resourceLifecycleLimits.resourceBytes);
  assert(deserializeResourceLifecyclePlan(serializeResourceLifecyclePlan(f.plan("delete"))));
  await writeFile(join(f.root, "notes", f.pins.path), Buffer.alloc(resourceLifecycleLimits.resourceBytes + 1));
  assert.throws(() => f.preview("delete"), errorCode("INVALID_DOCUMENT"));
});

async function rawRecord(f, path, raw) {
  await mkdir(join(f.root, "papers", path, ".."), { recursive: true });
  await writeFile(join(f.root, "papers", path), raw);
  const small = decodeMarkdown(`other-${f.documents.length}`, "small", path, "papers");
  f.documents.push({ ...small, raw, record: { ...small.record, sha256: sha256(raw) } });
}
test("resource reference scan accepts Markdown beyond former per-file and aggregate byte limits", async t => {
  const f = await fixture(t);
  await rawRecord(f, "large.md", `---\ndocumentId: large\n---\n${"x".repeat(1_100_000)}`);
  await rawRecord(f, "aggregate.md", `---\ndocumentId: aggregate\n---\n${"x".repeat(16_000_000)}`);
  assert(f.preview().scannedBytes > 16 * 1024 * 1024);
});

test("resource reference scan accepts more than 2048 documents and retains directory depth validation", async t => {
  const f = await fixture(t, "notes", "No refs", "Doc.md");
  for (let index = 1; index < 2049; index++) await rawRecord(f, `d-${index}.md`, "small");
  assert.equal(f.preview().scannedDocuments, 2049);
  const g = await fixture(t, "notes", "No refs", "Doc.md");
  const depth32 = Array(32).fill("dir").join("/");
  await rawRecord(g, `${depth32}/Deep.md`, "small");
  assert(g.preview());
  await mkdir(join(g.root, "papers", depth32, "too-deep"));
  assert.throws(() => g.preview(), errorCode("INVALID_WORKSPACE"));
});

test("original capture records are fresh and all outputs omit host paths", async t => {
  const provenance = JSON.parse(await readFile(join(packageRoot, "migration/resource-lifecycle-provenance.json"), "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  const f = await fixture(t);
  const serialized = serializeResourceLifecyclePlan(f.plan());
  assert(!serialized.includes(f.root));
  assert(!JSON.stringify(f.preview()).includes(f.root));
  assert.deepEqual((await readdir(join(f.root, "notes/Team/Doc.assets"))).sort(), ["source.bin"]);
});
