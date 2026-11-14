import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { CoreError } from "../dist/contracts.js";
import { scanNativeLegacySkillTree } from "../dist/legacy-skill-lifecycle-native.js";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
export { transports, fixturePublisher } from "./host-composition-legacy-shared-captures.mjs";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const actor = Object.freeze({ id: "batch15-native-fixture-human", canWrite: true, collaborationKind: "human" });
export const sourceBytes = Buffer.from('---\r\nname: Fixture\r\ndescription: "User\'s original workflow"\r\n---\r\n# Body\r\nNo commands are executed.\r\n');
const repositoryRoot = fileURLToPath(new URL("../legacy/", import.meta.url));
const require = createRequire(import.meta.url);
export function originalLoader(overrides = {}) {
  const modules = new Map();
  function original(path) {
    if (modules.has(path)) return modules.get(path).exports;
    assert.ok(path.startsWith(repositoryRoot) && path.endsWith(".ts"));
    const module = { exports: {} };
    modules.set(path, module);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })(
      name => Object.hasOwn(overrides, name) ? overrides[name] : name.startsWith(".")
        ? original(`${resolve(dirname(path), name)}.ts`) : require(name),
      module, module.exports, path, dirname(path));
    return module.exports;
  }
  return relative => original(join(repositoryRoot, relative));
}
export async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.batch15-native-${randomUUID()}`);
  await mkdir(parent);
  let root = await initialize(join(parent, "workspace"));
  const originalRoot = join(root, "packages/original");
  mkdirSync(join(originalRoot, "skills/System/PKM"), { recursive: true });
  writeFileSync(join(originalRoot, "skills/System/PKM/PKM Skills.md"), sourceBytes);
  mkdirSync(join(root, "packages/target"), { recursive: true });
  writeFileSync(join(root, "packages/target/unrelated.bin"), Buffer.from([0, 255, 17]));
  let storage, runtime, database;
  const state = { owned: true, approved: true, retry: false, stageFault: false, reads: 0, sourceCalls: 0 };
  let workspaceId;
  const grant = () => ({
    binding: { workspaceId, actorId: actor.id, sourceRootId: "native-original-skills", destinationRootId: "native-fixture-target",
      targetId: "fixture", targetKind: "custom", extensionVersion: "test" },
    sourceRelative: "packages/original/skills", destinationRelative: "packages/target",
  });
  const skillPolicy = {
    scope: "exclusive-native-disposable-fixture",
    admissionForActor: who => who.id === actor.id && who.collaborationKind === "human" ? grant() : undefined,
    assertFixtureOwnership() {
      if (database) assert.equal(database.isTransaction, false);
      if (!state.owned) throw new CoreError("ACCESS_DENIED", "Fixture is not exclusively native-owned.");
      if (state.stageFault && database?.prepare("SELECT 1 FROM legacy_skill_native_intent").get())
        throw new Error("fixture owner fault after durable staging");
    },
    authorize: who => state.approved && who.id === actor.id,
    approveRetry: () => state.retry,
  };
  const original = originalLoader();
  const writer = original("src/knowledge/storage.ts");
  writer.setStorePath(originalRoot);
  mkdirSync(join(originalRoot, "scripts/Engineering"), { recursive: true });
  writeFileSync(join(originalRoot, "scripts/Engineering/run.py"), "print('not executed')\n");
  const script = writer.scriptGet("Engineering/run.py");
  const { ProjectStore } = original("src/workflows/project-store.ts");
  const projects = new ProjectStore(join(originalRoot, ".pkm/state"), () => "batch15-source", { autoMigrate: false });
  const created = projects.createProject({ commandId: "batch15-original-create", fingerprint: "batch15-source-project",
    expectedStoreVersion: projects.list().storeVersion }, "Original fixture project");
  const project = created.snapshot.projects.find(item => item.projectId === created.entityId);
  writeFileSync(join(originalRoot, "project-oracle.json"), JSON.stringify(project));
  const inventory = [
    { area: "scripts", relativePath: script.path, slug: script.path, title: script.file, knowledgeId: script.knowledgeId, aliases: script.aliases },
    { area: "projects", relativePath: `${project.projectId}.json`, slug: project.projectId, title: project.name },
  ];
  const assetPolicy = {
    scope: "exclusive-native-disposable-fixture", sourceRelative: "packages/original",
    assertFixtureOwnership() { if (database) assert.equal(database.isTransaction, false); if (!state.owned) throw new CoreError("ACCESS_DENIED", "No fixture ownership."); },
    authorize: who => state.approved && who.id === actor.id,
    authorizeEntry: who => who.id === actor.id,
    authorizeDocument: (who, id) => who.id === actor.id && id !== "hidden",
    inventory() {
      state.sourceCalls++;
      if (database) assert.equal(database.isTransaction, false);
      const path = join(root, "packages/original");
      const body = readFileSync(join(path, "scripts", script.path));
      const identity = readFileSync(join(path, "scripts", dirname(script.path), `.${basename(script.path)}.pkm.json`));
      const p = JSON.parse(readFileSync(join(path, "project-oracle.json")));
      return {
        scripts: [{ ...inventory[0], sourceRevision: hash(Buffer.concat([body, identity])) }].map(({ area, ...item }) => item),
        projects: [{ relativePath: `${p.projectId}.json`, slug: p.projectId, title: p.name, sourceRevision: hash(JSON.stringify(p)) }],
      };
    },
  };
  async function open(path = root) {
    root = path;
    workspaceId = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id;
    storage = await Storage.open(root, { deferRecovery: true });
    try { runtime = await createNativeRuntime({ storage, batch15Skills: skillPolicy, batch15Assets: assetPolicy }); }
    catch (error) { await storage.close(); storage = undefined; throw error; }
    database = storage.connectNative();
  }
  async function close() {
    database?.close(); database = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  }
  await open();
  t.after(async () => { await close(); await rm(parent, { recursive: true, force: true }); });
  return {
    parent, state, script, project, inventory, original, skillPolicy, assetPolicy,
    get root() { return root; }, get storage() { return storage; }, get runtime() { return runtime; }, get database() { return database; },
    grant, open, close, async restart() { await close(); await open(); },
    input(action = "inject") {
      const scan = scanNativeLegacySkillTree(database, () => {}, {
        source: join(root, grant().sourceRelative), destination: join(root, grant().destinationRelative),
      });
      return { operationId: randomUUID(), action, sourceSha256: hash(scan.source),
        destinationSha256: scan.destination === null ? null : hash(scan.destination), manifestSha256: legacySkillManifestHash(scan.manifest) };
    },
    async bytes() { return readFile(join(root, "packages/target/pkm-skills/SKILL.md")); },
    projectionOracle() {
      const target = join(parent, "original-skill-target");
      mkdirSync(target, { recursive: true });
      const loader = originalLoader({
        "../knowledge/filestore": { getStorePath: () => join(root, "packages/original") },
        os: { ...require("os"), homedir: () => join(parent, "home") }, vscode: {},
      });
      const projection = loader("src/skills/pkm-skill-projection.ts");
      const states = new Map([["pkm.skillProjection.customTargets.v1", [{ id: "fixture", kind: "custom", label: "Fixture", root: target }]]]);
      const context = { extensionPath: repositoryRoot, extension: { packageJSON: { version: "test" } },
        globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } };
      return { projection, context, target };
    },
  };
}
