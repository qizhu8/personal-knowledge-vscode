#!/usr/bin/env node
const assert = require('assert');
const {
  availableSkillRouterSources,
  normalizeSkillRouterSourcePriority,
} = require('../dist/skill-router-config.js');

const sources = availableSkillRouterSources([
  { id: 'sub-z', alias: 'Zulu', publisher: 'Publisher Z' },
  { id: 'sub-a', alias: 'Alpha', publisher: 'Publisher A' },
]);

assert.deepStrictEqual(
  sources.map(source => source.id),
  ['pkm-personal', 'agent-native', 'subscriber:sub-a', 'subscriber:sub-z'],
  'fixed sources must lead the default list and Subscribers must be stable and deterministic',
);
assert.deepStrictEqual(
  normalizeSkillRouterSourcePriority(
    ['subscriber:sub-z', 'pkm-personal', 'subscriber:missing', 'subscriber:sub-z'],
    sources,
  ),
  ['subscriber:sub-z', 'pkm-personal', 'agent-native', 'subscriber:sub-a'],
  'normalization must preserve valid order, remove stale/duplicate IDs, and append new sources',
);

console.log('Router source config: stable IDs, deterministic defaults, and normalization OK');
