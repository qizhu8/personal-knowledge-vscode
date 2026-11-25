import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInstalledActionPureOracle } from "../../tests/installed-action-pure-oracle.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import {
  createInstalledNativeActionPureStageProtocol, startInstalledNativeActionPureUi,
} from "./installed-native-action-pure-ui.mjs";

const states = new WeakMap(), prefix = "native-action-pure";
const tools = ["action_templates", "action_definition_check", "action_graph_check", "action_capabilities"];
const actionPaths = ["actions", "action-module-sets", ".pkm/state/actions"];
const fail = code => { throw Object.assign(new Error(code), { code }); };
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_ACTION_PURE_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_ACTION_PURE_VERIFIED_PHASE_REQUIRED");
  return state;
}
export const installedNativeActionPureStageNames = Object.freeze([
  "templates", "definition-invalid", "graph-constant", "graph-typed",
  "capabilities-denied", "definition-registry-denied", "graph-private-denied", "graph-nested-private-denied",
].map(name => `${prefix}-${name}`));

export function assertInstalledNativeActionPureCatalog(catalog, receipt) {
  assert.equal(catalog.provenance.metadataSha256, receipt.sourceCatalogSha256);
  return tools.map(tool => {
    const contract = catalog.contracts.find(item => item.transportName === tool);
    assert(contract, `Missing exact Original Action contract ${tool}`);
    assert.equal(contract.id, `mcp.tool.${tool}`); assert.equal(contract.version, 1);
    assert.equal(contract.readOnly, true, "All four exact Original contracts must remain readonly; hints grant nothing.");
    const field = tool === "action_definition_check" ? "definition" : tool === "action_graph_check" ? "graph" : undefined;
    assert.deepEqual(contract.inputSchema, {
      additionalProperties: false, properties: field ? { [field]: { additionalProperties: true, type: "object" } } : {},
      ...(field ? { required: [field] } : {}), type: "object",
    }, "Never invent registry, source, referrer, execution or credential arguments.");
    return { tool, operation: contract.id, version: 1, readOnly: true };
  });
}
async function image(root, knowledgeOnly = false) {
  const files = await u.files(root, knowledgeOnly), directories = [];
  let count = files.length;
  async function walk(path, member, depth = 0) {
    const stat = await lstat(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid());
    assert(++count <= 16384 && depth <= 32, "Bounded disposable Root image required.");
    directories.push({ path: member, mode: stat.mode & 0o777 });
    for (const name of (await readdir(path)).sort()) {
      const next = join(path, name), info = await lstat(next);
      if (info.isDirectory()) await walk(next, member ? `${member}/${name}` : name, depth + 1);
    }
  }
  if (knowledgeOnly) for (const area of ["notes", "skills", "papers"]) await walk(join(root, area), area);
  else await walk(root, "");
  const rows = [];
  for (const file of files) {
    const stat = await lstat(join(root, file.path));
    rows.push({ path: file.path, sha256: file.sha256, size: file.bytes.length, mode: stat.mode & 0o777 });
  }
  return { files: rows, directories };
}
function business(component) {
  const database = component.storage.connectNative();
  try {
    const rows = table => {
      const values = database.prepare(`SELECT * FROM ${table} ORDER BY 1 LIMIT 4097`).all().map(row => ({ ...row }));
      assert(values.length <= 4096, "Only a bounded disposable business journal is eligible.");
      return values;
    };
    return { receipts: rows("receipts"), intents: rows("migration_runtime_intents"), documents: rows("documents") };
  } finally { database.close(); }
}
async function controls(state, root) {
  for (const file of state.protectedFiles) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
  for (const path of actionPaths) await u.absent(join(root, path), "INSTALLED_ACTION_PURE_SOURCE_OR_RUNTIME_APPEARED");
}
function valueOf(response) {
  assert(response && response.isError !== true, JSON.stringify(response));
  const value = response.structuredContent ?? JSON.parse(response.content[0].text);
  assert.deepEqual(JSON.parse(response.content[0].text), value, "Original raw content and structured result must agree.");
  u.noPrivatePublication(value); return value;
}

/** Call cold/pre-B0. This prepares only a closed oracle; it never seeds Action sources or grants. */
export async function prepareInstalledNativeActionPureFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_ACTION_PURE_ALREADY_PREPARED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_ACTION_PURE_EXPLICIT_PYTHON_REQUIRED");
  await u.privateDirectory(componentFixture.root, "INSTALLED_ACTION_PURE_PRIVATE_ROOT_REQUIRED");
  for (const path of ["b0", "custody"]) await u.absent(join(componentFixture.directory, path), "INSTALLED_ACTION_PURE_PRE_B0_REQUIRED");
  for (const path of ["core.sqlite", ".pkm-next-original-mcp.json", ...actionPaths])
    await u.absent(join(componentFixture.root, path), "INSTALLED_ACTION_PURE_PRE_B0_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacyStat = await lstat(privacyPath);
  assert(privacyStat.isFile() && !privacyStat.isSymbolicLink() && privacyStat.nlink === 1
    && privacyStat.uid === process.getuid() && !(privacyStat.mode & 0o077));
  assert.deepEqual(JSON.parse(await readFile(privacyPath)), installedNativeKnowledgeMovePrivacyPolicy,
    "Parent must configure independent ordinary PUBLIC/Private policy before preparation.");
  const baseline = await image(componentFixture.root), before = await u.files(componentFixture.root);
  const oracle = await createInstalledActionPureOracle({ directory: componentFixture.directory, legacyVsix, python });
  const [componentContracts] = oracle.invoke([{ fixture: "component-contracts" }]);
  assert(componentContracts.result, JSON.stringify(componentContracts));
  const components = new Map(componentContracts.result.map(component => [component.action_id, component]));
  const node = (id, actionId, parameters, extra = {}) => ({
    id, action_id: actionId, content_hash: components.get(actionId).content_hash, parameters, ...extra,
  });
  const validDefinition = {
    schema: "pkm.action.definition/v1", action_id: "example.installed.registry", version: 1,
    input_schema: { type: "object" }, output_schema: { type: "object" }, effects: ["pure"],
    implementations: [{ kind: "program", platforms: ["Linux", "Windows", "Darwin"],
      program: "never-execute-private-action", args: ["--never-read-private-source"] }],
  };
  const hidden = { id: "query", action_id: "private.installed.query", inputs: {} };
  const requests = [
    { tool: "action_templates", arguments: {} },
    { tool: "action_definition_check", arguments: { definition: {} } },
    { tool: "action_graph_check", arguments: { graph: {
      action_id: "example.installed.constant", nodes: [node("constant", "core.constant", { value: "closed Original" })],
    } } },
    { tool: "action_graph_check", arguments: { graph: {
      action_id: "example.installed.typed", name: "", nodes: [
        node("constant", "core.constant", { value: "42" }, { value_type: "string" }),
        node("cast", "core.cast", { target_type: "integer" }, { value_type: "integer", implementation: "javascript" }),
      ], edges: [{ source: "constant", output: "value", target: "cast", input: "value" }],
    } } },
    { tool: "action_capabilities", arguments: {}, refusal: true },
    { tool: "action_definition_check", arguments: { definition: validDefinition }, refusal: true },
    { tool: "action_graph_check", arguments: { graph: {
      action_id: "example.installed.private", nodes: [{ id: "private", action_id: hidden.action_id, content_hash: "0".repeat(64) }],
    } }, refusal: true },
    { tool: "action_graph_check", arguments: { graph: {
      action_id: "example.installed.nested", nodes: [node("loop", "core.for",
        { items: [], body: [hidden], value: null, max_iterations: 1 })],
    } }, refusal: true },
  ].map((step, index) => Object.freeze({ ...step, arguments: Object.freeze(step.arguments),
    stage: installedNativeActionPureStageNames[index], noReview: true }));
  const cases = requests.filter(step => step.tool !== "action_capabilities");
  const expected = oracle.invoke(cases);
  cases.forEach((step, index) => {
    if (step.refusal) assert.match(expected[index].boundary ?? "", /private workspace metadata/);
    else assert(expected[index].result, JSON.stringify(expected[index]));
  });
  assert(expected[0].result.templates.length > 0, "A nonempty actual Original catalogue is mandatory.");
  assert.deepEqual(await u.files(componentFixture.root), before, "Oracle preparation must not alter any Root bytes or modes.");
  const rootStat = await lstat(componentFixture.root);
  const value = Object.freeze({ kind: "pkm.installed-native-action-pure-fixture/v1", root: componentFixture.root,
    originalPackageSha256: oracle.originalPackageSha256, stageCount: requests.length,
    completeOperationIds: Object.freeze(["mcp.tool.action_templates"]) });
  const state = { installed, componentFixture, value, baseline, rootIdentity: [rootStat.dev, rootStat.ino],
    requests, expected: new Map(cases.map((step, index) => [step.stage, expected[index].result])),
    protectedFiles: before.filter(file => !["notes", "skills", "papers"].includes(file.path.split("/")[0])), phase: "prepared" };
  states.set(componentFixture, state); states.set(value, state); return value;
}

/** Parent owns editors, normal Host admission, cold component, shutdown and recovery. No Action authority is requested. */
export async function verifyInstalledNativeActionPure({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture, "prepared");
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_ACTION_PURE_SAME_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  const catalog = (await u.load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  const publicContracts = assertInstalledNativeActionPureCatalog(catalog, host.receipt);
  const binding = { root: component.root, workspaceId: component.workspaceId, custodyPlanSha256: component.custody.planSha256,
    catalogSha256: host.receipt.sourceCatalogSha256, profileSha256: host.receipt.profileSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const installedPins = {};
  for (const name of ["original-mcp-action-pure", "original-mcp-public", "original-mcp-cold-component",
    "domain/action-compiler-graph", "domain/action-compiler-validation", "domain/legacy-action-mcp-original"])
    installedPins[name] = u.hash(await readFile(join(installed, "next-runtime/server/dist", `${name}.js`)));
  installedPins.hostEntry = u.hash(await readFile(join(installed, "dist/extension.cjs")));
  const runId = randomUUID(), abort = new AbortController(), lease = { ...component.owner.workspaceLease() };
  const preludeKnowledge = await image(component.root, true), beforeBusiness = business(component);
  state.b0Sha256 = component.b0.sha256; state.driverRoot = root;
  await controls(state, component.root);
  await writeFile(join(root, `${prefix}-ui-contract.json`), JSON.stringify({
    schema: "pkm.installed-native-action-pure-ui/v1", runId, binding, publicContracts, stages: state.requests,
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeActionPureUi({ root, python, env, port, runId, timeoutMs });
  void ui.done.catch(error => abort.abort(error));
  const check = async () => {
    if (ui.error) throw ui.error;
    abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
    assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await controls(state, component.root);
  };
  const protocol = await createInstalledNativeActionPureStageProtocol({ root, runId, timeoutMs,
    stages: installedNativeActionPureStageNames, check });
  const outcomes = [], acknowledgements = [];
  try {
    await ui.ready; await check();
    for (const step of state.requests) {
      await protocol.begin(step.stage);
      const filesBefore = await u.files(component.root, true), journalBefore = business(component);
      let response, failure;
      try { response = await component.invoke(step.tool, step.arguments, abort.signal); }
      catch (error) { failure = error; }
      if (step.refusal) {
        const denied = failure ?? (response?.isError ? response.structuredContent ?? response : undefined);
        assert(denied, "A runtime-required control must not return success-like business data.");
        const message = denied.message ?? JSON.stringify(denied);
        assert.match(message, /ACTION_FULL_RUNTIME_REQUIRED:/,
          "Policy/adapter stage-not-admitted or unrelated failures do not count as the exact full-runtime boundary.");
        u.noPrivatePublication({ message });
        outcomes.push({ stage: step.stage, tool: step.tool, denied: true, code: denied.code ?? null,
          fullRuntimeRequired: true, noActionSourceOrRuntimeAdmission: true });
      } else {
        if (failure) throw failure;
        const actual = valueOf(response);
        assert.deepEqual(actual, state.expected.get(step.stage), "Actual component.invoke must match the closed sealed22 business result.");
        outcomes.push({ stage: step.stage, tool: step.tool, originalResultSha256: u.hash(JSON.stringify(actual)),
          exactClosedOriginalResult: true });
      }
      assert.deepEqual(await u.files(component.root, true), filesBefore, "Every stage preserves the whole post-prelude Knowledge image.");
      assert.deepEqual(business(component), journalBefore, "Read tools and denials must leave all business receipts/intents/documents unchanged.");
      await check(); acknowledgements.push(await protocol.complete(step.stage));
    }
    await protocol.finish(); await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, `${prefix}-ui-passed.json`)));
    assert.equal(proof.runId, runId); assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true);
    assert.deepEqual(proof.dialogs, [], "No PUBLIC, source, credential, trust or execution modal may be added.");
    assert.equal(acknowledgements.length, state.requests.length);
    assert(acknowledgements.every(ack => ack.noUnexpectedModal === true));
    assert.deepEqual(await image(component.root, true), preludeKnowledge); assert.deepEqual(business(component), beforeBusiness);
    state.finalKnowledge = preludeKnowledge;
    state.evidence = { passed: true, actualNativeUi: true, actualComponentInvoke: true, payloadBuildId, binding, installedPins,
      originalPackageSha256: sourceFixture.originalPackageSha256, acknowledgedStageCount: acknowledgements.length,
      publicDialogCount: 0, noReviewEveryStage: true, sameOwnerLease: true, wholePreludeKnowledgeUnchanged: true,
      businessReceiptsIntentsAndDocumentsUnchanged: true, businessSnapshotSha256: u.hash(JSON.stringify(beforeBusiness)),
      completeOperationIds: sourceFixture.completeOperationIds,
      boundedOnlyOperationIds: ["mcp.tool.action_definition_check", "mcp.tool.action_graph_check"],
      deniedOperationIds: ["mcp.tool.action_capabilities"], outcomes, acknowledgements,
      actionExecutionOrSourceAdmissionPerformed: false, credentialOrExternalNetworkTestPerformed: false,
      fullAction: false, full151: false, b1AndB0Qualified: false };
    await writeFile(join(root, `${prefix}-passed.json`), JSON.stringify(state.evidence), { mode: 0o600, flag: "wx" });
    state.phase = "verified";
    return state.evidence;
  } catch (error) { await protocol.fail(error); throw error; }
  finally { if (state.phase !== "verified") state.phase = "failed"; abort.abort(); await ui.stop(); }
}

export async function verifyInstalledNativeActionPureB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const state = stateFor(sourceFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: state.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || typeof b1.b1Path !== "string" || relative(state.componentFixture.directory, b1.b1Path).includes(sep)
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? ""))
    fail("INSTALLED_ACTION_PURE_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_ACTION_PURE_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), manifest = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(manifest.root, sourceFixture.root);
  assert.equal(manifest.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  assert.deepEqual(await image(retirement.archive, true), state.finalKnowledge); await controls(state, retirement.archive);
  for (const row of [...state.finalKnowledge.files, ...state.finalKnowledge.directories]) {
    const captured = manifest.rows.find(item => item.path === row.path);
    assert(captured, "B1 must contain every final Knowledge file/directory and exact mode.");
    assert.equal(captured.mode, row.mode);
    if (row.sha256) { assert.equal(captured.sha256, row.sha256); assert.equal(captured.size, row.size); }
  }
  const runtimeNames = ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"];
  for (const name of (await readdir(retirement.archive)).filter(name => name.startsWith("core.sqlite")))
    assert(runtimeNames.includes(name), "Unknown native sidecars cannot be silently discarded.");
  for (const row of manifest.rows.filter(row => row.path.startsWith("core.sqlite")))
    assert(runtimeNames.includes(row.path) && row.directory === false);
  for (const name of runtimeNames) {
    const captured = manifest.rows.find(row => row.path === name);
    if (!captured) {
      assert.notEqual(name, "core.sqlite");
      await u.absent(join(retirement.archive, name), "INSTALLED_ACTION_PURE_NEW_SIDECAR"); continue;
    }
    const bytes = await readFile(join(retirement.archive, name)), stat = await lstat(join(retirement.archive, name));
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o777, captured.mode); assert.equal(bytes.length, captured.size); assert.equal(u.hash(bytes), captured.sha256);
    assert.equal(u.hash(await readFile(join(b1.b1Path, "payload", name))), captured.sha256);
    if (name === "core.sqlite") assert.equal(captured.sha256, stoppedCoreSha256);
    if (name === "core.sqlite-wal") assert.equal(bytes.length, 0);
  }
  return { b1Sha256: receipt.b1Sha256, stoppedCoreSha256, exactKnowledgeModesAndStoppedCoreSidecars: true,
    noArchivedSqliteReopen: true };
}
export async function verifyInstalledNativeActionPureRestored(sourceFixture, options) {
  const state = stateFor(sourceFixture, "verified"), b1 = await verifyInstalledNativeActionPureB1(sourceFixture, options);
  const expected = { componentFixture: state.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: state.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, options.retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, options.retirement, options.restored, retired);
  assert.deepEqual(await image(options.restored.root), state.baseline, "Fresh B0 must reproduce the complete baseline bytes and modes.");
  const rootStat = await lstat(options.restored.root);
  assert.notDeepEqual([rootStat.dev, rootStat.ino], state.rootIdentity);
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace",
    ".pkm-next-original-mcp.json", ".pkm-native", ...actionPaths])
    await u.absent(join(options.restored.root, path), "INSTALLED_ACTION_PURE_B0_NATIVE_STATE");
  const recovery = { ...b1, freshB0ExactBytesAndModes: true, originalRootOverwritten: false,
    freshB0NoNativeDatabaseOrActionGrants: true, b1AndB0Qualified: true, fullAction: false, full151: false };
  await writeFile(join(state.driverRoot, `${prefix}-recovery-passed.json`),
    JSON.stringify({ ...state.evidence, ...recovery }), { mode: 0o600, flag: "wx" });
  return recovery;
}
