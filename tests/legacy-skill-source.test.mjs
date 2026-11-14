import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import {
  prepareLegacySkillSource, validateLegacySkillSourcePlan, prepareLegacySkillSourceInstall, validateLegacySkillSourceInstallPlan, inspectLegacySkillSourceInstall,
} from "../dist/legacy-skill-source.js";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
import { scanNativeLegacySkillSource, scanNativeLegacySkillSourceAndTarget } from "../dist/legacy-skill-lifecycle-native.js";

const root = fileURLToPath(new URL("../legacy/", import.meta.url));
const tests = fileURLToPath(new URL("./", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const bundle = readFileSync(join(root, "resources/pkm-skills-router.md"));
const legacy = readFileSync(join(root, "tests/fixtures/pkm-skills-router-1.7.2.md"));
const custom = Buffer.from("---\nname: Custom\n---\nCustom source must survive.\n");

function originalWriter(store) {
  const require = createRequire(import.meta.url);
  const load = (file, overrides = {}) => {
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
      name => Object.hasOwn(overrides, name) ? overrides[name] : require(name), module, module.exports);
    return module.exports;
  };
  const version = load(join(root, "src/runtime/version-order.ts"));
  return load(join(root, "src/skills/pkm-skill-projection.ts"), {
    "../knowledge/filestore": { getStorePath: () => store },
    "../runtime/version-order": version, vscode: {},
  });
}

test("native source inventory pins absence and rejects unsafe trees before effects", () => {
  const dir = join(tests, `.legacy-skill-scan-${randomUUID()}`);
  mkdirSync(dir);
  const db = new DatabaseSync(":memory:");
  try {
    const empty = scanNativeLegacySkillSource(db, () => {}, dir);
    assert.equal(empty.source, null);
    assert.deepEqual(empty.manifest, []);
    mkdirSync(join(dir, "System/PKM"), { recursive: true });
    writeFileSync(join(dir, "System/PKM/PKM Skills.md"), legacy);
    const populated = scanNativeLegacySkillSource(db, () => {}, dir);
    assert.deepEqual(populated.source, legacy);
    assert.equal(populated.manifest.length, 3);
    assert.deepEqual(populated.pin, empty.pin);
    symlinkSync("System", join(dir, "link"));
    assert.throws(() => scanNativeLegacySkillSource(db, () => {}, dir), { code: "CONFLICT" });
    rmSync(join(dir, "link"));
    linkSync(join(dir, "System/PKM/PKM Skills.md"), join(dir, "hardlink"));
    assert.throws(() => scanNativeLegacySkillSource(db, () => {}, dir), { code: "CONFLICT" });
    rmSync(join(dir, "hardlink"));
    writeFileSync(join(dir, "system"), "collision");
    assert.throws(() => scanNativeLegacySkillSource(db, () => {}, dir), { code: "INVALID_ARGUMENT" });
    rmSync(join(dir, "system"));
    db.exec("BEGIN");
    assert.throws(() => scanNativeLegacySkillSource(db, () => {}, dir), { code: "CONFLICT" });
    db.exec("ROLLBACK");
    assert.throws(() => scanNativeLegacySkillSource(db, () => { throw new Error("owner lost"); }, dir), /owner lost/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const [label, before, transition] of [
  ["missing", null, "create"], ["legacy", legacy, "upgrade"], ["custom", custom, "preserve"],
]) {
  test(`canonical source ${label} matches original inject writer`, () => {
    const dir = join(tests, `.legacy-skill-source-${randomUUID()}`);
    const previousHome = process.env.HOME;
    const store = join(dir, "store"), target = join(dir, "target");
    const sourcePath = join(store, "skills/System/PKM/PKM Skills.md");
    mkdirSync(target, { recursive: true });
    if (before) { mkdirSync(dirname(sourcePath), { recursive: true }); writeFileSync(sourcePath, before); }
    const states = new Map([["pkm.skillProjection.customTargets.v1", [{ id: "fixture", kind: "custom", label: "Fixture", root: target }]]]);
    const context = { extensionPath: root, extension: { packageJSON: { version: "test" } },
      globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } };
    try {
      process.env.HOME = join(dir, "home");
      const request = { beforeSha256: before ? hash(before) : null, bundleSha256: hash(bundle) };
      const plan = prepareLegacySkillSource(request, before, bundle);
      assert.equal(plan.transition, transition);
      const status = originalWriter(store).injectPkmSkill(context, "fixture");
      assert.equal(status.state, "current");
      assert.equal(existsSync(sourcePath), true);
      assert.deepEqual(readFileSync(sourcePath), Buffer.from(plan.afterBase64, "base64"));
      assert.deepEqual(validateLegacySkillSourcePlan(plan, bundle, hash(bundle)), plan);
      assert.throws(() => validateLegacySkillSourcePlan({ ...plan, afterBase64: Buffer.from("forged").toString("base64") }, bundle, hash(bundle)), { code: "CONFLICT" });
      assert.throws(() => prepareLegacySkillSource({ ...request, bundleSha256: "0".repeat(64) }, before, bundle), { code: "CONFLICT" });
    } finally { process.env.HOME = previousHome; rmSync(dir, { recursive: true, force: true }); }
  });
}

test("full source and modified managed projection plan matches original writer and rejects tampering", () => {
  const dir = join(tests, `.legacy-skill-plan-${randomUUID()}`), oldHome = process.env.HOME;
  const store = join(dir, "store"), target = join(dir, "target"), sourceRoot = join(store, "skills");
  const sourcePath = join(sourceRoot, "System/PKM/PKM Skills.md"), projectionPath = join(target, "pkm-skills/SKILL.md");
  mkdirSync(dirname(sourcePath), { recursive: true }); mkdirSync(dirname(projectionPath), { recursive: true });
  writeFileSync(sourcePath, legacy);
  const modified = Buffer.from('---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nuser modification\n');
  writeFileSync(projectionPath, modified);
  writeFileSync(join(target, "other.bin"), Buffer.from([0, 255]));
  const db = new DatabaseSync(":memory:");
  const binding = { workspaceId: "workspace", actorId: "human", sourceRootId: "source", destinationRootId: "target", targetId: "fixture", targetKind: "custom", extensionVersion: "test" };
  const states = new Map([["pkm.skillProjection.customTargets.v1", [{ id: "fixture", kind: "custom", label: "Fixture", root: target }]]]);
  const context = { extensionPath: root, extension: { packageJSON: { version: "test" } },
    globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } };
  try {
    process.env.HOME = join(dir, "home");
    const snapshot = scanNativeLegacySkillSourceAndTarget(db, () => {}, { source: sourceRoot, destination: target });
    const input = { operationId: randomUUID(), sourceSha256: hash(legacy), bundleSha256: hash(bundle),
      sourceManifestSha256: legacySkillManifestHash(snapshot.sourceManifest),
      destinationSha256: hash(modified), destinationManifestSha256: legacySkillManifestHash(snapshot.destinationManifest) };
    const plan = prepareLegacySkillSourceInstall(binding, input, snapshot.source, bundle, snapshot.sourceManifest, snapshot.destination, snapshot.destinationManifest);
    assert.deepEqual(validateLegacySkillSourceInstallPlan(plan, bundle, hash(bundle)), plan);
    for (const [source, destination, state] of [
      [plan.sourceBeforeManifest, plan.destinationBeforeManifest, "before"],
      [plan.sourceAfterManifest, plan.destinationBeforeManifest, "source-after"],
      [plan.sourceBeforeManifest, plan.destinationAfterManifest, "destination-after"],
      [plan.sourceAfterManifest, plan.destinationAfterManifest, "after"],
    ]) assert.equal(inspectLegacySkillSourceInstall(plan, bundle, hash(bundle), source, destination).state, state);
    assert.throws(() => inspectLegacySkillSourceInstall(plan, bundle, hash(bundle), [], plan.destinationAfterManifest), { code: "CONFLICT", effect: "unknown" });
    assert.throws(() => validateLegacySkillSourceInstallPlan({ ...plan, destinationAfterBase64: Buffer.from("forged").toString("base64") }, bundle, hash(bundle)), { code: "CONFLICT" });
    const forgedBundle = Buffer.from("forged bundle with recomputed digest");
    const forgedInput = { ...input, bundleSha256: hash(forgedBundle) };
    const forgedPlan = prepareLegacySkillSourceInstall(binding, forgedInput, snapshot.source, forgedBundle, snapshot.sourceManifest, snapshot.destination, snapshot.destinationManifest);
    assert.throws(() => validateLegacySkillSourceInstallPlan(forgedPlan, forgedBundle, hash(bundle)), { code: "CONFLICT" });
    assert.throws(() => prepareLegacySkillSourceInstall(binding, { ...input, destinationSha256: "0".repeat(64) }, snapshot.source, bundle, snapshot.sourceManifest, snapshot.destination, snapshot.destinationManifest), { code: "CONFLICT" });
    const original = originalWriter(store).injectPkmSkill(context, "fixture");
    assert.equal(original.state, "current");
    assert.deepEqual(readFileSync(sourcePath), Buffer.from(plan.source.afterBase64, "base64"));
    assert.deepEqual(readFileSync(projectionPath), Buffer.from(plan.destinationAfterBase64, "base64"));
    const after = scanNativeLegacySkillSourceAndTarget(db, () => {}, { source: sourceRoot, destination: target });
    assert.deepEqual(after.sourceManifest, plan.sourceAfterManifest);
    assert.deepEqual(after.destinationManifest, plan.destinationAfterManifest);
  } finally { process.env.HOME = oldHome; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("original writer refuses unmanaged and newer targets before creating source", () => {
  const dir = join(tests, `.legacy-skill-conflict-${randomUUID()}`), oldHome = process.env.HOME;
  const store = join(dir, "store"), sourceRoot = join(store, "skills"), target = join(dir, "target");
  const sourcePath = join(sourceRoot, "System/PKM/PKM Skills.md"), projectionPath = join(target, "pkm-skills/SKILL.md");
  mkdirSync(sourceRoot, { recursive: true }); mkdirSync(dirname(projectionPath), { recursive: true });
  const db = new DatabaseSync(":memory:");
  const binding = { workspaceId: "workspace", actorId: "human", sourceRootId: "source", destinationRootId: "target", targetId: "fixture", targetKind: "custom", extensionVersion: "test" };
  const states = new Map([["pkm.skillProjection.customTargets.v1", [{ id: "fixture", kind: "custom", label: "Fixture", root: target }]]]);
  const context = { extensionPath: root, extension: { packageJSON: { version: "test" } },
    globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } };
  try {
    process.env.HOME = join(dir, "home");
    for (const before of [
      "Unmanaged skill",
      '<!-- pkm-managed {"schema":1,"routerVersion":"9.0.0"} -->\nnewer',
    ]) {
      writeFileSync(projectionPath, before);
      const snap = scanNativeLegacySkillSourceAndTarget(db, () => {}, { source: sourceRoot, destination: target });
      const input = { operationId: randomUUID(), sourceSha256: null, bundleSha256: hash(bundle),
        sourceManifestSha256: legacySkillManifestHash(snap.sourceManifest),
        destinationSha256: hash(snap.destination), destinationManifestSha256: legacySkillManifestHash(snap.destinationManifest) };
      assert.throws(() => prepareLegacySkillSourceInstall(binding, input, snap.source, bundle, snap.sourceManifest, snap.destination, snap.destinationManifest), { code: "CONFLICT" });
      assert.throws(() => originalWriter(store).injectPkmSkill(context, "fixture"), /Refusing/);
      assert.equal(existsSync(sourcePath), false);
      assert.equal(readFileSync(projectionPath, "utf8"), before);
    }
  } finally { process.env.HOME = oldHome; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
