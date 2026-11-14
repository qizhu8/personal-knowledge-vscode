import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { captureStatus, implementationDigest } from "./migration.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sorted = values => [...values].sort();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(sorted(Object.keys(value)).map(key => [key, canonical(value[key])]));
  return value;
}
export const readinessDigest = value => sha(JSON.stringify(canonical(value)));
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === new Set(a).size && b.length === new Set(b).size
  && JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const declarationId = item => `legacy:${item.kind}:${item.path}:${item.name}`;
const contractId = (id, version) => `${id}@${version}`;
function authorityKey(authority) {
  const key = authority.publicKey?.type === "public" ? authority.publicKey : createPublicKey(authority.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Readiness authority must use Ed25519.");
  return key;
}

/**
 * Frozen v1 API. Requirements are exact scopes, not capability or test totals.
 * Signed evidence is supplied by independently enrolled verifier/human authorities.
 */
export function readinessRequirements(contract) {
  const requirements = [];
  const add = (id, workstream, kind, scope, checks, extra = {}) =>
    requirements.push({ id, workstream, kind, scope, checks, ...extra });
  for (const gate of contract.workstreams) {
    for (const id of gate.contracts) add(`contract:${id}`, gate.id, "parity", [contractId(id, contract.operationVersion)], contract.evidencePolicy.requiredParityChecks);
    for (const id of gate.scenarios) add(id, gate.id, "scenario", [id],
      [...contract.evidencePolicy.requiredScenarioChecks, ...contract.scenarioChecks?.[id] ?? []]);
  }
  for (const group of contract.legacyDeclarations) for (const name of group.names) {
    const id = declarationId({ ...group, name });
    add(id, group.workstream, "parity", [id], contract.evidencePolicy.requiredParityChecks);
  }
  for (const group of contract.sourceDeclaredContracts) for (const id of group.ids) {
    const key = `legacy-contract:${group.path}:${contractId(id, contract.operationVersion)}`;
    add(key, group.workstream, "parity", [key], contract.evidencePolicy.requiredParityChecks);
  }
  for (const [kind, group] of [["command", contract.legacyCommands], ["configuration", contract.legacyConfigurations]]) {
    for (const id of group.ids) add(`legacy-${kind}:${id}`, group.workstream, "parity", [id], contract.evidencePolicy.requiredParityChecks);
  }
  for (const item of contract.dynamicLegacyMappings) add(`dynamic:${item.profile}:${item.id}`, item.workstream, "parity",
    [contractId(item.id, item.version)], contract.evidencePolicy.requiredParityChecks);
  for (const profile of contract.catalogProfiles) add(`catalog:${profile}`, "mcp", "catalog", [profile], contract.catalogChecks, { profile });
  for (const decision of contract.decisions.filter(item => item.gate === "functional-scope")) {
    add(`decision:${decision.id}`, decision.workstream, "decision", [decision.id], decision.checks);
  }
  return requirements.sort((a, b) => a.id.localeCompare(b.id, "en") || a.workstream.localeCompare(b.workstream, "en"));
}

function signedPayload(record, context, contractDigest) {
  const p = record?.payload;
  if (!p || p.schema !== "pkm.readiness-attestation/v1" || p.result !== "qualified"
    || !["actual-isolated", "legacy-oracle", "human"].includes(p.evidenceMode)) return "unqualified-or-self-reported";
  if (p.contractDigest !== contractDigest || p.inventoryRevision !== context.inventory.revision
    || p.implementationDigest !== context.implementationDigest) return "stale-evidence";
  const authority = (context.trustedAuthorities ?? []).find(item => item.id === record.authorityId);
  const role = ["policy", "decision"].includes(p.kind) ? "human" : "verifier";
  if (!authority || !authority.roles?.includes(role)) return "authority-not-enrolled";
  try {
    if (typeof record.signature !== "string" || !verify(null, Buffer.from(JSON.stringify(canonical(p))),
      authorityKey(authority), Buffer.from(record.signature, "base64"))) return "invalid-independent-signature";
  } catch { return "invalid-independent-signature"; }
  if (!Array.isArray(p.artifacts) || !p.artifacts.length
    || new Set(p.artifacts.map(item => item.path)).size !== p.artifacts.length
    || p.artifacts.some(item => !safeArtifactPath(item.path) || !validDigest(item.sha256)
      || context.artifactDigests?.[item.path] !== item.sha256)) return "artifact-bytes-not-qualified";
  return null;
}

function safeArtifactPath(path) {
  return typeof path === "string" && /^(?:migration|tests)\//.test(path)
    && !path.includes("\\") && path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith("."));
}

function qualifyCatalog(payload, requirement, context, contract) {
  const catalog = payload.observations?.catalog;
  if (!catalog || catalog.profile !== requirement.profile || !validDigest(catalog.revision)
    || !Array.isArray(catalog.pages) || !catalog.pages.length || !Array.isArray(catalog.described)) return "catalog-evidence-missing";
  let offset = 0;
  const items = [];
  for (const [index, page] of catalog.pages.entries()) {
    if (page.revision !== catalog.revision || page.offset !== offset || !Array.isArray(page.items)
      || !Number.isSafeInteger(page.total) || page.total < 0 || page.total !== catalog.pages[0].total) return "catalog-pagination-or-revision-mismatch";
    items.push(...page.items);
    offset += page.items.length;
    if (index === catalog.pages.length - 1 ? page.nextOffset !== null || offset !== page.total
      : !page.items.length || page.nextOffset !== offset) return "catalog-incomplete-pages";
  }
  const ids = items.map(item => item.id);
  if (new Set(ids).size !== ids.length || catalog.described.length !== items.length) return "catalog-duplicate-or-undescribed";
  for (const item of items) {
    const described = catalog.described.find(entry => entry.id === item.id);
    if (!described || described.version !== item.version || described.readOnly !== item.readOnly
      || described.revision !== catalog.revision || !validDigest(described.inputSchemaDigest)
      || !validDigest(described.outputSchemaDigest) || typeof item.readOnly !== "boolean") return `catalog-contract-mismatch:${item.id}`;
    if (requirement.profile.startsWith("next-")) {
      const declared = context.serverContracts.find(entry => entry.id === item.id);
      if (!declared) return `catalog-unmapped-native:${item.id}`;
      if (declared.version !== item.version || declared.readOnly !== item.readOnly) return `catalog-version-or-authority-mismatch:${item.id}`;
      if (requirement.profile.endsWith("-read") && !item.readOnly) return `catalog-read-actor-mutation:${item.id}`;
    } else {
      const knownNames = contract.legacyDeclarations.flatMap(group => group.names);
      const sourceIds = contract.sourceDeclaredContracts.flatMap(group => group.ids);
      if (!knownNames.includes(item.id.replace(/^(?:mcp\.tool\.|native\.tool\.)/, "")) && !sourceIds.includes(item.id)
        && !contract.dynamicLegacyMappings.some(entry => entry.profile === requirement.profile && entry.id === item.id && entry.version === item.version)) {
        return `catalog-unmapped-dynamic-legacy:${item.id}`;
      }
      if (item.version !== contract.operationVersion) return `catalog-legacy-version-mismatch:${item.id}`;
    }
  }
  // Every known operation has an explicit available/denied/unavailable observation,
  // including native-only and optional operations absent from an actor's catalog.
  const expected = requirement.profile.startsWith("next-")
    ? context.serverContracts.map(item => item.id)
    : sorted(new Set([
      ...contract.legacyDeclarations.filter(group => requirement.profile === "legacy-mcp"
        ? group.kind === "mcp-declaration" : group.kind === "typescript-contract-candidate").flatMap(group => group.names),
      ...contract.sourceDeclaredContracts.flatMap(group => group.ids),
      ...contract.dynamicLegacyMappings.filter(item => item.profile === requirement.profile).map(item => item.id),
    ]));
  const coverage = catalog.coverage;
  if (!Array.isArray(coverage) || !sameSet(coverage.map(item => item.id), expected)) return "catalog-static-runtime-coverage-incomplete";
  for (const item of coverage) {
    if (!["available", "denied", "unavailable"].includes(item.state) || !item.reason?.trim()) return "catalog-coverage-unexplained";
    const available = items.some(entry => entry.id === item.id || entry.id === `mcp.tool.${item.id}` || entry.id === `native.tool.${item.id}`);
    if ((item.state === "available") !== available) return `catalog-coverage-contradiction:${item.id}`;
    if (item.state !== "available" && payload.checks.authorizationDenials !== true) return "catalog-denial-unverified";
  }
  return null;
}

/**
 * Pure evaluator. trustedAuthorities and artifactDigests are native trust inputs,
 * never fields copied from the evidence document. A signed receipt is an auditable
 * assertion by that independent authority, not proof inferred from test filenames.
 */
export function evaluateReadiness(context) {
  try { return evaluate(context); }
  catch {
    return { schema: "pkm.cutover-readiness/v1", status: "blocked", readyForCutoverReview: false,
      acceptedWorkstreams: 0, totalWorkstreams: 21, workstreams: [], checklist: [],
      blockers: [{ id: "contract", reason: "malformed-input" }],
      finalCutover: { status: "separate-human-gate", authorized: false, automaticSwitch: false, automaticStop: false } };
  }
}

function evaluate(context) {
  const { contract, manifest, inventory } = context;
  const blockers = [];
  const block = (id, reason) => blockers.push({ id, reason });
  if (contract?.schema !== "pkm.cutover-readiness-contract/v1" || !Array.isArray(contract.workstreams)
    || !Array.isArray(manifest?.workstreams) || !Array.isArray(inventory?.surfaces)) {
    return { schema: "pkm.cutover-readiness/v1", status: "blocked", readyForCutoverReview: false,
      acceptedWorkstreams: 0, totalWorkstreams: 21, checklist: [], blockers: [{ id: "contract", reason: "malformed-input" }],
      finalCutover: { status: "separate-human-gate", authorized: false, automaticSwitch: false, automaticStop: false } };
  }
  if (manifest.schema !== contract.manifestSchema || inventory.schema !== contract.inventorySchema
    || contract.operationVersion !== 1) block("contract", "schema-or-version-mismatch");
  if (manifest.workstreams.length !== 21 || contract.workstreams.length !== 21
    || !sameSet(manifest.workstreams.map(item => item.id), contract.workstreams.map(item => item.id))) block("workstreams", "canonical-21-gate-mapping-mismatch");
  if (!validDigest(context.implementationDigest)) block("implementation", "missing-current-fingerprint");
  if (inventory.revision !== contract.inventoryRevision) block("inventory", "readiness-inventory-version-mismatch");
  if (!context.currentInventory || readinessDigest(inventory) !== readinessDigest(context.currentInventory)) block("inventory", "new-or-changed-legacy-source-drift");
  if (!Array.isArray(context.captureIssues) || context.captureIssues.length) block("provenance", "missing-or-stale-capture-qualification");
  const mappedDeclarations = contract.legacyDeclarations.flatMap(group => group.names.map(name => declarationId({ ...group, name })));
  if (!sameSet(mappedDeclarations, inventory.surfaces.map(declarationId))) block("legacy-declarations", "unmapped-or-duplicate-legacy-contracts");
  if (!sameSet(contract.legacyCommands.ids, inventory.commands)) block("legacy-commands", "unmapped-or-duplicate-legacy-commands");
  if (!sameSet(contract.legacyConfigurations.ids, inventory.configurationKeys)) block("legacy-configuration", "unmapped-or-duplicate-legacy-settings");
  const nativeIds = contract.workstreams.flatMap(item => item.contracts);
  const requiredNative = sorted(new Set(nativeIds));
  if (!Array.isArray(context.serverContracts) || !sameSet(requiredNative, context.serverContracts.map(item => item.id))) block("native-contracts", "unmapped-or-drifted-canonical-operation");
  else if (context.serverContracts.some(item => item.version !== contract.operationVersion)) block("native-contracts", "canonical-operation-version-mismatch");
  if (!context.sourceContractsCurrent) block("native-contracts", "source-definition-build-or-map-drift");
  if (!Array.isArray(context.trustedAuthorities) || !context.trustedAuthorities.some(item => item.roles?.includes("human"))
    || !context.trustedAuthorities.some(item => item.roles?.includes("verifier"))) block("authority", "independent-human-and-verifier-enrollment-required");
  if (context.trustedAuthorities?.some(item => item.roles?.includes("human") && item.roles?.includes("verifier"))) block("authority", "human-and-independent-verifier-must-be-distinct");
  if (context.trustedAuthorities?.length) {
    try {
      const keys = context.trustedAuthorities.map(item => ({
        roles: item.roles, digest: sha(authorityKey(item).export({ type: "spki", format: "der" })),
      }));
      if (new Set(context.trustedAuthorities.map(item => item.id)).size !== context.trustedAuthorities.length
        || keys.some(item => item.roles.includes("human")
          && keys.some(other => other.roles.includes("verifier") && other.digest === item.digest))) block("authority", "human-and-independent-verifier-must-be-distinct");
    } catch { block("authority", "invalid-enrolled-authority-key"); }
  }
  const requirements = readinessRequirements(contract);
  if (requirements.some(item => !contract.workstreams.some(gate => gate.id === item.workstream))) block("requirements", "unknown-workstream");
  const grouped = new Map();
  for (const requirement of requirements) {
    const entries = grouped.get(requirement.id) ?? [];
    entries.push(requirement);
    grouped.set(requirement.id, entries);
  }
  for (const [id, entries] of grouped) {
    // Cross-domain sharing of the same canonical operation is intentional.
    if (new Set(entries.map(item => item.workstream)).size !== entries.length) block(id, "duplicate-requirement-mapping");
  }
  const evidence = Array.isArray(context.evidence) ? context.evidence : [];
  const unknownEvidence = evidence.filter(record => !grouped.has(record?.payload?.requirementId));
  for (const record of unknownEvidence) block(record?.payload?.requirementId ?? "evidence", "unknown-evidence-scope");
  const qualified = new Map();
  const checklist = requirements.map(requirement => {
    const candidates = evidence.filter(record => record?.payload?.requirementId === requirement.id);
    let reason = candidates.length === 0 ? "missing-independent-evidence" : candidates.length !== 1 ? "duplicate-evidence" : null;
    const record = candidates[0];
    const payload = record?.payload;
    if (!reason) reason = signedPayload(record, context, readinessDigest(contract));
    if (!reason && (payload.kind !== requirement.kind || !sameSet(payload.scope, requirement.scope))) reason = "exact-mapped-scope-mismatch";
    if (!reason && requirement.checks.some(check => payload.checks?.[check] !== true)) reason = "required-check-not-qualified";
    if (!reason && ["parity", "scenario", "measurement", "catalog"].includes(requirement.kind)
      && payload.evidenceMode === "human") reason = "human-decision-not-execution-evidence";
    if (!reason && requirement.kind === "parity" && payload.evidenceMode !== "legacy-oracle") reason = "native-slice-not-legacy-parity";
    if (!reason && ["policy", "decision"].includes(requirement.kind) && payload.evidenceMode !== "human") reason = "native-test-not-human-authority";
    if (!reason && !payload.observations?.method?.trim()) reason = "qualification-method-undocumented";
    if (!reason && requirement.kind === "catalog") reason = qualifyCatalog(payload, requirement, context, contract);
    if (!reason && requirement.kind === "decision") {
      if (!payload.observations?.decision?.rationale?.trim() || !payload.observations.decision.runbookReference?.trim()) reason = "operator-decision-undocumented";
    }
    if (!reason) qualified.set(requirement.id, payload);
    return { id: requirement.id, workstream: requirement.workstream, kind: requirement.kind,
      scope: requirement.scope, requiredChecks: requirement.checks, status: reason ? "blocked" : "qualified", blockingReason: reason };
  });
  for (const row of checklist) if (row.status === "blocked") block(row.id, row.blockingReason);
  const globalBlocked = blockers.some(item => !grouped.has(item.id));
  const workstreams = contract.workstreams.map(gate => {
    const rows = checklist.filter(item => item.workstream === gate.id);
    const accepted = !globalBlocked && rows.length > 0 && rows.every(item => item.status === "qualified");
    return { id: gate.id, title: manifest.workstreams.find(item => item.id === gate.id)?.title ?? gate.id,
      status: accepted ? "qualified" : "blocked", qualifiedRequirements: rows.filter(item => item.status === "qualified").length,
      requiredRequirements: rows.length, unresolvedScope: accepted ? [] : gate.unresolved,
      blockingReasons: sorted(new Set(rows.filter(item => item.status === "blocked").map(item => `${item.id}: ${item.blockingReason}`))) };
  });
  const uniqueBlockers = [...new Map(blockers.map(item => [`${item.id}:${item.reason}`, item])).values()]
    .sort((a, b) => a.id.localeCompare(b.id, "en") || a.reason.localeCompare(b.reason, "en"));
  const ready = uniqueBlockers.length === 0 && workstreams.every(item => item.status === "qualified");
  return { schema: "pkm.cutover-readiness/v1", status: ready ? "readyForCutoverReview" : "blocked",
    readyForCutoverReview: ready, contractDigest: readinessDigest(contract),
    inventoryRevision: inventory.revision, implementationDigest: context.implementationDigest,
    acceptedWorkstreams: workstreams.filter(item => item.status === "qualified").length,
    totalWorkstreams: 21, workstreams, checklist, blockers: uniqueBlockers,
    optionalOperationalGates: contract.optionalOperationalGates,
    finalCutover: { status: "separate-human-gate", authorized: false, automaticSwitch: false, automaticStop: false } };
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
async function currentInventory() {
  const files = [...await sourceFiles(resolve(repository, "src")),
    ...(await readdir(resolve(repository, "resources"))).filter(name => /\.(py|js)$/.test(name)).map(name => resolve(repository, "resources", name))].sort();
  const sources = [], surfaces = [];
  for (const file of files) {
    const path = relative(repository, file);
    const content = await readFile(file, "utf8");
    const hostDependencies = [...new Set([...content.matchAll(/(?:from\s+|require\(\s*)["'](vscode(?:\/[^"']*)?)["']/g)].map(match => match[1]))];
    sources.push({ path, sha256: sha(content), lines: content.split("\n").length, hostDependencies });
    for (const match of content.matchAll(/@mcp\.tool\([^\n]*\)\s*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g)) surfaces.push({
      kind: "mcp-declaration", name: match[1], path, line: content.slice(0, match.index).split("\n").length,
    });
    if (path.endsWith(".ts")) {
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = node.properties.filter(ts.isPropertyAssignment);
          const property = name => properties.find(item => item.name.getText(source).replaceAll(/["']/g, "") === name);
          const identity = property("name") ?? property("id");
          if (identity && ts.isStringLiteral(identity.initializer)
            && (property("parameters") || property("inputSchema") || property("execute") || property("permission"))) surfaces.push({
            kind: "typescript-contract-candidate", name: identity.initializer.text, path,
            line: source.getLineAndCharacterOfPosition(identity.getStart(source)).line + 1,
          });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  const packageSource = await readFile(resolve(repository, "package.json"), "utf8");
  const metadata = JSON.parse(packageSource);
  const commands = (metadata.contributes?.commands ?? []).map(item => item.command);
  const configuration = metadata.contributes?.configuration;
  const configurationKeys = (Array.isArray(configuration) ? configuration : [configuration]).flatMap(item => Object.keys(item?.properties ?? {})).sort();
  const legacyTests = [];
  for (const entry of (await readdir(resolve(repository, "tests"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isFile() && /^test-.*\.(js|mjs|py|ts)$/.test(entry.name)) {
      const path = `tests/${entry.name}`;
      legacyTests.push({ path, sha256: sha(await readFile(resolve(repository, path))) });
    }
  }
  const packageSha256 = sha(packageSource);
  return { schema: "pkm.migration-inventory/v1",
    measurement: "Source snapshot, not runtime enabled tools, semantic parity or implementation completion. Dynamic registrations and external providers require separate runtime qualification.",
    revision: sha(JSON.stringify({ packageSha256, sources, surfaces, commands, configurationKeys, legacyTests })),
    packageSha256, sources, surfaces, commands, configurationKeys, legacyTests };
}
async function nativeSourceContracts() {
  // Only the canonical composed registry counts. An unreferenced internal module
  // is not an exposed capability; generated Todo definitions are not literal IDs.
  const { definitions } = await import(new URL("../dist/contracts.js", import.meta.url));
  return definitions.map(item => ({ id: item.id, version: 1, readOnly: item.readOnly })).sort((a, b) => a.id.localeCompare(b.id, "en"));
}
async function artifactDigest(path) {
  if (!safeArtifactPath(path)) return undefined;
  const full = resolve(root, path);
  if (isAbsolute(relative(root, full)) || relative(root, full).startsWith("..")) return undefined;
  // Refuse every symlink component before reading any evidence bytes.
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return undefined; }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  try { return sha(await readFile(full)); }
  catch (error) { if (error.code === "ENOENT" || error.code === "EISDIR") return undefined; throw error; }
}

/** Read-only, bounded repository inspection; no runtime connection or data import. */
export async function inspectReadiness({ evidence = [], trustedAuthorities = [], strict = false } = {}) {
  try {
    const report = await inspect({ evidence, trustedAuthorities });
    if (strict && report.blockers.some(item => item.reason === "malformed-input")) {
      throw new Error("Readiness inspection encountered malformed input.");
    }
    return report;
  } catch (error) {
    if (strict) throw error;
    return evaluateReadiness(undefined);
  }
}

async function inspect({ evidence, trustedAuthorities }) {
  const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
  const [contract, manifest, inventory, current, captures, digest, serverContracts] = await Promise.all([
    json("migration/readiness-contract.json"), json("migration/manifest.json"), json("migration/inventory.json"),
    currentInventory().catch(() => undefined), captureStatus().catch(() => ({ issues: [{ reason: "provenance-validation-failed" }] })),
    implementationDigest().catch(() => undefined), nativeSourceContracts().catch(() => []),
  ]);
  const artifactDigests = {};
  for (const path of sorted(new Set(evidence.flatMap(record => record?.payload?.artifacts?.map(item => item.path) ?? [])))) {
    const digest = await artifactDigest(path);
    if (digest) artifactDigests[path] = digest;
  }
  const contractSource = await readFile(resolve(root, "src/contracts.ts"), "utf8");
  let buildCurrent = false;
  try {
    const verification = await json("migration/verification.json");
    buildCurrent = verification.schema === "pkm.migration-verification/v1" && verification.passed === true
      && verification.digest === digest && verification.command === "npm test";
  } catch { buildCurrent = false; }
  const after = await implementationDigest().catch(() => undefined);
  const stableDigest = digest === after ? digest : undefined;
  return evaluateReadiness({ contract, manifest, inventory, currentInventory: current, implementationDigest: stableDigest,
    captureIssues: captures.issues, serverContracts, sourceContractsCurrent: buildCurrent && /version:\s*z\.literal\(1\)/.test(contractSource),
    evidence, trustedAuthorities, artifactDigests });
}

export function formatReadinessChecklist(report) {
  return [
    `Cutover review readiness: ${report.status}`,
    `Exact qualified workstreams: ${report.acceptedWorkstreams}/${report.totalWorkstreams} (checklist count, not completion percentage).`,
    ...report.workstreams?.flatMap(gate => [
      `${gate.status === "qualified" ? "[x]" : "[ ]"} ${gate.id}: ${gate.title}`,
      ...gate.unresolvedScope.map(item => `    Remaining scope: ${item}`),
    ]) ?? [],
    ...report.blockers.map(item => `BLOCK ${item.id}: ${item.reason}`),
    `Optional operational gates: ${report.optionalOperationalGates?.scenarios?.length ?? 0} scenarios, ${report.optionalOperationalGates?.policies?.length ?? 0} policies and ${report.optionalOperationalGates?.decisions?.length ?? 0} decisions; not part of functional parity.`,
    "Final switch: separate human authorization; this evaluator never stops or switches services.",
  ].join("\n") + "\n";
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const usage = "Usage: node scripts/readiness.mjs [--json|--checklist] [--require-ready] [--evidence FILE --trusted-authorities FILE|-]";

function validateEvidence(bundle) {
  if (!object(bundle) || bundle.schema !== "pkm.readiness-evidence/v1" || !Array.isArray(bundle.evidence)
    || Object.keys(bundle).some(key => !["schema", "evidence"].includes(key))) {
    throw new Error("Evidence must be a pkm.readiness-evidence/v1 bundle containing only schema and evidence.");
  }
  for (const record of bundle.evidence) {
    const p = record?.payload;
    if (!object(record) || Object.keys(record).some(key => !["authorityId", "payload", "signature"].includes(key))
      || !nonempty(record.authorityId) || typeof record.signature !== "string"
      || !/^[A-Za-z0-9+/]{86}==$/.test(record.signature)
      || Buffer.from(record.signature, "base64").toString("base64") !== record.signature
      || !object(p) || p.schema !== "pkm.readiness-attestation/v1" || !nonempty(p.requirementId)
      || !["parity", "scenario", "catalog", "policy", "measurement", "decision"].includes(p.kind)
      || !nonempty(p.result) || !["actual-isolated", "legacy-oracle", "human"].includes(p.evidenceMode)
      || ![p.contractDigest, p.inventoryRevision, p.implementationDigest].every(validDigest)
      || !Array.isArray(p.scope) || !p.scope.length || !p.scope.every(nonempty)
      || !object(p.checks) || !Object.values(p.checks).every(value => typeof value === "boolean")
      || !object(p.observations) || !nonempty(p.observations.method)
      || !Array.isArray(p.artifacts) || !p.artifacts.length
      || p.artifacts.some(item => !object(item) || !safeArtifactPath(item.path) || !validDigest(item.sha256))) {
      throw new Error("Malformed readiness attestation in explicitly supplied evidence.");
    }
    const observations = p.observations;
    for (const field of ["policy", "decision", "catalog", "metrics"]) {
      if (field in observations && !object(observations[field])) {
        throw new Error(`Malformed readiness observation: ${field} must be an object.`);
      }
    }
    for (const [value, fields] of [
      [observations.policy, ["id", "status", "workload", "faultModel", "limitations", "faultModelClass"]],
      [observations.decision, ["rationale", "runbookReference", "outbound"]],
    ]) {
      if (value && fields.some(field => field in value && typeof value[field] !== "string")) {
        throw new Error("Malformed readiness policy/decision observation.");
      }
    }
    if (observations.policy && "thresholds" in observations.policy && !object(observations.policy.thresholds)) {
      throw new Error("Malformed readiness policy thresholds.");
    }
    const catalog = observations.catalog;
    if (catalog && (("pages" in catalog && (!Array.isArray(catalog.pages) || catalog.pages.some(page =>
      !object(page) || !Array.isArray(page.items) || page.items.some(item => !object(item)))))
      || ("described" in catalog && (!Array.isArray(catalog.described) || catalog.described.some(item => !object(item)))))) {
      throw new Error("Malformed readiness catalog observations.");
    }
  }
  return bundle.evidence;
}

function validateAuthorities(bundle) {
  if (!object(bundle) || bundle.schema !== "pkm.readiness-authorities/v1" || !Array.isArray(bundle.authorities)
    || Object.keys(bundle).some(key => !["schema", "authorities"].includes(key))) {
    throw new Error("Trust input must be a separate pkm.readiness-authorities/v1 public-key registry.");
  }
  const ids = new Set(), rolesByKey = new Map();
  for (const authority of bundle.authorities) {
    if (!object(authority) || Object.keys(authority).some(key => !["id", "roles", "publicKey"].includes(key))
      || !nonempty(authority.id) || ids.has(authority.id)
      || !Array.isArray(authority.roles) || authority.roles.length !== 1
      || !["human", "verifier"].includes(authority.roles[0])
      || typeof authority.publicKey !== "string" || !authority.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")) {
      throw new Error("Each enrolled authority needs a unique id, one human/verifier role and an Ed25519 public PEM key.");
    }
    const digest = sha(authorityKey(authority).export({ type: "spki", format: "der" }));
    if (rolesByKey.has(digest) && rolesByKey.get(digest) !== authority.roles[0]) {
      throw new Error("Human and independent verifier authorities must use distinct keys.");
    }
    ids.add(authority.id);
    rolesByKey.set(digest, authority.roles[0]);
  }
  return bundle.authorities;
}

async function operatorInputs(evidenceFile, authorityFile) {
  let trustText;
  if (authorityFile === "-") {
    // Explicit native operator channel, never a key extracted from a receipt.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    trustText = Buffer.concat(chunks).toString("utf8");
  } else {
    const [file, repo] = await Promise.all([realpath(resolve(authorityFile)), realpath(repository)]);
    const path = relative(repo, file);
    if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))) {
      throw new Error("Trusted authority registry must be outside the repository (including symlink targets), or supplied on operator stdin.");
    }
    trustText = await readFile(file, "utf8");
  }
  const trustedAuthorities = validateAuthorities(JSON.parse(trustText));
  const evidence = validateEvidence(JSON.parse(await readFile(resolve(evidenceFile), "utf8")));
  return { evidence, trustedAuthorities, strict: true };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = new Set(), files = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (flags.has(arg)) throw new Error(usage);
      flags.add(arg);
      if (["--evidence", "--trusted-authorities"].includes(arg)) {
        const value = args[++index];
        if (!value || value.startsWith("--") || (arg === "--evidence" && value === "-")) throw new Error(usage);
        files[arg] = value;
      } else if (!["--json", "--checklist", "--require-ready"].includes(arg)) throw new Error(usage);
    }
    if (Boolean(files["--evidence"]) !== Boolean(files["--trusted-authorities"])) throw new Error(usage);
    const inputs = files["--evidence"] ? await operatorInputs(files["--evidence"], files["--trusted-authorities"]) : {};
    const report = await inspectReadiness(inputs);
    process.stdout.write(flags.has("--checklist") ? formatReadinessChecklist(report) : JSON.stringify(report, null, 2) + "\n");
    if (flags.has("--require-ready") && !report.readyForCutoverReview) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Readiness input/inspection error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
