#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-skill-mcp-"));
try {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "mcp.ts"), "utf8");
  const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\n\n  fs\.writeFileSync\(reqTxt/.exec(source);
  assert(match, "could not extract generated unified MCP server template");
  const store = path.join(root, "store");
  fs.mkdirSync(path.join(store, "skills", "Coding"), { recursive: true });
  fs.writeFileSync(path.join(store, "skills", "Coding", "Python Testing.md"), `---\nname: Python Testing\ndescription: Use when debugging Python tests with pytest and import errors.\ntags:\n  - python\n  - pytest\ncreated: 2026-08-12\n---\n\nRun pytest with the repository source path configured.\n`);
  fs.mkdirSync(path.join(store, "skills", "Project", "Common"), { recursive: true });
  fs.writeFileSync(path.join(store, "skills", "Project", "Common", "TODO Notes.md"), `---\nname: TODO Notes\ndescription: Use for project task checklists, progress notes, coding work, and issue tracking.\ntags:\n  - task\n  - coding\n  - notes\ncreated: 2026-08-12\n---\n\nFormat project work as a hierarchical checklist with verification evidence.\n`);
  fs.writeFileSync(path.join(store, "skills", "Coding", "Scope Python Packaging.md"), `---\nname: Scope Python UDO Dependency Packaging\ndescription: Package and import local Python dependencies for Scope UDO execution.\ntags:\n  - python\n  - package\n  - scope\ncreated: 2026-08-12\n---\n\nConfigure dependency archives and import paths.\n`);
  fs.writeFileSync(path.join(store, "skills", "Project", "Common", "Azure PIM.md"), `---\nname: Azure PIM Role Activation\ndescription: Use when that member needs an Azure privileged role and identity permissions.\ntags:\n  - azure\n  - role\n  - identity\ncreated: 2026-08-12\n---\n\nNo member name is required after role activation; validate data access.\n`);

  const subscriptionCache = path.join(root, "subscription-cache");
  const subscribedRoot = path.join(subscriptionCache, "node-1", "share-1");
  fs.mkdirSync(path.join(subscribedRoot, "content", "skills", "Team"), { recursive: true });
  fs.writeFileSync(path.join(subscribedRoot, "_subscription.json"), JSON.stringify({ subscriptionId: "sub-1", alias: "Team Broker", publisher: "Colleague", nodeId: "node-1", shareId: "share-1", revision: 3, collectionHash: "sha256:test", syncedAt: "2026-09-03T01:02:03Z" }));
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "Remote Skill.md"), "Explicit subscribed knowledge content");
  fs.writeFileSync(path.join(subscribedRoot, "content", "skills", "Team", "Remote Skill.md.pkm-source.json"), JSON.stringify({ subscriptionAlias: "Team Broker", publisher: "Colleague", shareId: "share-1", revision: 3, syncedAt: "2026-09-03T01:02:03Z" }));
  const render = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION", "storeFwd", "subscriptionCacheFwd", `return \`${match[1]}\`;`);
  const server = render("test", "test", "test", store.replaceAll('\\', '/'), subscriptionCache.replaceAll('\\', '/'));
  const moduleDir = path.join(root, "module");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "server.py"), server);
  fs.writeFileSync(path.join(moduleDir, "chat_server.py"), "from fastmcp import FastMCP\nmcp = FastMCP('chat-stub')\n");
  fs.writeFileSync(path.join(moduleDir, "exercise.py"), `import json, pathlib\nimport server\ncap = json.loads(server.skill_capabilities())\nassert cap['capability'] == 'pkm-skills'\nassert pathlib.Path(server.STORE) == pathlib.Path(r'${store.replaceAll('\\', '\\\\')}'), server.STORE\nassert server._all_skills(), (server.STORE, server.SKILLS, list(server.SKILLS.rglob('*')))\ncontext = json.loads(server.skill_context('debug pytest Python import errors'))\nassert context['count'] == 1, context\nassert context['no_match'] is False and context['retrieval'] == 'summary', context\nskill = context['skills'][0]\nassert skill['skill_id'] == 'Coding/Python Testing'\nassert skill['content_hash']\nassert 'content' not in skill, skill\nfull_skill = json.loads(server.get_skill(skill['skill_id']))\nassert full_skill['skill_id'] == skill['skill_id']\nassert full_skill['content_hash'] == skill['content_hash']\nassert 'Run pytest' in full_skill['content']\nno_match = json.loads(server.skill_context('organize a birthday picnic menu'))\nassert no_match['no_match'] is True and no_match['count'] == 0, no_match\nfeedback = json.loads(server.skill_feedback('debug tests', [skill['skill_id']], 'success', ['PYTHONPATH was required'], ['pytest passed']))\nassert feedback['feedback_id']\nproposal = json.loads(server.propose_skill_update(skill['skill_id'], skill['content_hash'], 'Document PYTHONPATH', ['pytest passed'], 'Add the verified command.', 0.9))\nassert proposal['ok'] and proposal['conflict'] is False\nconflict = json.loads(server.propose_skill_update(skill['skill_id'], 'stale-hash', 'Stale proposal'))\nassert conflict['conflict'] is True\nassert pathlib.Path(proposal['proposal_path']).exists()\nassert (pathlib.Path(r'${store.replaceAll('\\', '\\\\')}') / '_feedback' / 'skill-usage.jsonl').exists()\nprint('PKM Skill MCP: thresholded summaries, full fetch, feedback, proposal, and conflict detection OK')\n`);
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "positive = json.loads(server.skill_context('Package Python dependencies and import paths for a Scope Python UDO'))\nassert positive['skills'][0]['skill_id'] == 'Coding/Scope Python UDO Dependency Packaging', positive\nassert positive['skills'][0]['task_coverage'] >= 0.7, positive\nrename_context = json.loads(server.skill_context(\"Debug and fix PKM Chatroom participant rename where entering a new name and role does not update the roster and reports 'That member is no longer in the room roster'. Trace stable participant identity across rename and role editing, add regression coverage.\", workspace='/workspace', files=['src/chatroom-hub.ts'], diagnostics='That member is no longer in the room roster.'))\nassert rename_context['no_match'] is True and rename_context['count'] == 0, rename_context\n");
  fs.appendFileSync(path.join(moduleDir, "exercise.py"), "subscriptions = json.loads(server.list_subscriptions())\nassert subscriptions[0]['alias'] == 'Team Broker', subscriptions\nsubscribed = json.loads(server.search_subscribed_content('subscribed knowledge', content_type='skills', alias='Team Broker'))\nassert len(subscribed) == 1 and subscribed[0]['share_id'] == 'share-1', subscribed\nremote = json.loads(server.get_subscribed_content('node-1', 'share-1', 'skills', 'Team/Remote Skill.md'))\nassert 'Explicit subscribed knowledge' in remote['content'], remote\nassert remote['provenance']['subscriptionAlias'] == 'Team Broker', remote\n");
  execFileSync("python", [path.join(moduleDir, "exercise.py")], { cwd: moduleDir, stdio: "inherit" });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
