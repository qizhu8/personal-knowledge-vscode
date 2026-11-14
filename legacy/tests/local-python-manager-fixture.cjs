"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const [build, root, executable, cache] = process.argv.slice(2);
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
const { planPythonCreation, createOfflinePythonEnvironment, inspectPythonFolder } = require(path.join(build, "runtime/local-python-management.js"));
async function main() {
  require("./private-linux-account-fixture.cjs")(root, path.join(root, "home"));
  const outcomes = {};
  const snapshot = require("./local-python-manager-cache-snapshot.cjs"), sourceBefore = snapshot(cache);
  for (const mode of ["success", "cancel", "conflict", "empty-cache"]) {
    const storage = path.join(root, mode); fs.mkdirSync(storage, { mode: 0o700 });
    const store = new LocalEnvironmentCatalog(path.join(storage, "catalog"));
    const selectedCache = mode === "empty-cache" ? path.join(storage, "empty-cache") : cache;
    if (mode === "empty-cache") fs.mkdirSync(selectedCache, { mode: 0o700 });
    const authority = new LocalPythonManagerAuthority(() => true);
    const manager = authority.select("conda", executable, selectedCache), before = store.read();
    const entry = planPythonCreation(storage, `local-${mode}`, "", "conda"), abort = new AbortController();
    let checks = 0, launchedCreate = false;
    const operation = createOfflinePythonEnvironment({ storage, entry, store, expected: before.digest, signal: abort.signal,
      provider: authority.provider(manager, { pythonVersion: "3.11", report(phase) {
        if (phase === "conda-create") { launchedCreate = true; if (mode === "cancel") abort.abort(); }
      } }),
      check() {
        authority.validate(manager);
        if (++checks === 3 && mode === "conflict") store.register({ id: "concurrent-node", name: "Concurrent", language: "javascript",
          kind: "runtime", manager: "local", executors: [{ id: "node", executable: process.execPath }] }, store.read().digest);
      } });
    if (mode === "success") {
      await operation; assert(launchedCreate);
      const output = execFileSync(entry.executors[0].executable, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
        { env: {}, cwd: storage, encoding: "utf8" }).trim();
      assert.equal(output, entry.root); assert.equal(store.read().catalog.entries[0].manager, "conda");
      outcomes.success = { actualPrefix: output, manager: "conda", offline: true };
    } else {
      await assert.rejects(operation, mode === "cancel" ? /cancelled/ : mode === "conflict" ? /Catalog changed/ : /failed|not.*found|unavailable/i);
      assert(!store.read().catalog.entries.some(item => item.id === entry.id));
      assert(fs.existsSync(entry.root), "Partial files must never be deleted.");
      if (mode === "cancel") assert(launchedCreate, "Cancellation must stop a genuinely spawned owned manager child.");
      if (mode === "conflict") {
        const recovered = inspectPythonFolder(entry.root, "Explicit completed-folder recovery");
        store.register(recovered, store.read().digest); assert.equal(recovered.manager, "conda");
        assert(fs.existsSync(entry.executors[0].executable));
      }
      outcomes[mode] = { preservedDirectory: entry.root, automaticReplay: false, falseSuccess: false };
    }
    authority.validate(manager); authority.revoke();
  }
  const sourceAfter = snapshot(cache); assert.equal(sourceAfter, sourceBefore, "Original selected cache attributes/repodata must not change.");
  outcomes.sourceCache = { before: sourceBefore, after: sourceAfter,
    scope: "cache root/top-level identities and attributes, repodata bytes; not an all-files forensic hash" };
  process.stdout.write(JSON.stringify(outcomes));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
