import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { prepareLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
function snapshot(root) {
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, file = join(directory, name), stat = lstatSync(file, { bigint: true });
      entries.push({ path, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size),
        mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
        ...(stat.isFile() ? { sha256: createHash("sha256").update(readFileSync(file)).digest("hex") } : {}) });
      if (stat.isDirectory()) visit(file, path);
    }
  }
  visit(root); return entries;
}
test("ordinary API Chat adopts its actual original root; real MCP/HTTP clients read segmented/PNG history, continue and recover real process failures", async t => {
  const directory = join(project, ".migration-test-work", `api-chat-upgrade-${randomUUID()}`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await fixture.runUpgrade({ extension: project, root: join(directory, "knowledge"),
    runtime: join(project, "../"), node: process.execPath });
  assert.equal(result.takeover, "EXPERIMENTAL_SAME_ROOT");
  assert.equal(result.nativeHttpContinuation, true);
  assert.equal(result.crashRecoveredWithoutDuplicateEffect, true);
  assert.equal(result.unknownProviderOutcome, "BLOCKED_NO_REISSUE");
  assert.equal(result.originalSourceUnchanged, true);
});
test("API Chat receipt does not admit unrelated Session controls or mutate any original state on refusal", async t => {
  const directory = join(project, ".migration-test-work", `api-chat-refusal-${randomUUID()}`), root = join(directory, "knowledge");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mask = process.umask(0o077);
  try {
    fixture.create({ extension: project, root });
    mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic.\n", { mode: 0o600 });
    mkdirSync(join(root, ".pkm/state/agent-sessions"), { mode: 0o700 });
    writeFileSync(join(root, ".pkm/state/agent-sessions/unsupported.json"), "{}", { mode: 0o600 });
  } finally { process.umask(mask); }
  const before = snapshot(root);
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {}), error => error.code === "PKM_STATE_UNSUPPORTED");
  assert.deepEqual(snapshot(root), before);
  assert(!existsSync(join(root, "core.sqlite")));
  assert(!existsSync(join(root, ".pkm-next-root-adoption.json")));
});
