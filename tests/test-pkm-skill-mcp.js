#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-skill-mcp-"));
try {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "mcp/mcp.ts"), "utf8");
  assert(source.includes("fastmcp>=2.0.0,<4.0.0"), "generated MCP requirements must exclude incompatible FastMCP major versions");
  const generatedDirectory = path.join(root, "generated");
  const compiledDirectory = path.join(root, "compiled");
  fs.mkdirSync(compiledDirectory, { recursive: true });
  fs.writeFileSync(path.join(compiledDirectory, "mcp.js"), 'module.exports = require("./mcp/mcp");');
  const generationScript = require("typescript").transpileModule(source.slice(source.indexOf("export function generateMcpServer(")), {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2020, module: require("typescript").ModuleKind.CommonJS },
  }).outputText;
  const generation = {
    exports: {}, fs, path, require, process, __dirname: path.join(compiledDirectory, "mcp"),
    createHash: crypto.createHash,
    ensureRecipeCompiler: require("../dist/mcp/recipe-compiler").ensureRecipeCompiler,
    getStorePath: () => path.join(root, "generation-store"),
    managedMcpServerDirectory: () => generatedDirectory,
    mcpStatus: () => ({ newerThanExpected: false }),
    configuredMcpFeatureDomains: () => ["knowledge", "automation", "skillRouter"],
    writeMcpFeatureDomainConfig() {}, writeActionWorkspaceConfig() {},
    resolveMcpPython: () => "python",
    mcpStdioCommand: (command, args) => ({ command, args }),
    UNIFIED_MCP_VERSION: "test", KNOWLEDGE_MCP_VERSION: "test", CHAT_MCP_VERSION: "test",
    RECIPE_MCP_VERSION: "test", AGENT_SESSION_MCP_VERSION: "test",
  };
  require("vm").runInNewContext(generationScript, generation);
  const generated = generation.generateMcpServerFiles({
    extensionPath: path.join(__dirname, ".."), globalStorageUri: { fsPath: path.join(root, "global-storage") },
  }, generatedDirectory);
  assert.strictEqual(generated.serverPath, path.join(generatedDirectory, "server.py"));
  const generatedPython = fs.readFileSync(generated.serverPath, "utf8");
  for (const tool of ["skill_capabilities", "skill_context", "skill_feedback", "propose_skill_update"]) {
    assert(generatedPython.includes(`def ${tool}(`), `actual generation must retain ${tool}`);
  }
  const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\n\n  fs\.writeFileSync\(reqTxt/.exec(source);
  assert(match, "could not extract generated unified MCP server template");
  const store = path.join(root, "store");
  fs.mkdirSync(path.join(store, "skills", "Coding"), { recursive: true });
  fs.writeFileSync(path.join(store, "skills", "Coding", "Python Testing.md"), `---\nname: Python Testing\ndescription: Use when debugging Python tests with pytest and import errors.\ntags: ["python", "pytest"]\nrecipe_required: true\nrecipe_hint: "Reusable Python test diagnosis and validation"\nrelated_skills: ["Coding/Scope Python UDO Dependency Packaging"]\ncreated: 2026-08-12\n---\n\nRun pytest with the repository source path configured.\n`);
  fs.mkdirSync(path.join(store, "skills", "Project", "Common"), { recursive: true });
  fs.writeFileSync(path.join(store, "skills", "Project", "Common", "TODO Notes.md"), `---\nname: TODO Notes\ndescription: Use for project task checklists, progress notes, coding work, and issue tracking.\ntags:\n  - task\n  - coding\n  - notes\ncreated: 2026-08-12\n---\n\nFormat project work as a hierarchical checklist with verification evidence.\n`);
  fs.writeFileSync(path.join(store, "skills", "Coding", "Scope Python Packaging.md"), `---\nname: Scope Python UDO Dependency Packaging\ndescription: Package and import local Python dependencies for Scope UDO execution.\ntags:\n  - python\n  - package\n  - scope\ncreated: 2026-08-12\n---\n\nConfigure dependency archives and import paths.\n`);
  fs.writeFileSync(path.join(store, "skills", "Project", "Common", "Azure PIM.md"), `---\nname: Azure PIM Role Activation\ndescription: Use when that member needs an Azure privileged role and identity permissions.\ntags:\n  - azure\n  - role\n  - identity\ncreated: 2026-08-12\n---\n\nNo member name is required after role activation; validate data access.\n`);
  fs.mkdirSync(path.join(store, "notes", "Projects"), { recursive: true });
  fs.writeFileSync(path.join(store, "notes", "Projects", "Release Constraints.md"), `---\ntitle: Release Constraints\ntype: general\ntags: ["release"]\ncreated: 2026-08-12\n---\n\nDo not publish automatically.\n`);
  const recipeDefinition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [{ nodeId: "validate", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }], outputs: {}, completion: { requiredNodes: ["validate"] } } };
  const recipe = { recipeId: "recipe_release", scope: "global", name: "Release Validation", description: "Validate release constraints", definition: recipeDefinition, executableDigest: crypto.createHash("sha256").update(JSON.stringify(canonical(recipeDefinition))).digest("hex"), revision: 1, nodeBindings: [{ nodeId: "validate", bindings: [{ bindingId: "scope", kind: "skill", knowledgeId: "Coding/Scope Python UDO Dependency Packaging", contentHash: "b".repeat(64), usage: "recommended" }, { bindingId: "release", kind: "note", knowledgeId: "Projects/Release Constraints", contentHash: "c".repeat(64), usage: "required" }] }] };
  const projectPayload = { state: { schema: 1, rootId: "root_test", projects: [], threads: [], recipes: [recipe], migrations: [], audit: [] }, receipts: [] };
  fs.mkdirSync(path.join(store, ".pkm", "state"), { recursive: true });
  fs.writeFileSync(path.join(store, ".pkm", "state", "projects.json"), JSON.stringify({ schema: 1, storeVersion: 1, payload: projectPayload, digest: crypto.createHash("sha256").update(JSON.stringify(canonical(projectPayload))).digest("hex") }));

  const subscriptionCache = path.join(root, "subscription-cache");
  const subscribedRoot = path.join(subscriptionCache, "node-1", "share-1");
  fs.mkdirSync(path.join(subscribedRoot, "content", "skills", "Team"), { recursive: true });
  fs.writeFileSync(path.join(subscribedRoot, "_subscription.json"), JSON.stringify({ subscriptionId: "sub-1", alias: "Team Broker", priority: "normal", publisher: "Colleague", nodeId: "node-1", shareId: "share-1", revision: 3, collectionHash: "sha256:test", syncedAt: "2026-09-03T01:02:03Z" }));
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "Remote Skill.md"), `---
name: Remote Broker Diagnostics
description: Use when troubleshooting distributed Broker replication and subscriber synchronization incidents.
tags: ["broker", "replication", "subscription"]
---

Explicit subscribed knowledge content`);
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "Remote Skill.md.pkm-source.json"), JSON.stringify({ subscriptionAlias: "Team Broker", publisher: "Colleague", shareId: "share-1", revision: 3, syncedAt: "2026-09-03T01:02:03Z" }));
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "AutoLabeling V2 Data Preparation.md"), `---
name: AutoLabeling V2 Data Preparation
description: Prepare and validate AutoLabeling v2 grammar and accuracy S2S and 17-label S2C datasets with deterministic normalization, filtering, splitting, and exports.
tags:
  - autolabeling
  - data-preparation
  - grammar
  - accuracy
priority: highest
---

Build deterministic training datasets and validate every exported split.`);
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "AutoLabeling V2 Data Preparation.md.pkm-source.json"), JSON.stringify({ subscriptionAlias: "A6000-CG2", publisher: "Colleague", shareId: "share-1", revision: 3, syncedAt: "2026-09-03T01:02:03Z" }));
  const subscribedFixtures = [
    ["notes", "Team/Remote Note.md", "Explicit subscribed note content"],
    ["prompts", "Ads/Review/v1/prompt.md", "Explicit subscribed prompt content"],
    ["scripts", "Team/check.script", "Explicit subscribed script content"],
    ["servers", "sample-api/server.link.json", JSON.stringify({ name: "Remote Sample API", url: "http://remote.example:8000/" })],
  ];
  for (const [type, relative, content] of subscribedFixtures) {
    const target = path.join(subscribedRoot, "content", type, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.writeFileSync(`${target}.pkm-source.json`, JSON.stringify({ subscriptionAlias: "Team Broker", publisher: "Colleague", shareId: "share-1", revision: 3 }));
  }
  const retrievalState = path.join(root, "retrieval-state");
  const environmentsRegistry = path.join(root, "environments", "registry.json");
  const render = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION", "RECIPE_MCP_VERSION", "AGENT_SESSION_MCP_VERSION", "storeFwd", "subscriptionCacheFwd", "retrievalStateFwd", "environmentsRegistryFwd", "context", `return \`${match[1]}\`;`);
  const server = render("test", "test", "test", "test", "test", store.replaceAll('\\', '/'), subscriptionCache.replaceAll('\\', '/'), retrievalState.replaceAll('\\', '/'), environmentsRegistry.replaceAll('\\', '/'), { extensionPath: path.resolve(__dirname, "..") });
  const moduleDir = path.join(root, "module");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "server.py"), server);
  fs.copyFileSync(path.join(__dirname, "..", "resources", "recipe_runtime.py"), path.join(moduleDir, "recipe_runtime.py"));
  fs.copyFileSync(path.join(__dirname, "..", "resources", "recipe_health.py"), path.join(moduleDir, "recipe_health.py"));
  fs.copyFileSync(path.join(__dirname, "..", "resources", "agent_session_runtime.py"), path.join(moduleDir, "agent_session_runtime.py"));
  fs.copyFileSync(path.join(__dirname, "..", "resources", "mcp_call_guard.py"), path.join(moduleDir, "mcp_call_guard.py"));
  fs.copyFileSync(path.join(__dirname, "..", "resources", "diagnostic_log.py"), path.join(moduleDir, "diagnostic_log.py"));
  fs.copyFileSync(path.join(__dirname, "..", "resources", "api_chat_control.py"), path.join(moduleDir, "api_chat_control.py"));
  for (const resource of ["knowledge_recovery.py", "knowledge_mutations.py", "knowledge_mutations.js", "knowledge_snapshots.py", "asset_classification.py", "asset_classification.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", "resources", resource), path.join(moduleDir, resource));
  }
  for (const resource of ["action_runtime.py", "action_modules.py", "action_authoring.py", "action_monitoring.py", "action_azuredevops.py", "action_run_store.py", "action_recovery.py", "action_components.py"]) {
    fs.copyFileSync(path.join(__dirname, "..", "resources", resource), path.join(moduleDir, resource));
  }
  fs.writeFileSync(path.join(moduleDir, "chat_server.py"), "from fastmcp import FastMCP\nmcp = FastMCP('chat-stub')\n");
  fs.writeFileSync(path.join(moduleDir, "exercise.py"), `import asyncio, hashlib, json, pathlib\nfrom fastmcp import Client\nimport server\nversion = server.check_version()\nassert version['components']['recipes'] == 'test' and 'pkm-recipes' in version['capabilities'], version\nassert version['recipe_discovery_tool'] == 'recipe_capabilities'\ntool_names = {tool.name for tool in asyncio.run(server.mcp.list_tools())}\nassert {'skill_context','list_notes','recipe_capabilities','agent_session_capabilities'} <= tool_names, tool_names\ncap = json.loads(server.skill_capabilities())\nassert cap['capability'] == 'pkm-skills'\nassert pathlib.Path(server.STORE) == pathlib.Path(r'${store.replaceAll('\\', '\\\\')}'), server.STORE\nassert server._all_skills(), (server.STORE, server.SKILLS, list(server.SKILLS.rglob('*')))\ncontext = json.loads(server.skill_context('debug pytest Python import errors'))\nfull_context = json.loads(server.skill_context('debug pytest Python import errors', detail='full'))\nassert len(json.dumps(context, ensure_ascii=False)) < len(json.dumps(full_context, ensure_ascii=False)), (context, full_context)\nassert 'task' not in context and full_context['task'] == 'debug pytest Python import errors'\nassert context['count'] == 1, context\nassert context['no_match'] is False and context['retrieval'] == 'summary', context\nskill = context['skills'][0]\nassert skill['skill_id'] == 'Coding/Python Testing'\nassert skill['content_hash']\nassert 'content' not in skill, skill\nfull_skill = json.loads(server.get_skill(skill['skill_id']))\nassert full_skill['skill_id'] == skill['skill_id']\nassert full_skill['content_hash'] == skill['content_hash']\nassert 'Run pytest' in full_skill['content']\nasync def assert_typed_skill_transport():\n    async with Client(server.mcp) as client:\n        result = await client.call_tool('skill_context', {'task':'debug pytest Python import errors'})\n        assert result.structured_content == json.loads(result.content[0].text), result.structured_content\nasyncio.run(assert_typed_skill_transport())\nnote = json.loads(server.get_note('Projects/Release Constraints'))\nnote_document = {key: note[key] for key in ['title', 'type', 'category', 'tags', 'content']}\nexpected_note_hash = hashlib.sha256(json.dumps(note_document, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()\nassert note['content_hash'] == expected_note_hash, note\nno_match = json.loads(server.skill_context('organize a birthday picnic menu'))\nassert no_match['no_match'] is True and no_match['count'] == 0, no_match\nfeedback = json.loads(server.skill_feedback('debug tests', [skill['skill_id']], 'success', ['PYTHONPATH was required'], ['pytest passed']))\nassert feedback['feedback_id']\nproposal = json.loads(server.propose_skill_update(skill['skill_id'], skill['content_hash'], 'Document PYTHONPATH', ['pytest passed'], 'Add the verified command.', 0.9))\nassert proposal['ok'] and proposal['conflict'] is False\nconflict = json.loads(server.propose_skill_update(skill['skill_id'], 'stale-hash', 'Stale proposal'))\nassert conflict['conflict'] is True\nassert pathlib.Path(proposal['proposal_path']).exists()\nassert (pathlib.Path(r'${store.replaceAll('\\', '\\\\')}') / '_feedback' / 'skill-usage.jsonl').exists()\nprint('PKM Skill MCP: thresholded summaries, full fetch, feedback, proposal, and conflict detection OK')\n`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "\nhttp_retrieval_request = server._retrieval_request\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "\ntools = {tool.name: tool for tool in asyncio.run(server.mcp.list_tools())}\nfor read_tool in ['check_version','retrieval_status','search_knowledge','skill_capabilities','skill_context','list_skills','search_skills','get_skill','agent_session_capabilities']:\n    assert tools[read_tool].annotations.readOnlyHint is True, (read_tool, tools[read_tool].annotations)\nassert tools['skill_feedback'].annotations.readOnlyHint is not True, tools['skill_feedback'].annotations\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "server.RETRIEVAL_STATE.mkdir(parents=True, exist_ok=True)\n(server.RETRIEVAL_STATE / 'worker.json').write_text(json.dumps({'token':'test','port':9}), encoding='utf-8')\ntimeouts = []\noriginal_urlopen = server.urllib.request.urlopen\ndef capture_timeout(request, timeout):\n    timeouts.append(timeout)\n    raise TimeoutError('bounded test timeout')\nserver.urllib.request.urlopen = capture_timeout\ntry:\n    bounded = server._retrieval_request('/search', {'deadline_at_ms': int(server.time.time() * 1000) + 250})\nfinally:\n    server.urllib.request.urlopen = original_urlopen\nassert bounded['ok'] is False and 0.1 <= timeouts[0] <= 0.5, (bounded, timeouts)\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "async def assert_snapshot_read_only():\n    async with Client(server.mcp) as client:\n        capabilities = (await client.call_tool('agent_session_capabilities', {})).structured_content\n        assert capabilities['owner'] == 'pkm-chat' and capabilities['external_sessions'] == 'unsupported', capabilities\n        listed = (await client.call_tool('agent_session_snapshot_list', {})).structured_content\n        assert listed['snapshots'] == [], listed\n        for retired in ['agent_session_start', 'agent_session_todo_append', 'agent_session_snapshot_recover']:\n            assert retired not in tools, retired\n        await client.call_tool('skill_context', {'task':'debug pytest Python import errors'})\nasyncio.run(assert_snapshot_read_only())\nstate_root = pathlib.Path(server.STORE) / '.pkm' / 'state'\nassert not (state_root / 'agent-sessions' / 'active').exists(), 'Snapshot reads must not create external Agent Session mappings'\nassert not (state_root / 'mcp-usage' / 'todos').exists(), 'MCP calls without a PKM Todo must not be attributed'\n");
    fs.appendFileSync(path.join(moduleDir, "exercise.py"), "feedback_path = pathlib.Path(server.STORE) / '_feedback' / 'skill-usage.jsonl'\nfeedback_entry = json.loads(feedback_path.read_text(encoding='utf-8').splitlines()[-1])\nassert 'task' not in feedback_entry and len(feedback_entry['task_hash']) == 64, feedback_entry\nevents = []\nserver._collector_post = lambda event_type, interaction_id, payload: events.append({'event_type': event_type, 'payload': payload})\nprivate_task = 'PRIVATE QUERY TEXT 9173'\nserver.skill_context(private_task, workspace='/PRIVATE/WORKSPACE', files=['secret-file.ts'], diagnostics='PRIVATE DIAGNOSTIC')\nserver.skill_feedback(private_task, [skill['skill_id']], 'success', ['PRIVATE OBSERVATION'], ['PRIVATE EVIDENCE'])\nserver.get_skill(skill['skill_id'])\nevent_text = json.dumps(events)\nfor private_value in [private_task, '/PRIVATE/WORKSPACE', 'secret-file.ts', 'PRIVATE DIAGNOSTIC', 'PRIVATE OBSERVATION', 'PRIVATE EVIDENCE', 'Run pytest']:\n    assert private_value not in event_text, (private_value, event_text)\nsearch_event = events[0]\nassert search_event['event_type'] == 'search_invocation' and search_event['payload']['tool_name'] == 'pkm.skill_context', search_event\nassert set(search_event['payload']) == {'tool_name', 'duration_ms', 'success', 'result_count', 'result_hashes', 'routes', 'model_based_routing_enabled'}, search_event\nassert search_event['payload']['model_based_routing_enabled'] is False\nassert events[1]['payload']['feedback']['observation_count'] == 1 and events[1]['payload']['feedback']['evidence_count'] == 1\nassert 'task_hash' not in events[1]['payload']['feedback']\nassert set(events[2]['payload']['skill']) == {'content_hash', 'source', 'read_only'}\npositive = json.loads(server.skill_context('Package Python dependencies and import paths for a Scope Python UDO'))\nassert positive['skills'][0]['skill_id'] == 'Coding/Scope Python UDO Dependency Packaging', positive\nassert positive['skills'][0]['task_coverage'] >= 0.7, positive\nrename_context = json.loads(server.skill_context(\"Debug and fix PKM Chatroom participant rename where entering a new name and role does not update the roster and reports 'That member is no longer in the room roster'. Trace stable participant identity across rename and role editing, add regression coverage.\", workspace='/workspace', files=['src/chatroom/chatroom-hub.ts'], diagnostics='That member is no longer in the room roster.'))\nassert rename_context['no_match'] is True and rename_context['count'] == 0, rename_context\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "subscriptions = json.loads(server.list_subscriptions())\nassert subscriptions[0]['alias'] == 'Team Broker' and subscriptions[0]['priority'] == 'normal', subscriptions\nsubscribed = json.loads(server.search_subscribed_content('subscribed knowledge', content_type='skills', alias='Team Broker'))\nassert len(subscribed) == 1 and subscribed[0]['share_id'] == 'share-1' and subscribed[0]['source_priority'] == 'normal', subscribed\nremote = json.loads(server.get_subscribed_content('node-1', 'share-1', 'skills', 'Team/Remote Skill.md'))\nassert 'Explicit subscribed knowledge' in remote['content'], remote\nassert remote['provenance']['subscriptionAlias'] == 'Team Broker', remote\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "all_skills = json.loads(server.list_skills())\nbroker_listing = next((item for item in all_skills if item.get('source') == 'subscription' and item['name'] == 'Remote Broker Diagnostics'), None)\nassert broker_listing, all_skills\nassert broker_listing['skill_id'] == 'pkm://subscriptions/node-1/share-1/skills/Team/Remote%20Skill.md', broker_listing\nbroker_context = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert broker_context['count'] == 1, broker_context\nbroker_summary = broker_context['skills'][0]\nassert broker_summary['skill_id'] == broker_listing['skill_id'], broker_summary\nassert broker_summary['source'] == 'subscription' and broker_summary['read_only'] is True, broker_summary\nassert broker_summary['provenance']['alias'] == 'Team Broker', broker_summary\nbroker_search = json.loads(server.search_skills('distributed Broker replication'))\nassert broker_search[0]['skill_id'] == broker_summary['skill_id'], broker_search\nbroker_skill = json.loads(server.get_skill(broker_summary['skill_id']))\nassert 'Explicit subscribed knowledge' in broker_skill['content'], broker_skill\nassert broker_skill['provenance']['publisher'] == 'Colleague', broker_skill\nreadonly_proposal = json.loads(server.propose_skill_update(broker_summary['skill_id'], broker_summary['content_hash'], 'Do not modify Broker cache'))\nassert readonly_proposal['ok'] is False and 'read-only' in readonly_proposal['error'], readonly_proposal\nauto_search = json.loads(server.search_skills('AutoLabeling V2 Data Preparation'))\nassert auto_search and auto_search[0]['source'] == 'subscription', auto_search\nlong_task = 'Prepare the AutoLabeling v2 grammar and accuracy datasets for the next training cycle. Read all raw exports, normalize malformed rows deterministically, remove duplicates, preserve identifiers, validate language and label distributions, construct S2S and 17-label S2C examples, create leakage-safe train validation and test splits, write reproducible manifests, compare counts with the previous release, investigate anomalies, and publish final artifacts with verification evidence.'\nauto_context = json.loads(server.skill_context(long_task))\nassert auto_context['no_match'] is False and auto_context['count'] >= 1, auto_context\nassert auto_context['skills'][0]['name'] == 'AutoLabeling V2 Data Preparation', auto_context\nassert auto_context['skills'][0]['source'] == 'subscription' and auto_context['skills'][0]['priority'] == 'required', auto_context\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "for content_type, query, expected_path in [('notes','subscribed note','Team/Remote Note.md'),('prompts','subscribed prompt','Ads/Review/v1/prompt.md'),('scripts','subscribed script','Team/check.script'),('servers','Remote Sample API','sample-api/server.link.json')]:\n    matches = json.loads(server.search_subscribed_content(query, content_type=content_type, alias='Team Broker'))\n    assert len(matches) == 1 and matches[0]['path'] == expected_path, (content_type, matches)\n    item = json.loads(server.get_subscribed_content(matches[0]['node_id'], matches[0]['share_id'], matches[0]['content_type'], matches[0]['path']))\n    assert 'content' in item and item['provenance']['shareId'] == 'share-1', (content_type, item)\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "copied = json.loads(server.get_subscribed_content_by_path('pkm://subscriptions/node-1/share-1/notes/Team/Remote%20Note.md'))\nassert copied['content'] == 'Explicit subscribed note content', copied\ninvalid_copied = json.loads(server.get_subscribed_content_by_path('pkm://subscriptions/node-1/share-1/unknown/file'))\nassert invalid_copied['error'], invalid_copied\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "worker_status = json.loads(server.retrieval_status())\nassert worker_status['ok'] is False and 'unavailable' in worker_status['error'], worker_status\nworker_search = json.loads(server.search_knowledge('AutoLabeling data preparation'))\nassert worker_search['ok'] is False and 'unavailable' in worker_search['error'], worker_search\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "raw_retrieval = {'ok': True, 'request_id': 'r1', 'corpus_revision': 'rev1', 'query_intent': 'hybrid', 'intent_signals': ['identifier_anchor'], 'exact_terms': [], 'lexical_anchors': ['AutoLabeling'], 'fuzzy_terms': ['data'], 'fuzzy_query': 'data', 'requested_content_types': [], 'content_type_routing': 'none', 'route_index_versions': {'very-long-route-key': 'hash'}, 'hits': [{'rank': 1, 'score': 0.0163934426, 'skill_id': 'skill:data-prep', 'content_hash': 'abc', 'content_type': 'skill', 'source_uri': 'pkm://skills/data-prep', 'title': 'Data Prep', 'description': 'Prepare datasets', 'metadata': {'large': 'metadata'}, 'provenance': {'provider': 'pkm', 'collection': 'skills', 'private': 'detail'}, 'read_only': False, 'contributing_routes': ['very-long-route-key']}]}\nserver._retrieval_request = lambda route, payload=None: raw_retrieval\ncompact = json.loads(server.search_knowledge('AutoLabeling data preparation', limit=1))\nassert 'route_index_versions' not in compact and 'contributing_routes' not in compact['hits'][0] and 'metadata' not in compact['hits'][0], compact\nassert compact['hits'][0]['provenance'] == {'provider': 'pkm'}, compact\ndebug = json.loads(server.search_knowledge('AutoLabeling data preparation', limit=1, debug=True))\nassert debug['route_index_versions'] and debug['hits'][0]['contributing_routes'], debug\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "raw_retrieval['hits'].append({'rank': 2, 'score': 0.014, 'skill_id': 'pkm://subscriptions/node-1/share-1/skills/priority.md', 'content_hash': 'priority', 'content_type': 'subscription', 'source_uri': 'pkm://subscriptions/node-1/share-1/skills/priority.md', 'title': 'Priority Source', 'description': 'Priority source result', 'metadata': {'source_priority': 'highest'}, 'provenance': {'provider': 'broker', 'source_priority': 'highest'}, 'read_only': True})\npriority_search = json.loads(server.search_knowledge('priority source', limit=1))\nassert priority_search['hits'][0]['content_hash'] == 'priority', priority_search\nassert priority_search['hits'][0]['provenance']['source_priority'] == 'highest', priority_search\nraw_retrieval['hits'] = raw_retrieval['hits'][:1]\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "server.RETRIEVAL_STATE.mkdir(parents=True, exist_ok=True)\nrouter_config = server.RETRIEVAL_STATE / 'router-config.json'\nrouter_config.write_text(json.dumps({'schema': 1, 'enabledSolutions': ['copilot_default']}), encoding='utf-8')\ndisabled_context = json.loads(server.skill_context('must not execute'))\ndisabled_search = json.loads(server.search_knowledge('must not execute'))\nassert disabled_context['disabled'] is True and disabled_context['fallback'] == 'copilot_default', disabled_context\nassert disabled_search['disabled'] is True and disabled_search['fallback'] == 'copilot_default', disabled_search\nrouter_config.write_text(json.dumps({'schema': 1, 'enabledSolutions': ['copilot_default', 'l1_online']}), encoding='utf-8')\nsearch_events = []\nserver._collector_post = lambda event_type, interaction_id, payload: search_events.append({'event_type': event_type, 'payload': payload})\nserver.skill_context('private skill context query')\nserver.search_knowledge('private unified query')\nserver.search_skills('private skill query')\nserver.search_notes('private note query')\nserver.search_papers('private paper query')\nserver.search_subscribed_content('private subscription query')\nsearch_tools = {event['payload']['tool_name'] for event in search_events if event['event_type'] == 'search_invocation'}\nfor expected_tool in ['pkm.skill_context', 'pkm.search_knowledge', 'pkm.search_skills', 'pkm.search_notes', 'pkm.search_papers', 'pkm.search_subscribed_content']:\n    assert expected_tool in search_tools, (expected_tool, search_tools)\nsearch_event_text = json.dumps(search_events)\nfor private_value in ['private skill context query', 'private unified query', 'private skill query', 'private note query', 'private paper query', 'private subscription query']:\n    assert private_value not in search_event_text, (private_value, search_event_text)\nfor event in search_events:\n    if event['event_type'] == 'search_invocation':\n        assert set(event['payload']) == {'tool_name', 'duration_ms', 'success', 'result_count', 'result_hashes', 'routes', 'model_based_routing_enabled'}, event\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "required_linkage = full_skill['linkage']\nassert required_linkage['recipe_required'] is True, required_linkage\nassert required_linkage['recipe_hint'] == 'Reusable Python test diagnosis and validation', required_linkage\nassert required_linkage['related_skills'] == ['Coding/Scope Python UDO Dependency Packaging'], required_linkage\nassert required_linkage['next_action']['kind'] == 'search_or_create_recipe', required_linkage\nscope_skill = json.loads(server.get_skill('Coding/Scope Python UDO Dependency Packaging'))\nassert scope_skill['linkage']['related_recipes'][0]['recipe_id'] == 'recipe_release', scope_skill\nassert scope_skill['linkage']['related_recipes'][0]['bindings'] == [{'node_id': 'validate', 'usage': 'recommended'}], scope_skill\nassert note['linkage']['related_recipes'][0]['recipe_id'] == 'recipe_release', note\nassert note['linkage']['related_recipes'][0]['bindings'] == [{'node_id': 'validate', 'usage': 'required'}], note\nraw_retrieval['hits'][0].update({'skill_id': 'skill:Coding/Scope Python UDO Dependency Packaging', 'content_type': 'skill'})\nlinked_hit = json.loads(server.search_knowledge('scope package', limit=1))['hits'][0]\nassert linked_hit['linkage']['related_recipes'][0]['recipe_id'] == 'recipe_release', linked_hit\nraw_retrieval['hits'][0].update({'skill_id': 'note:Projects/Release Constraints', 'content_type': 'note'})\nlinked_note_hit = json.loads(server.search_knowledge('release constraints', limit=1))['hits'][0]\nassert linked_note_hit['linkage']['related_recipes'][0]['recipe_id'] == 'recipe_release', linked_note_hit\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "server._skill_write('Remote Broker Diagnostics', 'Use the subscriber local policy first.', 'Use when troubleshooting distributed Broker replication and subscriber synchronization incidents.', 'Team', ['broker','replication','subscription'], priority='high')\nconflict_context = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert conflict_context['skills'][0]['skill_id'] == 'Team/Remote Broker Diagnostics', conflict_context\nassert conflict_context['skills'][0]['source'] == 'local' and conflict_context['skills'][0]['skill_priority'] == 'high', conflict_context\nsubscription_metadata = pathlib.Path(server.SUBSCRIPTIONS) / 'node-1' / 'share-1' / '_subscription.json'\nmetadata = json.loads(subscription_metadata.read_text(encoding='utf-8'))\nmetadata['priority'] = 'highest'\nsubscription_metadata.write_text(json.dumps(metadata), encoding='utf-8')\nsource_preferred = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert source_preferred['skills'][0]['source'] == 'subscription' and source_preferred['skills'][0]['skill_priority'] == 'highest', source_preferred\nserver.update_skill('Remote Broker Diagnostics', priority='highest')\nequal_priority = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert equal_priority['skills'][0]['source'] == 'local', equal_priority\nmetadata['priority'] = 'high'\nsubscription_metadata.write_text(json.dumps(metadata), encoding='utf-8')\nserver.update_skill('Remote Broker Diagnostics', priority='high')\nrouter_config.write_text(json.dumps({'schema': 2, 'enabledSolutions': ['copilot_default', 'l1_online'], 'sourcePriority': ['subscriber:sub-1', 'pkm-personal', 'agent-native']}), encoding='utf-8')\nsubscriber_first = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert subscriber_first['skills'][0]['source_key'] == 'subscriber:sub-1' and subscriber_first['skills'][0]['source_rank'] == 1, subscriber_first\nassert subscriber_first['source_priority'][0] == 'subscriber:sub-1', subscriber_first\nrouter_config.write_text(json.dumps({'schema': 2, 'enabledSolutions': ['copilot_default', 'l1_online'], 'sourcePriority': ['agent-native', 'pkm-personal', 'subscriber:sub-1']}), encoding='utf-8')\nnative_first = json.loads(server.skill_context('distributed Broker replication subscriber synchronization'))\nassert native_first['source_priority'][0] == 'agent-native' and native_first['source_policy'].startswith('Evaluate applicable Agent Native Skills'), native_first\nrouter_config.write_text(json.dumps({'schema': 2, 'enabledSolutions': ['copilot_default', 'l1_online'], 'sourcePriority': ['pkm-personal', 'agent-native', 'subscriber:sub-1']}), encoding='utf-8')\nserver._skill_write('Normal Release Validation', 'Normal sequence.', 'Validate release package manifests and deployment checks.', 'Project/Common', ['release','validation','package'])\nserver._skill_write('Preferred Release Validation', 'Preferred sequence.', 'Validate release package manifests and deployment checks.', 'Project/Common', ['release','validation','package'], priority='high')\npriority_context = json.loads(server.skill_context('validate release package manifests deployment checks'))\nassert priority_context['skills'][0]['skill_id'] == 'Project/Common/Preferred Release Validation', priority_context\nassert priority_context['skills'][0]['skill_priority'] == 'high' and 'priority:high' in priority_context['skills'][0]['match_reason'], priority_context\nserver._skill_write('Irrelevant Highest', 'Underwater basket weaving.', 'Tune underwater basket weaving material colors.', 'Project/Common', ['basket'], priority='highest')\nunrelated = json.loads(server.skill_context('organize a birthday picnic menu'))\nassert unrelated['no_match'] is True, unrelated\nupdated = json.loads(server.update_skill('Normal Release Validation', priority='highest'))\nassert updated['ok'] is True\nassert json.loads(server.get_skill('Normal Release Validation'))['priority'] == 'highest'\ntry:\n    server.update_skill('Normal Release Validation', priority='urgent')\n    raise AssertionError('invalid priority must fail')\nexcept ValueError as error:\n    assert 'normal, high, or highest' in str(error), error\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
system_note = server.NOTES / 'System' / 'PKM' / 'Protected.md'
system_skill = server.SKILLS / 'System' / 'PKM' / 'Protected.md'
system_prompt = server.STORE / 'prompts' / 'System' / 'PKM' / 'v1' / 'prompt.md'
for fixture, body in [(system_note, '---\\ntitle: Protected\\n---\\n\\nSystem note'),
                      (system_skill, '---\\nname: Protected System Skill\\n---\\n\\nSystem Skill'),
                      (system_prompt, 'System prompt')]:
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(body, encoding='utf-8')
originals = {fixture: fixture.read_bytes() for fixture in [system_note, system_skill, system_prompt]}
alias = server.NOTES / 'system-alias.md'
alias.symlink_to(system_note)
async def assert_system_readonly_transport():
    async with Client(server.mcp) as client:
        note = (await client.call_tool('get_note', {'slug':'System/PKM/Protected'})).structured_content
        assert note['read_only'] is True and 'System note' in note['content'], note
        skill = (await client.call_tool('get_skill', {'name':'Protected System Skill'})).structured_content
        assert skill['read_only'] is True, skill
        blocked = [
            ('add_note', {'title':'New','content':'no','category':'System/PKM'}),
            ('update_note', {'slug':'System/PKM/Protected','content':'no'}),
            ('update_note', {'slug':'System/PKM/Protected','category':'Adhoc'}),
            ('delete_note', {'slug':'System/PKM/Protected'}),
            ('update_note', {'slug':'Projects/Release Constraints','category':'System/PKM'}),
            ('delete_note', {'slug':'system-alias'}),
            ('delete_note', {'slug':'../prompts/System/PKM/v1/prompt'}),
            ('delete_paper', {'slug':'../notes/System/PKM/Protected'}),
            ('add_skill', {'name':'New','content':'no','category':'system/PKM'}),
            ('add_skill', {'name':'Protected System Skill','content':'no','category':'Coding'}),
            ('update_skill', {'name':'Protected System Skill','content':'no'}),
            ('update_skill', {'name':'Protected System Skill','category':'Coding'}),
            ('delete_skill', {'name':'Protected System Skill'}),
            ('update_skill', {'name':'Python Testing','category':'System/PKM'}),
            ('recipe_create_from_skill', {'name':'No','category':'System/PKM',
             'definition_json':json.dumps(${JSON.stringify(recipeDefinition)}), 'command_id':'system-recipe-blocked',
             'source_skill_id':'Coding/Python Testing','source_skill_hash':'a'*64}),
        ]
        for tool_name, arguments in blocked:
            result = (await client.call_tool(tool_name, arguments)).structured_content
            assert result['ok'] is False and 'read-only' in json.dumps(result), (tool_name, result)
            assert all(fixture.read_bytes() == body for fixture, body in originals.items()), tool_name
        created = (await client.call_tool('add_note', {'title':'Editable','content':'yes','category':'Adhoc'})).structured_content
        assert created['ok'] is True, created
        updated = (await client.call_tool('update_note', {'slug':created['slug'],'content':'still editable'})).structured_content
        assert updated['ok'] is True, updated
        deleted = (await client.call_tool('delete_note', {'slug':created['slug']})).structured_content
        assert deleted['ok'] is True, deleted
        assert not (server.NOTES / 'System' / 'PKM' / 'New.md').exists()
        assert not (server.SKILLS / 'system').exists()
        assert json.loads(server.get_note('Projects/Release Constraints'))['content'].strip() == 'Do not publish automatically.'
asyncio.run(assert_system_readonly_transport())
print('System MCP read-only: real transport, alias/move/traversal protection, reads and user writes passed')
`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
original_request = server._retrieval_request
original_collector = server._collector_post
linked_events = []
server._collector_post = lambda kind, interaction_id, payload: linked_events.append((kind, interaction_id, payload))
context = json.loads(server.skill_context('Python pytest import errors'))
server.get_skill('Coding/Python Testing', interaction_id=context['interaction_id'])
server.skill_feedback('Python pytest import errors', ['Coding/Python Testing'], 'success', interaction_id=context['interaction_id'])
assert all(event[1] == context['interaction_id'] for event in linked_events), linked_events
assert {event[0] for event in linked_events} == {'search_invocation', 'skill_load', 'outcome'}, linked_events
assert 'Python pytest import errors' not in json.dumps(linked_events), linked_events
server._collector_post = original_collector
server._retrieval_request = lambda route, payload=None: {
    'ok': True, 'skill_serving': {'used': True, 'release_id': 'verified-fixture'},
    'hits': [{'skill_id': 'skill:Coding/Python Testing', 'content_type': 'skill'}]}
served = json.loads(server.search_skills('no lexical match required'))
assert len(served) == 1 and served[0]['skill_id'] == 'Coding/Python Testing', served
assert served[0]['skill_serving']['release_id'] == 'verified-fixture' and served[0]['content_hash'], served
server._retrieval_request = lambda route, payload=None: {
    'ok': True, 'skill_serving': {'used': True}, 'hits': []}
assert json.loads(server.search_skills('Python')) == [], 'A valid empty serving result is not a transport failure'
server._retrieval_request = lambda route, payload=None: {'ok': False, 'error': 'unavailable'}
assert json.loads(server.search_skills('Python')), 'Explicit serving failure must preserve the existing lexical fallback'
server._retrieval_request = original_request
`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
contract_request = server._retrieval_request
contract_calls = []
contract_hits = [{'rank': index, 'score': 1.0 / index, 'source_id': 'pkm://knowledge/item-' + kind,
                 'source_revision': '1', 'content_hash': kind, 'content_type': kind,
                 'skill_id': kind + ':fixture', 'source_uri': 'pkm://knowledge/item-' + kind,
                 'title': kind, 'description': 'Relevant fixture', 'metadata': {},
                 'provenance': {'provider': 'pkm'}, 'read_only': kind == 'script'}
                for index, kind in enumerate(['skill', 'note', 'research', 'script'], 1)]
def contract_retrieval(route, payload=None):
    contract_calls.append((route, payload))
    if route == '/get':
        selected = next((hit for hit in contract_hits if hit['source_id'] == payload['source_id']
                         and (not payload.get('content_type_filter') or hit['content_type'] in payload['content_type_filter'])), None)
        return {**selected, 'ok': True, 'content': 'Indexed fixture body'} if selected else {'ok': False, 'code': 'not-found'}
    selected = [hit for hit in contract_hits if not payload.get('content_type_filter')
                or hit['content_type'] in payload['content_type_filter']]
    return {'ok': True, 'hits': selected, 'incomplete': False, 'diagnostics': [],
            'schema': 'pkm.retrieval.result/v1', 'requested_content_types': payload.get('content_type_filter') or []}
server._retrieval_request = contract_retrieval
try:
    mixed = json.loads(server.search_knowledge('fixture', limit=10))
    assert {hit['content_type'] for hit in mixed['hits']} == {'skill', 'note', 'research', 'script'}, mixed
    assert mixed['groups']['skill'] == ['pkm://knowledge/item-skill'], mixed
    assert mixed['counts'] == {'skill': 1, 'note': 1, 'research': 1, 'script': 1}, mixed
    assert mixed['truncated'] is False and mixed['result_count'] == 4, mixed
    bounded = json.loads(server.search_knowledge('fixture', limit=2))
    assert bounded['truncated'] is True and bounded['incomplete'] is True, bounded
    assert sum(bounded['counts'].values()) == len(bounded['hits']) == 2, bounded
    filtered = json.loads(server.search_knowledge('fixture', limit=10, content_type_filter=['skill']))
    assert {hit['content_type'] for hit in filtered['hits']} == {'skill'}, filtered
    multi = json.loads(server.search_knowledge('fixture', limit=10, content_type_filter=['note', 'research']))
    assert {hit['content_type'] for hit in multi['hits']} == {'note', 'research'}, multi
    for invalid_filter in [['typo'], [], 'skill']:
      invalid = json.loads(server.search_knowledge('fixture', content_type_filter=invalid_filter))
      assert invalid['ok'] is False, invalid
    empty = json.loads(server.search_knowledge('fixture', content_type_filter=['recipe']))
    assert empty['ok'] is True and empty['hits'] == [] and empty['groups'] == {} and empty['counts'] == {}, empty
    for kind, search_name, read_name in [('skill', 'search_skills', 'get_skill'), ('note', 'search_notes', 'get_note'),
                       ('research', 'search_research', 'get_research'), ('script', 'search_scripts', 'get_script')]:
      typed = json.loads(getattr(server, search_name)('fixture', limit=10, detail='standard'))
      assert len(typed['hits']) == 1 and typed['hits'][0]['content_type'] == kind, typed
      assert typed['groups'][kind] == ['pkm://knowledge/item-' + kind], typed
      assert contract_calls[-1][1]['content_type_filter'] == [kind], contract_calls[-1]
      loaded = json.loads(getattr(server, read_name)(id=typed['hits'][0]['source_id']))
      assert loaded['content_type'] == kind and loaded['content_hash'] == typed['hits'][0]['content_hash'], loaded
      assert loaded['read_only'] is (kind == 'script'), loaded
    assert json.loads(server.get_note(id='pkm://knowledge/item-skill'))['ok'] is False
    assert json.loads(server.get_note(id='different', slug='Projects/Release Constraints'))['ok'] is False
    assert json.loads(server.get_skill(name='Python Testing'))['name'] == 'Python Testing'
    assert json.loads(server.get_note(slug='Projects/Release Constraints'))['slug'] == 'Projects/Release Constraints'
    assert json.loads(server.search_papers('fixture', limit=10, detail='standard')) == json.loads(server.search_research('fixture', limit=10, detail='standard'))
    created_paper = json.loads(server.add_paper('Contract Research Fixture', category='Adhoc', content='Fixture body'))
    assert json.loads(server.get_paper(slug=created_paper['slug'])) == json.loads(server.get_research(slug=created_paper['slug']))
    assert json.loads(server.list_research()) == json.loads(server.list_papers())
    async def standard_transport():
      async with Client(server.mcp) as client:
        definitions = {tool.name: tool for tool in await client.list_tools()}
        for tool_name in ['search_skills', 'search_notes', 'search_research', 'search_scripts']:
          definition = definitions[tool_name]
          assert {'query', 'limit', 'detail'} <= set(definition.inputSchema['properties']), definition
          assert definition.inputSchema['properties']['limit']['default'] == 20, definition
          assert definition.annotations.readOnlyHint is True, definition
          called = (await client.call_tool(tool_name, {'query': 'fixture', 'limit': 10, 'detail': 'standard'})).structured_content
          assert called['ok'] is True and len(called['hits']) == 1 and called['result_count'] == 1, called
        loaded = (await client.call_tool('get_script', {'id': 'pkm://knowledge/item-script'})).structured_content
        assert loaded['content_type'] == 'script' and loaded['read_only'] is True, loaded
    asyncio.run(standard_transport())
finally:
    server._retrieval_request = contract_request
`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
import io
saved_request = server._retrieval_request
saved_urlopen = server.urllib.request.urlopen
server._retrieval_request = http_retrieval_request
def canonical_denial(request, timeout):
    assert request.full_url.endswith('/get'), request.full_url
    raise server.urllib.error.HTTPError(request.full_url, 404, 'Not found', {},
        io.BytesIO(json.dumps({'ok': False, 'code': 'not-found', 'error': 'Knowledge source not found'}).encode()))
server.urllib.request.urlopen = canonical_denial
try:
    denied = json.loads(server.get_skill(id='pkm://subscriptions/node-1/share-1/skills/Team/Remote%20Skill.md'))
    assert denied['ok'] is False and denied['code'] == 'not-found' and 'content' not in denied, denied
finally:
    server._retrieval_request = saved_request
    server.urllib.request.urlopen = saved_urlopen
print('Knowledge MCP contracts: mixed/strict retrieval, classification, limits, standard transport, stable reads, aliases and denial handling passed')
`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
# BR-13: normal (compact) MCP output must retain provenance and zero-hit status.
def dual_fixture(path, payload=None):
    route = payload['route']
    evidence = [dict(path='lexical', rank=1, score=500, matched_field='title', matched_path='pkm://notes/network', match='keyword'),
                dict(path='semantic', rank=2, score=.001, matched_field='embedding-index', matched_path='pkm://notes/network', match='semantic')]
    hits = [] if route == 'semantic' else [dict(rank=1, score=1/61 + 1/62, skill_id='note:network', source_id='pkm://notes/network',
        content_hash='a'*64, source_revision='r1', content_type='note', source_uri='pkm://notes/network', title='Network', description='',
        sources=['lexical','semantic'], source_label='both', path_evidence=evidence, score_semantics='rrf')]
    return dict(ok=True, route=route, search_mode=route, semantic_status='off' if route=='semantic' else 'fallback',
                semantic_reason='embedding not configured' if route=='semantic' else 'fixture provider failed', hits=hits,
                solution={'package_id': None, 'reason': 'execution-error'},
                skill_serving={'used': False, 'release_id': None, 'fallback_reason': 'fixture provider failed'})
previous_request = server._retrieval_request
server._retrieval_request = dual_fixture
try:
    result = json.loads(server.search_knowledge('network', route='dual'))
    assert result['search_mode'] == 'dual' and result['semantic_status'] == 'fallback', result
    assert result['hits'][0]['source_label'] == 'both' and result['hits'][0]['path_evidence'][1]['score'] == .001, result
    assert result['hits'][0]['score_semantics'] == 'rrf', result
    assert result['solution']['reason'] == 'execution-error' and result['skill_serving']['used'] is False, result
    empty = json.loads(server.search_notes('network', route='semantic'))
    assert empty['hits'] == [] and empty['semantic_status'] == 'off' and empty['search_mode'] == 'semantic', empty
    assert json.loads(server.search_notes('network', route='invalid'))['ok'] is False
    for tool in ['search_skills', 'search_scripts', 'search_research', 'search_papers']:
        empty = json.loads(getattr(server, tool)('network', route='semantic'))
        assert empty['hits'] == [] and empty['semantic_status'] == 'off', (tool, empty)
        dual = json.loads(getattr(server, tool)('network', route='dual'))
        assert dual['search_mode'] == 'dual' and dual['semantic_status'] == 'fallback', (tool, dual)
        assert json.loads(getattr(server, tool)('network', route='invalid'))['ok'] is False
    server._retrieval_request = lambda *_args, **_kwargs: dict(ok=False, error='worker offline')
    unavailable = json.loads(server.search_knowledge('network', route='dual'))
    assert unavailable['semantic_status'] == 'unavailable' and 'offline' in unavailable['semantic_reason'], unavailable
    for tool in ['search_skills', 'search_notes', 'search_scripts', 'search_research', 'search_papers']:
        unavailable = json.loads(getattr(server, tool)('network', route='semantic'))
        assert unavailable['ok'] is False and unavailable['semantic_status'] == 'unavailable', (tool, unavailable)
finally:
    server._retrieval_request = previous_request
async def model_route_discovery():
    async with Client(server.mcp) as client:
        tools = {tool.name: tool for tool in await client.list_tools()}
        for name in ['search_skills', 'search_notes', 'search_scripts', 'search_research', 'search_papers']:
            assert tools[name].inputSchema['properties']['route']['default'] == 'lexical', name
asyncio.run(model_route_discovery())
print('BR-13 MCP: compact source labels/evidence, explicit modes, empty off status and transport unavailable passed')
`);
  if (process.env.PKM_RETRIEVAL_LIVE_STATE) {
    assert(path.isAbsolute(process.env.PKM_RETRIEVAL_LIVE_STATE));
    fs.appendFileSync(path.join(moduleDir, "exercise.py"), `
server.RETRIEVAL_STATE = server.Path(${JSON.stringify(process.env.PKM_RETRIEVAL_LIVE_STATE)})
server._retrieval_request = http_retrieval_request
server.urllib.request.urlopen = original_urlopen
live_snapshot = json.loads((server.RETRIEVAL_STATE / 'snapshot.json').read_text())
async def live_model_acceptance():
    async with Client(server.mcp) as client:
        for name, kind in [('search_skills','skill'), ('search_notes','note'), ('search_scripts','script'),
                           ('search_research','research'), ('search_papers','research')]:
            document = next(value for value in live_snapshot['documents']
                            if value['content_type'] == kind and value.get('visibility') != 'private' and value.get('title'))
            response = await client.call_tool(name, {'query': document['title'], 'route':'semantic', 'limit':5})
            assert not response.is_error, (name, response)
            value = json.loads(response.content[0].text)
            assert value['ok'] and value['semantic_status'] == 'ready' and value['hits'], (name, value)
            assert value['skill_serving']['used'] is True and value['solution']['package_id'], (name, value)
            assert all(hit['content_type'] == kind and 'semantic' in hit['sources'] for hit in value['hits']), (name, value)
            print('Live MCP semantic acceptance:', name, value['solution']['package_id'], len(value['hits']))
asyncio.run(live_model_acceptance())
`);
  }
  execFileSync("python", [path.join(moduleDir, "exercise.py")], { cwd: moduleDir, stdio: "inherit" });
  fs.writeFileSync(path.join(moduleDir, "feature-domains.json"), JSON.stringify({ schema: 1, enabled: ["skillRouter"] }));
  fs.writeFileSync(path.join(moduleDir, "feature-domains.py"), "import asyncio, json, server\nfrom fastmcp import Client\nasync def main():\n  async with Client(server.mcp) as client:\n    names = {tool.name for tool in await client.list_tools()}\n    assert {'check_version','skill_context','search_knowledge','search_skills','get_skill','retrieval_status'} <= names, names\n    assert not ({'list_notes','add_skill','recipe_capabilities','agent_session_capabilities'} & names), names\n    response = await client.call_tool('check_version', {})\n    assert not response.is_error\nasyncio.run(main())\nversion = server.check_version()\nassert version['enabled_feature_domains'] == ['skillRouter'] and version['capabilities'] == ['pkm-skills'], version\nassert 'recipe_discovery_tool' not in version and version['skill_discovery_tool'] == 'skill_capabilities', version\nevents = list((server.STORE / '.pkm' / 'state' / 'mcp-usage' / 'events').glob('*.json'))\nassert events, events\nusages = [json.loads(event.read_text(encoding='utf-8')) for event in events]\nusage = next(item for item in reversed(sorted(usages, key=lambda item: item['occurredAt'])) if item['toolName'] == 'check_version')\nassert usage['inputBytes'] >= 0 and usage['outputBytes'] > 0, usage\nassert usage['estimatedTokenEquivalent'] > 0 and usage['reportedTokens'] == {'input': 0, 'output': 0}, usage\nprint('MCP feature domains: discovery filtering and call-boundary evidence OK')\n");
  execFileSync("python", [path.join(moduleDir, "feature-domains.py")], { cwd: moduleDir, stdio: "inherit" });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
