import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import {
  executeLegacySkillLifecycle, inspectLegacySkillLifecyclePending, legacySkillLifecycleDefinitions,
  legacySkillLifecyclePlanHash, legacySkillManifestHash, prepareLegacySkillLifecycle,
  validateLegacySkillLifecyclePlan, materializeLegacySkills, recoverLegacySkillLifecycle,
} from "../dist/legacy-skill-lifecycle.js";
import { renderProjection } from "../dist/domain/skill-routing-projection.js";
import { decodeMarkdown } from "../dist/markdown.js";
import { readSkillRouting } from "../dist/skill-routing.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const repositoryRoot = fileURLToPath(new URL("../legacy/", import.meta.url));
const testRoot = fileURLToPath(new URL("./", import.meta.url));
const source = Buffer.from('---\r\nname: Example\r\ndescription: "User\'s workflow"\r\n---\r\n\r\n# Body\r\ninstructions only\r\n');
const actor = { id: "local:approved", canWrite: true };
const binding = { workspaceId: "workspace", actorId: actor.id, sourceRootId: "source", destinationRootId: "target", targetId: "fixture", targetKind: "custom", extensionVersion: "test" };
const makeInput = (manifest = [], action = "inject", destination = null) => ({
  operationId: randomUUID(), action, sourceSha256: hash(source), destinationSha256: destination && hash(destination),
  manifestSha256: legacySkillManifestHash(manifest),
});

test("original writer oracle: injected bytes, status, removal and conflict", () => {
  const root = join(testRoot, `legacy-skill-lifecycle-fixture-${randomUUID()}`);
  const store = join(root, "store"), target = join(root, "target"), previousHome = process.env.HOME;
  mkdirSync(join(store, "skills", "System", "PKM"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const sourcePath = join(store, "skills", "System", "PKM", "PKM Skills.md");
  writeFileSync(sourcePath, source);
  process.env.HOME = join(root, "home");
  try {
    const require = createRequire(import.meta.url);
    function load(file, overrides = {}) {
      const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const module = { exports: {} };
      vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
        name => Object.hasOwn(overrides, name) ? overrides[name] : require(name), module, module.exports);
      return module.exports;
    }
    const version = load(join(repositoryRoot, "src/runtime/version-order.ts"));
    const original = load(join(repositoryRoot, "src/skills/pkm-skill-projection.ts"), {
      "../knowledge/filestore": { getStorePath: () => store }, "../runtime/version-order": version, vscode: {},
    });
    const states = new Map([["pkm.skillProjection.customTargets.v1", [{ id: "fixture", kind: "custom", label: "Fixture", root: target }]]]);
    const context = { extensionPath: repositoryRoot, extension: { packageJSON: { version: "test" } },
      globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } };
    const status = original.injectPkmSkill(context, "fixture");
    const written = readFileSync(status.skillPath);
    assert.equal(status.state, "current");
    assert.deepEqual(written, Buffer.from(renderProjection(source.toString(), { kind: "custom" }, "test").content));
    assert.deepEqual(written, Buffer.from(prepareLegacySkillLifecycle(binding, makeInput(), source, null, []).afterContent));
    const newer = written.toString().replace('"routerVersion":"2.0.0"', '"routerVersion":"9.0.0"');
    writeFileSync(status.skillPath, newer);
    assert.throws(() => original.injectPkmSkill(context, "fixture"), /Refusing to replace newer PKM Skill Router/);
    writeFileSync(status.skillPath, written);
    original.removeInjectedPkmSkill(context, "fixture");
    assert.equal(existsSync(status.skillPath), false);
    mkdirSync(dirname(status.skillPath), { recursive: true });
    writeFileSync(status.skillPath, "unmanaged");
    assert.throws(() => original.injectPkmSkill(context, "fixture"), /Refusing to overwrite a non-PKM Skill/);
    assert.throws(() => original.removeInjectedPkmSkill(context, "fixture"), /Refusing to remove a non-PKM Skill/);
    const manifest = [{ kind: "directory", path: "pkm-skills" }, { kind: "file", path: "pkm-skills/SKILL.md", sha256: hash("unmanaged"), size: 9 }];
    assert.throws(() => prepareLegacySkillLifecycle(binding, makeInput(manifest, "remove", Buffer.from("unmanaged")), source, Buffer.from("unmanaged"), manifest), { code: "CONFLICT" });
    assert.deepEqual(readFileSync(status.skillPath), Buffer.from("unmanaged"));
    assert.deepEqual(readFileSync(sourcePath), source);
  } finally { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
});

test("strict catalog schemas and stale, tampered, colliding and unsupported inputs fail closed", () => {
  assert.equal(legacySkillLifecycleDefinitions.length, 2);
  for (const definition of legacySkillLifecycleDefinitions) {
    assert.ok(z.toJSONSchema(definition.input));
    assert.ok(z.toJSONSchema(definition.output));
  }
  assert.equal(legacySkillLifecycleDefinitions[0].input.safeParse({ ...makeInput(), action: "remove" }).success, false);
  assert.equal(legacySkillLifecycleDefinitions[0].input.safeParse({ ...makeInput(), source: "subscriber:remote" }).success, false);
  assert.throws(() => prepareLegacySkillLifecycle(binding, { ...makeInput(), sourceSha256: "0".repeat(64) }, source, null, []), { code: "CONFLICT" });
  assert.throws(() => prepareLegacySkillLifecycle({ ...binding, sourceRootId: "target" }, makeInput(), source, null, []), { code: "ACCESS_DENIED" });
  assert.throws(() => legacySkillManifestHash([{ kind: "file", path: "../outside", sha256: hash("x"), size: 1 }]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => legacySkillManifestHash([{ kind: "file", path: "A", sha256: hash("x"), size: 1 }, { kind: "file", path: "a/B", sha256: hash("y"), size: 1 }]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => legacySkillManifestHash([{ kind: "file", path: "A", sha256: hash("x"), size: 1 }, { kind: "file", path: "a", sha256: hash("y"), size: 1 }]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => prepareLegacySkillLifecycle(binding, makeInput(), Buffer.from([255]), null, []), { code: "INVALID_ARGUMENT" });
  const legacy = readFileSync(join(repositoryRoot, "tests/fixtures/pkm-skills-router-1.7.2.md"));
  assert.throws(() => prepareLegacySkillLifecycle(binding, { ...makeInput(), sourceSha256: hash(legacy) }, legacy, null, []), { code: "NOT_AVAILABLE" });
});

test("whole-manifest journal recognizes only pinned before/after; tamper and unknown remain fenced", () => {
  const manifest = [{ kind: "directory", path: "other" }, { kind: "file", path: "other/asset.bin", sha256: hash("asset"), size: 5 }];
  const input = makeInput(manifest);
  const plan = prepareLegacySkillLifecycle(binding, input, source, null, manifest);
  const pin = legacySkillLifecyclePlanHash(plan);
  assert.equal(inspectLegacySkillLifecyclePending(plan, pin, source, null, manifest).state, "before");
  assert.equal(inspectLegacySkillLifecyclePending(plan, pin, source, null, plan.afterManifest).state, "after");
  assert.throws(() => inspectLegacySkillLifecyclePending(plan, pin, source, null, []), { code: "CONFLICT" });
  assert.throws(() => inspectLegacySkillLifecyclePending(plan, "0".repeat(64), source, null, manifest), { code: "CONFLICT" });
  assert.throws(() => validateLegacySkillLifecyclePlan({ ...plan, afterContent: "tampered" }, source, null), { code: "CONFLICT" });
  assert.throws(() => validateLegacySkillLifecyclePlan(plan, Buffer.from("changed"), null), { code: "CONFLICT" });
  const installed = Buffer.from(plan.afterContent);
  const removal = prepareLegacySkillLifecycle(binding, makeInput(plan.afterManifest, "remove", installed), source, installed, plan.afterManifest);
  assert.deepEqual(removal.afterManifest, manifest);
  assert.equal(removal.afterContent, null);
});

test("native authority, replay, pending fence and unknown failure do not silently retry", async () => {
  let pending = false, committed = null, calls = [];
  const host = {
    async withExclusive(work) { calls.push("exclusive"); return work(); },
    authorize(a, b) { return a.id === b.actorId; },
    async replayOrFence() { calls.push("receipt"); if (committed) return { kind: "replay", result: committed }; if (pending) throw new Error("pending"); return { kind: "new" }; },
    async scan() { calls.push("scan"); return { source, destination: null, manifest: [] }; },
    async stage() { calls.push("stage"); pending = true; },
    async applyAndVerify() { calls.push("apply"); throw new Error("unknown outcome"); },
    async commit(plan) { calls.push("commit"); committed = plan.result; pending = false; },
  };
  const input = makeInput(), fp = hash("trusted host fingerprint");
  await assert.rejects(executeLegacySkillLifecycle(host, { ...actor, id: "other" }, binding, input, fp), { code: "ACCESS_DENIED" });
  assert.deepEqual(calls, []);
  await assert.rejects(executeLegacySkillLifecycle(host, actor, binding, input, fp), /unknown outcome/);
  assert.deepEqual(calls, ["exclusive", "receipt", "scan", "stage", "apply"]);
  calls = [];
  await assert.rejects(executeLegacySkillLifecycle(host, actor, binding, input, fp), /pending/);
  assert.deepEqual(calls, ["exclusive", "receipt"]);
  pending = false;
  host.applyAndVerify = async () => { calls.push("apply"); };
  await executeLegacySkillLifecycle(host, actor, binding, input, fp);
  calls = [];
  assert.deepEqual(await executeLegacySkillLifecycle(host, actor, binding, input, fp), committed);
  assert.deepEqual(calls, ["exclusive", "receipt"]);
});

test("policy-approved materialization reuses pinned canonical routing without runtime grants", async () => {
  const root = join(testRoot, `legacy-skill-lifecycle-routing-${randomUUID()}`);
  const raw = "---\nname: Pinned Skill\ndescription: An example\n---\nDo not execute commands.\n";
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills", "Example.md"), raw);
  try {
    const docs = [decodeMarkdown("example", raw, "Example.md", "skills")];
    const run = (operation, args) => readSkillRouting(root, docs, { operation, args, actorId: actor.id });
    const snapshot = run("knowledge.skill.routing.sources", {}).snapshotRevision;
    let projections = 0;
    const host = { authorize: (a, workspace) => a.id === actor.id && workspace === "workspace",
      async project(_actor, args) { projections++; return run("knowledge.skill.routing.project", args); } };
    const input = { workspaceId: "workspace", source: "pkm-personal", snapshotRevision: snapshot,
      selected: [{ id: "example", documentSha256: hash(raw) }] };
    await assert.rejects(materializeLegacySkills(host, { ...actor, id: "denied" }, input), { code: "ACCESS_DENIED" });
    await assert.rejects(materializeLegacySkills(host, actor, { ...input, source: "subscriber:remote" }), { code: "INVALID_ARGUMENT" });
    assert.equal(projections, 0);
    const result = await materializeLegacySkills(host, actor, input);
    assert.equal(result.items[0].content, "Do not execute commands.\n");
    assert.equal(result.projection, null);
    await assert.rejects(materializeLegacySkills(host, actor, { ...input, snapshotRevision: "0".repeat(64) }), { code: "CONFLICT" });
    await assert.rejects(materializeLegacySkills(host, actor, { ...input, selected: [{ ...input.selected[0], documentSha256: "0".repeat(64) }] }), { code: "CONFLICT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery requires matching intent and explicit approval; before retries, after commits, unknown fences", async () => {
  const input = makeInput(), plan = prepareLegacySkillLifecycle(binding, input, source, null, []);
  const fingerprint = hash("trusted");
  let state = "before", approved = false, applies = 0, commits = 0;
  const host = {
    async withExclusive(work) { return work(); }, authorize: () => true, approveRetry: () => approved,
    async readPending() { return { plan, planSha256: legacySkillLifecyclePlanHash(plan), fingerprint }; },
    async scan() {
      if (state === "before") return { source, destination: null, manifest: [] };
      if (state === "after") return { source, destination: Buffer.from(plan.afterContent), manifest: plan.afterManifest };
      return { source, destination: null, manifest: [{ kind: "directory", path: "unexpected" }] };
    },
    async applyAndVerify() { applies++; }, async commit() { commits++; },
  };
  await assert.rejects(recoverLegacySkillLifecycle(host, actor, input.operationId, fingerprint), { code: "ACCESS_DENIED" });
  approved = true;
  await assert.rejects(recoverLegacySkillLifecycle(host, actor, randomUUID(), fingerprint), { code: "CONFLICT" });
  state = "unknown";
  await assert.rejects(recoverLegacySkillLifecycle(host, actor, input.operationId, fingerprint), { code: "CONFLICT" });
  assert.equal(applies + commits, 0);
  state = "before";
  assert.deepEqual(await recoverLegacySkillLifecycle(host, actor, input.operationId, fingerprint), plan.result);
  assert.equal(applies, 1); assert.equal(commits, 1);
  state = "after";
  assert.deepEqual(await recoverLegacySkillLifecycle(host, actor, input.operationId, fingerprint), plan.result);
  assert.equal(applies, 1); assert.equal(commits, 2);
});

test("native scanner rejection of symlinks or cancellation precedes staging", async () => {
  const root = join(testRoot, `legacy-skill-lifecycle-link-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    symlinkSync("absent", join(root, "link"));
    let stages = 0, cancelled = false;
    const host = {
      async withExclusive(work) { return work(); }, authorize: () => true,
      async replayOrFence() { return { kind: "new" }; },
      async scan() { if (cancelled) throw new Error("cancelled"); if (lstatSync(join(root, "link")).isSymbolicLink()) throw new Error("symlink denied"); },
      async stage() { stages++; }, async applyAndVerify() { throw new Error("unreachable"); }, async commit() { throw new Error("unreachable"); },
    };
    const input = makeInput();
    await assert.rejects(executeLegacySkillLifecycle(host, actor, binding, input, hash("trusted")), /symlink denied/);
    cancelled = true;
    await assert.rejects(executeLegacySkillLifecycle(host, actor, binding, input, hash("trusted")), /cancelled/);
    assert.equal(stages, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
