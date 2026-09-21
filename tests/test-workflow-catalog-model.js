#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  BUILTIN_NODE_KIND_IDS,
  WorkflowCatalogError,
  createBuiltinNodeKindRegistry,
  createDefinitionDraft,
  createNodeKindRegistry,
  digestCanonical,
  emptyDefinitionCatalog,
  forkDefinition,
  installExactBundle,
  publishDefinition,
  reviseDefinitionDraft
} = require("../dist/workflows/catalog-model.js");

const errorCode = (action, code) => assert.throws(action, error => error instanceof WorkflowCatalogError && error.code === code);
const definition = (...kinds) => ({ schema: "pkm.workflow.definition/v1", spec: { nodes: kinds.map((kind, index) => ({ nodeId: `node_${index}`, kind })) } });
const request = (draft, commandId, overrides = {}) => ({
  commandId,
  expectedRevision: draft.revision,
  expectedExecutableDigest: draft.executableDigest,
  dependencies: [],
  resources: [],
  presentation: { name: "Example" },
  capabilityManifest: [],
  evidenceManifest: [],
  ...overrides
});

const registry = createBuiltinNodeKindRegistry();
assert.deepStrictEqual(Object.keys(registry), [...BUILTIN_NODE_KIND_IDS]);
assert(Object.isFrozen(registry));
assert(BUILTIN_NODE_KIND_IDS.every(kindId => Object.isFrozen(registry[kindId])));
assert.deepStrictEqual(new Set(Object.values(registry).map(item => item.adapterClass)), new Set(["none", "command", "agent", "check", "human-gate", "policy-gate", "control", "subflow"]));
assert(registry["pkm.step.noop/v1"].evidenceDeclarations.includes("invocation-receipt"));
assert(registry["pkm.control.join/v1"].stateContractId.includes("control"));
assert(registry["pkm.step.command/v1"].portability.portable === false);

const digest = digestCanonical({ exact: true });
const validRegistration = {
  ...registry["pkm.step.noop/v1"],
  kindId: "example.test.step/v1",
  inputDeclarations: { value: { type: "string", required: true, nullable: false, schema: {} } },
  outputDeclarations: { done: { type: "boolean", required: true, nullable: false, schema: {} } },
  capabilityDeclarations: ["z", "a"],
  evidenceDeclarations: ["receipt"],
  portability: { portable: true, installationRequirements: ["z", "a"], runtimeAvailable: true }
};
const customRegistry = createNodeKindRegistry([validRegistration]);
assert.deepStrictEqual(customRegistry[validRegistration.kindId].capabilityDeclarations, ["a", "z"]);
assert.deepStrictEqual(Object.keys(customRegistry[validRegistration.kindId].inputDeclarations), ["value"]);
errorCode(() => createNodeKindRegistry([validRegistration, validRegistration]), "duplicate-node-kind");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, kindId: "bad" }]), "invalid-node-kind");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, schemaVersion: "" }]), "invalid-node-kind-contract");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, configSchemaDigest: "bad" }]), "invalid-node-kind-contract");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, configValidatorDigest: "bad" }]), "invalid-node-kind-contract");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, conformanceDigest: "bad" }]), "invalid-node-kind-contract");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, supportState: "revoked" }]), "invalid-revocation");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, revocation: { revoked: true, reason: "withdrawn" } }]), "invalid-revocation");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, capabilityDeclarations: [""] }]), "invalid-set-value");
errorCode(() => createNodeKindRegistry([{ ...validRegistration, evidenceDeclarations: ["same", "same"] }]), "duplicate-set-value");

let draft = createDefinitionDraft("schema: v1\n", definition(...BUILTIN_NODE_KIND_IDS), () => "alpha");
assert.strictEqual(draft.definitionId, "def_alpha");
assert.strictEqual(draft.revision, 1);
assert(Object.isFrozen(draft.compiledDefinition));
assert.strictEqual(reviseDefinitionDraft(draft, draft.source, definition(...BUILTIN_NODE_KIND_IDS)), draft);
const revised = reviseDefinitionDraft(draft, "schema: v1\n# presentation\n", definition(...BUILTIN_NODE_KIND_IDS));
assert.strictEqual(revised.definitionId, draft.definitionId);
assert.strictEqual(revised.revision, 2);
assert.notStrictEqual(revised.sourceDigest, draft.sourceDigest);
assert.strictEqual(revised.executableDigest, draft.executableDigest);
const behaviorRevision = reviseDefinitionDraft(revised, revised.source, definition("pkm.step.noop/v1"));
assert.notStrictEqual(behaviorRevision.executableDigest, revised.executableDigest);
assert.match(createDefinitionDraft("x", definition("pkm.step.noop/v1")).definitionId, /^def_[0-9a-f-]{36}$/);
errorCode(() => createDefinitionDraft("x", definition("pkm.step.noop/v1"), () => ""), "invalid-definition-id");

let catalog = emptyDefinitionCatalog();
assert(Object.isFrozen(catalog));
const resources = [
  { path: "b.txt", mediaType: "text/plain", size: 2, contentDigest: digestCanonical("b") },
  { path: "a.txt", mediaType: "text/z", size: 1, contentDigest: digestCanonical("z") },
  { path: "a.txt", mediaType: "text/a", size: 1, contentDigest: digestCanonical("z") },
  { path: "a.txt", mediaType: "text/a", size: 1, contentDigest: digestCanonical("a") }
];
const first = publishDefinition(catalog, draft, request(draft, "publish-1", {
  resources,
  presentation: { name: "First", annotations: { color: "blue" } },
  capabilityManifest: ["network", "filesystem"],
  evidenceManifest: ["result", "receipt"]
}), registry, () => "version-a");
catalog = first.catalog;
assert.strictEqual(first.replayed, false);
assert.strictEqual(first.version.versionId, "ver_version-a");
assert.strictEqual(first.version.runtimeStatus, "runnable");
assert.deepStrictEqual(first.version.resourceManifest.map(item => item.contentDigest), [digestCanonical("z"), digestCanonical("a"), digestCanonical("z"), digestCanonical("b")]);
assert.deepStrictEqual(first.version.capabilityManifest, ["filesystem", "network"]);
assert(Object.isFrozen(first.version));
assert(Object.isFrozen(first.version.dependencyLock));
assert.throws(() => { first.version.runtimeStatus = "changed"; }, TypeError);
assert.notStrictEqual(first.version.sourceDigest, first.version.executableDigest);
assert.notStrictEqual(first.version.resourceManifestDigest, first.version.presentationDigest);
assert.notStrictEqual(first.version.bundleDigest, first.version.executableDigest);

const replay = publishDefinition(catalog, draft, request(draft, "publish-1", {
  resources,
  presentation: { name: "First", annotations: { color: "blue" } },
  capabilityManifest: ["network", "filesystem"],
  evidenceManifest: ["result", "receipt"]
}), registry, () => "unused");
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.catalog, catalog);
assert.strictEqual(replay.version, first.version);
errorCode(() => publishDefinition(catalog, draft, request(draft, "publish-1", { presentation: { name: "Changed" } }), registry), "command-conflict");
errorCode(() => publishDefinition({ ...catalog, versions: [] }, draft, request(draft, "publish-1", {
  resources,
  presentation: { name: "First", annotations: { color: "blue" } },
  capabilityManifest: ["network", "filesystem"],
  evidenceManifest: ["result", "receipt"]
}), registry), "catalog-corrupt");
errorCode(() => publishDefinition(catalog, draft, request(draft, "stale-revision", { expectedRevision: 9 }), registry), "stale-draft");
errorCode(() => publishDefinition(catalog, draft, request(draft, "stale-digest", { expectedExecutableDigest: digest }), registry), "stale-draft");
errorCode(() => publishDefinition(catalog, draft, request(draft, "identity-clash"), registry, () => "version-a"), "identity-conflict");

const presentationOnly = publishDefinition(catalog, revised, request(revised, "publish-presentation"), registry, () => "version-p");
catalog = presentationOnly.catalog;
assert.strictEqual(presentationOnly.version.executableDigest, first.version.executableDigest);
assert.notStrictEqual(presentationOnly.version.sourceDigest, first.version.sourceDigest);
assert.notStrictEqual(presentationOnly.version.bundleDigest, first.version.bundleDigest);

const unknownDraft = createDefinitionDraft("x", definition("example.missing/v1"), () => "unknown");
errorCode(() => publishDefinition(catalog, unknownDraft, request(unknownDraft, "unknown"), registry), "unknown-node-kind");
const revokedRegistration = { ...validRegistration, supportState: "revoked", revocation: { revoked: true, reason: "security" } };
const revokedRegistry = createNodeKindRegistry([revokedRegistration]);
const revokedDraft = createDefinitionDraft("x", definition(validRegistration.kindId), () => "revoked");
errorCode(() => publishDefinition(catalog, revokedDraft, request(revokedDraft, "revoked"), revokedRegistry), "revoked-node-kind");

const portableRegistry = createBuiltinNodeKindRegistry(["pkm.step.agent/v1"]);
const portableDraft = createDefinitionDraft("x", definition("pkm.step.agent/v1"), () => "portable");
const portable = publishDefinition(catalog, portableDraft, request(portableDraft, "portable"), portableRegistry, () => "portable-version");
catalog = portable.catalog;
assert.strictEqual(portable.version.runtimeStatus, "not-runnable-here");
assert.deepStrictEqual(portable.version.unavailableKinds, ["pkm.step.agent/v1"]);
const localRegistry = createBuiltinNodeKindRegistry(["pkm.step.command/v1"]);
const localDraft = createDefinitionDraft("x", definition("pkm.step.command/v1"), () => "local");
errorCode(() => publishDefinition(catalog, localDraft, request(localDraft, "local"), localRegistry), "runtime-unavailable");
const malformedDraft = createDefinitionDraft("x", {}, () => "malformed");
errorCode(() => publishDefinition(catalog, malformedDraft, request(malformedDraft, "malformed"), registry), "invalid-compiled-definition");
const malformedNodeDraft = createDefinitionDraft("x", { spec: { nodes: [null] } }, () => "malformed-node");
errorCode(() => publishDefinition(catalog, malformedNodeDraft, request(malformedNodeDraft, "malformed-node"), registry), "invalid-compiled-node");

const childDraft = createDefinitionDraft("child", definition("pkm.step.noop/v1"), () => "child");
const child = publishDefinition(catalog, childDraft, request(childDraft, "child"), registry, () => "child-v1");
catalog = child.catalog;
const parentDraft = createDefinitionDraft("parent", definition("pkm.subflow/v1"), () => "parent");
const parent = publishDefinition(catalog, parentDraft, request(parentDraft, "parent", { dependencies: [{ slot: "child", versionId: child.version.versionId }] }), registry, () => "parent-v1");
catalog = parent.catalog;
assert.deepStrictEqual(parent.version.dependencyLock.entries[0], {
  slot: "child",
  definitionId: childDraft.definitionId,
  versionId: child.version.versionId,
  executableDigest: child.version.executableDigest,
  dependencyLockDigest: child.version.dependencyLockDigest,
  transitiveLock: child.version.dependencyLock
});
errorCode(() => publishDefinition(catalog, parentDraft, request(parentDraft, "missing-dep", { dependencies: [{ slot: "x", versionId: "missing" }] }), registry), "dependency-not-found");
errorCode(() => publishDefinition(catalog, parentDraft, request(parentDraft, "duplicate-slot", { dependencies: [{ slot: "x", versionId: child.version.versionId }, { slot: "x", versionId: child.version.versionId }] }), registry), "duplicate-dependency-slot");
errorCode(() => publishDefinition(catalog, childDraft, request(childDraft, "direct-cycle", { dependencies: [{ slot: "self", versionId: child.version.versionId }] }), registry), "dependency-cycle");
errorCode(() => publishDefinition(catalog, childDraft, request(childDraft, "transitive-cycle", { dependencies: [{ slot: "parent", versionId: parent.version.versionId }] }), registry), "dependency-cycle");

const grandDraft = createDefinitionDraft("grand", definition("pkm.subflow/v1"), () => "grand");
const grand = publishDefinition(catalog, grandDraft, request(grandDraft, "grand", { dependencies: [
  { slot: "z-parent", versionId: parent.version.versionId },
  { slot: "a-child", versionId: child.version.versionId }
] }), registry, () => "grand-v1");
catalog = grand.catalog;
assert.deepStrictEqual(grand.version.dependencyLock.entries.map(entry => entry.slot), ["a-child", "z-parent"]);
errorCode(() => publishDefinition(catalog, childDraft, request(childDraft, "deep-cycle", { dependencies: [{ slot: "grand", versionId: grand.version.versionId }] }), registry), "dependency-cycle");
const unrelatedDraft = createDefinitionDraft("unrelated", definition("pkm.subflow/v1"), () => "unrelated");
const unrelated = publishDefinition(catalog, unrelatedDraft, request(unrelatedDraft, "unrelated", { dependencies: [{ slot: "grand", versionId: grand.version.versionId }] }), registry, () => "unrelated-v1");
catalog = unrelated.catalog;
assert.strictEqual(unrelated.version.runtimeStatus, "runnable");

errorCode(() => publishDefinition(catalog, draft, request(draft, "bad-resource-path", { resources: [{ ...resources[0], path: "" }] }), registry), "invalid-resource");
errorCode(() => publishDefinition(catalog, draft, request(draft, "bad-resource-media", { resources: [{ ...resources[0], mediaType: "" }] }), registry), "invalid-resource");
errorCode(() => publishDefinition(catalog, draft, request(draft, "bad-resource-size-float", { resources: [{ ...resources[0], size: 1.2 }] }), registry), "invalid-resource");
errorCode(() => publishDefinition(catalog, draft, request(draft, "bad-resource-size-negative", { resources: [{ ...resources[0], size: -1 }] }), registry), "invalid-resource");
errorCode(() => publishDefinition(catalog, draft, request(draft, "bad-resource-digest", { resources: [{ ...resources[0], contentDigest: "bad" }] }), registry), "invalid-resource");
errorCode(() => publishDefinition(catalog, draft, request(draft, "duplicate-resource", { resources: [resources[0], resources[0]] }), registry), "duplicate-resource");

let installCatalog = emptyDefinitionCatalog();
const upstream = { rootId: "root-upstream", definitionId: "def-upstream", versionId: "ver-upstream", bundleDigest: first.version.bundleDigest };
const installed = installExactBundle(installCatalog, upstream, (() => { const ids = ["local", "receipt"]; return () => ids.shift(); })());
installCatalog = installed.catalog;
assert.strictEqual(installed.replayed, false);
assert.strictEqual(installed.installation.localDefinitionId, "def_local");
const reinstalled = installExactBundle(installCatalog, upstream, () => "unused");
assert.strictEqual(reinstalled.replayed, true);
assert.strictEqual(reinstalled.catalog, installCatalog);
assert.strictEqual(reinstalled.installation, installed.installation);
errorCode(() => installExactBundle(installCatalog, { ...upstream, versionId: "other", bundleDigest: "bad" }), "invalid-bundle-digest");
const randomInstall = installExactBundle(emptyDefinitionCatalog(), { ...upstream, versionId: "random" });
assert.match(randomInstall.installation.localDefinitionId, /^def_[0-9a-f-]{36}$/);
const forked = forkDefinition(installCatalog, installed.installation.localDefinitionId, (() => { const ids = ["forked", "fork-receipt"]; return () => ids.shift(); })());
assert.strictEqual(forked.fork.localDefinitionId, "def_forked");
assert.notStrictEqual(forked.fork.localDefinitionId, installed.installation.localDefinitionId);
assert.strictEqual(forked.catalog.forks.length, 1);
const randomFork = forkDefinition(emptyDefinitionCatalog(), "def_source");
assert.match(randomFork.fork.localDefinitionId, /^def_[0-9a-f-]{36}$/);

console.log("workflow catalog model test: exact registry, immutable publication, dependency closure, portability, and install replay OK");