"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { prepareServerDependencyTree } = require("../scripts/next-rehearsal-runtime");

function fixture(t) {
  const base = path.resolve(".migration-test-work", `package-dependencies-${randomUUID()}`);
  const server = path.join(base, "server"), extension = path.join(base, "extension"), output = path.join(base, "output");
  for (const dir of [path.join(server, "node_modules"), path.join(extension, "node_modules"), output])
    fs.mkdirSync(dir, { recursive: true });
  const declared = { name: "private-server", version: "1.0.0", dependencies: { "fixture-dep": "1.2.3" } };
  const lock = { packages: { "node_modules/fixture-dep": { version: "1.2.3" } } };
  fs.writeFileSync(path.join(server, "package.json"), JSON.stringify(declared));
  fs.writeFileSync(path.join(server, "package-lock.json"), JSON.stringify(lock));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = (root, version) => {
    const dir = path.join(root, "node_modules", "fixture-dep");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-dep", version }));
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = 'fixture';");
  };
  return { server, extension, output, declared, lock, install };
}

test("packaging materializes an exact lock-matching hoisted direct dependency privately", t => {
  const f = fixture(t);
  f.install(f.extension, "1.2.3");
  const result = prepareServerDependencyTree(f.output, f.server, f.extension, f.declared, f.lock);
  assert.equal(require(path.join(result.modules, "fixture-dep")), "fixture");
  assert(!fs.existsSync(path.join(f.server, "node_modules", "fixture-dep")));
  assert.equal(result.temporary, path.join(f.output, ".server-dependency-input"));
});

test("packaging resolves hoisted dependencies when the server has no local node_modules", t => {
  const f = fixture(t);
  f.install(f.extension, "1.2.3");
  fs.rmSync(path.join(f.server, "node_modules"), { recursive: true });
  const result = prepareServerDependencyTree(f.output, f.server, f.extension, f.declared, f.lock);
  assert.equal(require(path.join(result.modules, "fixture-dep")), "fixture");
  assert(!fs.existsSync(path.join(f.server, "node_modules")));
});

test("packaging refuses missing or mismatched hoisted dependencies and does not replace local ones", t => {
  const f = fixture(t);
  assert.throws(() => prepareServerDependencyTree(f.output, f.server, f.extension, f.declared, f.lock),
    /Missing locked next-server dependency/);
  f.install(f.extension, "1.2.4");
  assert.throws(() => prepareServerDependencyTree(f.output, f.server, f.extension, f.declared, f.lock),
    /does not match next-server lockfile/);
  f.install(f.server, "1.2.3");
  const result = prepareServerDependencyTree(f.output, f.server, f.extension, f.declared, f.lock);
  assert.equal(result.server, f.server);
  assert.equal(result.temporary, undefined);
});
