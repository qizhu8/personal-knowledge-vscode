#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DEFAULT_KNOWLEDGE_GITIGNORE_RULES, defaultKnowledgeGitignore } = require('../dist/root-storage-policy');

const ignore = defaultKnowledgeGitignore();
for (const rule of [
  'envs/', 'mcp-server/', 'packages/**/node_modules/', 'packages/**/dist/',
  'packages/**/artifacts/', 'packages/**/.vscode-test/', 'servers/**/.venv/',
  'servers/**/data/', 'servers/**/models/',
]) {
  assert(DEFAULT_KNOWLEDGE_GITIGNORE_RULES.includes(rule), `Knowledge Root must ignore ${rule}`);
  assert(ignore.split(/\r?\n/).includes(rule), `serialized Knowledge Root policy must include ${rule}`);
}

const environmentPaths = fs.readFileSync(path.join(__dirname, '..', 'src', 'environment-paths.ts'), 'utf8');
assert.match(environmentPaths, /path\.join\(os\.homedir\(\), "pkm-envs"\)/, 'managed environments must default outside the Knowledge Root');

console.log('root storage policy test: environments, server runtime data, models, dependencies, and build outputs are excluded from future Git growth OK');