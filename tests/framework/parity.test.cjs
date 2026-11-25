"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ROOT, MATRIX, buildMatrix, originalContracts, sourceFacts, validateMatrix } = require("./parity.cjs");

const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, MATRIX), "utf8"));
const row = name => matrix.operations.find(operation => operation.id === `mcp.tool.${name}`);

test("parity enumerates the independent original oracle exactly and separates A, source gates and effects", () => {
  const { contracts } = originalContracts(ROOT);
  const report = validateMatrix(matrix);
  assert.equal(report.staticOnly, true);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.verifiedEffectSequences, 0);
  assert.equal(report.unverifiedOriginalOperations, 151);
  assert.equal(report.aliasesCountedAsOperations, 0);
  assert.deepEqual(matrix.operations.map(operation => [operation.id, operation.version, operation.readOnly, operation.action]),
    contracts.map(contract => [contract.id, contract.version, contract.readOnly, contract.transportName]));
  const facts = sourceFacts(ROOT);
  assert.deepEqual(matrix.operations.filter(operation => operation.native.fullOriginalReadiness === "implemented")
    .map(operation => operation.action).sort(), [...facts.gate].sort());
  for (const operation of matrix.operations) {
    assert.equal(operation.compatibilityA.executor, "original-business-runtime");
    assert.equal(operation.compatibilityA.database, "original-business-database");
    assert.equal(operation.compatibilityA.channel, operation.readOnly ? "capability_read" : "capability_call");
    if (!operation.evidence.reviewedEvidenceRefs.length)
      assert.equal(operation.evidence.installed, "unverified-operation-sequence");
    assert.equal(operation.evidence.production, "unverified-operation-sequence");
  }
  assert.equal(row("api_chat_send").native.dispatch, "implemented");
  assert.equal(row("api_chat_send").native.nativeDogfoodWritable, "disabled");
  assert.equal(row("api_chat_send").native.fullOriginalReadiness, "blocked");
  assert.equal(row("update_skill").native.nativeDogfoodWritable, "conditional");
  assert.match(row("add_skill").native.reason, /same-name.*scoped installed.*sanitized destination collision/);
  assert.match(row("add_skill").native.reason, /new producer path has no additional installed evidence/);
});

test("missing, duplicated and orphan original mappings fail even when their total remains 151", () => {
  const absent = structuredClone(matrix);
  absent.operations.pop();
  assert.throws(() => validateMatrix(absent));
  const duplicate = structuredClone(matrix);
  duplicate.operations[1] = structuredClone(duplicate.operations[0]);
  assert.throws(() => validateMatrix(duplicate), /Duplicate original operation mapping/);
  const alias = structuredClone(matrix);
  alias.operations[0].id = "mcp.tool.skill_write";
  assert.throws(() => validateMatrix(alias), /Missing\/orphan/);
  const changedRole = structuredClone(matrix);
  changedRole.operations.find(operation => operation.action === "list_papers").readOnly = true;
  assert.throws(() => validateMatrix(changedRole), /Original contracts/);
  assert.equal(row("list_papers").readOnly, false);
  assert.equal(row("paper_graph").readOnly, false);
  assert.equal(row("get_subscribed_content").readOnly, false);
});

test("integrated producers change implementation facts without borrowing installed, pure or historical qualification", () => {
  const facts = sourceFacts(ROOT);
  assert.equal(facts.action.length, 21);
  assert.equal(facts.authoring.length, 15);
  assert(facts.authoring.includes("action_module_sets") && facts.action.includes("action_module_sets"));
  const integrated = [...facts.authoring, ...facts.action, ...facts.subscription, ...facts.maintenance,
    ...facts.recipeExecution, "recipe_create_from_skill", "recipe_capabilities", "portal_control", "diagnostics_latest"];
  for (const name of new Set(integrated)) {
    const entry = row(name);
    assert.equal(entry.native.dispatch, "implemented", name);
    assert.equal(entry.native.fullOriginalReadiness, "implemented", name);
    assert.equal(entry.native.blockerCode, null, name);
    if (!entry.evidence.reviewedEvidenceRefs.length)
      assert.equal(entry.evidence.installed, "unverified-operation-sequence", name);
    assert.equal(entry.evidence.production, "unverified-operation-sequence", name);
  }
  assert.match(row("list_subscriptions").native.reason, /separate per-call native read consent/);
  assert.match(row("skill_feedback").native.reason, /must not mutate formal Skills/);
  assert.match(row("diagnostics_latest").native.reason, /No persisted diagnostic history/);
  assert.match(row("knowledge_file_trash").native.reason, /Prompt\/Script v3.*Historical installed/);
  assert.equal(row("knowledge_file_trash").evidence.installed, "unverified-operation-sequence");
  const report = validateMatrix(matrix);
  assert.equal(report.nativeGateImplemented, 78);
  assert.equal(report.verifiedEffectSequences, 0);
  assert.equal(report.fullNativeParityReady, false);
  for (const name of ["action_register", "list_subscriptions", "skill_feedback", "recipe_run_start",
    "portal_control", "diagnostics_latest"]) {
    const promoted = structuredClone(matrix);
    promoted.operations.find(entry => entry.action === name).evidence.installed = "reviewed-installed-success";
    assert.throws(() => validateMatrix(promoted), /source availability changed/);
  }
});

test("imported tool facts fail closed for reshaped declarations and missing genuine producer or authority calls", () => {
  const readFileSync = fs.readFileSync;
  const mutations = [
    ["src/original-mcp-action-runtime.ts", '"./original-mcp-action-tools.js"', '"./unreviewed-action-tools.js"'],
    ["src/original-mcp-action-tools.ts", '"action_run_events"', '"action_orphan"'],
    ["src/original-mcp-action-tools.ts", "originalMcpActionRuntimeTools.map", "unreviewedTools.map"],
    ["src/original-mcp-action-tools.ts", '"action_register",', '...unreviewedTools, "action_register",'],
    ["src/original-mcp-public.ts", "return result(await dispatchOriginalMcpActionAuthoring(",
      "return result(await unavailableAuthoring("],
    ["src/original-mcp-public.ts", "if (originalMcpActionOperationIds.includes(contract.id)) return undefined;",
      "if (originalMcpActionOperationIds.includes(contract.id)) return false;"],
    ["src/original-mcp-action-authoring.ts", "value = await legacyActionWrite(", "value = await unavailableWrite("],
    ["src/original-mcp-action-authoring.ts", "originalMcpPublicRequestMatches(storage", "unreviewedRequest(storage"],
    ["src/original-mcp-action-runtime.ts", "await invokeOriginalMcpAction(", "await unavailableAction("],
    ["src/original-mcp-subscription.ts", "await host.authorizeSubscriptionRead(", "await host.unreviewedRead("],
    ["src/original-mcp-skill-maintenance.ts", "return legacySkillMaintenance(", "return unavailableMaintenance("],
    ["src/original-mcp-portal.ts", "await requestOriginalMcpNative(", "await unavailablePortal("],
    ["src/native-current-process-diagnostics.ts", "source.writer.latest(args.limit)", "unreviewedHistory(args.limit)"],
    ["src/original-mcp-recipe-execution.ts", "return (await createOriginalMcpRecipeExecution(",
      "return (await unavailableRecipeExecution("],
  ];
  try {
    for (const [file, before, after] of mutations) {
      const target = path.join(ROOT, file);
      let inspected = false;
      fs.readFileSync = function(input, ...args) {
        const value = readFileSync.call(this, input, ...args);
        if (input !== target) return value;
        assert(value.includes(before), `${file}: mutation must hit actual source`);
        inspected = true;
        return value.replaceAll(before, after);
      };
      assert.throws(() => buildMatrix(), /parity review|literal tool selection|source\/effect binding missing|orphan original operation/i, file);
      assert(inspected, file);
    }
    const publicFile = path.join(ROOT, "src/original-mcp-public.ts");
    fs.readFileSync = function(input, ...args) {
      const value = readFileSync.call(this, input, ...args);
      if (input !== publicFile) return value;
      const fallback = value.match(/if \(originalMcpPureActionTool\(request\.tool\)\)\s+return result\(invokeOriginalMcpPureAction\(request\.tool, request\.arguments\)\);/);
      assert(fallback, "The mutation must move the actual pure fallback");
      return value.replace(fallback[0], "").replace("if (originalMcpActionAuthoringTool(request.tool))",
        `${fallback[0]}\nif (originalMcpActionAuthoringTool(request.tool))`);
    };
    assert.throws(() => buildMatrix(), /authoring must precede.*pure fallback/);
  } finally { fs.readFileSync = readFileSync; }
});

test("each required case names its original operation, closed original sequence and explicit effect oracles", () => {
  const known = new Set(matrix.operations.map(operation => operation.id));
  for (const operation of matrix.operations) {
    const requirement = operation.requiredCase;
    assert(requirement.steps.some(step => step.operation === operation.id), operation.id);
    for (const step of requirement.steps) {
      assert(step.operation === null || known.has(step.operation), `${operation.id}: ${step.operation}`);
      assert(step.stage && step.oracle, operation.id);
    }
    for (const check of ["guarded-denial-zero-effect", "expiry-cancel-no-late-effect",
      "durable-receipt-or-read-preservation", "restart-no-replay", "B1-B0-preservation"])
      assert(requirement.requiredChecks.includes(check), `${operation.id}: ${check}`);
  }
  for (const name of ["add_skill", "get_skill", "update_skill", "list_skills", "search_skills"]) {
    const steps = row(name).requiredCase.steps;
    assert.deepEqual(steps.slice(0, 5).map(step => step.stage),
      ["write", "read-after-write", "update", "read-after-update", "retrieve"]);
  }
  for (const name of ["get_script", "search_scripts"]) {
    const requirement = row(name).requiredCase;
    assert.match(requirement.fixture, /no Script create\/update\/execute operation/);
    assert(requirement.steps.some(step => step.operation === null && step.stage === "fixture-update"));
    assert(!requirement.profileRestrictions.unsealedExternalRefresh.includes("installed-native-isolated"));
    assert.match(requirement.profileRestrictions.nativeSealedCustody, /v1 Scripts are auxiliary-only/);
  }
  assert(!known.has("mcp.tool.script_write"));
  assert.match(row("retrieval_feedback").requiredCase.steps.find(step =>
    step.operation === "mcp.tool.retrieval_feedback").oracle, /real retrieval receipt/);
});

test("the exact inspected A Skill case registers five original operations without promoting native or full acceptance", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "compatibility-a-skill-basic-roundtrip");
  assert(effect);
  assert.equal(effect.executionProfile, "compatibility-a-isolated");
  assert.equal(effect.test.file, "tests/compatibility-mcp.test.mjs");
  assert(effect.stages.some(stage => stage.stage === "read-after-write"));
  assert(effect.stages.some(stage => stage.stage === "read-after-update"));
  assert(effect.stages.some(stage => stage.stage === "retrieve"));
  assert(effect.stages.some(stage => stage.stage === "guarded-denial-zero-effect"));
  assert(effect.stages.some(stage => stage.stage === "restart"));
  assert.match(effect.receipt, /NOT canonical durable native/);
  assert.match(effect.preservation, /NOT full B1\/B0/);
  assert.equal(effect.reportedRun.fileCasesSkipped, 0);
  for (const operation of effect.operations) {
    const entry = matrix.operations.find(candidate => candidate.id === operation);
    assert.equal(entry.evidence.compatibilityA, "operator-attested-isolated-basic-success");
    assert.equal(entry.requiredCase.coverage, "A-and-native-same-name-upsert-basic-receipts-preservation-full-acceptance-incomplete");
  }
  const cold = matrix.effectCases.find(candidate => candidate.id === "native-cold-source-skill-upsert-roundtrip");
  assert.equal(cold.reportedRun.fileCasesPassed, cold.reportedRun.frameworkRun.mappedWholeFileCasesPassed);
  assert(cold.reportedRun.frameworkRun.casesPassed >= cold.reportedRun.fileCasesPassed,
    "Batch totals must remain separate from the actual mapped whole-file count");
  assert.match(cold.reportedRun.trust, /no additional operation mapping/);
});

test("effect registrations reject orphan operations, missing independent assertions and pass-by-registration", () => {
  for (const mutate of [
    effect => { effect.operations.push("mcp.tool.skill_write"); },
    effect => { effect.stages[0].operation = "mcp.tool.delete_skill"; },
    effect => { effect.stages[0].assertion = ""; },
    effect => { delete effect.receipt; },
    effect => { delete effect.preservation; },
    effect => { effect.executionProfile = "production"; },
    effect => { effect.test.file = "tests/../src/core.ts"; },
    effect => { effect.test.name = "Unregistered invented effect case"; },
    effect => { effect.passed = true; },
    effect => { effect.verified = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.effectCases[0]);
    assert.throws(() => validateMatrix(changed));
  }
  const absent = structuredClone(matrix);
  absent.effectCases = [];
  assert.throws(() => validateMatrix(absent), /Missing registered effect case/);
  assert.deepEqual(buildMatrix().operations.map(operation => operation.id), matrix.operations.map(operation => operation.id));
});

test("final installed evidence maps exact native upsert stages and receipt preservation without runtime approval by registration", () => {
  const installed = matrix.effectCases.find(effect => effect.executionProfile === "installed-native-isolated");
  assert(installed.runner && !installed.test, "Actual installed coordinator is not a fabricated node:test case");
  const evidence = matrix.reviewedEvidence[installed.reviewedEvidenceRefs[0]];
  assert.deepEqual([...installed.operations].sort(), [...evidence.operations].sort());
  const stages = installed.stages.map(stage => stage.stage);
  assert(stages.indexOf("same-name-upsert") < stages.indexOf("read-after-upsert"));
  assert(stages.indexOf("read-after-upsert") < stages.indexOf("retrieve"));
  assert(stages.includes("canonical-receipt") && stages.includes("B1-B0-preservation"));
  assert(!stages.includes("guarded-denial-zero-effect"), "Note denial is not silently borrowed as Skill denial evidence");
  assert.match(evidence.canonicalReceiptHashAvailability, /no truncated hash or intermediate run identity/);
  assert(evidence.remainingGaps.includes("occupied-other-identity replacement"));
  const report = validateMatrix(matrix);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0, "CI must not access private/session artifacts");
  assert.equal(report.verifiedEffectSequences, 0);
  assert.equal(report.fullNativeParityReady, false);
  for (const mutate of [
    value => { value.effectCases.find(effect => effect.runner).runner.scenarioArgument = "--fake-isolation"; },
    value => { value.effectCases.find(effect => effect.runner).reviewedEvidenceRefs = ["caller-says-passed"]; },
    value => { Object.values(value.reviewedEvidence)[0].observations.productionCutover = true; },
    value => { Object.values(value.reviewedEvidence)[0].sha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed);
    assert.throws(() => validateMatrix(changed));
  }
});

test("A Note/Paper keeps its metadata-only oracle; Research and installed search require separate evidence", () => {
  const effect = matrix.effectCases.find(candidate => candidate.id === "compatibility-a-note-paper-basic-roundtrip");
  assert(effect);
  const mapped = new Set(effect.operations);
  for (const module of ["note", "paper"]) {
    const entry = row(`search_${module}s`);
    assert(mapped.has(entry.id));
    assert.equal(entry.evidence.compatibilityA, "operator-attested-isolated-basic-success");
    assert.equal(entry.evidence.installed, "reviewed-installed-public-note-paper-create-list-lexical-private-filter-stopped-B1-fresh-B0");
    assert(!effect.reviewedEvidenceRefs, "Original/A test results are not themselves installed proof");
    const moduleStages = effect.stages.filter(stage => stage.operation?.endsWith(`_${module}`)
      || stage.operation?.endsWith(`_${module}s`));
    assert(moduleStages.some(stage => stage.stage === "read-after-write"));
    assert(moduleStages.some(stage => stage.stage === "read-after-update"));
    assert(moduleStages.some(stage => stage.stage === "retrieve"));
    assert(moduleStages.some(stage => stage.stage === "restart"));
  }
  assert.match(effect.stages.find(stage => stage.stage === "original-offline-metadata-oracle").assertion,
    /deep-equals the actual original.*empty metadata-only fallback/);
  for (const alias of ["get_research", "list_research", "search_research"]) {
    assert(!mapped.has(row(alias).id));
    assert.deepEqual(row(alias).evidence.effectCaseRefs, ["installed-native-research-read-list-lexical-graph"]);
    assert.equal(row(alias).evidence.compatibilityA, "unverified-no-formal-effect-case");
  }
  const report = validateMatrix(matrix);
  assert.equal(report.staleOperatorAttestedCases, 0, "Both A cases must bind the latest reported whole-file run");
  assert.equal(report.distinctOriginalOperationsWithRegisteredBasicCases, new Set(matrix.effectCases
    .filter(candidate => !candidate.coverageKind || candidate.coverageKind === "basic-operation-sequence")
    .flatMap(candidate => candidate.operations)).size);
  assert.equal(report.fullNativeParityReady, false);
});

test("Trash conditional source branches and supplemental IDs never promote broker exposure or installed acceptance", () => {
  const facts = sourceFacts(ROOT);
  const conditional = matrix.operations.filter(operation => operation.module === "Trash" && operation.native.dispatch === "conditional");
  assert.deepEqual(conditional.map(operation => operation.action).sort(), [...facts.conditionalTrash].sort());
  for (const name of ["delete_note", "knowledge_file_trash"]) {
    const entry = row(name);
    assert.equal(entry.native.implementation, "partial");
    assert.equal(entry.native.developmentStatus, name === "delete_note"
      ? "installed-public-note-slice-qualified-full-parity-unqualified" : "source-conditional-unqualified");
    assert.equal(entry.native.fullOriginalReadiness, "blocked");
    assert.equal(entry.native.blockerCode, "ORIGINAL_TRASH_CUSTODY_ADMISSION_REQUIRED");
    assert.equal(entry.native.nativeDogfoodWritable, "disabled");
    if (name === "knowledge_file_trash") {
      assert.deepEqual(entry.evidence.effectCaseRefs, ["compatibility-a-reviewed-file-trash-basic"]);
      assert.equal(entry.evidence.installed, "unverified-operation-sequence");
    } else assert.deepEqual(entry.evidence.effectCaseRefs, ["installed-native-public-note-trash-basic"]);
  }
  for (const name of ["delete_skill", "delete_paper"]) {
    assert.equal(row(name).native.implementation, "partial");
    assert.equal(row(name).native.dispatch, "conditional");
    assert.equal(row(name).native.developmentStatus, "installed-public-skill-paper-v2-slice-qualified-full-parity-unqualified");
    assert.match(row(name).native.sourceCondition, new RegExp(`strict v2 area=${name === "delete_skill" ? "skills" : "papers"}`));
    assert.equal(row(name).native.fullOriginalReadiness, "blocked");
    assert.equal(row(name).native.nativeDogfoodWritable, "disabled");
    assert.equal(row(name).evidence.nativeColdSource, "unverified-no-formal-effect-case");
    assert.equal(row(name).evidence.installed, "reviewed-installed-public-unshared-skill-paper-v2-delete-restore-UI-receipts-stopped-B1-fresh-B0");
    assert.deepEqual(row(name).evidence.reviewedEvidenceRefs, ["installed-public-skill-paper-trash-v2-b4a693-parent-reviewed"]);
    assert.equal(row(name).readOnly, false);
  }
  const originals = new Set(matrix.operations.map(operation => operation.id));
  assert.deepEqual(matrix.supplementalSourceCapabilities.map(operation => operation.id).sort(), [...facts.supplementalTrash].sort());
  for (const operation of matrix.supplementalSourceCapabilities) {
    assert(!originals.has(operation.id));
    assert.equal(operation.originalBusinessOperation, false);
    assert.equal(operation.approvalBridgeIsOriginalBusinessOperation, false);
    assert.equal(operation.effectEvidence, operation.id === "knowledge.trash.lifecycle.preview"
      ? "unverified-no-formal-accepted-lifecycle-or-installed-case" : "reviewed-installed-fresh-note-slice-stage-only");
  }
  const promoted = structuredClone(matrix);
  promoted.operations.find(operation => operation.action === "delete_note").native.nativeDogfoodWritable = "enabled";
  assert.throws(() => validateMatrix(promoted), /source availability changed/);
});

test("direct supporting fixture hashes invalidate A attestations without granting a new run or reading arbitrary files", () => {
  const mutableA = new Set(["compatibility-a-skill-basic-roundtrip", "compatibility-a-note-paper-basic-roundtrip"]);
  const aCases = matrix.effectCases.filter(effect => mutableA.has(effect.id));
  assert(aCases.every(effect => effect.reportedRun.sourceFiles.some(source => source.file === effect.test.file)));
  const stale = structuredClone(matrix);
  for (const effect of stale.effectCases.filter(candidate => mutableA.has(candidate.id)))
    effect.reportedRun.sourceFiles.find(source => source.file === "tests/compatibility-mcp-fixture.mjs").sha256 = "0".repeat(64);
  const staleReport = validateMatrix(stale);
  assert.equal(staleReport.staleOperatorAttestedCases, aCases.length);
  assert.equal(staleReport.staleAttestations.length, aCases.length);
  for (const attestation of staleReport.staleAttestations) {
    assert(mutableA.has(attestation.caseId));
    assert.deepEqual(attestation.changedFiles.map(source => [source.file, source.reason]),
      [["tests/compatibility-mcp-fixture.mjs", "supporting-file-content-changed"]]);
    assert(attestation.changedFiles.every(source => source.expectedSha256 !== source.actualSha256));
  }
  assert.equal(staleReport.operatorAttestedCasesByProfile["compatibility-a-isolated"],
    validateMatrix(matrix).operatorAttestedCasesByProfile["compatibility-a-isolated"] - aCases.length);
  assert.equal(staleReport.fullNativeParityReady, false);
  assert.equal(staleReport.externalEvidenceFilesOpenedByChecker, 0);
  for (const mutate of [
    effect => { delete effect.reportedRun.sourceFiles; },
    effect => { effect.reportedRun.sourceFiles[1].file = "../outside.mjs"; },
    effect => { effect.reportedRun.sourceFiles[1].file = "/outside.mjs"; },
    effect => { effect.reportedRun.sourceFiles[1].file = "tests/unimported-fixture.mjs"; },
    effect => { effect.reportedRun.sourceFiles[0].sha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.effectCases.find(effect => effect.executionProfile === "compatibility-a-isolated"));
    assert.throws(() => validateMatrix(changed));
  }
});

test("Script refusal and pinned-reader lexical algorithm stay separate from actual MCP basic and native acceptance", () => {
  const scriptCases = matrix.effectCases.filter(effect => ["guarded-refusal", "algorithm-positive"].includes(effect.coverageKind));
  const refusal = scriptCases.find(effect => effect.coverageKind === "guarded-refusal");
  const algorithm = scriptCases.find(effect => effect.coverageKind === "algorithm-positive");
  assert(refusal && algorithm);
  for (const effect of scriptCases) {
    assert.deepEqual(effect.operations, ["mcp.tool.get_script", "mcp.tool.search_scripts"]);
    assert(!effect.operations.includes("mcp.tool.search_knowledge"));
    assert(effect.reportedRun.sourceFiles.some(source => source.file === "tests/script-basic-fixture.mjs"));
    assert(effect.reportedRun.sourceFiles.some(source => source.file === "tests/compatibility-mcp-fixture.mjs"));
  }
  assert(algorithm.stages.some(stage => stage.supportingOperation === "mcp.tool.search_knowledge"
    && stage.supportingCoverage === "guarded-refusal-only" && stage.operation === null));
  for (const name of ["get_script", "search_scripts"]) {
    assert.equal(row(name).requiredCase.coverage, "A-basic-plus-installed-frozen-initial-private-preservation-scope-full-acceptance-incomplete");
    assert.equal(row(name).evidence.installed, "reviewed-installed-v2-frozen-initial-read-private-exclusion-B1-image-fresh-B0");
    assert.equal(row(name).evidence.nativeColdSource, "unverified-no-formal-effect-case");
  }
  const report = validateMatrix(matrix);
  assert.equal(report.distinctOriginalOperationsWithRegisteredBasicCases, 41);
  assert.equal(report.distinctOriginalOperationsWithNonBasicCases, 2);
  assert.equal(report.operatorAttestedBasicOperations, 32);
  assert.equal(report.fullNativeParityReady, false);
  const promoted = structuredClone(matrix);
  promoted.effectCases.find(effect => effect.coverageKind === "algorithm-positive").coverageKind = "basic-operation-sequence";
  assert.throws(() => validateMatrix(promoted), /cannot be promoted to MCP basic/);
});

test("installed Trash qualifies delete_note only with RAW identity and separate preservation proof, not uncalled aliases or incomplete flows", () => {
  const effect = matrix.effectCases.find(candidate => candidate.id === "installed-native-public-note-trash-basic");
  assert.deepEqual(effect.operations, ["mcp.tool.delete_note"]);
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.match(evidence.rawOracleScope, /public get_note omits knowledgeId\/revision/);
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.independentPreservation.exactReceiptsAndSuccessorsAtB1, true);
  for (const stage of effect.stages.filter(stage => ["knowledge.trash.list", "knowledge.trash.restore"].includes(stage.nativeOperation)))
    assert.equal(stage.operation, null, "Supplemental list/restore must not become original operation IDs");
  for (const gap of ["originalReadonlyBucketRestoreQualified", "installedTransportCancellationQualified",
    "installedDestinationCollisionQualified", "installedPendingRecoveryQualified"])
    assert.equal(evidence.observations[gap], false);
  assert.deepEqual(row("knowledge_file_trash").evidence.reviewedEvidenceRefs, []);
  for (const name of ["delete_skill", "delete_paper"])
    assert(!row(name).evidence.reviewedEvidenceRefs.includes(effect.reviewedEvidenceRefs[0]),
      "The old Note v1 artifact must never become Skill/Paper v2 evidence");
  const report = validateMatrix(matrix);
  assert.equal(report.distinctOriginalOperationsWithRegisteredBasicCases, 41);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  const promoted = structuredClone(matrix);
  promoted.effectCases.find(candidate => candidate.id === effect.id).operations.push("mcp.tool.knowledge_file_trash");
  assert.throws(() => validateMatrix(promoted), /unrelated original operations|delete_note-only/);
});

test("genuine Original/A Script worker basic coverage and interrupted lifecycle do not invent native grants or extra operation IDs", () => {
  const basic = matrix.effectCases.find(effect => effect.id === "compatibility-a-script-real-worker-basic");
  const lifecycle = matrix.effectCases.find(effect => effect.coverageKind === "lifecycle-only");
  assert(basic && lifecycle);
  assert.deepEqual(basic.operations, ["mcp.tool.get_script", "mcp.tool.search_scripts"]);
  assert.equal(basic.executionProfile, "compatibility-a-isolated");
  assert(basic.stages.some(stage => stage.stage === "genuine-original-worker-startup"
    && /publishes its own worker.json\/token\/PID/.test(stage.assertion)));
  assert(basic.stages.some(stage => stage.stage === "retrieve-after-refresh"));
  assert(basic.stages.some(stage => stage.stage === "read-after-refresh"));
  assert(basic.stages.some(stage => stage.supportingOperation === "mcp.tool.search_knowledge"
    && stage.supportingCoverage === "guarded-refusal-only"));
  assert.deepEqual(lifecycle.operations, []);
  assert(lifecycle.stages.some(stage => stage.stage === "interrupted-retained-cleanup"));
  for (const effect of [basic, lifecycle])
    assert(effect.reportedRun.sourceFiles.some(source => source.file === "tests/script-original-worker-fixture.mjs"));
  for (const name of ["get_script", "search_scripts"]) {
    assert.equal(row(name).evidence.compatibilityA, "operator-attested-isolated-basic-success");
    assert.equal(row(name).evidence.installed, "reviewed-installed-v2-frozen-initial-read-private-exclusion-B1-image-fresh-B0");
    assert.equal(row(name).evidence.nativeColdSource, "unverified-no-formal-effect-case");
  }
  const report = validateMatrix(matrix);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  const invented = structuredClone(matrix);
  invented.effectCases.find(effect => effect.coverageKind === "lifecycle-only").operations.push("mcp.tool.search_knowledge");
  assert.throws(() => validateMatrix(invented));
});

test("Todo original/A planning-state and cancelled-drain cases map only successful original APIs, not worker or reviewer refusals", () => {
  const basic = matrix.effectCases.find(effect => effect.id === "compatibility-a-todo-planning-state-basic");
  const drain = matrix.effectCases.find(effect => effect.id === "compatibility-a-todo-cancelled-wait-drain");
  assert(basic && drain);
  for (const name of ["todo_board_create", "add_workitem", "get_board", "get_workitem", "update_workitem",
    "claim_workitem", "change_workitem_state", "list_boards", "list_workitems", "list_workitem_history",
    "list_board_changes", "note_work_items"]) {
    assert(basic.operations.includes(row(name).id));
    assert.equal(row(name).evidence.compatibilityA, "operator-attested-isolated-basic-success");
    assert.equal(row(name).evidence.installed, "reviewed-installed-first-board-planning-source-receipts-B1-fresh-B0");
  }
  for (const name of ["note_work_item_command", "accept_workitem"]) {
    assert(!basic.operations.includes(row(name).id) && !drain.operations.includes(row(name).id));
    assert(basic.stages.some(stage => stage.supportingOperation === row(name).id
      && stage.supportingCoverage === "guarded-refusal-only" && stage.operation === null));
    assert.equal(row(name).requiredCase.coverage, "guarded-refusal-only-basic-unqualified");
  }
  assert(drain.stages.some(stage => stage.stage === "EOF-drain"));
  assert.match(drain.receipt, /cancelled caller receipt is not success/i);
  for (const effect of [basic, drain])
    assert(effect.reportedRun.sourceFiles.some(source => source.file === "tests/todo-basic-fixture.mjs"));
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.staleOperatorAttestedCases, 0);
  assert.equal(report.fullNativeParityReady, false);
  const promoted = structuredClone(matrix);
  promoted.effectCases.find(effect => effect.id === basic.id).operations.push("mcp.tool.accept_workitem");
  assert.throws(() => validateMatrix(promoted), /refusal-only positive coverage/);
});

test("actual held-schema compatibility is explicit zero-operation evidence, not old/current serving or installed acceptance", () => {
  const effect = matrix.effectCases.find(candidate => candidate.coverageKind === "schema-compatibility-only");
  assert(effect);
  assert.deepEqual(effect.operations, []);
  assert.equal(effect.executionProfile, "source-staged-held-schema-probe");
  assert(effect.stages.some(stage => stage.stage === "compatible-v1-control-accepted"));
  assert(effect.stages.some(stage => stage.stage === "actual-v2-plan-journal-refused"));
  assert.match(effect.archivePin.authority, /Actual held archive\/module\/packaged-Zod dependency closure/);
  assert(effect.reportedRun.sourceFiles.some(source => source.file === "clients/vscode-host/installed-held-script-custody-parser.mjs"));
  assert.match(effect.receipt, /oldOwnerServingQualified=false/);
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
  for (const mutate of [
    candidate => { candidate.operations.push("mcp.tool.get_script"); },
    candidate => { candidate.coverageKind = "basic-operation-sequence"; },
    candidate => { candidate.executionProfile = "installed-native-isolated"; },
    candidate => { candidate.archivePin.actualHeldSchemaModuleSha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.effectCases.find(candidate => candidate.id === effect.id));
    assert.throws(() => validateMatrix(changed));
  }
});

test("installed frozen Script evidence qualifies only initial get/search/private-preservation with two genuine editor epochs", () => {
  const effect = matrix.effectCases.find(candidate => candidate.id === "installed-native-frozen-script-initial-read");
  assert.deepEqual(effect.operations, ["mcp.tool.get_script", "mcp.tool.search_scripts"]);
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.notEqual(evidence.observations.deniedEpoch, evidence.observations.approvedEpoch);
  assert.equal(evidence.observations.readonlyModals, 0);
  assert.equal(evidence.observations.liveHelperB1AndRestoredQualified, false);
  assert.equal(evidence.observations.independentPreservation.stoppedNativeDatabaseImagePreserved, true);
  assert.equal(evidence.observations.independentPreservation.scriptMutationReceiptCreated, false);
  assert(effect.stages.some(stage => stage.operation === "mcp.tool.get_script" && stage.stage === "returned-id-read"));
  assert(effect.stages.some(stage => stage.operation === "mcp.tool.search_scripts" && stage.stage === "frozen-public-retrieve"));
  assert(!effect.stages.some(stage => ["write", "update", "external-CAS-fixture-refresh"].includes(stage.stage)));
  assert.match(evidence.preservationScope, /not newly reopened B1 rows/);
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  const promoted = structuredClone(matrix);
  promoted.effectCases.find(candidate => candidate.id === effect.id).operations.push("mcp.tool.search_knowledge");
  assert.throws(() => validateMatrix(promoted), /unrelated original operations|frozen initial/);
});

test("installed Todo twelve original calls retain exact GENESIS/receipt/root bindings without full worker/reviewer scope", () => {
  const effect = matrix.effectCases.find(candidate => candidate.id === "installed-native-first-board-planning-basic");
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert(effect.operations.every(operation => effect.stages.some(stage => stage.operation === operation)));
  assert.equal(effect.operations.length, 12);
  assert.equal(evidence.canonicalReceipts.length, 5);
  assert(evidence.canonicalReceipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.resultSha256)));
  assert.equal(evidence.observations.liveHelperB1AndRestoredQualified, false);
  assert.equal(evidence.observations.oneBoardB1BytesReceiptsAndStoppedImagePreserved, true);
  for (const gap of ["sourceRevocationRenewal", "transportCancelRecovery", "humanAcceptance", "workerEnrollment"])
    assert.equal(evidence.observations[gap], false);
  assert(!effect.operations.includes("mcp.tool.accept_workitem"));
  assert(!effect.operations.includes("mcp.tool.note_work_item_command"));
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  const promoted = structuredClone(matrix);
  promoted.effectCases.find(candidate => candidate.id === effect.id).operations.push("mcp.tool.accept_workitem");
  assert.throws(() => validateMatrix(promoted), /unrelated original operations|first-Board/);
});

test("remaining gates distinguish available A, missing branches, unqualified Source and incomplete scoped installed oracles", () => {
  const report = validateMatrix(matrix);
  assert.equal(report.remainingOperationGates.length, 151);
  assert.deepEqual(report.remainingOperationGates.map(gate => gate.operation), matrix.operations.map(row => row.id));
  assert.equal(Object.values(report.remainingGatesByNextState).reduce((sum, count) => sum + count, 0), 151);
  assert.deepEqual(Object.values(report.remainingGatesByModule).reduce((totals, module) =>
    [totals[0] + module.missingAdapter, totals[1] + module.sourceOnly, totals[2] + module.installedScoped], [0, 0, 0]),
  [34, 77, 40]);
  const gate = name => report.remainingOperationGates.find(value => value.operation === `mcp.tool.${name}`);
  assert.equal(gate("delete_userstory").nextGate, "missing-original-implementation-branch");
  assert.equal(gate("delete_paper").nextGate, "incomplete-full-original-oracles");
  assert.equal(gate("api_chat_list").nextGate, "source-without-installed-qualification");
  assert.equal(gate("get_skill").nextGate, "incomplete-full-original-oracles");
  assert.equal(gate("get_skill").installedQualification.state, "reviewed-scoped-not-full-original");
  assert.equal(gate("get_skill").oracles.restart, "full-original-same-root-no-replay-oracle-incomplete");
  for (const value of report.remainingOperationGates) {
    const entry = matrix.operations.find(row => row.id === value.operation);
    assert.equal(value.compatibilityA, "available-original-policy-not-native-qualification");
    assert.equal(value.channel, entry.compatibilityA.channel);
    assert.deepEqual(value.requiredWorkflow.steps, entry.requiredCase.steps);
    assert(value.requiredWorkflow.steps.some(step => step.operation === value.operation));
    assert.equal(value.nativeBlocker.code, entry.native.blockerCode);
  }
  assert.equal(report.fullReadiness, false);
  assert.equal(report.userRootStorageMigrated, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
});

test("remaining gates expose stale attestation dependencies without inventing an installed proof or refreshing a run", () => {
  const stale = structuredClone(matrix);
  const effect = stale.effectCases.find(candidate => candidate.id === "compatibility-a-note-paper-basic-roundtrip");
  effect.reportedRun.sourceFiles.find(source => source.file === "tests/compatibility-mcp-fixture.mjs").sha256 = "0".repeat(64);
  const report = validateMatrix(stale);
  for (const operation of effect.operations) {
    const gate = report.remainingOperationGates.find(gate => gate.operation === operation);
    assert(gate.sourceAttestations.staleCaseRefs.includes(effect.id));
    assert(!gate.sourceAttestations.currentCaseRefs.includes(effect.id));
  }
  assert.equal(report.staleOperatorAttestedCases, 1);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("approved in-place evidence adds only four installed IDs with paired immediate reads and separate preservation", () => {
  const effect = matrix.effectCases.find(candidate => candidate.id === "installed-native-existing-note-paper-inplace-read");
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.deepEqual(effect.operations, ["update_note", "get_note", "update_paper", "get_paper"].map(name => `mcp.tool.${name}`));
  assert.equal(evidence.canonicalReceipts.length, 4);
  for (const kind of ["note", "paper"]) {
    const stages = effect.stages.filter(stage => stage.operation?.endsWith(`_${kind}`));
    assert.deepEqual(stages.map(stage => stage.operation),
      [`mcp.tool.update_${kind}`, `mcp.tool.get_${kind}`, `mcp.tool.update_${kind}`, `mcp.tool.get_${kind}`]);
    assert(stages.every(stage => stage.arguments.slug === "Old/Before"));
    assert.deepEqual(stages[2].arguments.tags, ["inplace-verified"]);
    assert.equal(evidence.canonicalReceipts.filter(receipt => receipt.operation === `mcp.tool.update_${kind}`).length, 2);
  }
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.independentB1SixReceiptsCommitmentsAndPrivateControlsPreserved, true);
  assert.equal(evidence.bindingReview.exportedColdRootSha256, null);
  assert.equal(evidence.bindingReview.exportedColdProfileSha256, null);
  assert(!effect.stages.some(stage => ["write", "retrieve", "restart"].includes(stage.stage)));
  for (const name of ["add_note", "list_notes", "search_notes", "add_paper", "list_papers", "search_papers", "update_skill", "get_skill"])
    assert(!row(name).evidence.reviewedEvidenceRefs.includes(effect.reviewedEvidenceRefs[0]), name);
  const report = validateMatrix(matrix);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  for (const operation of effect.operations)
    assert.equal(report.remainingOperationGates.find(gate => gate.operation === operation).nextGate,
      "incomplete-full-original-oracles");
  assert.equal(report.staleOperatorAttestedCases, 0);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("in-place registration rejects borrowed operations, fabricated binding digests and reassigned candidate or preservation proof", () => {
  for (const mutate of [
    value => { value.effectCases.find(effect => effect.id === "installed-native-existing-note-paper-inplace-read").operations.push("mcp.tool.add_note"); },
    value => { value.effectCases.find(effect => effect.id === "installed-native-existing-note-paper-inplace-read").stages[1].stage = "restart"; },
    value => { value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].candidateVsixSha256 = "0".repeat(64); },
    value => { value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].bindingReview.exportedColdRootSha256 = "0".repeat(64); },
    value => { value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].referenceSourcePins[0].sha256 = "0".repeat(64); },
    value => { value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].selectors.preservation = "/coldComponent/nativePrivateInplace/b1AndB0Qualified"; },
    value => { value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].canonicalReceipts[0].operationId = value.reviewedEvidence["installed-note-paper-inplace-6367-parent-reviewed"].canonicalReceipts[1].operationId; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed);
    assert.throws(() => validateMatrix(changed));
  }
});

test("approved Original/A Trash registers only three public-pair delete IDs without native, installed or private-target promotion", () => {
  const cases = matrix.effectCases.filter(effect => effect.test?.file === "tests/skill-paper-trash-basic.test.mjs");
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.flatMap(effect => effect.operations), ["delete_skill", "delete_paper", "knowledge_file_trash"].map(name => `mcp.tool.${name}`));
  for (const effect of cases) {
    assert.equal(effect.executionProfile, "compatibility-a-isolated");
    assert.equal(effect.reportedRun.fileCasesPassed, 4);
    assert.equal(effect.reportedRun.frameworkRun.mappedWholeFileCasesPassed, 4);
    assert(effect.reportedRun.sourceFiles.some(source => source.file === "tests/original-knowledge-writer-fixture.mjs"));
    assert(effect.reportedRun.limitations.some(limitation => /direct private Skill deletion.*unsafe\/unqualified.*not an A regression/.test(limitation)));
    assert(effect.stages.some(stage => stage.stage === "owned-exit-before-fixture-removal"));
    assert(!effect.reviewedEvidenceRefs);
    const entry = matrix.operations.find(row => row.id === effect.operations[0]);
    assert.equal(entry.evidence.compatibilityA, "operator-attested-isolated-basic-success");
    assert.equal(entry.evidence.installed, effect.operations[0] === "mcp.tool.knowledge_file_trash"
      ? "unverified-operation-sequence" : "reviewed-installed-public-unshared-skill-paper-v2-delete-restore-UI-receipts-stopped-B1-fresh-B0");
    assert.equal(entry.native.fullOriginalReadiness, "blocked");
    assert.deepEqual(entry.evidence.reviewedEvidenceRefs, effect.operations[0] === "mcp.tool.knowledge_file_trash"
      ? [] : ["installed-public-skill-paper-trash-v2-b4a693-parent-reviewed"]);
  }
  for (const effect of cases.slice(0, 2)) {
    assert(effect.stages.some(stage => stage.stage === "gateway-reconnect-no-replay"));
    assert.equal(effect.stages.find(stage => stage.stage === "closed-oracle-only-restore").operation, null);
  }
  assert(cases[2].stages.some(stage => stage.stage === "read-lane-and-stale-CAS-refusal"));
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.deepEqual(report.remainingGatesByNextState, {
    "missing-original-implementation-branch": 34,
    "source-without-installed-qualification": 77,
    "incomplete-full-original-oracles": 40,
  });
  assert.equal(report.fullNativeParityReady, false);
});

test("finite declared Trash test names remain exact and cannot promote an untested leaf, native profile or restore alias", () => {
  for (const mutate of [
    effect => { effect.test.name = effect.test.name.replace("delete_skill", "delete_note"); },
    effect => { effect.test.name = effect.test.name.replace("delete_skill", "delete_${kind}"); },
    effect => { effect.operations.push("mcp.tool.delete_note"); },
    effect => { effect.executionProfile = "installed-native-isolated"; },
    effect => { effect.stages.find(stage => stage.stage === "closed-oracle-only-restore").operation = "mcp.tool.skill_trash_restore"; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.effectCases.find(effect => effect.id === "compatibility-a-skill-trash-basic"));
    assert.throws(() => validateMatrix(changed));
  }
});

test("changed indirect Trash oracle support invalidates all three attestations without opening artifacts or refreshing pins", () => {
  const readFileSync = fs.readFileSync, support = path.join(ROOT, "tests/original-knowledge-writer-fixture.mjs");
  let report;
  try {
    fs.readFileSync = function(file, ...args) {
      const value = readFileSync.call(this, file, ...args);
      return file === support ? value + "\n" : value;
    };
    report = validateMatrix(matrix);
  } finally { fs.readFileSync = readFileSync; }
  assert.equal(report.staleOperatorAttestedCases, 3);
  assert(report.staleAttestations.every(effect => effect.changedFiles.length === 1
    && effect.changedFiles[0].file === "tests/original-knowledge-writer-fixture.mjs"
    && effect.changedFiles[0].reason === "supporting-file-content-changed"));
  assert.equal(report.qualifiedBasicOriginalOperations, 40,
    "Two stale A delete cases remain independently installed-qualified; generic file Trash does not");
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  for (const name of ["delete_skill", "delete_paper", "knowledge_file_trash"]) {
    const gate = report.remainingOperationGates.find(gate => gate.operation === `mcp.tool.${name}`);
    assert.equal(gate.sourceAttestations.currentCaseRefs.length, 0);
    assert.equal(gate.sourceAttestations.staleCaseRefs.length, 1);
  }
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("new installed Skill/Paper v2 qualifies exactly two public deletes with four area-bound canonical receipts and stopped-image preservation", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "installed-native-public-skill-paper-trash-v2");
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.deepEqual(effect.operations, ["mcp.tool.delete_skill", "mcp.tool.delete_paper"]);
  assert.deepEqual(evidence.publicCalls.map(call => call.arguments),
    [{ name: "SkillTrashOwner" }, { slug: "SkillPaperTrash/PaperTrashOwner" }]);
  assert.equal(evidence.canonicalReceipts.length, 4);
  for (const transition of evidence.custodyTransitions) {
    assert.equal(transition.requestSchema, "pkm.original-native-trash-request/v2");
    assert.deepEqual(transition.selectionAreas, [transition.area]);
    assert.equal(evidence.canonicalReceipts.find(receipt => receipt.operationId === transition.operationId).operation,
      `knowledge.trash.${transition.action}`);
  }
  for (const stage of effect.stages.filter(stage => stage.nativeOperation)) assert.equal(stage.operation, null);
  assert.equal(evidence.heldReceiverSchemaProbe.compatibleNoteV1DtoAccepted, true);
  assert.equal(evidence.heldReceiverSchemaProbe.noteControlSchemaOnly, true);
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.separateStoppedB1AndFreshB0Qualified, true);
  assert.equal(evidence.observations.archivedSqliteReopenedForPreservation, false);
  assert.equal(evidence.runProvenance.helperChecks.currentHelperSourceReattestedByThatRun, false);
  for (const name of ["delete_note", "list_papers", "knowledge_file_trash", "get_skill", "get_paper"])
    assert(!row(name).evidence.reviewedEvidenceRefs.includes(effect.reviewedEvidenceRefs[0]), name);
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.staleOperatorAttestedCases, 0);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("installed v2 evidence refuses cross-area/v1 provenance and borrowed Note/list/old-bucket qualification", () => {
  const evidenceId = "installed-public-skill-paper-trash-v2-b4a693-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.operations.push("mcp.tool.delete_note"); },
    evidence => { evidence.operations.push("mcp.tool.list_papers"); },
    evidence => { evidence.custodyTransitions[0].area = "papers"; },
    evidence => { evidence.custodyTransitions[0].selectionAreas = ["notes"]; },
    evidence => { evidence.custodyTransitions[0].requestSchema = "pkm.original-native-trash-request/v1"; },
    evidence => { evidence.canonicalReceipts[1].operation = "knowledge.trash.restore"; },
    evidence => { evidence.heldReceiverSchemaProbe.refusedMoveRequestSha256[0] = "0".repeat(64); },
    evidence => { evidence.heldReceiverSchemaProbe.oldOwnerServingQualified = true; },
    evidence => { evidence.heldReceiverSchemaProbe.noteControlSchemaOnly = false; },
    evidence => { evidence.observations.paperListOperationParityQualified = true; },
    evidence => { evidence.observations.oldReadonlyBucketRestoreQualified = true; },
    evidence => { evidence.observations.genericKnowledgeFileTrashQualified = true; },
    evidence => { evidence.observations.installedPendingRecoveryQualified = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("installed v2 registration requires exact support pins and separate image proof, never a hash-only helper run or reopened B1", () => {
  const evidenceId = "installed-public-skill-paper-trash-v2-b4a693-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.referenceSourcePins.splice(1, 1); },
    evidence => { evidence.referenceSourcePins[0].sha256 = ""; },
    evidence => { evidence.referenceSourcePins[0].sha256 = "0".repeat(64); },
    evidence => { evidence.preservationPins.stoppedCoreSha256 = "0".repeat(64); },
    evidence => { evidence.selectors.B1FreshB0 = "/coldComponent/nativeSkillPaperTrash/b1AndB0Qualified"; },
    evidence => { evidence.observations.archivedSqliteReopenedForPreservation = true; },
    evidence => { evidence.runProvenance.helperChecks.currentHelperSourceReattestedByThatRun = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("fresh installed Note/Paper maps six exact create/list/search IDs without transferring four older get/update proofs", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "installed-native-public-note-paper-create-list-lexical");
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.deepEqual(effect.operations, ["add_note", "list_notes", "search_notes", "add_paper", "list_papers", "search_papers"]
    .map(name => `mcp.tool.${name}`));
  assert(effect.operations.every(operation => effect.stages.some(stage => stage.operation === operation)));
  assert.equal(evidence.canonicalReceipts.length, 4);
  assert.equal(evidence.originalSemanticScope.originalMcpRawWriteAssignsIdentity, false);
  assert.equal(evidence.originalSemanticScope.nativeIdentityRevisionIncrementSeparatelyProven, true);
  assert.equal(evidence.observations.paperListReadOnly, false);
  assert.equal(evidence.paperListPublicStages.length, 2);
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.separateIndependentStoppedB1FreshB0Qualified, true);
  for (const name of ["get_note", "update_note", "get_paper", "update_paper"]) {
    assert.deepEqual(row(name).evidence.reviewedEvidenceRefs, ["installed-note-paper-inplace-6367-parent-reviewed"]);
    assert(!row(name).evidence.effectCaseRefs.includes(effect.id));
  }
  assert(!row("list_papers").evidence.reviewedEvidenceRefs.includes("installed-public-skill-paper-trash-v2-b4a693-parent-reviewed"),
    "Previous Trash-only validation is not retrospectively credited with the new list proof");
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.staleOperatorAttestedCases, 0);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("fresh Note/Paper evidence rejects borrowed IDs, invented Original identity/upsert or semantic/read-only/CAS claims", () => {
  const evidenceId = "installed-public-note-paper-basic-5948-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.operations.push("mcp.tool.get_note"); },
    evidence => { evidence.operations.push("mcp.tool.update_paper"); },
    evidence => { evidence.originalSemanticScope.originalMcpRawWriteAssignsIdentity = true; },
    evidence => { evidence.originalSemanticScope.originalCreateIsNotUpsert = false; },
    evidence => { evidence.originalSemanticScope.paperOfflineMetadataOnly = false; },
    evidence => { evidence.originalSemanticScope.paperBodyOnlyControlEmpty = false; },
    evidence => { evidence.observations.paperListReadOnly = true; },
    evidence => { evidence.paperListPublicStages.pop(); },
    evidence => { evidence.observations.publicCallerCasArgumentInvented = true; },
    evidence => { evidence.observations.readOnlyActorLanePerformed = true; },
    evidence => { evidence.observations.semanticOrNetworkPerformed = true; },
    evidence => { evidence.documentRevisionProof[0].updateReceiptOperationId = evidence.documentRevisionProof[1].updateReceiptOperationId; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("fresh Note/Paper profile requires original oracle/support and separate B1 pins, not a changed old receipt or Source hash refresh", () => {
  const evidenceId = "installed-public-note-paper-basic-5948-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.referenceSourcePins.splice(3, 1); },
    evidence => { evidence.referenceSourcePins[0].sha256 = ""; },
    evidence => { evidence.originalMcpSourceSha256 = "0".repeat(64); },
    evidence => { evidence.candidateVsixSha256 = "6367a908d10fcede19a3d76a40b93f9cf63dfb0375eb24ec53029cfd867d9075"; },
    evidence => { evidence.selectors.B1FreshB0 = "/coldComponent/nativeNotePaperBasic/b1AndB0Qualified"; },
    evidence => { evidence.observations.archivedSqliteReopenedForPreservation = true; },
    evidence => { evidence.runProvenance.helperChecks.currentHelperSourceReattestedByThatRun = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("final installed Research qualifies four exact basic IDs without invented A transport, Paper borrowing or semantic variants", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "installed-native-research-read-list-lexical-graph");
  const evidence = matrix.reviewedEvidence[effect.reviewedEvidenceRefs[0]];
  assert.deepEqual(effect.operations, ["get_research", "list_research", "search_research", "paper_graph"].map(name => `mcp.tool.${name}`));
  assert(effect.operations.every(operation => effect.stages.some(stage => stage.operation === operation)));
  assert.equal(evidence.compatibilityABasicRegistration.status, "unverified-no-actual-A-gateway-test");
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.independentParentB1AndFreshB0Qualified, true);
  assert(/^[a-f0-9]{64}$/.test(evidence.preservationPins.freshB0ReceiptSha256));
  assert.notEqual(evidence.rootBinding.root, evidence.supersededArtifactHistory[0].root);
  assert.notEqual(evidence.sha256, evidence.supersededArtifactHistory[0].sha256);
  assert.equal(evidence.supersededArtifactHistory[0].status, "passed-older-output-shape-not-current-operation-mapping");
  for (const name of ["get_research", "list_research", "search_research", "paper_graph"]) {
    assert.equal(row(name).evidence.compatibilityA, "unverified-no-formal-effect-case");
    assert.deepEqual(row(name).evidence.reviewedEvidenceRefs, [effect.reviewedEvidenceRefs[0]]);
  }
  for (const name of ["get_paper", "list_papers", "search_papers"])
    assert(!row(name).evidence.reviewedEvidenceRefs.includes(effect.reviewedEvidenceRefs[0]), name);
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.operatorAttestedBasicOperations, 32, "Helper callbacks must not silently become new Original/A cases");
  assert.deepEqual(report.remainingGatesByModule.Research, { missingAdapter: 0, sourceOnly: 0, installedScoped: 9 });
  assert.equal(report.staleOperatorAttestedCases, 0);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("Research graph evidence rejects readonly downgrade, deduplicated/empty-only graph and invented pagination/model/A qualification", () => {
  const evidenceId = "installed-research-basic-994eb9-final-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.operations.push("mcp.tool.get_paper"); },
    evidence => { evidence.graphPublicDialogs[0].readOnly = true; },
    evidence => { evidence.graphPublicDialogs[0].choice = "Approve this request"; },
    evidence => { evidence.graphPublicDialogs[0].focusedEnterDenial = false; },
    evidence => { evidence.graphResults[1].edges = 1; },
    evidence => { evidence.graphResults[1].nodes = 0; },
    evidence => { evidence.originalSemanticScope.listArguments.push("offset"); },
    evidence => { evidence.originalSemanticScope.listPaginationParametersExist = true; },
    evidence => { evidence.originalSemanticScope.semanticOrNetworkQualified = true; },
    evidence => { evidence.compatibilityABasicRegistration.status = "operator-attested-isolated-basic-success"; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("Research current mapping requires the fresh final receipt/artifact/support, never an older Root or an edited early B1 flag", () => {
  const evidenceId = "installed-research-basic-994eb9-final-parent-reviewed";
  for (const mutate of [
    evidence => { delete evidence.preservationPins.freshB0ReceiptSha256; },
    evidence => { evidence.preservationPins.freshB0ReceiptSha256 = "0".repeat(64); },
    evidence => { evidence.sha256 = evidence.supersededArtifactHistory[0].sha256; },
    evidence => { evidence.rootBinding.root = evidence.supersededArtifactHistory[0].root; },
    evidence => { evidence.referenceSourcePins[0].sha256 = evidence.supersededArtifactHistory[0].helperSha256; },
    evidence => { evidence.selectors.freshB0 = "/coldComponent/nativeResearchBasic/b1AndB0Qualified"; },
    evidence => { evidence.observations.liveHelperB1AndB0Qualified = true; },
    evidence => { evidence.observations.archivedSqliteReopenedForPreservation = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("installed Recovery qualifies only two registered PUBLIC Note/0644 IDs without A transport or historical evidence borrowing", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "installed-native-recovery-registered-public-note-0644");
  const evidenceId = effect.reviewedEvidenceRefs[0], evidence = matrix.reviewedEvidence[evidenceId];
  assert.deepEqual(effect.operations, ["knowledge_recovery_preview", "knowledge_recovery_apply"].map(name => `mcp.tool.${name}`));
  assert.equal(effect.executionProfile, "installed-native-recovery-registered-public-note-0644-isolated");
  assert.deepEqual(effect.stages.filter(stage => stage.operation).map(stage => stage.stage), evidence.outcomes.map(outcome => outcome.stage));
  const report = validateMatrix(matrix);
  for (const operation of effect.operations) {
    const entry = matrix.operations.find(row => row.id === operation);
    assert.deepEqual(entry.evidence.reviewedEvidenceRefs, [evidenceId]);
    assert.equal(entry.evidence.compatibilityA, "unverified-no-formal-effect-case");
    assert.equal(entry.native.dispatch, "conditional");
    assert.equal(entry.native.fullOriginalReadiness, "blocked");
    assert.equal(report.remainingOperationGates.find(gate => gate.operation === operation).nextGate, "incomplete-full-original-oracles");
  }
  for (const entry of matrix.operations.filter(row => !effect.operations.includes(row.id))) {
    assert(!entry.evidence.reviewedEvidenceRefs.includes(evidenceId));
    assert(!entry.evidence.effectCaseRefs.includes(effect.id));
  }
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.operatorAttestedBasicOperations, 32);
  assert.deepEqual(report.remainingGatesByModule.Recovery, { missingAdapter: 0, sourceOnly: 0, installedScoped: 2 });
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
  assert.equal(report.fullNativeParityReady, false);
});

test("Recovery rejects wrong actor/operation/receipt and reassignment to unrelated historical operations", () => {
  const evidenceId = "installed-recovery-public-note-0644-20261123-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.canonicalReceipt.actorId = "mcp:other"; },
    evidence => { evidence.canonicalReceipt.operation = "knowledge.note.update"; },
    evidence => { evidence.canonicalReceipt.operationId = "00000000-0000-4000-8000-000000000000"; },
    evidence => { evidence.canonicalReceipt.fingerprint = "0".repeat(64); },
    evidence => { evidence.canonicalReceipt.resultSha256 = "0".repeat(64); },
    evidence => { evidence.canonicalReceipt.custodyReceiptSha256 = "0".repeat(64); },
    evidence => { evidence.operations.push("mcp.tool.get_research"); },
    evidence => { evidence.compatibilityABasicRegistration.status = "operator-attested-isolated-basic-success"; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
  const borrowed = structuredClone(matrix);
  borrowed.operations.find(row => row.id === "mcp.tool.get_paper").evidence.reviewedEvidenceRefs.push(evidenceId);
  assert.throws(() => validateMatrix(borrowed));
});

test("Recovery requires actual picker/ACKs, separate focused denials and exact counts without widening full arbitrary-file scope", () => {
  const evidenceId = "installed-recovery-public-note-0644-20261123-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.actualFolderPickers.pop(); },
    evidence => { evidence.actualFolderPickers[0].actualFolderPicker = false; },
    evidence => { evidence.actualFolderPickers[1].directory = evidence.rootBinding.root; },
    evidence => { evidence.observations.acknowledgedStageCount = 6; },
    evidence => { evidence.outcomes[1].stage = evidence.outcomes[0].stage; },
    evidence => { evidence.outcomes[2].noEffects = false; },
    evidence => { evidence.actualDialogs.find(dialog => dialog.kind === "source").focusedEnterDenial = false; },
    evidence => { evidence.actualDialogs.find(dialog => dialog.kind === "repair").choice = "Repair this exact missing owner"; },
    evidence => { evidence.actualDialogs = evidence.actualDialogs.filter(dialog => dialog.kind !== "public"); },
    evidence => { evidence.nativeAuthority.sourceDefaultDecision = "allow"; },
    evidence => { evidence.nativeAuthority.ordinaryPublicApprovalDoesNotGrantRepair = false; },
    evidence => { evidence.canonicalReceipt.actual.restored = 0; },
    evidence => { evidence.outcomes[5].counts.identical = 0; },
    evidence => { evidence.qualifiedScope.fullRecovery = true; },
    evidence => { evidence.qualifiedScope.ownerCount = 2; },
    evidence => { evidence.qualifiedScope.retainedOriginalMode = "100755"; },
    evidence => { evidence.executionProfile = "installed-native-isolated"; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
  const widened = structuredClone(matrix);
  widened.effectCases.find(effect => effect.id === "installed-native-recovery-registered-public-note-0644").stages[4].assertion = "Full arbitrary-file Recovery qualified";
  assert.throws(() => validateMatrix(widened), /exact two-ID registered PUBLIC Note/);
});

test("Recovery binds the fresh Root/stopped B1/support and independent Parent proof, never edited leaf flags or archived SQLite reopen", () => {
  const evidenceId = "installed-recovery-public-note-0644-20261123-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.rootBinding.root = matrix.reviewedEvidence["installed-research-basic-994eb9-final-parent-reviewed"].rootBinding.root; },
    evidence => { evidence.preservationPins.b1Sha256 = "0".repeat(64); },
    evidence => { evidence.preservationPins.stoppedCoreSha256 = "0".repeat(64); },
    evidence => { evidence.selectors.independentParentPreservation = "/coldComponent/nativeKnowledgeRecovery/b1AndB0Qualified"; },
    evidence => { evidence.observations.liveHelperB1AndB0Qualified = true; },
    evidence => { evidence.observations.actualEditorFullyClosedBeforeB1 = false; },
    evidence => { evidence.independentParentPreservation.noArchivedSqliteReopen = false; },
    evidence => { evidence.independentParentPreservation.freshB0NoDatabaseGrantsOrNativeLocks = false; },
    evidence => { evidence.independentParentPreservation.originalRootOverwritten = true; },
    evidence => { evidence.runProvenance.failedPriorProfilesAccepted = true; },
    evidence => { evidence.referenceSourcePins.pop(); },
    evidence => { evidence.referenceSourcePins[0].sha256 = "0".repeat(64); },
    evidence => { evidence.observations.profileRemoved = false; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("installed pure Action registers complete templates and bounded graph only, not diagnostics, refusals or whole runtime", () => {
  const effect = matrix.effectCases.find(effect => effect.id === "installed-native-action-pure-templates-bounded-component-graph");
  const evidenceId = effect.reviewedEvidenceRefs[0], evidence = matrix.reviewedEvidence[evidenceId];
  assert.deepEqual(effect.operations, ["mcp.tool.action_templates", "mcp.tool.action_graph_check"]);
  assert.deepEqual(evidence.leafOperationIds, {
    completeOperationIds: ["mcp.tool.action_templates"],
    boundedOnlyOperationIds: ["mcp.tool.action_definition_check", "mcp.tool.action_graph_check"],
    deniedOperationIds: ["mcp.tool.action_capabilities"],
  });
  assert.equal(effect.operationScopes["mcp.tool.action_templates"], "complete-nonempty-catalogue");
  assert.match(effect.operationScopes["mcp.tool.action_graph_check"], /^bounded-basic-/);
  assert.deepEqual(effect.stages.slice(0, 8).map(stage => stage.operation),
    ["mcp.tool.action_templates", null, "mcp.tool.action_graph_check", "mcp.tool.action_graph_check",
      null, null, "mcp.tool.action_graph_check", "mcp.tool.action_graph_check"]);
  for (const name of ["action_definition_check", "action_capabilities"]) {
    assert.deepEqual(row(name).evidence.reviewedEvidenceRefs, []);
    assert.deepEqual(row(name).evidence.effectCaseRefs, []);
    assert.equal(row(name).evidence.installed, "unverified-operation-sequence");
  }
  for (const entry of matrix.operations.filter(entry => !effect.operations.includes(entry.id))) {
    assert(!entry.evidence.effectCaseRefs.includes(effect.id), entry.id);
    assert(!entry.evidence.reviewedEvidenceRefs.includes(evidenceId), entry.id);
  }
  assert.equal(evidence.compatibilityABasicRegistration.status, "unverified-no-actual-A-gateway-test");
  assert.equal(evidence.qualifiedScope.validDefinitionRegistryQualified, false);
  assert.equal(evidence.qualifiedScope.privateActionReferencesQualified, false);
  assert.equal(evidence.qualifiedScope.fullAction, false);
  assert.equal(evidence.qualifiedScope.full151, false);
  assert.equal(row("action_templates").native.fullOriginalReadiness, "implemented");
  assert.deepEqual(sourceFacts(ROOT).pureActionComplete, ["action_templates"]);
  for (const name of ["action_definition_check", "action_graph_check"]) {
    assert.equal(row(name).native.implementation, "partial");
    assert.equal(row(name).native.fullOriginalReadiness, "implemented");
    assert.equal(row(name).native.blockerCode, null);
    assert(row(name).native.sourceRefs.includes("src/original-mcp-action-authoring.ts#dispatchOriginalMcpActionAuthoring"));
    assert(row(name).native.sourceRefs.includes("src/original-mcp-action-pure.ts#invokeOriginalMcpPureAction"));
    assert.match(row(name).native.reason, /Historical sealed pure.*not evidence for the newly integrated/);
  }
  assert.equal(row("action_capabilities").native.implementation, "partial");
  assert.equal(row("action_capabilities").evidence.installed, "unverified-operation-sequence");
  const report = validateMatrix(matrix);
  assert.equal(report.qualifiedBasicOriginalOperations, 41);
  assert.equal(report.reviewedInstalledBasicOperations, 40);
  assert.equal(report.operatorAttestedBasicOperations, 32);
  assert.deepEqual(report.remainingGatesByNextState, {
    "missing-original-implementation-branch": 34,
    "source-without-installed-qualification": 77,
    "incomplete-full-original-oracles": 40,
  });
  assert.deepEqual(report.remainingGatesByModule.Action, { missingAdapter: 0, sourceOnly: 34, installedScoped: 2 });
  assert.equal(report.fullReadiness, false);
  assert.equal(report.fullNativeParityReady, false);
  assert.equal(report.userRootStorageMigrated, false);
  assert.equal(report.externalEvidenceFilesOpenedByChecker, 0);
});

test("Action pure evidence requires eight rendered noReview ACKs, nonempty exact outputs and genuine full-runtime denials", () => {
  const evidenceId = "installed-action-pure-3b068761-20261123-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.acknowledgements.pop(); },
    evidence => { evidence.acknowledgements[1].stage = evidence.acknowledgements[0].stage; },
    evidence => { evidence.acknowledgements[0].noUnexpectedModal = false; },
    evidence => { evidence.observations.acknowledgedStageCount = 7; },
    evidence => { evidence.observations.publicDialogCount = 1; },
    evidence => { evidence.observations.noReviewEveryStage = false; },
    evidence => { evidence.observations.sameOwnerLease = false; },
    evidence => { evidence.observations.businessReceiptsIntentsAndDocumentsUnchanged = false; },
    evidence => { evidence.positiveOutputs = []; },
    evidence => { evidence.positiveOutputs[2].originalResultSha256 = ""; },
    evidence => { evidence.oracle.templateCatalogueNonempty = false; },
    evidence => { evidence.denials[0].code = "COMPONENT_TOOL_NOT_ADMITTED"; },
    evidence => { evidence.denials[3].noActionSourceOrRuntimeAdmission = false; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});

test("Action invalid diagnostics and private references cannot be promoted or borrowed from same-candidate fairness", () => {
  const evidenceId = "installed-action-pure-3b068761-20261123-parent-reviewed";
  for (const mutate of [
    evidence => { evidence.operations.push("mcp.tool.action_definition_check"); },
    evidence => { evidence.operations.push("mcp.tool.action_capabilities"); },
    evidence => { evidence.leafOperationIds.completeOperationIds.push("mcp.tool.action_graph_check"); },
    evidence => { evidence.qualifiedScope.validDefinitionRegistryQualified = true; },
    evidence => { evidence.qualifiedScope.privateActionReferencesQualified = true; },
    evidence => { evidence.qualifiedScope.actionSourceOrRuntimeAdmission = true; },
    evidence => { evidence.qualifiedScope.fullAction = true; },
    evidence => { evidence.runProvenance.independentFairness48ArtifactBorrowed = true; },
    evidence => { evidence.compatibilityABasicRegistration.status = "operator-attested-isolated-basic-success"; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
  const widened = structuredClone(matrix);
  widened.effectCases.find(effect => effect.id === "installed-native-action-pure-templates-bounded-component-graph")
    .operationScopes["mcp.tool.action_graph_check"] = "complete-full-Action-graph";
  assert.throws(() => validateMatrix(widened), /complete templates and bounded graph only/);
});

test("Action new report/Root/Source/B1 bindings cannot replace historical Recovery or use edited leaf preservation flags", () => {
  const evidenceId = "installed-action-pure-3b068761-20261123-parent-reviewed";
  const recovery = matrix.reviewedEvidence["installed-recovery-public-note-0644-20261123-parent-reviewed"];
  assert.equal(recovery.sha256, "ae002b4906f651382b9631c9580e6dc6474743caed664a1f7f4173a6d8ea49ea");
  assert.notEqual(matrix.reviewedEvidence[evidenceId].rootBinding.root, recovery.rootBinding.root);
  for (const mutate of [
    evidence => { evidence.sha256 = recovery.sha256; },
    evidence => { evidence.artifactBytes = 0; },
    evidence => { evidence.candidateVsixSha256 = recovery.candidateVsixSha256; },
    evidence => { evidence.rootBinding.root = recovery.rootBinding.root; },
    evidence => { evidence.rootBinding.nativeHostReceiptSha256 = recovery.rootBinding.nativeHostReceiptSha256; },
    evidence => { evidence.referenceSourcePins[0].sha256 = "0".repeat(64); },
    evidence => { evidence.preservationPins.b1Sha256 = recovery.preservationPins.b1Sha256; },
    evidence => { evidence.preservationPins.stoppedCoreSha256 = recovery.preservationPins.stoppedCoreSha256; },
    evidence => { evidence.selectors.independentParentPreservation = "/coldComponent/nativeActionPure/b1AndB0Qualified"; },
    evidence => { evidence.observations.liveHelperB1AndB0Qualified = true; },
    evidence => { evidence.observations.actualEditorFullyClosedBeforeB1 = false; },
    evidence => { evidence.independentParentPreservation.noArchivedSqliteReopen = false; },
    evidence => { evidence.independentParentPreservation.freshB0NoNativeDatabaseOrActionGrants = false; },
    evidence => { evidence.independentParentPreservation.originalRootOverwritten = true; },
  ]) {
    const changed = structuredClone(matrix);
    mutate(changed.reviewedEvidence[evidenceId]);
    assert.throws(() => validateMatrix(changed));
  }
});
