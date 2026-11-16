import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateHostBuild, validateHostPayload } from "./package-host.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");

test("packaging rejects stale, missing, altered and linked build assets", async () => {
  const root = join(here, `.package-test-${randomUUID()}`);
  const required = ["extension.cjs", "extension-modules.json", "migration/src/import-helper.js", "migration/package.json"];
  try {
    const files = {};
    for (const name of required) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), "fixture");
      files[name] = digest("fixture");
    }
    await writeFile(join(root, "host-build.json"), JSON.stringify({ schema: "pkm.host-build/v1", files }));
    await validateHostBuild(root);
    await writeFile(join(root, "stale.cjs"), "stale previous build");
    await assert.rejects(validateHostBuild(root), /changed or are incomplete/);
    await rm(join(root, "stale.cjs"));
    await writeFile(join(root, "extension.cjs"), "changed");
    await assert.rejects(validateHostBuild(root), /changed or are incomplete/);
    await rm(join(root, "extension.cjs"));
    await assert.rejects(validateHostBuild(root), /changed or are incomplete/);
    await symlink("migration/package.json", join(root, "extension.cjs"));
    await assert.rejects(validateHostBuild(root), /linked or unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("relocated build retains Python inventory and CommonJS resource dependencies", async () => {
  const root = join(here, `.package-test-${randomUUID()}`);
  try {
    await validateHostBuild();
    await cp(join(here, "dist"), join(root, "dist"), { recursive: true });
    await cp(join(here, "next-runtime"), join(root, "next-runtime"), { recursive: true });
    const source = join(root, "source");
    await mkdir(join(source, "notes"), { recursive: true });
    await writeFile(join(source, "notes/Example.md"), "---\ntitle: Relocated\n---\nFixture\n");
    const result = spawnSync(process.env.PKM_TEST_PYTHON || "python3",
      ["-I", "-S", "-B", join(root, "next-runtime/server/compat/legacy-note-inventory.py"), source],
      { input: "{}", encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Relocated/);
    for (const name of ["resources/action_components.js", "dist/runtime/cross-process-lock.js", "dist/knowledge/markdown-assets.js"])
      assert.equal(typeof require(join(root, "next-runtime/server/legacy", name)), "object");
    assert.equal(JSON.parse(await readFile(join(root, "next-runtime/server/legacy/package.json"), "utf8")).type, "commonjs");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the packaged extension and Core share one unchanged retained CommonJS authority closure", async () => {
  const root = join(here, `.package-test-${randomUUID()}`);
  try {
    await validateHostPayload();
    for (const name of ["dist", "next-runtime", "package.json"])
      await cp(join(here, name), join(root, name), { recursive: true });
    const payload = await validateHostPayload(root);
    const modules = JSON.parse(await readFile(join(root, "dist/extension-modules.json"), "utf8"));
    assert(modules.retainedExternals.includes("../next-runtime/server/legacy/dist/runtime/managed-writer-session.js"),
      "The existing managed chat client must use the same physical managed session brand as Core");
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const path = require("node:path");
      const { createRequire } = require("node:module");
      const root = ${JSON.stringify(root)};
      const extension = createRequire(path.join(root, "dist/extension.cjs"));
      const core = createRequire(path.join(root, "next-runtime/server/dist/active-vscode-migration-host.js"));
      const fromExtension = extension("../next-runtime/server/legacy/dist/runtime/host-writer-admission.js");
      const fromCore = core("../legacy/dist/runtime/host-writer-admission.js");
      assert.equal(fromExtension.HostWriterAdmission, fromCore.HostWriterAdmission);
      const registry = core("../legacy/dist/runtime/managed-host-child-registry.js");
      const directory = path.join(root, "disposable-root");
      fs.mkdirSync(directory);
      const host = new fromExtension.HostWriterAdmission(directory, () => directory);
      const children = registry.createManagedHostChildRegistry(directory, host);
      registry.assertManagedHostChildRegistry(children, directory, host);
      const foreign = { ...host };
      assert.throws(() => registry.createManagedHostChildRegistry(directory, foreign));
      children.close().then(() => process.stdout.write("singleton authority validated"));
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /singleton authority validated/);
    assert.equal(payload.buildId, JSON.parse(await readFile(join(root, "next-runtime/manifest.json"), "utf8")).buildId);
    await mkdir(join(root, "dist/runtime"), { recursive: true });
    await cp(join(root, "next-runtime/server/legacy/dist/runtime/host-writer-admission.js"),
      join(root, "dist/runtime/host-writer-admission.js"));
    const build = JSON.parse(await readFile(join(root, "dist/host-build.json"), "utf8"));
    build.files["runtime/host-writer-admission.js"] =
      digest(await readFile(join(root, "dist/runtime/host-writer-admission.js")));
    await writeFile(join(root, "dist/host-build.json"), JSON.stringify(build));
    await assert.rejects(validateHostPayload(root), /Duplicate retained host module/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
