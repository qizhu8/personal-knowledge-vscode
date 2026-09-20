#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { messageAddressesManagedAgent } = require('../dist/chat-managed-agent-routing');
const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
const aiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.ts'), 'utf8');

assert.strictEqual(messageAddressesManagedAgent({ text: 'please investigate', recipients: ['Agent With Spaces'] }, 'Agent With Spaces'), true,
  'recipient chips must activate a managed agent even when the body has no mention');
assert.strictEqual(messageAddressesManagedAgent({ text: 'team request', recipients: ['all'] }, 'Agent A'), true);
assert.strictEqual(messageAddressesManagedAgent({ text: '@"Agent A" legacy request' }, 'Agent A'), true,
  'legacy messages without structured recipients must retain text mention fallback');
assert.strictEqual(messageAddressesManagedAgent({ text: '@Other request', recipients: ['Other'] }, 'Agent A'), false);
assert.strictEqual(messageAddressesManagedAgent({ text: '@Agent A text disagrees with routing', recipients: ['Other'] }, 'Agent A'), false,
  'authoritative structured recipients must win over body text');
assert.strictEqual(messageAddressesManagedAgent({ text: 'plain message' }, 'Agent A'), false);

assert.match(extensionSource, /const directed = messageAddressesManagedAgent\(message, agent\.name\)/);
assert.match(extensionSource, /if \(status === "connected"\) \{[\s\S]{0,120}agent\.active = true;/,
  'a reconnected managed agent must resume processing directed messages');
assert.match(extensionSource, /agent\.pendingMessages\.push\(message\)/,
  'a directed message must enter the managed-agent mailbox');
assert.match(extensionSource, /if \(agent\.busy\) \{[\s\S]{0,180}queued:/,
  'a busy managed agent must retain newly directed messages instead of dropping them');
assert.match(extensionSource, /finally \{[\s\S]{0,600}drainManagedAgentMessages\(context, agent\)/,
  'the mailbox must continue draining after each generation finishes');
assert.doesNotMatch(extensionSource, /!agent\.active \|\| agent\.busy \|\| message\.from/,
  'busy must not remain an early-drop condition');
assert.match(aiSource, /setTimeout\(\(\) => cancellation\.cancel\(\), 90_000\)/);
assert.match(aiSource, /Copilot model response timed out after 90 seconds/);
assert.match(extensionSource, /agent\.status = failure \? `error: \$\{failure\}`/,
  'generation failures must remain visible instead of being overwritten by standby');

console.log('Managed Agent routing: structured recipients, reconnect activation, queued delivery, and bounded generation OK');
