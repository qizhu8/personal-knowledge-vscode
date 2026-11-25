import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);

export async function prepareDistinctManagedRuntimeFixture(directory) {
  const checkout = join(directory, "checkout"), scratch = join(directory, "scratch");
  await mkdir(checkout, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const source = await readFile(join(repository, "src/core.ts"), "utf8");
  const tree = ts.createSourceFile("src/core.ts", source, ts.ScriptTarget.Latest, true);
  const arrays = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "features"
      && ts.isArrayLiteralExpression(node.initializer)
      && node.initializer.elements.some(item => ts.isStringLiteral(item) && item.text === "knowledge-documents"))
      arrays.push(node.initializer.getStart(tree) + 1);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(arrays.length, 1, "Locate the actual Core server_info feature array, not a manifest marker.");
  const copy = async path => cp(join(repository, path), join(checkout, path), {
    recursive: true, dereference: true,
    filter: path => !["node_modules", ".git", "__pycache__"].includes(basename(path)) && !path.endsWith(".pyc"),
  });
  for (const path of ["src", "scripts", "compat", "compute", "domain", "browser", "experimental", "migration",
    "package.json", "package-lock.json", "tsconfig.json", "legacy/src", "legacy/dist",
    "legacy/resources", "legacy/scripts", "legacy/package.json"])
    await copy(path);
  for (const path of ["node_modules", "legacy/node_modules"])
    await symlink(await realpath(join(repository, path)), join(checkout, path), process.platform === "win32" ? "junction" : "dir");
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, PYTHONDONTWRITEBYTECODE: "1" };
  const buildTimings = [];
  const run = (phase, executable, args) => {
    const started = Date.now();
    const result = spawnSync(executable, args, { cwd: checkout, env, encoding: "utf8", timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024 });
    buildTimings.push({ phase, durationMs: Date.now() - started });
    assert(!result.error && result.status === 0,
      `${phase}: ${result.error?.message ?? result.signal ?? result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return result.stdout.trim();
  };
  const python = run("resolve-python", process.env.PKM_TEST_PYTHON || process.env.PYTHON || "python3",
    ["-c", "import sys; print(sys.executable)"]);
  const compiler = join(checkout, "node_modules/typescript/bin/tsc");
  const artifacts = [], artifactProfiles = [];
  for (const version of ["A", "B"]) {
    // Only the disposable source copy changes; both releases use the normal compiler, profile generator and packager.
    const marker = JSON.stringify(`runtime-code-upgrade-proof:${version}`);
    await writeFile(join(checkout, "src/core.ts"), source.slice(0, arrays[0]) + marker + ", " + source.slice(arrays[0]));
    run(`${version}:bootstrap-compile`, process.execPath, [compiler, "-p", "tsconfig.json"]);
    run(`${version}:generate-profile`, process.execPath, ["scripts/generate-storage-bootstrap-profile.mjs"]);
    run(`${version}:canonical-build`, process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--silent"]);
    const extension = join(checkout, `extension-${version}`), artifact = join(extension, "next-runtime");
    const extensionVersion = `5.0.0-proof${version}`;
    await mkdir(extension, { mode: 0o700 });
    await writeFile(join(extension, "package.json"), JSON.stringify({ name: "pkm-upgrade-fixture", version: extensionVersion }),
      { mode: 0o600 });
    const started = Date.now();
    const temporaryEnvironment = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
    try {
      for (const key of Object.keys(temporaryEnvironment)) process.env[key] = scratch;
      require(join(checkout, "scripts/stage-runtime.cjs")).stage(artifact, { production: true, extensionVersion });
    } finally {
      for (const [key, value] of Object.entries(temporaryEnvironment))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    buildTimings.push({ phase: `${version}:production-package`, durationMs: Date.now() - started });
    const { verifyNextPayload } = require(join(artifact, "server/legacy/dist/runtime/next-payload-verifier.js"));
    const payload = verifyNextPayload(extension);
    const manifest = JSON.parse(await readFile(join(artifact, "manifest.json"), "utf8"));
    const module = await import(pathToFileURL(join(artifact, "server/dist/storage-bootstrap-profile.js")).href);
    const profile = JSON.parse(module.STORAGE_BOOTSTRAP_PROFILE_JSON);
    artifactProfiles.push({ version: extensionVersion, payloadBuildId: payload.buildId, inventoryFiles: Object.keys(manifest.files).length,
      sourceSha256: profile.sourceSha256, schemaSha256: profile.schemaSha256, tables: profile.tables.length,
      sourceFiles: profile.sourceFiles });
    artifacts.push(artifact);
  }
  const [a, b] = artifactProfiles;
  assert.notEqual(a.payloadBuildId, b.payloadBuildId);
  assert.notEqual(a.sourceSha256, b.sourceSha256);
  assert.equal(a.schemaSha256, b.schemaSha256);
  assert.equal(a.tables, b.tables);
  assert.deepEqual(a.sourceFiles.map(item => item.path), b.sourceFiles.map(item => item.path));
  assert.deepEqual(a.sourceFiles.filter((item, index) => item.sha256 !== b.sourceFiles[index].sha256).map(item => item.path),
    ["src/core.ts"]);
  assert.equal(digest(await readFile(join(repository, "src/core.ts"))), digest(source), "Production Core was not modified.");
  return { artifactA: resolve(artifacts[0]), artifactB: resolve(artifacts[1]), python, buildTimings,
    sourceCoreSha256: digest(source), artifactProfiles: artifactProfiles.map(({ sourceFiles: _files, ...profile }) => profile) };
}
