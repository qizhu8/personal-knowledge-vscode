#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnowledgeInventoryManager } = require('../dist/knowledge-inventory.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-inventory-root-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-inventory-state-'));
  const worker = path.join(__dirname, '..', 'dist', 'knowledge-inventory-worker.js');
  try {
    const noteDir = path.join(root, 'notes', 'Project', 'Deep');
    const skillDir = path.join(root, 'skills', 'Coding');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    const scriptDir = path.join(root, 'scripts', 'Tools');
    fs.mkdirSync(scriptDir, { recursive: true });
    const notePath = path.join(noteDir, 'progress.md');
    fs.writeFileSync(notePath, '---\ntitle: First Progress\ntype: general\n---\nbody');
    fs.writeFileSync(path.join(skillDir, 'Testing.md'), '---\nname: Testing\ndescription: tests\n---\nbody');
    fs.writeFileSync(path.join(scriptDir, 'check.py'), 'print("ok")');

    const manager = new KnowledgeInventoryManager(root, state, worker);
    const progress = [];
    const first = await manager.refresh(value => progress.push(value));
    assert(progress.some(value => value.batchCount === 3), 'first scan must stream parsed entries before completion');
    assert.strictEqual(first.stats.scanned, 3);
    assert.strictEqual(first.stats.parsed, 3);
    assert.strictEqual(manager.notes()[0].title, 'First Progress');
    assert.deepStrictEqual(manager.folders('notes'), ['Project', 'Project/Deep']);
    assert.strictEqual(manager.skills()[0].name, 'Testing');
    assert.deepStrictEqual(manager.scripts()[0], {
      path: 'Tools/check.py', file: 'check.py', category: 'Tools', extension: '.py', lang: 'Python', size: 11, updatedAt: manager.scripts()[0].updatedAt,
    });

    const second = await manager.refresh();
    assert.strictEqual(second.stats.reused, 3);
    assert.strictEqual(second.stats.parsed, 0);
    fs.writeFileSync(notePath, '---\ntitle: Updated Progress\ntype: general\n---\nupdated body is larger');
    const third = await manager.refresh();
    assert.strictEqual(third.stats.reused, 2);
    assert.strictEqual(third.stats.parsed, 1);
    assert.strictEqual(manager.notes()[0].title, 'Updated Progress');

    fs.rmSync(path.join(skillDir, 'Testing.md'));
    const fourth = await manager.refresh();
    assert.strictEqual(fourth.stats.removed, 1);
    const restored = new KnowledgeInventoryManager(root, state, worker);
    assert.strictEqual(restored.snapshot.revision, fourth.revision);
    assert.strictEqual(restored.notes()[0].title, 'Updated Progress');
    assert(fs.existsSync(path.join(state, 'manifest.json')));
    console.log('knowledge inventory test: persisted manifest, async scan, unchanged reuse, one-file parse, deletion, and restart restore OK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
