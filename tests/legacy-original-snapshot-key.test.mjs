import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { planLegacyStateImport } from "../dist/legacy-state-import.js";
import { planLegacyImport } from "../dist/legacy-import.js";
import { inspectLegacyRootPkmPrivacyState } from "../dist/legacy-root-pkm-state.js";
import { snapshotFixture } from "./agent-snapshot-reads-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const algorithm = "A256GCM-PKM-LOCAL-OBFUSCATION/v1";
const olderAlgorithm = "A256GCM-PKM-INTERNAL/v1";

async function fixture(t) {
  const directory = join(repository, ".migration-test-work", `original-snapshot-${randomUUID()}`);
  const root = join(directory, "knowledge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return root;
}

function originalModule(path, overrides = {}, modules = new Map()) {
  const filename = resolve(repository, path);
  if (modules.has(filename)) return modules.get(filename).exports;
  const source = readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }, require = createRequire(filename);
  modules.set(filename, module);
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith(".")) return originalModule(require.resolve(`${name}.ts`), overrides, modules);
    return require(name);
  };
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename })(
    localRequire, module, module.exports, filename, dirname(filename));
  return module.exports;
}

async function contents(root) {
  const files = {};
  async function walk(directory, relative = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else files[name] = await readFile(join(directory, entry.name));
    }
  }
  await walk(root);
  return files;
}

test("original Agent Snapshot format uses disposable copies of its actual obfuscation keys", async t => {
  const root = await fixture(t);
  const original = await originalModule("src/agent-sessions/agent-snapshots.ts", { "../chat/chat-history-storage": {} });
  const session = snapshotFixture().payload.session;
  const sessionPath = join(root, ".pkm/state/agent-sessions", `${session.sessionId}.json`);
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
  await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 });
  const created = original.createAgentSnapshot(root, session.sessionId);
  await rm(sessionPath);
  const snapshotPath = join(root, ".pkm/state/agent-snapshots", `${created.snapshot.snapshotId}.json`);
  const before = await readFile(snapshotPath);
  assert.equal(JSON.parse(before).payload.algorithm, algorithm);

  assert.equal(original.copyAgentSnapshotObfuscationKey("unknown"), undefined);
  const key = original.copyAgentSnapshotObfuscationKey(algorithm);
  const other = original.copyAgentSnapshotObfuscationKey(olderAlgorithm);
  assert.equal(key.length, 32);
  assert.equal(other.length, 32);
  assert.notDeepEqual(key, other);
  key.fill(0); other.fill(0);
  assert.notDeepEqual(original.copyAgentSnapshotObfuscationKey(algorithm), key);
  const authority = {
    epoch: async () => "original-format-v1",
    key: async (requested, epoch) => epoch === "original-format-v1"
      ? original.copyAgentSnapshotObfuscationKey(requested) : undefined,
  };
  const plan = await planLegacyStateImport(root, undefined, authority);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.keyEpoch, "original-format-v1");
  assert.equal(JSON.stringify(plan).includes(original.copyAgentSnapshotObfuscationKey(algorithm).toString("base64")), false);
  await assert.rejects(planLegacyStateImport(root), { code: "KEY_AUTHORITY_REQUIRED" });
  await assert.rejects(planLegacyStateImport(root, undefined, { ...authority, key: async () => Buffer.alloc(32) }),
    { code: "INVALID_STATE" });
  let calls = 0;
  await assert.rejects(planLegacyStateImport(root, undefined, {
    ...authority, epoch: async () => ++calls < 3 ? "original-format-v1" : undefined,
  }), { code: "KEY_AUTHORITY_REQUIRED" });
  assert.deepEqual(await readFile(snapshotPath), before);

  const contents = original.readAgentSnapshotContents(root, created.snapshot.snapshotId);
  const snapshot = JSON.parse(before);
  const iv = randomBytes(12), legacyKey = original.copyAgentSnapshotObfuscationKey(olderAlgorithm);
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  cipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshot.snapshotId}:${snapshot.magicCode}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({
    session: contents.session, recipeRuns: contents.recipeRuns,
  })), cipher.final()]);
  legacyKey.fill(0);
  snapshot.payload = { algorithm: olderAlgorithm, iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  assert.deepEqual(original.readAgentSnapshotContents(root, created.snapshot.snapshotId), contents);
  const olderBytes = await readFile(snapshotPath);
  assert.equal((await planLegacyStateImport(root, undefined, authority)).entries.length, 1);
  assert.deepEqual(await readFile(snapshotPath), olderBytes);
});

test("an actual original Knowledge Snapshot repository remains blocked and unchanged", async t => {
  const root = await fixture(t);
  const mask = process.umask(0o077);
  try {
    const privacy = await originalModule("src/knowledge/content-privacy.ts");
    privacy.setPrivacyStoreRoot(root);
    privacy.setTopLevelPrivacy("notes", "Private", true);
    await mkdir(join(root, "notes/Private"), { recursive: true, mode: 0o700 });
    await mkdir(join(dirname(root), "t"), { mode: 0o700 });
    await writeFile(join(root, "notes/Private/Fixture.md"), "# Synthetic snapshot\n", { mode: 0o600 });
    const output = execFileSync("python3", ["-c", [
      "import json,sys",
      "sys.path.insert(0, sys.argv[1])",
      "from knowledge_snapshots import KnowledgeSnapshots",
      "print(json.dumps(KnowledgeSnapshots(sys.argv[2]).create('fixture')))",
    ].join("\n"), join(repository, "resources"), root], {
      cwd: repository, encoding: "utf8", env: {
        PATH: process.env.PATH || "", HOME: dirname(root), TMPDIR: join(dirname(root), "t"),
        PYTHONDONTWRITEBYTECODE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
      },
    });
    assert.match(JSON.parse(output).tag, /^pkm-snapshot-/);
  } finally { process.umask(mask); }
  const before = await contents(root);
  assert.throws(() => inspectLegacyRootPkmPrivacyState(root),
    { code: "PKM_STATE_UNSUPPORTED", path: ".pkm/state/knowledge-snapshots" });
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }),
    { code: "PKM_STATE_UNSUPPORTED", path: ".pkm/state/knowledge-snapshots" });
  assert.deepEqual(await contents(root), before);
});
