import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const note = "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000001\nrevision: 2\ntitle: Evidence\n---\nIndexed Evidence body.\n";
const skill = "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000002\nrevision: 2\nname: Evidence Skill\n---\nIndexed Evidence Skill body.\n";
const script = "print('Evidence from the imported Script')\n";
const original = await readFile(join(repository, "src/mcp/mcp.ts"), "utf8");
const contracts = JSON.parse(execFileSync(python, ["-c", `
import ast,asyncio,json,sys
from typing import Optional,List
from fastmcp import FastMCP
source=sys.stdin.read()
start=source.index("def get_knowledge(")
def function(name):
 start=source.index("def "+name+"(")
 end=source.find("\\n\\ndef ",start+1)
 feature=source.find("\\n\\n@_feature_tool",start+1)
 end=min(value for value in (end,feature,len(source)) if value>start)
 return ast.parse(source[start:end]).body[0]
names=["get_knowledge","get_script","search_knowledge","search_scripts","retrieval_status"]
tools={}
for name in names:
 node=function(name);node.decorator_list=[]
 namespace=dict(globals())
 exec(compile(ast.Module(body=[node],type_ignores=[]),"<original-mcp-function>","exec"),namespace)
 tools[name]=namespace[name]
async def main():
 mcp=FastMCP("original-contract-oracle")
 for name,function in tools.items(): mcp.tool(annotations={"readOnlyHint":True})(function)
 print(json.dumps({tool.name:tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}))
asyncio.run(main())
`], { input: original, encoding: "utf8" }));

for (const profile of ["compact", "legacy"])
test(`actual original import exposes indexed get/search/scripts through ${profile} MCP, native Board freshness, restart and relocated restore`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.indexed-mcp-${randomUUID()}`);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const source = join(parent, "source"), target = join(parent, "target"), relocated = join(parent, "relocated");
    const subscriptionRoot = join(parent, "subscription-source");
    await mkdir(join(source, "notes/Board.assets"), { recursive: true, mode: 0o700 });
    await mkdir(join(source, "skills"), { recursive: true });
    await mkdir(join(source, "scripts/Tools"), { recursive: true });
    await writeFile(join(source, "notes/Evidence.md"), note);
    await writeFile(join(source, "skills/Evidence.md"), skill);
    await writeFile(join(source, "notes/Board.md"), "---\ntitle: Board\ndocumentKind: todo-board\n---\nDescriptor only.\n");
    await writeFile(join(source, "notes/Board.assets/pkm-todo-board.json"), serializeTodoBoard([], {}));
    await writeFile(join(source, "scripts/Tools/check.py"), script);
    const remotePath = "pkm://subscriptions/fixture-remote/fixture-share/notes/Shared.md";
    await mkdir(join(subscriptionRoot, "cache/fixture-remote/fixture-share/content/notes"), { recursive: true });
    for (const [name, value] of Object.entries(subscriptionReadSourceFiles)) {
      const state = structuredClone(value);
      if (name === "subscriptions.json") state.subscriptions = [
        ...Array.from({ length: 100 }, (_, index) => ({ ...state.subscriptions[0],
          id: `000-sub-${index}`, nodeId: `000-node-${index}`, shareId: `000-share-${index}` })),
        ...state.subscriptions,
      ];
      await writeFile(join(subscriptionRoot, name), JSON.stringify(state));
    }
    await writeFile(join(subscriptionRoot, "cache/fixture-remote/fixture-share/_subscription.json"),
      JSON.stringify({ subscriptionId: "fixture-sub", nodeId: "fixture-remote", shareId: "fixture-share", syncedAt: "2026-01-02" }));
    await writeFile(join(subscriptionRoot, "cache/fixture-remote/fixture-share/content/notes/Shared.md"), "Evidence from an imported subscription.\n");
    await writeFile(join(subscriptionRoot, "cache/fixture-remote/fixture-share/content/notes/Shared.md.pkm-source.json"),
      JSON.stringify({ publisher: "Fixture publisher", revision: "source-7", upstream_uri: "pkm://notes/Shared" }));
    const deepRelative = `${Array.from({ length: 68 }, (_, index) => `d${index}`).join("/")}/Deep.md`;
    const deepCache = `cache/fixture-remote/fixture-share/content/notes/${deepRelative}`;
    const deepPath = `pkm://subscriptions/fixture-remote/fixture-share/notes/${deepRelative}`;
    await mkdir(join(subscriptionRoot, deepCache, ".."), { recursive: true });
    await writeFile(join(subscriptionRoot, deepCache), "Evidence from the complete deeply nested original cache.\n");
    const plan = await planLegacyImport(source, {}, { subscriptionRoot });
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    await importLegacyWorkspace(plan, target, { pythonExecutable: python });
    const managed = await legacyManagedFixture(parent);
    async function connect(data, write = true) {
      client = new Client({ name: "indexed-original-mcp-test", version: "1" });
      const transport = new StdioClientTransport({ command: python,
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          ...(write ? ["--allow-writes"] : []), "--managed-generation", managed],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PKM_CAPABILITY_PROFILE: profile }, stderr: "pipe" });
      let diagnostics = "";
      transport.stderr?.on("data", data => { diagnostics += data.toString(); });
      try { await client.connect(transport); } catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
    }
    async function invoke(name, args, write = false) {
      const result = await client.callTool(profile === "legacy" ? { name, arguments: args } : {
        name: write ? "capability_call" : "capability_read",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    }
    const close = async () => { await closeLegacyManagedFixture(client); client = undefined; };
    await connect(target);
    if (profile === "legacy") {
      const tools = (await client.listTools()).tools;
      for (const [name, contract] of Object.entries(contracts)) {
        const actual = tools.find(tool => tool.name === name);
        assert.deepEqual(actual.inputSchema, contract.inputSchema, name);
        assert.equal(actual.annotations.readOnlyHint, true);
      }
    }
    const workerBefore = await invoke("retrieval_status", {});
    assert.equal(workerBefore.ready, true);
    assert.equal(workerBefore.semantic_status, "off");
    process.kill(workerBefore.pid, 0);
    const found = await invoke("search_knowledge", { query: "Evidence", debug: true });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert(found.hits.some(hit => hit.content_type === "script"));
    assert(found.hits.some(hit => hit.content_type === "note"));
    assert(found.hits.some(hit => hit.content_type === "skill"));
    assert(found.hits.some(hit => hit.source_id === remotePath && hit.read_only === true));
    const remote = await invoke("get_knowledge", { id: remotePath });
    assert.equal(remote.content, "Evidence from an imported subscription.\n");
    assert.equal(remote.provenance.revision, "source-7");
    assert.equal(remote.read_only, true);
    const deep = await invoke("get_knowledge", { id: deepPath });
    assert.equal(deep.content, "Evidence from the complete deeply nested original cache.\n");
    assert.equal(deep.read_only, true);
    const sourceId = found.hits.find(hit => hit.content_type === "script").source_id;
    assert.equal((await invoke("get_script", { id: sourceId })).content, script);
    const forged = await client.callTool(profile === "legacy"
      ? { name: "get_knowledge", arguments: { id: sourceId, actorId: "other:actor" } }
      : { name: "capability_read", arguments: { operation: "mcp.tool.get_knowledge", version: 1,
        arguments: { id: sourceId, actorId: "other:actor" } } });
    assert.equal(forged.isError, true);
    assert.equal((await invoke("get_knowledge", { id: "knowledge_000000000000000000000001" })).content, "Indexed Evidence body.\n");
    assert.equal((await invoke("get_note", { id: "pkm://knowledge/knowledge_000000000000000000000001" })).content, "Indexed Evidence body.\n");
    assert.equal((await invoke("search_scripts", { query: "Evidence", detail: "standard" })).hits.length, 1);
    assert.equal((await invoke("search_notes", { query: "Evidence", detail: "standard" })).hits[0].content_type, "note");
    const before = await invoke("get_knowledge", { id: "pkm://notes/Board" });
    assert(before.content.includes("Board digest:"));
    const current = await invoke("note_work_items", { slug: "Board" });
    await invoke("note_work_item_upsert", { slug: "Board", expected_digest: current.digest, item: {
      id: "new-item", title: "Evidence task", goal: "Keep one authoritative Board", scope: "Migration",
      acceptance: ["Fresh digest"], kind: "Task", state: "Planning", evidence: [],
    } }, true);
    const after = await invoke("get_knowledge", { id: "pkm://notes/Board" });
    assert.notEqual(after.source_revision, before.source_revision);
    assert.notEqual(after.content, before.content);
    assert(after.ready_generation > before.ready_generation);
    const workerAfter = await invoke("retrieval_status", {});
    assert.equal(workerAfter.pid, workerBefore.pid);
    assert.equal(workerAfter.ready_generation, after.ready_generation);
    await close();
    await connect(target, false);
    const workerRestarted = await invoke("retrieval_status", {});
    assert.notEqual(workerRestarted.pid, workerBefore.pid);
    assert.equal(workerRestarted.corpus_revision, workerAfter.corpus_revision);
    assert.equal((await invoke("get_knowledge", { id: "pkm://notes/Board" })).source_revision, after.source_revision);
    assert.equal((await invoke("get_script", { id: sourceId })).content, script);
    assert.equal((await invoke("get_knowledge", { id: remotePath })).source_revision, remote.source_revision);
    assert.equal((await invoke("get_knowledge", { id: deepPath })).source_revision, deep.source_revision);
    await close();
    const storage = await Storage.open(target);
    try { await createWorkspaceBackup(storage, join(parent, "backup"), {
      acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    }); } finally { await storage.close(); }
    await restoreWorkspaceBackup(join(parent, "backup"), relocated, { nativeRestoreAuthority, pythonExecutable: python });
    await connect(relocated, false);
    const workerRelocated = await invoke("retrieval_status", {});
    assert.notEqual(workerRelocated.pid, workerRestarted.pid);
    assert.equal(workerRelocated.corpus_revision, workerAfter.corpus_revision);
    const restored = await invoke("get_knowledge", { id: "pkm://notes/Board" });
    assert.equal(restored.source_revision, after.source_revision);
    assert(restored.ready_generation > after.ready_generation);
    assert.equal((await invoke("get_script", { id: sourceId })).content, script);
    const restoredRemote = await invoke("get_knowledge", { id: remotePath });
    assert.equal(restoredRemote.content, remote.content);
    assert.equal(restoredRemote.source_revision, remote.source_revision);
    assert.equal(restoredRemote.read_only, true);
    const restoredDeep = await invoke("get_knowledge", { id: deepPath });
    assert.equal(restoredDeep.content, deep.content);
    assert.equal(restoredDeep.source_revision, deep.source_revision);
    assert.equal(restoredDeep.read_only, true);
    const restoredCache = join(relocated, "subscriptions/cache/fixture-remote/fixture-share/content/notes/Shared.md");
    await writeFile(restoredCache, "Do not grant substituted imported-cache authority.\n");
    const tampered = await client.callTool(profile === "legacy"
      ? { name: "get_knowledge", arguments: { id: remotePath } }
      : { name: "capability_read", arguments: { operation: "mcp.tool.get_knowledge", version: 1, arguments: { id: remotePath } } });
    assert.equal(tampered.isError, true);
    assert.match(JSON.stringify(tampered), /receipt|changed|cache/i);
    await writeFile(restoredCache, remote.content);
    await close();
    assert.equal(await readFile(join(source, "notes/Evidence.md"), "utf8"), note);
    assert.equal(await readFile(join(source, "skills/Evidence.md"), "utf8"), skill);
    assert.equal(await readFile(join(source, "scripts/Tools/check.py"), "utf8"), script);
    assert.equal(await readFile(join(subscriptionRoot, "cache/fixture-remote/fixture-share/content/notes/Shared.md"), "utf8"),
      "Evidence from an imported subscription.\n");
    assert.equal(await readFile(join(subscriptionRoot, deepCache), "utf8"), deep.content);
  });
