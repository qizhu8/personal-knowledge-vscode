import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();

test("Skills shared import preserves original bundle trees, refuses collisions and conservatively recovers interrupted publication", { timeout: 180000 }, async t => {
  const root = join(project, "../tests", `.skills-shared-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist"), extensionDist = join(root, "extension-dist");
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(project, "../tsconfig.json"),
    "--outDir", dist], { stdio: "pipe", timeout: 120000 });
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project,
    "--outDir", extensionDist, "--sourceMap", "false"], { stdio: "pipe", timeout: 120000 });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await cp(join(project, "../compat"), join(root, "compat"), { recursive: true });
  // The actual original bundle writer, not a new migration-specific fixture format.
  await writeFile(join(extensionDist, "package.json"), '{"type":"commonjs"}');
  const { importMarkdownAssetBundle } = require(join(extensionDist, "knowledge/markdown-assets.js"));
  const { planLegacyImport, importLegacyWorkspace, recoverLegacyImportOutcome, cleanupInterruptedLegacyImportStages } =
    await import(join(dist, "legacy-import.js"));
  const { auditImportedWorkspace } = await import(join(dist, "managed-import-audit.js"));
  const { bindImportedReadOnlyHost } = await import(join(dist, "managed-client-host.js"));
  const origin = join(root, "original-bundle-root"), source = join(root, "static-copy"), target = join(root, "target");
  const id = "knowledge_1234567890abcdef12345678";
  const content = "![legacy](_assets/diagrams/skill%20image.bin)\n![root](../_assets/root.bin)\n";
  const raw = `---\nschema: pkm.knowledge/v1\nknowledgeId: ${id}\nrevision: 2\naliases: []\nname: Original Skill\ndescription: Keep original metadata\n---\n${content}`;
  await mkdir(join(origin, "skills/Team"), { recursive: true, mode: 0o700 });
  await writeFile(join(origin, "skills/Team/Design.md"), raw);
  const bytes = Buffer.alloc(140011);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 253;
  const other = Buffer.from([255, 0, 3, 10, 128]);
  const assets = [
    { path: "Team/_assets/diagrams/skill image.bin", bytes },
    { path: "_assets/root.bin", bytes: other },
  ];
  importMarkdownAssetBundle(origin, assets.map(asset => ({ type: "skills", path: asset.path,
    data: asset.bytes.toString("base64"), digest: `sha256:${hash(asset.bytes)}` })),
  [{ area: "skills", path: "Team/Design.md", content }]);
  // Preserve unreferenced bytes too: preservation must not depend on catalog membership.
  await writeFile(join(origin, "skills/Team/_assets/unreferenced.bin"), "Do not silently discard");
  await writeFile(join(origin, "skills/Team/_assets/empty.bin"), Buffer.alloc(0));
  await mkdir(join(origin, "skills/Team/_assets/empty-directory"));
  await mkdir(source, { mode: 0o700 });
  await mkdir(join(source, "notes"), { mode: 0o700 });
  await cp(join(origin, "skills"), join(source, "skills"), { recursive: true });
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert(plan.entries.some(entry => entry.destination === "skills/Team/_assets/diagrams/skill image.bin" && entry.sha256 === hash(bytes)));
  const receipt = await importLegacyWorkspace(plan, target, { pythonExecutable: python });
  assert.equal(receipt.assetCount, 4);
  assert.equal((await recoverLegacyImportOutcome(target)).status, "published");
  const audit = await auditImportedWorkspace(target, plan);
  const marker = JSON.parse(await readFile(join(target, ".pkm-next-workspace"), "utf8"));
  const reader = bindImportedReadOnlyHost(target, marker.id, audit.assertUnchanged);
  const first = (await reader.invoke("asset-list", { id, limit: 1 })).result;
  assert.equal(first.total, 2);
  const later = (await reader.invoke("asset-list", { id, offset: first.nextOffset, revision: first.revision })).result;
  for (const asset of [...first.items, ...later.items]) {
    const expected = assets.find(item => item.path === asset.path).bytes;
    const chunks = [];
    for (let offset = 0; offset !== null;) {
      const response = await reader.invoke("asset-get", { id, path: asset.path,
        expectedDocumentSha256: first.documentSha256, expectedDigest: asset.digest, offset });
      assert.equal(response.error, undefined);
      chunks.push(Buffer.from(response.result.data, "base64"));
      offset = response.result.nextOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
  await reader.close();
  assert.equal(await readFile(join(target, "skills/Team/Design.md"), "utf8"), raw);
  assert.equal(await readFile(join(target, "skills/Team/_assets/unreferenced.bin"), "utf8"), "Do not silently discard");
  assert.equal((await readFile(join(target, "skills/Team/_assets/empty.bin"))).length, 0);
  assert((await lstat(join(target, "skills/Team/_assets/empty-directory"))).isDirectory());
  await assert.rejects(importLegacyWorkspace(plan, target, { pythonExecutable: python }), { code: "DESTINATION_EXISTS" });
  for (const asset of assets) assert.deepEqual(await readFile(join(target, "skills", asset.path)), asset.bytes);

  await t.test("portable case/Unicode/file-directory collisions block before publication", async () => {
    for (const names of [["Image.bin", "image.bin"], ["é.bin", "e\u0301.bin"], ["branch", "BRANCH"]]) {
      const copy = join(root, `collision-${randomUUID()}`);
      await cp(source, copy, { recursive: true });
      const directory = join(copy, "skills/Team/_assets");
      if (names[0] === "branch") await mkdir(join(directory, names[0]));
      else await writeFile(join(directory, names[0]), bytes);
      await writeFile(join(directory, names[1]), names[0] === "Image.bin" ? bytes : other);
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false);
      assert(blocked.blockers.some(item => item.code === "shared-asset-path-collision"), JSON.stringify(blocked.blockers));
      const absent = join(root, `blocked-${randomUUID()}`);
      await assert.rejects(importLegacyWorkspace(blocked, absent, { pythonExecutable: python }), { code: "IMPORT_BLOCKED" });
      await assert.rejects(lstat(absent), { code: "ENOENT" });
    }
  });
  await t.test("authority, links, unsafe names and changing shared bytes stay blocked", async () => {
    for (const kind of ["authority", "symlink", "hidden", "oversized"]) {
      const copy = join(root, `unsafe-${kind}`);
      await cp(source, copy, { recursive: true });
      const path = join(copy, "skills/Team/_assets", kind === "authority" ? "pkm-todo-board.json" : kind === "hidden" ? ".private" : `${kind}.bin`);
      if (kind === "symlink") await symlink(join(origin, "skills/_assets/root.bin"), path);
      else {
        await writeFile(path, "Must never be silently discarded or treated as authority.");
        if (kind === "oversized") await truncate(path, 16_777_217);
      }
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false);
      assert(blocked.blockers.some(item => ["symlink", "unsupported-shared-asset"].includes(item.code)));
    }
    const copy = join(root, "changed");
    await cp(source, copy, { recursive: true });
    const approved = await planLegacyImport(copy);
    await writeFile(join(copy, "skills/Team/_assets/diagrams/skill image.bin"), other);
    await assert.rejects(importLegacyWorkspace(approved, join(root, "changed-target"), { pythonExecutable: python }), { code: "SOURCE_CHANGED" });
  });
  await t.test("publication death retains exact shared bytes and unknown outcome; cleanup never deletes a published target", async () => {
    const crashTarget = join(root, "crash-target"), shim = join(root, "publication-death.py");
    await writeFile(shim, `#!${python}
import os, signal, sys
if len(sys.argv) >= 5 and sys.argv[-1] == ${JSON.stringify(crashTarget)}:
    os.kill(os.getppid(), signal.SIGKILL)
    sys.exit(79)
os.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}, *sys.argv[1:]])
`);
    await chmod(shim, 0o700);
    assert.throws(() => execFileSync(process.execPath, [join(dist, "cli.js"), "import", "--source", source,
      "--destination", crashTarget, "--plan-sha256", plan.planSha256, "--python", shim,
      "--acknowledge-quiescent-disposable-copy"], { stdio: "pipe", timeout: 30000 }),
    error => error.signal === "SIGKILL");
    const stages = (await readdir(root)).filter(name => /^\.crash-target\.pkm-legacy-import-[a-f0-9-]{36}$/.test(name));
    assert.equal(stages.length, 1);
    const stage = join(root, stages[0]);
    for (const asset of assets) assert.deepEqual(await readFile(join(stage, "skills", asset.path)), asset.bytes);
    const outcomePath = join(root, ".crash-target.pkm-legacy-import.outcome.json");
    const outcomeBytes = await readFile(outcomePath);
    const status = await recoverLegacyImportOutcome(crashTarget);
    assert.notEqual(status.status, "published");
    assert.deepEqual(await cleanupInterruptedLegacyImportStages(crashTarget), { removed: [stage], retained: [] });
    assert.deepEqual(await readFile(outcomePath), outcomeBytes, "Cleanup cannot erase the unknown outcome or authorize replay.");
    await assert.rejects(lstat(crashTarget), { code: "ENOENT" });
    assert.deepEqual(await cleanupInterruptedLegacyImportStages(target), { removed: [], retained: [] });
    assert.equal((await recoverLegacyImportOutcome(target)).status, "published");
    for (const asset of assets) {
      assert.deepEqual(await readFile(join(target, "skills", asset.path)), asset.bytes);
      assert.deepEqual(await readFile(join(source, "skills", asset.path)), asset.bytes);
      assert.deepEqual(await readFile(join(origin, "skills", asset.path)), asset.bytes);
    }
  });
});
