import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

const dist = resolve(import.meta.dirname, process.env.PKM_TEST_SERVER_DIST || "../dist");
const load = name => import(pathToFileURL(join(dist, `${name}.js`)).href);
const { planLegacyImport, importLegacyWorkspace } = await load("legacy-import");
const { auditImportedWorkspace } = await load("managed-import-audit");
const { bindImportedReadOnlyHost } = await load("managed-client-host");
const require = createRequire(import.meta.url), modules = new Map();
function original(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const mod = { exports: {} };
  modules.set(path, mod);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })(
    name => {
      if (!name.startsWith(".")) return require(name);
      const next = resolve(dirname(path), name);
      return original(existsSync(`${next}.ts`) ? `${next}.ts` : join(next, "index.ts"));
    }, mod, mod.exports, path, dirname(path));
  return mod.exports;
}
const old = original(resolve(import.meta.dirname, "../legacy/src/knowledge/storage.ts"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("imported managed library exposes pinned original Prompt versions and Script identity without writes or execution", { timeout: 120000 }, async t => {
  const parent = join(import.meta.dirname, `.managed-library-${randomUUID()}`);
  const source = join(parent, "source"), target = join(parent, "target");
  await mkdir(join(source, "notes"), { recursive: true });
  let host;
  t.after(async () => { await host?.close(); await rm(parent, { recursive: true, force: true }); });
  const identity = { schema: "pkm.script/v1", knowledgeId: "script_0123456789abcdef01234567",
    aliases: ["pkm://scripts/Old/check.py", "pkm://script/script_fedcba9876543210fedcba98"], extra: { preserved: true } };
  const raw = new Map([
    ["prompts/Ads/Accuracy/v9/prompt.jinja2", Buffer.from("{# PROMPT_METADATA\ntitle: Accuracy\nnote:\nReviewed\n#}\n\n{{ Language }}\n")],
    ["prompts/Ads/Accuracy/v10/prompt.jinja2", Buffer.from("\n{{ next }}\r\n")],
    ["prompts/Ads/Accuracy/v9/base.jinja2", Buffer.from("base {{ context }}")],
    ["prompts/Ads/Accuracy/v9/related/nested.txt", Buffer.from("nested")],
    ["scripts/Tools/check.py", Buffer.from("print('inert')\r\n")],
    ["scripts/Tools/.check.py.pkm.json", Buffer.from(JSON.stringify(identity))],
    ["scripts/Tools/unassigned.sh", Buffer.from("#!/bin/sh\nexit 91\n")],
    ["scripts/Tools/binary.bin", Buffer.from([255, 0, 128, 10])],
    ["scripts/Tools/large.txt", Buffer.alloc(140003, 0x61)],
  ]);
  for (const [path, bytes] of raw) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes, { mode: 0o600 });
  }
  await mkdir(join(source, "prompts/Ads/Accuracy/v9/empty"));
  old.setStorePath(source);
  const originalPrompt = old.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2");
  const originalVersions = old.promptGetAllVersionsOfFile("Ads", "Accuracy", "prompt.jinja2");
  const originalScript = old.scriptGet(`pkm://script/${identity.knowledgeId}`);
  assert.deepEqual(old.scriptGet("pkm://scripts/Old/check.py"), originalScript);
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
  await importLegacyWorkspace(plan, target, { pythonExecutable: python });
  for (const path of ["prompts/Ads/Accuracy/v99", "scripts/Tools/unplanned"]) {
    const unplanned = join(target, path);
    await mkdir(unplanned);
    await assert.rejects(auditImportedWorkspace(target, plan), /unplanned library directory/);
    await rm(unplanned, { recursive: true });
  }
  const audit = await auditImportedWorkspace(target, plan);
  host = bindImportedReadOnlyHost(target, "synthetic-library", audit.assertUnchanged);
  async function invoke(operation, args) {
    const response = await host.invoke(operation, args);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  }
  async function list(area) {
    let offset = 0, revision, items = [];
    do {
      const page = await invoke("library-list", { area, offset, limit: 2, ...(revision ? { snapshotRevision: revision } : {}) });
      revision ??= page.snapshotRevision;
      assert.equal(page.snapshotRevision, revision);
      items.push(...page.items);
      offset = page.nextOffset;
      if (offset === null) assert.equal(items.length, page.total);
    } while (offset !== null);
    return { items, revision };
  }
  const prompts = await list("prompts"), scripts = await list("scripts");
  assert.equal(prompts.revision, scripts.revision);
  assert(prompts.items.some(item => item.path === "prompts/Ads/Accuracy/v9/empty" && item.kind === "directory"));
  async function get(listing, path) {
    const item = listing.items.find(entry => entry.path === path);
    assert(item && item.kind === "file", path);
    const args = { area: item.area, path, expectedDigest: item.sha256, snapshotRevision: listing.revision };
    let offset = 0, first, chunks = [];
    do {
      const part = await invoke("library-get", { ...args, offset, length: 32768 });
      first ??= part;
      assert.equal(part.offset, offset);
      chunks.push(Buffer.from(part.data, "base64"));
      offset = part.nextOffset;
    } while (offset !== null);
    const bytes = Buffer.concat(chunks);
    assert.equal(sha(bytes), item.sha256);
    assert.deepEqual(bytes, raw.get(path));
    return { first, item, args };
  }
  const prompt = await get(prompts, "prompts/Ads/Accuracy/v9/prompt.jinja2");
  assert.deepEqual(prompt.first.legacy, originalPrompt);
  const other = await get(prompts, "prompts/Ads/Accuracy/v10/prompt.jinja2");
  const versions = [other, prompt].map(({ first }) => ({
    version: first.legacy.version,
    content: old.stripPromptMetadata(first.legacy.raw).replace(/^\n/, ""),
  }));
  assert.deepEqual(versions, originalVersions);
  const script = await get(scripts, "scripts/Tools/check.py");
  assert.deepEqual(script.first.legacy, originalScript);
  assert.deepEqual(script.item.scriptIdentity, identity);
  assert.equal(script.item.identityStatus, "preserved");
  const unassigned = await get(scripts, "scripts/Tools/unassigned.sh");
  assert.equal(unassigned.item.identityStatus, "unassigned");
  assert.equal(unassigned.first.legacy.knowledgeId, null);
  assert.equal(existsSync(join(target, "scripts/Tools/.unassigned.sh.pkm.json")), false);
  assert.equal((await get(scripts, "scripts/Tools/binary.bin")).first.textStatus, "binary");
  assert.equal((await get(scripts, "scripts/Tools/large.txt")).first.textStatus, "chunked");
  assert.equal((await host.invoke("library-get", { ...script.args, expectedDigest: "0".repeat(64) })).error.code, "CONFLICT");
  assert.equal((await host.invoke("library-list", { area: "scripts", snapshotRevision: "0".repeat(64) })).error.code, "CONFLICT");
  await assert.rejects(host.invoke("update", {}), /read-only/);
  await audit.assertUnchanged();
  for (const [path, bytes] of raw) {
    assert.deepEqual(await readFile(join(source, path)), bytes);
    assert.deepEqual(await readFile(join(target, path)), bytes);
  }
  await writeFile(join(target, "scripts/Tools/check.py"), "modified");
  await assert.rejects(host.invoke("library-list", { area: "scripts" }), /changed/);
  await assert.rejects(host.invoke("library-list", { area: "scripts" }), /previously failed/);
});
