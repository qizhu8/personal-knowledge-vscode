import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  prepareInstalledNativeActionPureFixture, verifyInstalledNativeActionPure, verifyInstalledNativeActionPureB1,
  verifyInstalledNativeActionPureRestored, assertInstalledNativeActionPureCatalog,
} from "./installed-native-action-pure.mjs";
import {
  createInstalledNativeActionPureStageProtocol, installedNativeActionPureUiProgram, startInstalledNativeActionPureUi,
} from "./installed-native-action-pure-ui.mjs";
import { installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the actual private Linux framework.");
assert(process.env.PKM_LEGACY_VSIX); assert(process.env.PKM_TEST_PYTHON);
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t) {
  const directory = resolve("tests", `.action-pure-installed-helper-${randomUUID()}`);
  await mkdir(join(directory, ".local/state/pkm-v5-recovery"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = process.env.HOME;
  let componentFixture;
  try {
    process.env.HOME = directory;
    componentFixture = await recovery.createOriginalMcpColdComponentFixture(
      join(directory, ".local/state/pkm-v5-recovery", `action-pure-${randomUUID()}`));
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
  for (const name of ["notes", "skills", "papers", ".pkm"])
    await mkdir(join(componentFixture.root, name), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "Unchanged common prelude control.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"),
    JSON.stringify(installedNativeKnowledgeMovePrivacyPolicy), { mode: 0o600 });
  return componentFixture;
}
test("pure installed preparation executes sealed22 closures without Root changes or manufacturing installed/B1 success", {
  timeout: 120000,
}, async t => {
  const componentFixture = await fixture(t);
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeActionPureFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  const before = await u.files(componentFixture.root);
  const prepared = await prepareInstalledNativeActionPureFixture(args);
  assert.equal(prepared.stageCount, 8); assert.equal(prepared.passed, undefined);
  assert.deepEqual(await u.files(componentFixture.root), before);
  for (const name of ["actions", "action-module-sets", ".pkm/state/actions", "core.sqlite"])
    await assert.rejects(readFile(join(prepared.root, name)), { code: "ENOENT" });
  const verify = { root: resolve("."), installed, sourceFixture: prepared,
    component: { root: prepared.root, fixture: componentFixture } };
  await assert.rejects(verifyInstalledNativeActionPure(verify), { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionPure({ ...verify, sourceFixture: { ...prepared } }),
    { code: "INSTALLED_ACTION_PURE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionPureB1(prepared, {}), { code: "INSTALLED_ACTION_PURE_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionPureRestored(prepared, {}), { code: "INSTALLED_ACTION_PURE_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeActionPureFixture(args), { code: "INSTALLED_ACTION_PURE_ALREADY_PREPARED" });
});
test("already sealed fixtures are refused before extraction or business preparation", async t => {
  const componentFixture = await fixture(t);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeActionPureFixture({ installed, componentFixture, python,
    legacyVsix: process.env.PKM_LEGACY_VSIX }), { code: "INSTALLED_ACTION_PURE_PRE_B0_REQUIRED" });
  assert(!(await readdir(componentFixture.directory)).includes("action-pure-original22-oracle"));
});
test("catalogue hint/input drift and unsafe UI drivers fail closed; every new readonly observer program compiles", async () => {
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const receipt = { sourceCatalogSha256: catalog.provenance.metadataSha256 };
  assertInstalledNativeActionPureCatalog(catalog, receipt);
  const drift = structuredClone(catalog);
  drift.contracts.find(row => row.transportName === "action_capabilities").readOnly = false;
  assert.throws(() => assertInstalledNativeActionPureCatalog(drift, receipt), /must remain readonly/);
  const injection = structuredClone(catalog);
  injection.contracts.find(row => row.transportName === "action_templates").inputSchema.properties.referrer = { type: "string" };
  assert.throws(() => assertInstalledNativeActionPureCatalog(injection, receipt), /Never invent/);
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<action-pure-ui>','exec')"],
    { input: installedNativeActionPureUiProgram, timeout: 10000, stdio: "pipe" });
  await assert.rejects(startInstalledNativeActionPureUi({ root: resolve("."), python, runId: randomUUID(), port: 9222 }),
    { code: "INSTALLED_ACTION_PURE_PRIVATE_DRIVER_REQUIRED" });
});
test("readonly stage ACKs cannot advance without exact run binding or hide a failed observer", async t => {
  for (const mode of ["wrong-run", "observer-failed"]) {
    const root = resolve("tests", `.installed-host-${randomUUID()}`), runId = randomUUID();
    await mkdir(root, { mode: 0o700 }); t.after(() => rm(root, { recursive: true, force: true }));
    const stages = ["native-action-pure-templates", "native-action-pure-definition-invalid"];
    const protocol = await createInstalledNativeActionPureStageProtocol({ root, runId, timeoutMs: 3000, stages });
    await protocol.begin(stages[0]);
    await assert.rejects(protocol.begin(stages[1]), { code: "INSTALLED_ACTION_PURE_STAGE_PENDING_ACK" });
    const observer = { schema: "pkm.installed-native-action-pure-ui-status/v1", runId,
      failed: mode === "observer-failed", phase: "waiting-work-complete" };
    await writeFile(join(root, "native-action-pure-ui-status.json"), JSON.stringify(observer), { mode: 0o600 });
    await writeFile(join(root, `native-action-pure-ui-ack-${stages[0]}.json`), JSON.stringify({
      schema: "pkm.installed-native-action-pure-ui-ack/v1", runId: randomUUID(), stage: stages[0],
      phase: "complete", noUnexpectedModal: true,
    }), { mode: 0o600 });
    await assert.rejects(protocol.complete(stages[0]), { code: mode === "observer-failed"
      ? "INSTALLED_ACTION_PURE_OBSERVER_FAILED" : "INSTALLED_ACTION_PURE_ACK_BINDING_MISMATCH" });
    await assert.rejects(protocol.finish(), { code: "INSTALLED_ACTION_PURE_STAGE_PENDING_ACK" });
    const failure = JSON.parse(await readFile(join(root, "native-action-pure-failure.json")));
    assert.equal(failure.stage, stages[0]); assert.deepEqual(failure.observer, observer);
  }
});
