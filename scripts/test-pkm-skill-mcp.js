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

  const render = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION", "storeFwd", `return \`${match[1]}\`;`);
  const server = render("test", "test", "test", store.replaceAll('\\', '/'));
  const moduleDir = path.join(root, "module");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "server.py"), server);
  fs.writeFileSync(path.join(moduleDir, "chat_server.py"), "from fastmcp import FastMCP\nmcp = FastMCP('chat-stub')\n");
  fs.writeFileSync(path.join(moduleDir, "exercise.py"), `import json, pathlib\nimport server\ncap = json.loads(server.skill_capabilities())\nassert cap['capability'] == 'pkm-skills'\nassert pathlib.Path(server.STORE) == pathlib.Path(r'${store.replaceAll('\\', '\\\\')}'), server.STORE\nassert server._all_skills(), (server.STORE, server.SKILLS, list(server.SKILLS.rglob('*')))\ncontext = json.loads(server.skill_context('debug pytest Python import errors'))\nassert context['count'] == 1, context\nskill = context['skills'][0]\nassert skill['skill_id'] == 'Coding/Python Testing'\nassert skill['content_hash']\nfeedback = json.loads(server.skill_feedback('debug tests', [skill['skill_id']], 'success', ['PYTHONPATH was required'], ['pytest passed']))\nassert feedback['feedback_id']\nproposal = json.loads(server.propose_skill_update(skill['skill_id'], skill['content_hash'], 'Document PYTHONPATH', ['pytest passed'], 'Add the verified command.', 0.9))\nassert proposal['ok'] and proposal['conflict'] is False\nconflict = json.loads(server.propose_skill_update(skill['skill_id'], 'stale-hash', 'Stale proposal'))\nassert conflict['conflict'] is True\nassert pathlib.Path(proposal['proposal_path']).exists()\nassert (pathlib.Path(r'${store.replaceAll('\\', '\\\\')}') / '_feedback' / 'skill-usage.jsonl').exists()\nprint('PKM Skill MCP: capabilities, context, feedback, proposal, and conflict detection OK')\n`);
  execFileSync("python", [path.join(moduleDir, "exercise.py")], { cwd: moduleDir, stdio: "inherit" });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
