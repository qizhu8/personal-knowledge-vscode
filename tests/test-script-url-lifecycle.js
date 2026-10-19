const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const storage = require("../dist/knowledge/storage.js");
const { parsePkmLocator, resolvePkmLocator, PkmLocatorError } = require("../dist/knowledge/knowledge-locator.js");

test("Script URL survives move and Knowledge Root relocation and opens the current file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-url-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "publisher");
  const receiver = path.join(root, "receiver");
  fs.mkdirSync(path.join(original, "scripts/Tools"), { recursive: true });
  fs.writeFileSync(path.join(original, "scripts/Tools/check.py"), "print('portable')\n");
  storage.setStorePath(original);
  const before = storage.scriptGet("Tools/check.py");
  const uri = `pkm://script/${before.knowledgeId}`;
  assert.equal(parsePkmLocator(uri).kind, "script");
  assert.equal(storage.scriptMove("Tools/check.py", "Moved"), true);
  fs.cpSync(original, receiver, { recursive: true });
  fs.rmSync(original, { recursive: true });
  storage.setStorePath(receiver);
  const after = storage.scriptGet(uri);
  assert.equal(after.path, "Moved/check.py");
  assert.equal(after.content, before.content);
  assert.equal(storage.scriptGet("pkm://scripts/Tools/check.py").path, after.path);
  const target = resolvePkmLocator(uri, [{
    area: "scripts", relativePath: after.path, slug: after.path, title: after.file,
    knowledgeId: after.knowledgeId, aliases: after.aliases,
  }]);
  assert.equal(target.type, "script");
  assert.equal(target.key, "Moved/check.py");
  for (const invalid of ["pkm://scripts/C%3A/secret.py", "pkm://scripts/a%2F..%2Fsecret.py", "pkm://knowledge/knowledge_0123456789abcdef01234567"]) {
    assert.throws(() => storage.scriptGet(invalid), error => error instanceof PkmLocatorError && error.code === "invalid");
  }
  const identity = storage.scriptIdentityFile(after.path);
  fs.writeFileSync(path.join(receiver, "scripts/duplicate.py"), "other");
  fs.copyFileSync(identity, storage.scriptIdentityFile("duplicate.py"));
  assert.throws(() => storage.scriptGet(uri), error => error instanceof PkmLocatorError && error.code === "duplicate");
});
