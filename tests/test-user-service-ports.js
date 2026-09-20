#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stableUserPort } = require('../dist/user-service-ports.js');

const userA = { username: 'alice', uid: 1001, gid: 1001, shell: '', homedir: '/home/alice' };
const userB = { username: 'bob', uid: 1002, gid: 1002, shell: '', homedir: '/home/bob' };
const services = ['serversProxyPort', 'contentGatewayPort', 'chatHubPort', 'subscriptionPort'];

const portsA = services.map(service => stableUserPort(service, userA));
const portsB = services.map(service => stableUserPort(service, userB));
assert.strictEqual(new Set(portsA).size, services.length, 'one user must receive distinct ports per service');
assert.strictEqual(new Set([...portsA, ...portsB]).size, services.length * 2, 'different UIDs must receive different host ports');
assert.deepStrictEqual(services.map(service => stableUserPort(service, userA)), portsA, 'allocation must be deterministic');
assert(portsA.every(port => port >= 1024 && port <= 65535));

const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
const subscriptions = fs.readFileSync(path.join(__dirname, '..', 'src', 'subscriptions.ts'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.match(extension, /inspect<number>\(setting\)/);
assert.match(extension, /globalValue === undefined/);
assert.match(extension, /stableUserPort\(setting\)/);
assert.match(subscriptions, /stableUserPort\("subscriptionPort"\)/);
for (const setting of ['serversProxyPort', 'contentGatewayPort', 'chatHubPort']) {
  assert.strictEqual(manifest.contributes.configuration.properties[`personalKnowledge.${setting}`].scope, 'machine');
}

console.log('user service ports test: deterministic per-user allocation, service separation, persistence, and machine scope OK');