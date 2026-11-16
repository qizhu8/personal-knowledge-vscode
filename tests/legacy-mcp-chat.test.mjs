import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initialize } from "../dist/storage.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "legacy");
const require = createRequire(join(repositoryRoot, "package.json"));

test("experimental managed startup rejects production claims before publishing an instance", async t => {
  const parent = join(packageRoot, `.pkm-legacy-chat-manifest-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace"));
  for (const change of [{ version: "1.0.0" }, { enabledFeatureDomains: ["knowledge"] },
    { components: { knowledge: "1.0.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" } }]) {
    const managedRoot = join(parent, randomUUID()), generation = randomUUID();
    const directory = join(managedRoot, "generations", generation);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      schema: "pkm.mcp.lifecycle/v1", managedRoot, generation, version: "0.1.0",
      components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
      enabledFeatureDomains: [], ...change,
    }));
    const result = spawnSync("python3", [join(packageRoot, "compat/legacy-compact-mcp.py"),
      "--data", data, "--node", process.execPath, "--managed-generation", directory], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /cannot claim production versions or complete feature domains/);
    assert.deepEqual(await readdir(managedRoot), ["generations"]);
    assert.deepEqual((await readdir(data)).sort(), [".pkm-next-workspace", "notes"]);
  }
});

test("existing Chat MCP connector handshakes, reads and drains the isolated compatibility process", { timeout: 60_000 }, async t => {
  const parent = join(packageRoot, `.pkm-legacy-chat-mcp-${randomUUID()}`);
  await mkdir(parent);
  let connection;
  t.after(async () => { try { await connection?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const data = join(parent, "workspace");
  await initialize(data);
  await writeFile(join(data, "notes", "Example.md"), "---\ntitle: Chat migration\n---\nBody\n");
  await mkdir(join(data, "papers"));
  await writeFile(join(data, "papers", "Example.md"), "---\ntitle: Research migration\nyear: 2025\n---\nResearch body\n");
  const compiled = join(parent, "chat-mcp.cjs");
  require("esbuild").buildSync({
    entryPoints: [join(repositoryRoot, "src/chat/api-chat-mcp.ts")],
    outfile: compiled, bundle: true, platform: "node", format: "cjs", external: ["vscode"],
    logLevel: "silent",
  });
  const Module = require("node:module");
  const originalLoad = Module._load;
  let connectManagedChatMcp;
  try {
    Module._load = function (name, ...args) {
      return name === "vscode" ? {} : originalLoad.call(this, name, ...args);
    };
    ({ connectManagedChatMcp } = require(compiled));
  } finally { Module._load = originalLoad; }
  const managed = join(parent, "managed");
  const generation = randomUUID();
  const generationDirectory = join(managed, "generations", generation);
  await mkdir(generationDirectory, { recursive: true });
  const files = {};
  for (const file of ["compat/legacy-compact-mcp.py", "compat/legacy-note-inventory.py", "dist/cli.js"]) {
    files[file] = createHash("sha256").update(await readFile(join(packageRoot, file))).digest("hex");
  }
  const manifest = {
    schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: managed, version: "0.1.0",
    extensionVersion: "0.1.0", runtimeBuild: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    node: process.execPath, enabledFeatureDomains: [], files,
  };
  await writeFile(join(generationDirectory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(managed, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation }));
  connection = await connectManagedChatMcp({
    command: "python3",
    args: [join(packageRoot, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
      "--managed-generation", generationDirectory],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    cwd: packageRoot,
  }, new AbortController().signal, managed);
  assert.equal(connection.generation, generation);
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_list_notes"));
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_get_board"));
  assert(!connection.catalog.some(tool => tool.name === "mcp_pkm_add_workitem"));
  const toolResult = JSON.parse(await connection.invoke("mcp_pkm_list_notes", { limit: 0 }, new AbortController().signal));
  const result = toolResult.structuredContent;
  assert.equal(result.schema, "pkm.note-inventory/v1");
  assert.equal(result.notes[0].title, "Chat migration");
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_get_note"));
  assert(connection.catalog.some(tool => tool.name === "mcp_pkm_list_research"));
  assert(!connection.catalog.some(tool => tool.name === "mcp_pkm_paper_graph"));
  const noteResult = JSON.parse(await connection.invoke("mcp_pkm_get_note", { id: "Example" }, new AbortController().signal));
  const note = noteResult.structuredContent ?? JSON.parse(noteResult.content[0].text);
  assert.equal(note.title, "Chat migration");
  assert.equal(note.content, "Body\n");
  const researchResult = JSON.parse(await connection.invoke("mcp_pkm_get_research", { slug: "Example" }, new AbortController().signal));
  const research = researchResult.structuredContent ?? JSON.parse(researchResult.content[0].text);
  assert.equal(research.title, "Research migration");
  assert.equal(research.content, "Research body\n");
  const discovered = JSON.parse(await connection.invoke("mcp_pkm_capabilities_describe",
    { operation: "mcp.tool.get_research" }, new AbortController().signal));
  assert.equal(discovered.structuredContent.readOnly, true);
  const statusResult = JSON.parse(await connection.invoke("mcp_pkm_mcp_lifecycle_status", {}, new AbortController().signal));
  assert.equal(statusResult.structuredContent.acceptingNewCalls, true);
  assert.equal(statusResult.structuredContent.generation, generation);
  assert.equal(statusResult.structuredContent.inFlight, 0);
  await connection.close();
  await assert.rejects(connection.invoke("mcp_pkm_list_notes", {}, new AbortController().signal), /closing|reconnect/i);
  await assert.rejects(readdir(join(managed, "instances")), { code: "ENOENT" });
});
