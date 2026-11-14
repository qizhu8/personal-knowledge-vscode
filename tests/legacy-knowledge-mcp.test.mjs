import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize } from "../dist/storage.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { projectRecipeSchema } from "../dist/project-recipes-contracts.js";
import { safeRecipeFileName } from "../dist/domain/project-recipes-storage-rules.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const names = ["list_papers", "list_research", "get_research", "get_paper", "paper_graph", "get_note", "list_skills",
  "get_skill", "search_notes", "search_skills", "search_research", "search_papers", "list_subscriptions",
  "search_subscribed_content", "get_subscribed_content", "get_subscribed_content_by_path",
  "add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper", "skill_capabilities", "skill_context",
  "note_work_items", "note_work_item_notes"];
const helperNames = ["_parse", "_name_of", "_cat_of", "_walk", "_mtime", "_arr", "_year", "_norm_cites",
  "_paper", "_all_papers", "_paper_get", "_paper_resolver", "_citation_counts", "_knowledge_read_key", "_canonical_knowledge_id",
  "_mcp_system_path", "_note", "_all_notes", "_note_get", "_note_hash", "_skill_priority", "_skill",
  "_skill_image_assets", "_all_skills", "_skill_id", "_skill_by_id", "_skill_hash", "_skill_linkage",
  "_skill_source_key", "_skill_source_rank", "_index", "_search_typed_knowledge", "_search_papers_legacy",
  "_router_config", "_router_source_priority", "_enabled_router_solutions", "_disabled_router_response",
  "_skill_terms", "_subscription_records"];
const originalSource = await readFile(join(repository, "src/mcp/mcp.ts"), "utf8");
const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\s+fs\.writeFileSync\(reqTxt/.exec(originalSource);
assert(match);
const originalPython = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION",
  "RECIPE_MCP_VERSION", "AGENT_SESSION_MCP_VERSION", "storeFwd", "subscriptionCacheFwd",
  "retrievalStateFwd", "environmentsRegistryFwd", "context", `return \`${match[1]}\`;`)(
  "fixture", "fixture", "fixture", "fixture", "fixture", "/unused", "/unused", "/unused", "/unused",
  { extensionPath: repository },
);
const oracleScript = `
import ast, asyncio, inspect, json, datetime, hashlib, re, sys, urllib.parse, mimetypes, sqlite3, time, uuid
from pathlib import Path
from typing import Any, Optional, List
from fastmcp import FastMCP
request = json.load(sys.stdin)
mcp = FastMCP("original-knowledge")
namespace = dict(globals(), STORE=Path(request["root"]), PAPERS=Path(request["root"]) / "papers",
    NOTES=Path(request["root"]) / "notes", SKILLS=Path(request["root"]) / "skills",
    SUBSCRIPTIONS=Path(request["root"]) / "subscriptions" / "cache",
    RETRIEVAL_STATE=Path(request["root"]) / "retrieval",
    _FEATURE_DOMAINS={"knowledge", "skillRouter"}, _project_recipes=lambda _store: request["recipes"],
    search_knowledge=lambda *args, **kwargs: '{"ok":false}',
    _retrieval_request=lambda *args, **kwargs: {"ok":False},
    _collect_search_invocation=lambda *args, **kwargs: None, _collector_post=lambda *args, **kwargs: None)
recipes_tree = ast.parse(request["recipeSource"])
exec(compile(ast.Module(body=[node for node in recipes_tree.body if isinstance(node, ast.FunctionDef)
    and node.name in {"related_recipes", "_recipe_summary"}], type_ignores=[]), "<original-recipe-runtime>", "exec"), namespace)
tree = ast.parse(request["source"])
selected = set(request["functions"] + ["_feature_tool"])
body = [node for node in tree.body if (isinstance(node, ast.FunctionDef) and node.name in selected)
    or (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_SKILL_STOP_WORDS" for target in node.targets))]
exec(compile(ast.Module(body=body, type_ignores=[]), "<original-generated-mcp>", "exec"), namespace)
native_tree = ast.parse(request["nativeSource"])
native_body = [node for node in ast.walk(native_tree) if isinstance(node, ast.FunctionDef)
    and node.name in {"note_work_items", "note_work_item_notes"}]
exec(compile(ast.Module(body=native_body, type_ignores=[]), "<original-native-mcp>", "exec"), namespace)
async def main():
    tools = {tool.name: tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}
    values = []
    raw_values = []
    for call in request["calls"]:
        value = namespace[call["tool"]](**call["arguments"])
        raw_values.append(value)
        try: value = json.loads(value)
        except json.JSONDecodeError: pass
        values.append(value)
    print(json.dumps({"tools":tools,"values":values,"rawValues":raw_values}, ensure_ascii=False))
asyncio.run(main())
`;

function normalized(value) {
  if (value && !Array.isArray(value) && typeof value.interaction_id === "string")
    return { ...value, interaction_id: "<generated interaction UUID>" };
  if (value && !Array.isArray(value) && Array.isArray(value.nodes)) return {
    ...value, nodes: [...value.nodes].sort((a, b) => a.key.localeCompare(b.key)),
  };
  return value;
}

test("captured original Knowledge executors remain source matched", () => {
  execFileSync(process.execPath, [join(root, "scripts/capture-legacy-knowledge-mcp.mjs"), "--check"]);
});

for (const change of ["content", "membership", "lease"]) {
  test(`captured Knowledge refuses a stale result after ${change} changes`, async t => {
    const parent = await mkdtemp(join(tmpdir(), "pkm-knowledge-race-"));
    let client, server;
    t.after(async () => {
      try { await client?.close(); await server?.close(); }
      finally { await rm(parent, { recursive: true, force: true }); }
    });
    const data = await initialize(join(parent, "workspace"));
    await mkdir(join(data, "papers"));
    await writeFile(join(data, "papers", "Example.md"), "---\ntitle: Before\n---\nBefore\n");
    let checks = 0;
    const storage = {
      workspaceRoot: () => data,
      withWorkspaceExclusive: work => work(),
      assertWorkspaceLease() {
        if (++checks !== 2) return;
        if (change === "lease") throw new Error("STORAGE_UNAVAILABLE: Test workspace lease was fenced.");
        writeFileSync(join(data, "papers", change === "content" ? "Example.md" : "Added.md"),
          "---\ntitle: After\n---\nAfter\n");
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startLegacyNoteMcp(storage, serverTransport, {
      core: {}, actor: { id: "mcp:external", canRead: true, canWrite: false },
    });
    client = new Client({ name: "knowledge-read-race", version: "1.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "legacy_knowledge_read",
      arguments: { tool: "get_research", arguments: { slug: "Example" } } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, change === "lease" ? /lease was fenced/ : /CONFLICT: Knowledge changed/);
    assert.equal(checks, 2);
  });
}

for (const kind of ["image", "subscription"]) test(`captured Knowledge pins ${kind} resource membership`, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-knowledge-resource-race-"));
  let client, server;
  t.after(async () => { try { await client?.close(); await server?.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const data = await initialize(join(parent, "workspace"));
  await mkdir(join(data, "skills", "Example.assets"), { recursive: true });
  await writeFile(join(data, "skills", "Example.md"), "---\nname: Example\n---\nBody\n");
  const cache = join(data, "subscriptions", "cache", "node_fixture", "share_fixture");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "_subscription.json"), JSON.stringify({ nodeId: "node_fixture", shareId: "share_fixture" }));
  if (kind === "subscription") {
    await mkdir(join(data, "papers"));
    await symlink(join(parent, "outside.md"), join(data, "papers", "unsafe.md"));
  }
  let checks = 0;
  const storage = {
    workspaceRoot: () => data, withWorkspaceExclusive: work => work(),
    assertWorkspaceLease() {
      if (++checks === 2) writeFileSync(kind === "image" ? join(data, "skills", "Example.assets", "added.png")
        : join(cache, "added.txt"), "new membership");
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = await startLegacyNoteMcp(storage, serverTransport, {
    core: {}, actor: { id: "mcp:external", canRead: true, canWrite: false },
  });
  client = new Client({ name: "knowledge-resource-race", version: "1.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "legacy_knowledge_read", arguments: {
    tool: kind === "image" ? "get_skill" : "list_subscriptions",
    arguments: kind === "image" ? { id: "Example" } : {},
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONFLICT: Knowledge changed/);
});

for (const profile of ["compact", "legacy"]) for (const writable of [false, true]) {
  test(`original Knowledge MCP contracts and results survive ${profile}/${writable ? "write" : "read-only"} transport`,
    { timeout: 60_000 }, async t => {
      const parent = await mkdtemp(join(tmpdir(), "pkm-legacy-knowledge-"));
      let client;
      t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
      const data = await initialize(join(parent, "workspace"));
      await mkdir(join(data, "notes", "System"), { recursive: true });
      await mkdir(join(data, "skills", "Coding"), { recursive: true });
      await mkdir(join(data, "skills", "System"), { recursive: true });
      await writeFile(join(data, "notes", "Example.md"), "---\ntitle: Note title\ntags: [\"native\"]\n---\nNote body\n");
      await writeFile(join(data, "notes", "System", "Rules.md"), "---\ntitle: Rules\n---\nSystem body\n");
      await writeFile(join(data, "notes", "Board.md"), "---\ntitle: Tasks\ndocumentKind: todo-board\n---\nNot task authority\n");
      await writeFile(join(data, "notes", "Resource.md"), "---\ntitle: Resource Board\n---\nNot task authority\n");
      await mkdir(join(data, "notes", "Resource.assets"));
      await writeFile(join(data, "notes", "Resource.assets", "pkm-todo-board.json"), "{}");
      await writeFile(join(data, "skills", "Coding", "Verify.md"),
        "---\nname: Verify\ndescription: Check work\npriority: highest\ntags: [\"tests\"]\n---\nRun tests.\n");
      await writeFile(join(data, "skills", "System", "Observe.md"), "---\nname: Observe\n---\nSystem Skill.\n");
      await mkdir(join(data, "skills", "Coding", "Verify.assets", "nested"), { recursive: true });
      await writeFile(join(data, "skills", "Coding", "Verify.assets", "nested", "a [b].png"), Buffer.from([0, 1, 2, 255]));
      const cache = join(data, "subscriptions", "cache", "node_fixture", "share_fixture");
      await mkdir(join(cache, "content", "skills"), { recursive: true });
      await mkdir(join(cache, "content", "notes"), { recursive: true });
      await writeFile(join(cache, "_subscription.json"), JSON.stringify({
        subscriptionId: "subscription_fixture", alias: "Fixture", publisher: "Publisher", priority: "highest",
        nodeId: "node_fixture", shareId: "share_fixture", revision: 3, syncedAt: "2026-01-01",
      }));
      await writeFile(join(cache, "content", "skills", "Remote.md"), "---\nname: Remote\npriority: high\n---\nRemote skill 中文.\n");
      await writeFile(join(cache, "content", "notes", "Shared.txt"), "Shared text 中文.");
      await writeFile(join(cache, "content", "notes", "Shared.txt.pkm-source.json"), JSON.stringify({ publisher: "Publisher" }));
      await writeFile(join(cache, "content", "notes", "binary.dat"), Buffer.from([255, 254]));
      const definition = { schema: "pkm.workflow.definition/v1", spec: {
        inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
        outputs: {}, completion: { requiredNodes: ["work"] },
      } };
      const compiled = compileWorkflowDefinitionV1(definition);
      assert.equal(compiled.ok, true);
      const recipe = projectRecipeSchema.parse({
        schema: "pkm.knowledge/v1", knowledgeId: "knowledge_" + createHash("sha256").update("recipe_note").digest("hex").slice(0, 24),
        aliases: ["recipe:recipe_note"], recipeId: "recipe_note",
        scope: "global", name: "Note workflow", category: "", description: "Linked Note workflow",
        definition, executableDigest: compiled.executableDigest, revision: 1,
        nodeBindings: [{ nodeId: "work", bindings: [{
          bindingId: "note", kind: "note", knowledgeId: "Example", contentHash: "a".repeat(64), usage: "reference",
        }] }],
      });
      await mkdir(join(data, "recipes"));
      const recipes = [recipe, ...Array.from({ length: 100 }, (_value, index) => {
        const recipeId = `recipe_link_${index}`;
        return { ...recipe, recipeId, name: `Linked workflow ${index}`,
          knowledgeId: "knowledge_" + createHash("sha256").update(recipeId).digest("hex").slice(0, 24),
          aliases: [`recipe:${recipeId}`] };
      })];
      for (const value of recipes) {
        await writeFile(join(data, "recipes", safeRecipeFileName(value.name, value.recipeId)), JSON.stringify(value));
      }
      await mkdir(join(data, "papers", "Team"), { recursive: true });
      const fixtures = [
        ["Z", { title: "Repeated", year: 2020, topic: "Ties" }, "Created first"],
        ["A", { title: "Parent", year: "2020", topic: "ML", authors: ["One"], tags: ["graph"] }, "Parent body"],
        ["Team/B", { title: "Child", year: 2024, topic: "ML", cites: [{ key: "Parent", comment: "Uses parent" }],
          kind: "idea", group: "Ideas", pinned: true }, "Child body 中文"],
        ["C", { title: "Other", year: 2025, topic: "Systems", cites: ["Team/B.md"] }, "Other body"],
        ["D", { title: "Repeated", year: 2020, topic: "Ties" }, "Created last"],
        ["Team/E", { title: "Nested duplicate", year: 2020, topic: "Ties", cites: ["Repeated"] }, "Resolve last duplicate"],
      ];
      for (const [slug, metadata, body] of fixtures) {
        const path = join(data, "papers", `${slug}.md`);
        await writeFile(path, `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`);
        await utimes(path, 1_700_000_000, 1_700_000_000);
      }
      const calls = [
        { tool: "list_research", arguments: {} }, { tool: "list_research", arguments: { topic: "ML" } },
        { tool: "list_research", arguments: { topic: "Ties" } },
        { tool: "get_paper", arguments: { slug: "Team/B" } },
        { tool: "get_research", arguments: { id: "A" } }, { tool: "get_research", arguments: { slug: "missing" } },
        { tool: "get_research", arguments: {} }, { tool: "get_research", arguments: { id: "A", slug: "C" } },
        { tool: "get_note", arguments: { id: "Example" } },
        { tool: "get_note", arguments: { slug: "System/Rules" } },
        { tool: "get_note", arguments: { id: "Board" } }, { tool: "get_note", arguments: { id: "Resource" } },
        { tool: "get_note", arguments: { slug: "missing" } },
        { tool: "get_note", arguments: {} }, { tool: "get_note", arguments: { id: "Example", slug: "Board" } },
        { tool: "get_skill", arguments: { name: "Verify" } },
        { tool: "get_skill", arguments: { name: "Remote" } },
        { tool: "get_skill", arguments: { id: "System/Observe" } },
        { tool: "get_skill", arguments: { id: "missing" } },
        ...["body", "title", '"bad query', "", "中文"].map(query => ({ tool: "search_notes", arguments: { query } })),
        ...["tests", "Run", "Remote", ""].map(query => ({ tool: "search_skills", arguments: { query, limit: 1 } })),
        ...["Child", "ML", ""].map(query => ({ tool: "search_research", arguments: { query } })),
        { tool: "search_papers", arguments: { query: "2020", limit: 2 } },
        { tool: "skill_capabilities", arguments: {} },
        { tool: "skill_context", arguments: { task: "Verify tests", detail: "full" } },
        { tool: "skill_context", arguments: { task: "Remote" } },
        { tool: "skill_context", arguments: { task: "" } },
        { tool: "skill_context", arguments: { task: "nonmatching private quantum" } },
        ...(writable ? [{ tool: "list_papers", arguments: {} },
          { tool: "list_skills", arguments: {} }, { tool: "list_skills", arguments: { category: "Coding" } },
          { tool: "list_subscriptions", arguments: {} },
          { tool: "search_subscribed_content", arguments: { query: "中文", limit: 1 } },
          { tool: "search_subscribed_content", arguments: { query: "", content_type: "notes", alias: "fixture" } },
          { tool: "get_subscribed_content", arguments: { node_id: "node_fixture", share_id: "share_fixture", content_type: "notes", path: "Shared.txt" } },
          { tool: "get_subscribed_content_by_path", arguments: { pkm_path: "pkm://subscriptions/node_fixture/share_fixture/notes/Shared.txt" } },
          { tool: "paper_graph", arguments: { limit: 1, neighbors: true } },
          { tool: "paper_graph", arguments: { topic: "Ties", limit: 1 } },
          { tool: "paper_graph", arguments: { topic: "ML", limit: 2 } }] : []),
      ];
      const oracle = JSON.parse(execFileSync("python3", ["-c", oracleScript], {
        input: JSON.stringify({ root: data, source: originalPython, functions: [...helperNames, ...names], calls,
          recipes, recipeSource: await readFile(join(repository, "resources/recipe_runtime.py"), "utf8"),
          nativeSource: await readFile(join(repository, "resources/knowledge_mutations.py"), "utf8") }),
        encoding: "utf8",
      }));
      const transport = new StdioClientTransport({
        command: "python3", args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          ...(writable ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe",
      });
      let diagnostics = "";
      transport.stderr?.on("data", chunk => { diagnostics += chunk; });
      client = new Client({ name: "original-research-parity", version: "1.0.0" });
      try { await client.connect(transport); } catch (error) { throw new Error(diagnostics, { cause: error }); }
      const invoke = async (name, args) => client.callTool({ name, arguments: args });
      const exposed = (await client.listTools()).tools;
      for (const name of names) {
        const enabled = writable || oracle.tools[name].annotations.readOnlyHint;
        if (profile === "legacy") assert.equal(exposed.some(tool => tool.name === name), enabled);
        const description = await invoke("capabilities_describe", { operation: `mcp.tool.${name}` });
        if (!enabled) {
          assert.equal(description.isError, true);
          assert.equal((await invoke(name, {})).isError, true);
          continue;
        }
        assert.notEqual(description.isError, true, JSON.stringify(description));
        assert.deepEqual(description.structuredContent.inputSchema, oracle.tools[name].inputSchema, name);
        assert.deepEqual(description.structuredContent.outputSchema, oracle.tools[name].outputSchema ?? null, name);
        assert.equal(description.structuredContent.description, oracle.tools[name].description, name);
        assert.equal(description.structuredContent.readOnly, oracle.tools[name].annotations.readOnlyHint, name);
      }
      for (const [index, call] of calls.entries()) {
        const direct = await invoke(call.tool, call.arguments);
        assert.notEqual(direct.isError, true, JSON.stringify(direct));
        const value = direct.structuredContent ?? (typeof oracle.values[index] === "string"
          ? direct.content[0].text : JSON.parse(direct.content[0].text));
        assert.deepEqual(normalized(value), normalized(oracle.values[index]), call.tool);
        if (!["paper_graph", "skill_context"].includes(call.tool)) assert.equal(direct.content[0].text, oracle.rawValues[index], call.tool);
        if (call.tool === "get_note" && call.arguments.id === "Example" && !call.arguments.slug)
          assert.equal(value.linkage.related_recipes.length, 101);
        const deferred = await invoke(oracle.tools[call.tool].annotations.readOnlyHint ? "capability_read" : "capability_call",
          { operation: `mcp.tool.${call.tool}`, version: 1, arguments: call.arguments });
        assert.equal(deferred.isError, direct.isError);
        assert.deepEqual(normalized(deferred.structuredContent), normalized(direct.structuredContent));
        if (typeof oracle.values[index] === "string") assert.deepEqual(deferred.content, direct.content);
        else assert.deepEqual(normalized(JSON.parse(deferred.content[0].text)), normalized(JSON.parse(direct.content[0].text)));
      }
      assert.equal((await invoke("get_research", { slug: "../outside" })).isError, true);
      for (const id of ["../outside", "/absolute", "System/../Example", "System\\Rules"]) {
        assert.equal((await invoke("get_note", { id })).isError, true, id);
      }
      assert.equal((await invoke("get_note", { id: "pkm://knowledge/knowledge_" + "a".repeat(24) })).isError, true);
      assert.equal((await invoke("get_note", { id: "Example", actorId: "user:local" })).isError, true);
      const backing = join(data, "notes", "Resource.assets", "pkm-todo-board.json");
      await rm(backing);
      await symlink(join(parent, "outside-board.json"), backing);
      assert.equal((await invoke("get_note", { id: "Resource" })).isError, true);
      await rm(backing);
      await writeFile(backing, "{}");
      if (writable) {
        await rm(join(data, "subscriptions", "cache"), { recursive: true });
        await writeFile(join(data, "subscriptions", "native.json"), "{}");
        const unavailable = await invoke("list_skills", {});
        assert.equal(unavailable.isError, true);
        assert.match(JSON.stringify(unavailable), /native identity and cache adapter/);
        await rm(join(data, "subscriptions"), { recursive: true });
      }
      for (const tool of ["search_notes", "search_skills", "search_research", "search_papers"]) {
        const standard = await invoke(tool, { query: "body", detail: "standard" });
        const semantic = await invoke(tool, { query: "body", route: "semantic" });
        if (!writable) {
          assert.equal(standard.isError, true);
          assert.equal(semantic.isError, true);
        } else {
          assert.notEqual(standard.isError, true);
          assert.equal(JSON.parse(standard.content[0].text).ok, true);
          assert.notEqual(semantic.isError, true);
          const off = JSON.parse(semantic.content[0].text);
          assert.equal(off.semantic_status, "off");
          assert.deepEqual(off.hits, []);
        }
      }
      await mkdir(join(data, "knowledge-read-config", "retrieval"), { recursive: true });
      await writeFile(join(data, "knowledge-read-config", "retrieval", "router-config.json"), JSON.stringify({
        schema: 2, enabledSolutions: ["copilot_default"], sourcePriority: ["pkm-personal", "agent-native"],
        sources: [{ id: "pkm-personal", label: "PKM Personal", kind: "personal", detail: "Personal" },
          { id: "agent-native", label: "Agent Native", kind: "native", detail: "Agent" }],
      }));
      const disabled = await invoke("skill_context", { task: "Verify tests" });
      assert.equal(JSON.parse(disabled.content[0].text).disabled, true);
      const missingResearch = await invoke("get_research", { id: "pkm://knowledge/knowledge_" + "a".repeat(24) });
      if (!writable) assert.equal(missingResearch.isError, true);
      else {
        assert.notEqual(missingResearch.isError, true);
        assert.equal(JSON.parse(missingResearch.content[0].text).code, "not-found");
      }
      assert.equal((await invoke("get_research", { slug: "A", actorId: "user:local" })).isError, true);
      await writeFile(join(data, "papers", "A.md"), "---\ntitle: Changed\n---\nNew source\n");
      const fresh = await invoke("get_research", { slug: "A" });
      assert.equal(JSON.parse(fresh.content[0].text).title, "Changed");
      assert.equal(JSON.parse(fresh.content[0].text).content, "New source\n");
      await symlink(join(parent, "outside.md"), join(data, "papers", "unsafe.md"));
      assert.equal((await invoke("list_research", {})).isError, true);
      const child = fixtures.find(([slug]) => slug === "Team/B");
      assert.deepEqual(await readFile(join(data, "papers", "Team", "B.md"), "utf8"),
        `---\n${Object.entries(child[1]).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${child[2]}`);
    });
}
