import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { legacyProjectEnvelopeOriginalSources } from "../dist/domain/legacy-project-envelope-provenance.js";
import { capturedSources } from "../dist/domain/project-thread-original.js";
import { readOriginalSource } from "../scripts/migration.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const legacyRoot = join(packageRoot, "legacy");
const require = createRequire(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const archive = "migration/evidence/project-authentication-originals.zip";
const archiveSha256 = "b15d0846c8b82862498418d4997a3aa7e93410462e603fd845d0e5dbae109f92";
const provenance = JSON.parse(readFileSync(new URL("../src/domain/legacy-note-workitems-provenance.json", import.meta.url), "utf8"));
const protectedPins = Object.freeze({
  ...Object.fromEntries(legacyProjectEnvelopeOriginalSources.map(source => [source.path, source.sha256])),
  ...provenance.sha256,
  ...Object.fromEntries(Object.entries(provenance.implementationSha256).map(([path, pin]) => [`next-server/${path}`, pin])),
  "src/chatroom/collaboration-model.ts": "56a7e33e2e89056f0b2f4c217c3969d1fae84425da5c6951c4d40faec34805d4",
  "src/knowledge/knowledge-contracts.ts": "0f4c453b726e70df7c3e8df3e4eb253114d89d4cb88eb8ce3e4f561bf336ab2f",
  "src/knowledge/knowledge-deletion-journal.ts": "3944f565fba8bb3875f8a9fb9ea39b9e779fb2a013705405f68cc60845c99e49",
  "src/knowledge/markdown-assets.ts": "3efa04f06f6b5fd7e649874d031e0ddb8a6ff4f33182747135c6601658922741",
  "src/runtime/pkm-projection.ts": "334c69b219e9b152144dfe985ac674ed3c8934d34d0d821f12adf32b4b27b136",
  "src/workflows/methodology-model.ts": "7e64b5f7e910291efa92241bd8e0f36f38a5afc1b404dc54c0f07269d346fbba",
  "src/workflows/project-cockpit.ts": "1952d5b2f4c7969fbd8f27beef3a955b9f36d3af7dc608c5776a26c0c499d617",
  "src/workflows/value-contracts.ts": "e6d44457433b9e931878ca530168bd51322589733a601431852fcf7609cccd52",
});
const members = Object.freeze(Object.fromEntries([
  "src/workflows/project-store.ts", "src/workflows/project-filesystem-store.ts",
  "src/workflows/project-model.ts", "src/workflows/recipe-filesystem-store.ts",
  "src/workflows/workflow-contracts.ts", "src/runtime/cross-process-lock.ts",
  "src/chatroom/collaboration-model.ts", "src/workflows/value-contracts.ts",
  "src/workflows/methodology-model.ts", "src/workflows/project-cockpit.ts",
  "src/runtime/pkm-projection.ts", "src/knowledge/knowledge-contracts.ts",
  "src/knowledge/knowledge-deletion-journal.ts", "src/knowledge/markdown-assets.ts",
  "resources/knowledge_mutations.py", "resources/knowledge_mutations.js",
  "src/knowledge/filestore.ts", "src/knowledge/note-work-items.ts",
  "src/knowledge/todo-board.ts", "src/knowledge/todo-api.ts", "src/knowledge/todo-api-contract.ts",
  "tests/test-note-work-items.js", "tests/test-note-work-item-lifecycle.js", "tests/test-todo-api-mcp.py",
  "next-server/src/legacy-note-workitems.ts", "next-server/src/legacy-note-workitems-contracts.ts",
  "next-server/src/legacy-note-workitems-journal.ts", "next-server/src/legacy-note-workitems-admission.ts",
  "next-server/tests/legacy-note-workitems-bridge.test.mjs",
  "next-server/tests/legacy-note-workitems-journal.test.mjs",
].map(path => [path, `project-authentication-original/source/${path}`])));
assert.deepEqual(Object.keys(members).sort(), Object.keys(protectedPins).sort());
for (const source of Object.values(capturedSources)) assert.equal(protectedPins[source.path], source.sha256);

export async function readProjectOriginal(path, {
  root = packageRoot, kind = "source", sha256 = protectedPins[path],
} = {}) {
  if (kind !== "source" || !Object.hasOwn(members, path)
    || !Object.hasOwn(protectedPins, path) || sha256 !== protectedPins[path]) {
    throw new Error("No exact Project/Note original path/role/digest binding.");
  }
  return readOriginalSource(`${archive}!/${members[path]}`, { root, kind, sha256, archiveSha256 });
}
const authenticatedSources = new Map(await Promise.all(Object.keys(members)
  .map(async path => [path, await readProjectOriginal(path)])));

export function projectOriginalSource(path, sha256 = protectedPins[path]) {
  assert.equal(Object.hasOwn(members, path), true, "Unknown Project/Note original");
  assert.equal(sha256, protectedPins[path], `Source pin changed: ${path}`);
  const bytes = authenticatedSources.get(path);
  assert.equal(hash(bytes), sha256, `Original source changed: ${path}`);
  return bytes.toString("utf8");
}

export function originalProjectModules() {
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const source = projectOriginalSource(path);
    assert.ok(path.endsWith(".ts"));
    const module = { exports: {} };
    modules.set(path, module);
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const filename = join(legacyRoot, path);
    const localRequire = name => {
      if (name.startsWith(".")) return load(posix.normalize(posix.join(posix.dirname(path), `${name}.ts`)));
      assert.ok(["fs", "path", "crypto"].includes(name), `Unexpected original dependency: ${name}`);
      return require(name);
    };
    runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename })
      (localRequire, module, module.exports, filename, dirname(filename));
    return module.exports;
  }
  return load;
}

export function originalKnowledgeBridge(root, request) {
  const load = originalProjectModules(), output = [], errors = [];
  const originalProcess = { argv: [process.execPath, "knowledge_mutations.js", legacyRoot, root], exitCode: 0 };
  const localRequire = name => {
    if (name === join(legacyRoot, "dist/knowledge/filestore")) return load("src/knowledge/filestore.ts");
    if (name === "node:fs") {
      const fs = require(name);
      return { ...fs, readFileSync: (path, ...args) => path === 0 ? JSON.stringify(request) : fs.readFileSync(path, ...args) };
    }
    assert.ok(["node:path", "node:crypto"].includes(name), `Unexpected bridge dependency: ${name}`);
    return require(name);
  };
  const source = projectOriginalSource("resources/knowledge_mutations.js");
  runInThisContext(`(function(require,process,console){${source}\n})`, { filename: "original-knowledge-mutations.js" })(
    localRequire, originalProcess, { log: value => output.push(value), error: value => errors.push(value) },
  );
  assert.equal(originalProcess.exitCode, 0, errors.join("\n"));
  assert.equal(output.length, 1, "Original bridge must return one synchronous Work Item result");
  return JSON.parse(output[0]);
}
