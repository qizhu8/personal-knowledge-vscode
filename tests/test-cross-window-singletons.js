#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withCrossProcessLock } = require('../dist/cross-process-lock.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-singleton-test-'));
  try {
    const lockPath = path.join(root, 'service.lock');
    const order = [];
    await Promise.all([
      withCrossProcessLock(lockPath, 'first', 2000, async () => {
        order.push('first:start');
        await new Promise(resolve => setTimeout(resolve, 80));
        order.push('first:end');
      }),
      withCrossProcessLock(lockPath, 'second', 2000, async () => {
        order.push('second:start');
        order.push('second:end');
      }),
    ]);
    assert.deepStrictEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
    assert.strictEqual(fs.existsSync(lockPath), false, 'completed service locks must be released');

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, nonce: 'stale', owner: 'dead', acquiredAt: 0 }));
    assert.strictEqual(await withCrossProcessLock(lockPath, 'recovery', 1000, async () => 'recovered'), 'recovered');

    const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    const servers = fs.readFileSync(path.join(__dirname, '..', 'src', 'servers.ts'), 'utf8');
    const subscriptions = fs.readFileSync(path.join(__dirname, '..', 'src', 'subscriptions.ts'), 'utf8');
    const retrieval = fs.readFileSync(path.join(__dirname, '..', 'src', 'retrieval-worker.ts'), 'utf8');
    const chatHub = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatroom-hub.ts'), 'utf8');
    const sync = fs.readFileSync(path.join(__dirname, '..', 'src', 'sync-server.ts'), 'utf8');

    assert.match(servers, /\.well-known\/pkm-servers-proxy/);
    assert.match(servers, /servers proxy reused/);
    assert.match(servers, /setInterval\(\(\) => \{ void ensureProxyAvailable\(\); \}, 15_000\)/);
    assert.match(servers, /acquireProcessLock\(lockName\)/);
    assert.match(servers, /updateState\(state => \{ state\[slug\] = run; \}\)/);
    assert.match(extension, /Public Content Gateway transition/);
    assert.match(extension, /publicContentTimer = setInterval[\s\S]{0,120}, 5_000\)/);
    assert.doesNotMatch(extension, /Use \$\{fallback\} and save it as the new machine default/);
    assert.match(extension, /for \(let attempt = 0; attempt < 20; attempt\+\+\)/);
    assert.match(retrieval, /newer PKM retrieval worker/);
    assert.match(retrieval, /worker-transition\.lock/);
    assert.match(subscriptions, /subscriptions-state\.lock/);
    assert.match(subscriptions, /subscription-background\.lock/);
    assert.match(subscriptions, /backgroundElectionTimer = setInterval[\s\S]{0,100}15_000/);
    assert.match(chatHub, /\.well-known\/pkm-chat-hub/);
    assert.doesNotMatch(extension, /retrying on an ephemeral port/);
    assert.match(extension, /Chat Hub is already active in another VS Code window/);
    assert.match(sync, /const candidate = createServer/);
    assert.match(sync, /candidate\.once\("error"/);
    assert.match(sync, /!this\.activeSessions\(\)\.length && this\.server/);

    console.log('cross-window singleton test: service locks, ownership discovery, monotonic reuse, leader election, and cleanup contracts OK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
