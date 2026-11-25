import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stageIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const python = spawnSync("python3", ["-I", "-S", "-c", "import pathlib,sys; print(pathlib.Path(sys.executable).resolve())"],
  { encoding: "utf8", timeout: 10000 });
assert.equal(python.status, 0, python.stderr);
const interpreter = python.stdout.trim();
const launcher = await readFile(new URL("../experimental/managed-launcher.py", import.meta.url));
const markerAbsent = Symbol("older-payload");

async function fixture(t, marker = "native-v1", writable = false, scheduler = false) {
  const root = join(fileURLToPath(new URL("../", import.meta.url)), `.pkm-launcher-dispatch-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const managed = join(root, "managed"), data = join(root, "data"), generation = randomUUID();
  const directory = join(managed, "generations", generation), runtime = join(directory, "runtime", "next-server");
  await mkdir(join(runtime, "dist"), { recursive: true, mode: 0o700 });
  await mkdir(join(runtime, "compat"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "runtime", "site-packages"), { recursive: true, mode: 0o700 });
  await mkdir(data, { mode: 0o700 });
  const workspaceId = randomUUID();
  await writeFile(join(data, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId }));
  const node = join(root, "node-dispatch-observer");
  await writeFile(node, `#!${interpreter}
import json,os,sys
print(json.dumps({"mode":"native","args":sys.argv[1:],"nodeOptions":os.environ.get("NODE_OPTIONS"),
 "pythonPath":os.environ.get("PYTHONPATH"),"isolatedPython":os.environ.get("PKM_ISOLATED_PYTHON_COMMAND")}))
`, { mode: 0o700 });
  await writeFile(join(runtime, "dist", "cli.js"), "// Dispatch target; the observer replaces a Node executable in this unit fixture.\n");
  await writeFile(join(runtime, "compat", "legacy-compact-mcp.py"),
    'import json,sys\nprint(json.dumps({"mode":"python-compat","args":sys.argv[1:]}))\n');
  await writeFile(join(runtime, "package.json"), JSON.stringify({
    name: "pkm-v5", version: "0.1.0", ...(marker === markerAbsent ? {} : { runtimeMcpFacade: marker }),
  }));
  const options = { data, allowWrites: writable, ...(scheduler ? { snapshotScheduler: {
    schema: "pkm.native-snapshot-scheduler/v1", workspaceId, actorId: "mcp:external", admissionSha256: "a".repeat(64),
  } } : {}) };
  await writeFile(join(directory, "launch.json"), JSON.stringify(options));
  const interpreters = {
    python: { path: interpreter, sha256: hash(await readFile(interpreter)) },
    node: { path: node, sha256: hash(await readFile(node)) },
  };
  const platform = { interpreters, launcherSha256: hash(launcher), pythonDistributions: [], pythonDependencyProfile: "fastmcp" };
  await writeFile(join(directory, "platform.json"), JSON.stringify(platform));
  await writeFile(join(directory, "python-dependencies.json"), JSON.stringify({ profile: "fastmcp", distributions: {} }));
  const files = {};
  async function inventory(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const local = prefix ? `${prefix}/${entry.name}` : entry.name, full = join(path, entry.name);
      if (entry.isDirectory()) await inventory(full, local);
      else files[local] = hash(await readFile(full));
    }
  }
  await inventory(directory);
  const digest = createHash("sha256");
  for (const name of Object.keys(files).sort()) digest.update(`${name}\0${files[name]}\0`);
  const manifest = {
    schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: managed, version: "0.1.0",
    components: Object.fromEntries(["knowledge", "chat", "recipes", "agent_sessions"].map(key => [key, "0.1.0"])),
    enabledFeatureDomains: [], experimental: true, runtimeBuild: digest.digest("hex"), files, node, ...platform,
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(managed, "launch.py"), launcher);
  const pointer = JSON.stringify({ schema: manifest.schema, generation });
  await writeFile(join(managed, "active-generation.json"), pointer);
  await writeFile(join(managed, "latest-generation.json"), pointer);
  return {
    root, managed, data, directory, generation, node,
    run(profile = "compact", args = []) {
      return spawnSync(interpreter, ["-I", "-S", join(managed, "launch.py"), ...args], {
        cwd: managed, encoding: "utf8", timeout: 10000,
        env: { PATH: process.env.PATH, PKM_CAPABILITY_PROFILE: profile,
          PYTHONPATH: join(root, "not-an-import-source"), NODE_OPTIONS: "--not-forwarded" },
      });
    },
  };
}

test("native payload dispatches the pinned Node entry and scrubs interpreter injection", async t => {
  const f = await fixture(t);
  const child = f.run();
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.mode, "native");
  assert.deepEqual(observed.args, [join(f.directory, "runtime/next-server/dist/cli.js"), "mcp",
    "--data", f.data, "--experimental-legacy-mcp", "--native-public-mcp",
    "--managed-generation", f.directory, "--read-only"]);
  assert.equal(observed.nodeOptions, null);
  assert.equal(observed.pythonPath, null);
  assert.equal(observed.isolatedPython, interpreter);
});

test("native writable scheduler dispatch retains the exact verified enrollment", async t => {
  const f = await fixture(t, "native-v1", true, true);
  const child = f.run();
  assert.equal(child.status, 0, child.stderr);
  const args = JSON.parse(child.stdout).args;
  assert(!args.includes("--read-only"));
  assert.deepEqual(args.slice(-2), ["--experimental-managed-snapshot-scheduler", "a".repeat(64)]);
});

test("explicit legacy profile and known older payloads retain the compatibility entry", async t => {
  const native = await fixture(t);
  const legacy = native.run("legacy");
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).mode, "python-compat");
  const older = await fixture(t, markerAbsent);
  const previous = older.run();
  assert.equal(previous.status, 0, previous.stderr);
  assert.equal(JSON.parse(previous.stdout).mode, "python-compat");
});

test("unknown facade markers fail verification, before any dispatch", async t => {
  const f = await fixture(t, "future-unknown");
  for (const args of [[], ["--verify-generation", f.generation]]) {
    const child = f.run("compact", args);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /unsupported MCP facade marker/);
    assert.equal(child.stdout, "");
  }
  const repository = join(f.root, "unknown-package"), target = join(f.root, "never-staged");
  await mkdir(repository, { mode: 0o700 });
  await writeFile(join(repository, "package.json"), '{"runtimeMcpFacade":"future-unknown"}');
  await assert.rejects(stageIsolatedManagedGeneration({
    managedRoot: target, data: f.data, repositoryRoot: repository,
  }), /Unsupported isolated MCP facade marker/);
  const names = await readdir(f.root);
  assert(!names.includes("never-staged"));
  const malformed = await fixture(t, null);
  const rejected = malformed.run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unsupported MCP facade marker/);
});

test("single-pass inventory agrees with the previous traversal on contents, links and special files", async t => {
  const f = await fixture(t);
  const child = spawnSync(interpreter, ["-I", "-S", "-B", "-c", `
import json, os, runpy, sys
from pathlib import Path
loaded = runpy.run_path(sys.argv[1])
directory = Path(sys.argv[2])
def original_inventory():
    actual = {}
    manifest_path = directory / "manifest.json"
    for target in directory.rglob("*"):
        if target.is_symlink():
            loaded["fail"]("linked runtime entry")
        if target.is_file() and target != manifest_path:
            actual[target.relative_to(directory).as_posix()] = loaded["file_digest"](target)
        elif not target.is_dir() and target != manifest_path:
            loaded["fail"]("unsupported runtime entry")
    return actual
def outcome(operation):
    try:
        return ("accepted", operation())
    except SystemExit as error:
        return ("rejected", str(error))
def compare(name):
    before = outcome(original_inventory)
    after = outcome(lambda: loaded["inventory"](directory))
    assert before == after, (name, before, after)
    return {"case": name, "outcome": after[0]}
nested = directory / ".hidden" / "Unicode-知识"
nested.mkdir(parents=True)
(nested / "empty").write_bytes(b"")
(nested / "content").write_bytes(b"same size, different bytes\\x00\\xff")
(nested / "manifest.json").write_text("nested manifests are ordinary content")
(nested / "empty-directory").mkdir()
results = [compare("nested-hidden-unicode-empty-and-binary")]
link = directory / "linked-file"
link.symlink_to(nested / "content")
results.append(compare("file-link"))
link.unlink()
link.symlink_to(nested, target_is_directory=True)
results.append(compare("directory-link"))
link.unlink()
link.symlink_to(directory / "missing")
results.append(compare("dangling-link"))
link.unlink()
if hasattr(os, "mkfifo"):
    special = directory / "special"
    os.mkfifo(special)
    results.append(compare("fifo"))
    special.unlink()
print(json.dumps(results))
`, join(f.managed, "launch.py"), f.directory], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.equal(results[0].outcome, "accepted");
  assert(results.slice(1).every(row => row.outcome === "rejected"));
});

test("verification still rejects full-content, exact-membership and link tampering", async t => {
  const cases = [
    ["changed file contents", async f => {
      const file = join(f.directory, "runtime/next-server/dist/cli.js");
      const bytes = await readFile(file);
      bytes[0] ^= 1;
      await writeFile(file, bytes);
    }, /exact dependency inventory or build mismatch/],
    ["unexpected hidden member", f => writeFile(join(f.directory, ".extra"), ""), /exact dependency inventory or build mismatch/],
    ["missing member", f => unlink(join(f.directory, "launch.json")), /exact dependency inventory or build mismatch/],
    ["file symlink", async f => {
      const file = join(f.directory, "runtime/next-server/dist/cli.js");
      await unlink(file);
      await symlink(join(f.managed, "launch.py"), file);
    }, /linked runtime entry/],
    ["directory symlink", f => symlink(join(f.directory, "runtime/next-server"), join(f.directory, "linked"), "dir"),
      /linked runtime entry/],
    ["manifest symlink", async f => {
      const path = join(f.directory, "manifest.json"), bytes = await readFile(path);
      await writeFile(join(f.root, "external-manifest.json"), bytes);
      await unlink(path);
      await symlink(join(f.root, "external-manifest.json"), path);
    }, /linked manifest/],
    ["launcher contents", async f => {
      await writeFile(join(f.managed, "launch.py"), Buffer.concat([launcher, Buffer.from("\n")]));
    }, /launcher integrity mismatch/],
    ["pinned executable contents", f => writeFile(f.node, "# changed interpreter\n"), /node interpreter changed/],
    ["manifest build digest", async f => {
      const path = join(f.directory, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.runtimeBuild = "0".repeat(64);
      await writeFile(path, JSON.stringify(manifest));
    }, /exact dependency inventory or build mismatch/],
  ];
  for (const [name, tamper, expected] of cases) {
    await t.test(name, async subtest => {
      const f = await fixture(subtest);
      await tamper(f);
      const child = f.run("compact", ["--verify-generation", f.generation]);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, expected);
      assert.equal(child.stdout, "");
    });
  }
});
