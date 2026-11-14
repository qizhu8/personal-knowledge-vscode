import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  evaluateReadiness, inspectReadiness, readinessDigest, readinessRequirements, formatReadinessChecklist,
} from "../scripts/readiness.mjs";
import { definitions } from "../dist/contracts.js";
import { contract, inventory, blockedFixture } from "./readiness-fixtures.mjs";

const blocked = (report, id, reason) => report.blockers.some(item => item.id === id && item.reason === reason);

test("the 21 gates enumerate exact static legacy and native scopes without qualifying any work", () => {
  const context = blockedFixture();
  const report = evaluateReadiness(context);
  const requirements = readinessRequirements(context.contract);
  assert.equal(contract.workstreams.length, 21);
  assert.equal(contract.legacyDeclarations.flatMap(group => group.names).length, inventory.surfaces.length);
  assert.equal(contract.legacyCommands.ids.length, inventory.commands.length);
  assert.equal(contract.legacyConfigurations.ids.length, inventory.configurationKeys.length);
  assert.equal(new Set(requirements.map(item => item.id)).size, requirements.length);
  assert.equal(report.readyForCutoverReview, false);
  assert.equal(report.acceptedWorkstreams, 0);
  assert.equal(report.totalWorkstreams, 21);
  assert.equal(report.checklist.length, requirements.length);
  assert(report.checklist.every(item => item.requiredChecks.length > 0 && item.scope.length > 0));
  assert(report.checklist.every(item => item.status === "blocked"));
});

test("manifest parity, test totals and native pins cannot replace exact independent evidence", () => {
  const context = blockedFixture();
  context.manifest.workstreams.forEach(item => { item.parity = true; item.state = "accepted"; });
  context.testsPassed = true;
  context.nativePinsCurrent = true;
  const report = evaluateReadiness(context);
  assert.equal(report.status, "blocked");
  assert.equal(report.acceptedWorkstreams, 0);
  assert(blocked(report, "agents.manager-sustainable-lifecycle", "missing-independent-evidence"));
  assert(blocked(report, "authority", "independent-human-and-verifier-enrollment-required"));
});

test("source, inventory, native operation and provenance drift fail closed", () => {
  const context = blockedFixture();
  context.currentInventory.sources.push({ path: "src/new-tool.ts", sha256: readinessDigest("new") });
  assert(blocked(evaluateReadiness(context), "inventory", "new-or-changed-legacy-source-drift"));

  const native = blockedFixture();
  native.serverContracts.push({ id: "new.operation", version: 1, readOnly: false });
  assert(blocked(evaluateReadiness(native), "native-contracts", "unmapped-or-drifted-canonical-operation"));

  const sourceMap = blockedFixture();
  sourceMap.sourceContractsCurrent = false;
  assert(blocked(evaluateReadiness(sourceMap), "native-contracts", "source-definition-build-or-map-drift"));

  const capture = blockedFixture();
  capture.captureIssues = [{ kind: "native", reason: "hash-changed" }];
  assert(blocked(evaluateReadiness(capture), "provenance", "missing-or-stale-capture-qualification"));
});

test("unmapped declarations, commands, settings, inventory revisions and operation versions block", () => {
  const declaration = blockedFixture();
  declaration.contract.legacyDeclarations[0].names.pop();
  assert(blocked(evaluateReadiness(declaration), "legacy-declarations", "unmapped-or-duplicate-legacy-contracts"));

  const commands = blockedFixture();
  commands.contract.legacyCommands.ids.pop();
  assert(blocked(evaluateReadiness(commands), "legacy-commands", "unmapped-or-duplicate-legacy-commands"));

  const settings = blockedFixture();
  settings.contract.legacyConfigurations.ids.pop();
  assert(blocked(evaluateReadiness(settings), "legacy-configuration", "unmapped-or-duplicate-legacy-settings"));

  const version = blockedFixture();
  version.serverContracts[0].version++;
  assert(blocked(evaluateReadiness(version), "native-contracts", "canonical-operation-version-mismatch"));

  const schema = blockedFixture();
  schema.inventory.schema = "unknown/v2";
  assert(blocked(evaluateReadiness(schema), "contract", "schema-or-version-mismatch"));

  const revision = blockedFixture();
  revision.contract.inventoryRevision = readinessDigest("other source inventory");
  assert(blocked(evaluateReadiness(revision), "inventory", "readiness-inventory-version-mismatch"));
});

test("a receipt cannot enroll its own signing key or claim a missing operator approval", () => {
  const context = blockedFixture();
  const attacker = generateKeyPairSync("ed25519");
  const requirement = readinessRequirements(context.contract)[0];
  const payload = {
    schema: "pkm.readiness-attestation/v1",
    result: "qualified",
    requirementId: requirement.id,
    kind: requirement.kind,
    contractDigest: readinessDigest(context.contract),
    inventoryRevision: context.inventory.revision,
    implementationDigest: context.implementationDigest,
    scope: requirement.scope,
    checks: Object.fromEntries(requirement.checks.map(check => [check, true])),
    evidenceMode: "legacy-oracle",
    artifacts: [{ path: "migration/manifest.json", sha256: readinessDigest("not the artifact") }],
    observations: { method: "Self-signed test payload" },
  };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value;
  context.evidence = [{
    payload,
    authorityId: "self-enrolled",
    publicKey: attacker.publicKey,
    signature: sign(null, Buffer.from(JSON.stringify(canonical(payload))), attacker.privateKey).toString("base64"),
  }];
  const report = evaluateReadiness(context);
  assert.equal(report.readyForCutoverReview, false);
  assert.equal(report.acceptedWorkstreams, 0);
  assert(blocked(report, requirement.id, "authority-not-enrolled"));
  assert(blocked(report, "authority", "independent-human-and-verifier-enrollment-required"));
  assert.equal(context.contract.policies.every(item => item.status === "proposed-unapproved"), true);
});

test("dynamic legacy operations need an exact profile/source mapping; unknown catalog items are never autoaccepted", () => {
  const context = blockedFixture();
  assert.deepEqual(context.contract.dynamicLegacyMappings, []);
  const requirement = readinessRequirements(context.contract).find(item => item.id === "catalog:legacy-mcp");
  assert(requirement.checks.includes("actualExecution"));
  assert(requirement.checks.includes("unavailableOperations"));
  assert(context.contract.workstreams.some(item => item.id === "mcp"));
  assert.equal(evaluateReadiness(context).readyForCutoverReview, false);
});

test("all 228 current canonical native operations map to exact workstream obligations without accepting candidates", () => {
  const mapped = new Set(contract.workstreams.flatMap(item => item.contracts));
  const batch15 = [
    { id: "legacy.skill.router.inject", version: 1, readOnly: false },
    { id: "legacy.skill.router.remove", version: 1, readOnly: false },
    { id: "knowledge.legacy-links.resolve", version: 1, readOnly: true },
    { id: "knowledge.asset.ownership.validate", version: 1, readOnly: true },
  ];
  assert.deepEqual(contract.nativeCatalogMap.batch15AddedPublicOperations, batch15);
  for (const expected of batch15) {
    assert(mapped.has(expected.id), `${expected.id} must have an explicit, still-unaccepted workstream obligation`);
    const definition = definitions.find(item => item.id === expected.id);
    assert(definition, `${expected.id} must exist in the canonical registry`);
    assert.equal(contract.operationVersion, expected.version);
    assert.equal(definition.readOnly, expected.readOnly);
  }
  const batch16 = [
    { id: "knowledge.classification.native-strict.command", version: 1, readOnly: false },
    { id: "memory.scope.forget.native", version: 1, readOnly: false },
  ];
  const batch19 = [
    { id: "knowledge.classification.original-compatible.command", version: 1, readOnly: false },
  ];
  const batch20 = [
    { id: "legacy.skill.source.install", version: 1, readOnly: false },
  ];
  const batch21 = [
    { id: "legacy.skill.source.remove", version: 1, readOnly: false },
  ];
  const batch22 = [
    { id: "legacy.skill.source.bridge", version: 1, readOnly: false },
  ];
  const batch23 = [
    { id: "subscription.identity.get", version: 1, readOnly: true },
  ];
  const currentRegistryAdditions = [
    { id: "knowledge.folder.lifecycle.promote-preview", version: 1, readOnly: true },
    { id: "knowledge.folder.promote-delete", version: 1, readOnly: false },
    { id: "knowledge.library.get", version: 1, readOnly: true },
    { id: "knowledge.library.list", version: 1, readOnly: true },
    { id: "knowledge.mutation.scan", version: 1, readOnly: true },
    { id: "plugin.runtime.disable", version: 1, readOnly: false },
    { id: "plugin.runtime.enable", version: 1, readOnly: false },
    { id: "plugin.runtime.invoke", version: 1, readOnly: false },
    { id: "subscription.broker.share-markers", version: 1, readOnly: true },
  ];
  assert.deepEqual(contract.nativeCatalogMap.batch19AddedPublicOperations, batch19);
  assert.deepEqual(contract.nativeCatalogMap.batch20AddedPublicOperations, batch20);
  assert.deepEqual(contract.nativeCatalogMap.batch21AddedPublicOperations, batch21);
  assert.deepEqual(contract.nativeCatalogMap.batch22AddedPublicOperations, batch22);
  assert.deepEqual(contract.nativeCatalogMap.batch23AddedPublicOperations, batch23);
  assert.deepEqual(contract.nativeCatalogMap.currentRegistryAdditions, currentRegistryAdditions);
  for (const expected of [...batch16, ...batch19, ...batch20, ...batch21, ...batch22, ...batch23, ...currentRegistryAdditions]) {
    assert(mapped.has(expected.id), `${expected.id} must have an explicit, still-unaccepted workstream obligation`);
    const definition = definitions.find(item => item.id === expected.id);
    assert(definition, `${expected.id} must exist in the canonical registry`);
    assert.equal(contract.operationVersion, expected.version);
    assert.equal(definition.readOnly, expected.readOnly);
  }
  assert.deepEqual([...definitions].map(item => item.id).sort(), [...mapped].sort());
  assert.equal(definitions.length, 228);
  for (const id of ["knowledge.trash.delete.original", "knowledge.trash.empty.original"]) {
    assert(mapped.has(id));
    assert.equal(definitions.find(item => item.id === id).readOnly, false);
  }
  const report = evaluateReadiness(blockedFixture());
  for (const operation of [...batch15, ...batch16, ...batch19, ...batch20, ...batch21, ...batch22, ...batch23, ...currentRegistryAdditions]) {
    assert(blocked(report, `contract:${operation.id}`, "missing-independent-evidence"),
      `${operation.id} must remain blocked until its own exact parity evidence is independently signed`);
  }
  assert(!blocked(report, "native-contracts", "unmapped-or-drifted-canonical-operation"));
  const originalClassification = definitions.find(item => item.id === batch19[0].id);
  assert.equal(originalClassification.input.safeParse({
    contract: "pkm.legacy-classification.original-compatible/v1", action: "preview",
  }).success, true);
  for (const grant of ["bearer", "authority", "MagicCode"]) assert.equal(originalClassification.input.safeParse({
    contract: "pkm.legacy-classification.original-compatible/v1", action: "preview", [grant]: "not-native-authority",
  }).success, false);
  for (const id of [
    "channel.runtime.accept", "channel.runtime.assign", "channel.runtime.update", "channel.runtime.reply",
    "remote.runtime.pin", "remote.runtime.publish", "remote.runtime.reconcile",
    "remote.runtime.subscription.run", "remote.runtime.subscription.mirror",
  ]) assert(mapped.has(id), `${id} must be mapped to an exact readiness workstream`);

  const context = blockedFixture();
  context.serverContracts = context.serverContracts.filter(item => item.id !== "remote.runtime.publish");
  assert(blocked(evaluateReadiness(context), "native-contracts", "unmapped-or-drifted-canonical-operation"));
});

test("functional parity excludes optional operational policies while retaining scope and separate cutover gates", () => {
  const context = blockedFixture();
  const requirements = readinessRequirements(context.contract);
  assert(context.contract.policies.every(item => item.status === "proposed-unapproved" && item.gate === "optional-operational"));
  for (const policy of context.contract.policies) {
    assert(!requirements.some(item => item.id === `policy:${policy.id}`));
    assert(!requirements.some(item => item.id === `measurement:${policy.id}`));
  }
  const optional = context.contract.optionalOperationalGates;
  assert.deepEqual(optional.policies, context.contract.policies.map(item => item.id));
  assert.deepEqual(optional.decisions, context.contract.decisions.filter(item => item.gate === "optional-operational").map(item => item.id));
  assert(optional.scenarios.every(id => !requirements.some(item => item.id === id)));
  assert(requirements.some(item => item.id === "decision:operator.scope-layouts-and-legacy-replacements"));
  assert(!requirements.some(item => item.id === "decision:operator.cutover-review-authority"));
  assert(context.contract.evidencePolicy.functionalParity.includes("intentional relaxation"));
  const report = evaluateReadiness(context);
  assert.equal(report.optionalOperationalGates, optional);
  assert.equal(report.finalCutover.authorized, false);
});

test("the report remains review-only and deterministic, and malformed input fails closed", () => {
  const context = blockedFixture();
  const a = evaluateReadiness(context);
  context.evidence.reverse();
  assert.deepEqual(evaluateReadiness(context), a);
  assert.deepEqual(a.finalCutover, {
    status: "separate-human-gate", authorized: false, automaticSwitch: false, automaticStop: false,
  });
  assert(!formatReadinessChecklist(a).includes("%"));
  assert(formatReadinessChecklist(a).includes("Final switch: separate human authorization"));
  assert(readinessRequirements(contract).some(item => item.id === "qualification.byte-identity-history-parity"));
  for (const malformed of [undefined, {}, { contract: {} }, { contract, manifest: {}, inventory: {} }]) {
    const report = evaluateReadiness(malformed);
    assert.equal(report.readyForCutoverReview, false);
    assert.equal(report.acceptedWorkstreams, 0);
    assert(report.blockers.some(item => item.reason === "malformed-input"));
  }
  const invalidMapping = blockedFixture();
  invalidMapping.contract.workstreams[0].scenarios = null;
  assert.equal(evaluateReadiness(invalidMapping).readyForCutoverReview, false);
});

test("read-only current-repository inspection reports blockers and never authorizes cutover", async () => {
  const report = await inspectReadiness();
  assert.equal(report.readyForCutoverReview, false);
  assert.equal(report.acceptedWorkstreams, 0);
  assert.equal(report.totalWorkstreams, 21);
  assert.equal(report.finalCutover.authorized, false);
  assert(report.blockers.length > 0);
});

test("--require-ready exits nonzero while the repository is legitimately blocked", async () => {
  let result;
  try {
    result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../scripts/readiness.mjs", import.meta.url)), "--require-ready",
    ]);
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.equal(report.readyForCutoverReview, false);
  assert.equal(report.acceptedWorkstreams, 0);
});
