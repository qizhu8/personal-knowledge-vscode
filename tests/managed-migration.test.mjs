import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize } from "../dist/storage.js";
import { isolatedManagedLaunch, publishIsolatedManagedGeneration, stageIsolatedManagedGeneration,
  verifyIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "legacy");
const require = createRequire(join(repositoryRoot, "package.json"));
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = join(packageRoot, `.managed-migration-${randomUUID()}`);
  await mkdir(root);
  const data = await initialize(join(root, "data")), managedRoot = join(root, "managed");
  await writeFile(join(data, "notes", "Example.md"), "---\ntitle: Frozen Note\n---\nBody\n");
  await mkdir(join(data, "papers"));
  await writeFile(join(data, "papers", "Paper.md"), "---\ntitle: Frozen Research\n---\nResearch body\n");
  const output = join(root, "connector.cjs");
  require("esbuild").buildSync({ entryPoints: [join(repositoryRoot, "src/chat/api-chat-mcp.ts")],
    outfile: output, bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
  const Module = require("node:module"), load = Module._load;
  let connect;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? {} : load.call(this, id, ...args); };
    connect = require(output).connectManagedChatMcp;
  } finally { Module._load = load; }
  const connections = [];
  t.after(async () => {
    await rm(join(root, "hold-note"), { force: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    try { for (const connection of connections) await connection.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, data, managedRoot,
    stage: (options = {}) => stageIsolatedManagedGeneration({ managedRoot, data, ...options }),
    async connect(options) {
      const connection = await connect(await isolatedManagedLaunch(managedRoot), new AbortController().signal, managedRoot, options);
      connections.push(connection); return connection;
    },
  };
}

const invoke = async (connection, name, input = {}, signal = new AbortController().signal) => {
  const result = JSON.parse(await connection.invoke(`mcp_pkm_${name}`, input, signal));
  return result.structuredContent ?? JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
};

async function waitFor(observe, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${description}`);
}

test("isolated provisioning refuses production-like roots and overlapping workspace/runtime authority without modifying them", async t => {
  const f = await fixture(t);
  await mkdir(f.managedRoot);
  const baseline = '{"schema":"pkm.mcp.lifecycle/v1","generation":"production-do-not-touch"}\n';
  await writeFile(join(f.managedRoot, "active-generation.json"), baseline);
  await assert.rejects(f.stage(), /nonempty or production managed root/);
  assert.deepEqual(await readdir(f.managedRoot), ["active-generation.json"]);
  assert.equal(await readFile(join(f.managedRoot, "active-generation.json"), "utf8"), baseline);
  await assert.rejects(stageIsolatedManagedGeneration({ managedRoot: join(f.data, "runtime"), data: f.data }), /separate/);
  assert(!((await readdir(f.data)).includes("runtime")));
});

test("frozen isolated generations handshake, update, explicitly reconnect, rollback and reject partial publication", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const source = join(packageRoot, "compat", "legacy-compact-mcp.py");
  const original = sha(await readFile(source));
  const first = await f.stage();
  await mkdir(join(f.managedRoot, "latest-generation.json"));
  await assert.rejects(publishIsolatedManagedGeneration(f.managedRoot, first.generation), /EISDIR|ENOTEMPTY/);
  await assert.rejects(readFile(join(f.managedRoot, "active-generation.json")), /ENOENT/,
    "Failed first publication must not expose an active compatibility baseline");
  await rm(join(f.managedRoot, "latest-generation.json"), { recursive: true });
  await publishIsolatedManagedGeneration(f.managedRoot, first.generation);
  const old = await f.connect();
  assert.equal(old.generation, first.generation);
  assert.equal((await invoke(old, "get_note", { id: "Example" })).title, "Frozen Note");
  assert.equal((await invoke(old, "get_research", { slug: "Paper" })).title, "Frozen Research");
  const second = await f.stage();
  assert.equal(second.runtimeBuild, first.runtimeBuild, "Generation identity must not change unchanged runtime bytes");
  await publishIsolatedManagedGeneration(f.managedRoot, second.generation);
  const status = await invoke(old, "mcp_lifecycle_status");
  assert.equal(status.generation, first.generation);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.acceptingNewCalls, true);
  assert.equal((await invoke(old, "list_notes", { limit: 0 })).notes.length, 1);
  const latestPath = join(f.managedRoot, "latest-generation.json");
  const validPointer = await readFile(latestPath);
  await writeFile(latestPath, "{broken-control");
  await assert.rejects(old.close(), /action-required|unverified|unknown/i,
    "Missing generation control cannot become a successful zero-in-flight drain receipt");
  await writeFile(latestPath, validPointer);
  await old.close();
  await assert.rejects(invoke(old, "list_notes"), /closing|reconnect/i);
  const successor = await f.connect();
  assert.equal(successor.generation, second.generation);
  await publishIsolatedManagedGeneration(f.managedRoot, first.generation);
  assert.equal((await invoke(successor, "mcp_lifecycle_status")).updateAvailable, true);
  await successor.close();
  const rollback = await f.connect();
  assert.equal(rollback.generation, first.generation);
  await rollback.close();
  const pointer = await readFile(join(f.managedRoot, "latest-generation.json"), "utf8");
  const directory = join(f.managedRoot, "generations", second.generation);
  const dependency = join(directory, "runtime", "site-packages", "fastmcp", "__init__.py");
  const bytes = await readFile(dependency);
  await writeFile(dependency, Buffer.concat([bytes, Buffer.from("\n# tamper\n")]));
  await assert.rejects(publishIsolatedManagedGeneration(f.managedRoot, second.generation), /inventory|build mismatch/);
  assert.equal(await readFile(join(f.managedRoot, "latest-generation.json"), "utf8"), pointer);
  await writeFile(dependency, bytes);
  const extra = join(directory, "runtime", "unlisted.py");
  await writeFile(extra, "raise RuntimeError('must never import')");
  await assert.rejects(verifyIsolatedManagedGeneration(f.managedRoot, second.generation), /inventory|build mismatch/);
  await rm(extra);
  const manifestPath = join(directory, "manifest.json"), manifestBytes = await readFile(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...second, enabledFeatureDomains: ["knowledge"] }));
  await assert.rejects(publishIsolatedManagedGeneration(f.managedRoot, second.generation), /experimental claims/);
  await writeFile(manifestPath, manifestBytes);
  const launcherPath = join(f.managedRoot, "launch.py"), launcherBytes = await readFile(launcherPath);
  await writeFile(launcherPath, Buffer.concat([launcherBytes, Buffer.from("\nraise SystemExit('untrusted')\n")]));
  await assert.rejects(verifyIsolatedManagedGeneration(f.managedRoot, first.generation), /launcher integrity/);
  await writeFile(launcherPath, launcherBytes);
  await assert.rejects(publishIsolatedManagedGeneration(f.managedRoot, randomUUID()), /ENOENT/);
  await writeFile(join(f.managedRoot, ".migration-publication-lock"), "owned");
  await assert.rejects(publishIsolatedManagedGeneration(f.managedRoot, second.generation), /busy/);
  await rm(join(f.managedRoot, ".migration-publication-lock"));
  assert.equal(await readFile(join(f.managedRoot, "latest-generation.json"), "utf8"), pointer);
  assert.equal(sha(await readFile(source)), original);
  const instances = await readdir(join(f.managedRoot, "instances"));
  for (const name of instances.filter(name => name.endsWith(".json"))) {
    const record = JSON.parse(await readFile(join(f.managedRoot, "instances", name), "utf8"));
    assert.equal(record.acceptingNewCalls, false);
    assert.equal(record.inFlight, 0);
    assert.equal(record.uncertainCalls, 0);
  }
});

test("an uncertain actual Note write completes once after cancellation and is never replayed on reconnect", { timeout: 90_000 }, async t => {
  const f = await fixture(t), generation = await f.stage({ allowWrites: true });
  const directory = join(f.managedRoot, "generations", generation.generation);
  const gate = join(f.root, "hold-note"), entered = join(f.root, "write-entered");
  await writeFile(gate, "hold");
  const name = "runtime/next-server/compat/legacy-compact-mcp.py", filename = join(directory, name);
  const source = await readFile(filename, "utf8");
  const admission = "            async def invoke(**arguments):";
  assert(source.includes(admission), "Actual captured Knowledge tool adapter must be present");
  await writeFile(filename, source.replace(admission, `${admission}
                if name == "add_note":
                    gate = Path(${JSON.stringify(gate)})
                    Path(${JSON.stringify(entered)}).write_text("entered")
                    while gate.exists():
                        await asyncio.sleep(0.025)`));
  generation.files[name] = sha(await readFile(filename));
  generation.runtimeBuild = sha(Object.keys(generation.files).sort().map(key => `${key}\0${generation.files[key]}\0`).join(""));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(generation));
  await publishIsolatedManagedGeneration(f.managedRoot, generation.generation);
  const connection = await f.connect({ drainTimeoutMs: 3_000 });
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_add_note"));
  const controller = new AbortController();
  const pending = invoke(connection, "add_note", { title: "Uncertain", content: "Committed once despite disconnected caller" }, controller.signal);
  const rejection = assert.rejects(pending, /may already have occurred|cancel/i);
  await waitFor(async () => { try { await readFile(entered); return true; } catch { return false; } }, "actual Note write admission");
  controller.abort();
  await rejection;
  await waitFor(async () => (await invoke(connection, "mcp_lifecycle_status")).uncertainCalls === 1, "uncertain write retained");
  await assert.rejects(connection.close(), /action-required|uncertain/i);
  await assert.rejects(readFile(join(f.data, "notes", "Uncertain.md")), /ENOENT/);
  await rm(gate);
  await waitFor(async () => {
    try { return (await readFile(join(f.data, "notes", "Uncertain.md"), "utf8")).includes("Committed once"); }
    catch { return false; }
  }, "actual native write commits after cancellation");
  const committedBytes = await readFile(join(f.data, "notes", "Uncertain.md"));
  await new Promise(resolve => setTimeout(resolve, 100));
  await connection.close();
  const successor = await f.connect();
  assert.equal((await invoke(successor, "get_note", { id: "Uncertain" })).content, "Committed once despite disconnected caller");
  await successor.close();
  assert.deepEqual(await readFile(join(f.data, "notes", "Uncertain.md")), committedBytes,
    "Reconnect must not replay the cancelled write or change its native receipt/revision");
  assert.equal((await readdir(join(f.data, "notes"))).filter(name => name === "Uncertain.md").length, 1);
});

test("actual Note subprocess cancellation retains uncertain admitted work until drain, without replay or termination", { timeout: 90_000 }, async t => {
  const f = await fixture(t), generation = await f.stage();
  const directory = join(f.managedRoot, "generations", generation.generation);
  const gate = join(f.root, "hold-note"), entered = join(f.root, "note-entered");
  await writeFile(gate, "hold");
  t.after(() => rm(gate, { force: true }));
  // Only the copied fixture adapter is instrumented; the real Note read and all
  // lifecycle/admission/transport code remain the actual shipped implementations.
  const name = "runtime/resources/note_inventory.py", filename = join(directory, name);
  await writeFile(filename, `${await readFile(filename, "utf8")}
_fixture_original_inventory = note_inventory_page
def note_inventory_page(*args, **kwargs):
    import time
    gate = Path(${JSON.stringify(gate)})
    Path(${JSON.stringify(entered)}).write_text("entered")
    while gate.exists():
        time.sleep(0.025)
    return _fixture_original_inventory(*args, **kwargs)
`);
  generation.files[name] = sha(await readFile(filename));
  generation.runtimeBuild = sha(Object.keys(generation.files).sort().map(key => `${key}\0${generation.files[key]}\0`).join(""));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(generation));
  await publishIsolatedManagedGeneration(f.managedRoot, generation.generation);
  const connection = await f.connect({ drainTimeoutMs: 3_000 });
  const controller = new AbortController();
  const pending = invoke(connection, "list_notes", { limit: 0 }, controller.signal);
  // Install rejection handling before cancellation to avoid an unhandled promise.
  const rejection = assert.rejects(pending, /may already have occurred|cancel/i);
  await waitFor(async () => { try { await readFile(entered); return true; } catch { return false; } }, "real Note worker admission");
  const active = await invoke(connection, "mcp_lifecycle_status");
  assert.equal(active.inFlight, 1);
  controller.abort();
  await rejection;
  await waitFor(async () => (await invoke(connection, "mcp_lifecycle_status")).uncertainCalls === 1, "uncertain cancellation boundary");
  await assert.rejects(connection.close(), /action-required|uncertain/i);
  const records = async () => Promise.all((await readdir(join(f.managedRoot, "instances")))
    .filter(name => name.endsWith(".json")).map(async name => JSON.parse(await readFile(join(f.managedRoot, "instances", name), "utf8"))));
  const blocked = (await records()).find(record => record.generation === generation.generation);
  assert.equal(blocked.inFlight, 1);
  assert.equal(blocked.uncertainCalls, 1);
  assert.equal(blocked.acceptingNewCalls, false);
  assert.equal(blocked.automaticReplay, false);
  assert.equal(blocked.automaticTermination, false);
  process.kill(blocked.pid, 0);
  await rm(gate);
  await waitFor(async () => (await records()).some(record => record.generation === generation.generation
    && record.inFlight === 0 && record.uncertainCalls === 0), "actual Note completion");
  await connection.close();
  assert.equal(await readFile(entered, "utf8"), "entered");
});
