const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JsonFileCache } = require("../dist/json-file-cache");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-json-cache-"));
try {
  const cache = new JsonFileCache(2);
  const first = path.join(root, "first.json");
  fs.writeFileSync(first, JSON.stringify({ value: "one" }));
  assert.deepStrictEqual(cache.read(first), { value: "one" });
  assert.deepStrictEqual(cache.read(first), { value: "one" });
  assert.deepStrictEqual(cache.stats(), { entries: 1, hits: 1, misses: 1 });

  const replacement = path.join(root, "replacement.json");
  fs.writeFileSync(replacement, JSON.stringify({ value: "two" }));
  fs.renameSync(replacement, first);
  assert.deepStrictEqual(cache.read(first), { value: "two" });
  assert.strictEqual(cache.stats().misses, 2);

  for (const [name, value] of [["second", 2], ["third", 3]]) {
    const file = path.join(root, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ value }));
    cache.read(file);
  }
  assert.strictEqual(cache.stats().entries, 2);

  const invalid = path.join(root, "invalid.json");
  fs.writeFileSync(invalid, "{");
  assert.throws(() => cache.read(invalid), SyntaxError);
  fs.writeFileSync(invalid, JSON.stringify({ recovered: true }));
  assert.deepStrictEqual(cache.read(invalid), { recovered: true });
  console.log("JSON file cache: hits, atomic replacement invalidation, bounds, and recovery OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
