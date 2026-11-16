import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readinessDigest, readinessRequirements } from "../scripts/readiness.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const invoke = (script, args, trust) => spawnSync(process.execPath, [script, ...args], {
  input: trust === undefined ? undefined : typeof trust === "string" ? trust : JSON.stringify(trust),
  encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
});

const pinnedTestReports = new Set([
  "legacy-read-race.report.json",
  "legacy-regression-batch12.report.json",
  "legacy-regression-oracle.report.json",
]);

async function copyTestSources(source, destination, pinnedReports = false) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.filter(entry => entry.isFile() && !entry.name.startsWith(".")
    && (/\.(?:mjs|js|py|ts)$/.test(entry.name) || (pinnedReports && pinnedTestReports.has(entry.name))))
    .map(entry => cp(resolve(source, entry.name), resolve(destination, entry.name))));
}

test("readiness fixture copies test source files, not ephemeral files or directories", async t => {
  const directory = resolve(`.readiness-copy-${randomUUID()}`);
  const source = resolve(directory, "source"), destination = resolve(directory, "destination");
  await mkdir(resolve(source, ".markdown-changing"), { recursive: true });
  await mkdir(resolve(source, "chat-session-work-changing"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(resolve(source, "example.test.mjs"), "test source"),
    writeFile(resolve(source, "fixture.py"), "fixture"),
    writeFile(resolve(source, "session.sqlite"), "runtime"),
    writeFile(resolve(source, "qualification-report.json"), "{}"),
    writeFile(resolve(source, "legacy-read-race.report.json"), "{}"),
    writeFile(resolve(source, ".markdown-changing", "example.test.mjs"), "transient"),
    writeFile(resolve(source, "chat-session-work-changing", "example.test.mjs"), "transient"),
  ]);
  await copyTestSources(source, destination, true);
  assert.deepEqual((await readdir(destination)).sort(), ["example.test.mjs", "fixture.py", "legacy-read-race.report.json"]);
});

test("operator evidence CLI preserves signatures, exact scope, fingerprints, artifacts and separate roles", async t => {
  // Outside all fingerprinted source/test trees, but within the working directory.
  const directory = resolve(`.readiness-cli-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = resolve(directory, "repository");
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const repository = resolve(packageRoot, "legacy");
  const fixtureLegacy = resolve(fixture, "legacy");
  await mkdir(fixtureLegacy, { recursive: true });
  await Promise.all([
    ...["src", "resources", "package.json"].map(path => cp(resolve(repository, path), resolve(fixtureLegacy, path), { recursive: true })),
    ...["dist/knowledge", "dist/runtime"].map(path =>
      cp(resolve(repository, path), resolve(fixtureLegacy, path), { recursive: true })),
    ...["src", "scripts", "browser", "clients", "compat", "compute", "dist", "migration", "experimental",
      "package.json", "package-lock.json", "tsconfig.json"].map(path =>
      cp(resolve(packageRoot, path), resolve(fixture, path), { recursive: true })),
    copyTestSources(resolve(repository, "tests"), resolve(fixtureLegacy, "tests")),
    copyTestSources(resolve(packageRoot, "tests"), resolve(fixture, "tests"), true),
  ]);
  await symlink(resolve(packageRoot, "node_modules"), resolve(fixture, "node_modules"));
  const fixtureCli = resolve(fixture, "scripts/readiness.mjs");
  const run = (args, trust) => invoke(fixtureCli, args, trust);
  const evidenceFile = resolve(directory, "evidence.json");
  const trustFile = resolve(fixture, "authorities.json");
  const human = generateKeyPairSync("ed25519"), verifier = generateKeyPairSync("ed25519");
  const trust = {
    schema: "pkm.readiness-authorities/v1",
    authorities: [
      { id: "operator-human", roles: ["human"], publicKey: human.publicKey.export({ type: "spki", format: "pem" }) },
      { id: "independent-verifier", roles: ["verifier"], publicKey: verifier.publicKey.export({ type: "spki", format: "pem" }) },
    ],
  };
  const contract = JSON.parse(await readFile(resolve(fixture, "migration/readiness-contract.json"), "utf8"));
  const initial = run([]);
  assert.equal(initial.status, 0, initial.stderr);
  const report = JSON.parse(initial.stdout);
  const artifact = "migration/manifest.json";
  const artifactHash = createHash("sha256").update(await readFile(resolve(fixture, artifact))).digest("hex");
  const parity = readinessRequirements(contract).find(item => item.kind === "parity");
  const decision = readinessRequirements(contract).find(item => item.id === "decision:operator.scope-layouts-and-legacy-replacements");
  const makeRecord = (requirement, key, authorityId, change = {}) => {
    const payload = {
      schema: "pkm.readiness-attestation/v1", result: "qualified",
      requirementId: requirement.id, kind: requirement.kind, scope: requirement.scope,
      contractDigest: readinessDigest(contract), inventoryRevision: report.inventoryRevision,
      implementationDigest: report.implementationDigest,
      evidenceMode: requirement.kind === "decision" ? "human" : "legacy-oracle",
      checks: Object.fromEntries(requirement.checks.map(check => [check, true])),
      artifacts: [{ path: artifact, sha256: artifactHash }],
      observations: { method: "Synthetic CLI boundary fixture, not migration qualification",
        decision: { rationale: "Fixture role boundary", runbookReference: "fixture-only" } },
      ...change,
    };
    return { authorityId, payload, signature: sign(null, Buffer.from(JSON.stringify(canonical(payload))), key.privateKey).toString("base64") };
  };
  const submit = async (records, registry = trust, args = []) => {
    await writeFile(evidenceFile, JSON.stringify({ schema: "pkm.readiness-evidence/v1", evidence: records }));
    return run(["--evidence", evidenceFile, "--trusted-authorities", "-", ...args], registry);
  };
  const row = (result, id) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).checklist.find(item => item.id === id);
  };
  const fail = result => {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Readiness input\/inspection error:/);
  };

  await t.test("valid independently supplied inputs qualify only exact rows, never authorize cutover", async () => {
    const result = await submit([
      makeRecord(parity, verifier, "independent-verifier"),
      makeRecord(decision, human, "operator-human"),
    ]);
    assert.equal(row(result, parity.id).status, "qualified");
    assert.equal(row(result, decision.id).status, "qualified");
    const evaluated = JSON.parse(result.stdout);
    assert.equal(evaluated.readyForCutoverReview, false);
    assert.equal(evaluated.finalCutover.authorized, false);
    assert.equal(evaluated.finalCutover.automaticSwitch, false);
    const externalRegistry = resolve(directory, "independently-enrolled.json");
    await writeFile(externalRegistry, JSON.stringify(trust));
    const external = run(["--evidence", evidenceFile, "--trusted-authorities", externalRegistry]);
    assert.equal(row(external, parity.id).status, "qualified");
    assert.equal((await submit([], trust, ["--require-ready"])).status, 1);
  });

  await t.test("stale fingerprints, scope drift and actual artifact drift remain blockers", async () => {
    for (const [change, reason] of [
      [{ implementationDigest: readinessDigest("stale") }, "stale-evidence"],
      [{ inventoryRevision: readinessDigest("stale") }, "stale-evidence"],
      [{ contractDigest: readinessDigest("stale") }, "stale-evidence"],
      [{ scope: ["unmapped"] }, "exact-mapped-scope-mismatch"],
      [{ artifacts: [{ path: artifact, sha256: readinessDigest("other bytes") }] }, "artifact-bytes-not-qualified"],
      [{ artifacts: [{ path: "tests/nonexistent-readiness-artifact.txt", sha256: artifactHash }] }, "artifact-bytes-not-qualified"],
    ]) {
      assert.equal(row(await submit([makeRecord(parity, verifier, "independent-verifier", change)]), parity.id).blockingReason, reason);
    }
  });

  await t.test("receipt keys never enroll and human/verifier execution roles remain distinct", async () => {
    const untrusted = makeRecord(parity, verifier, "not-enrolled");
    assert.equal(row(await submit([untrusted]), parity.id).blockingReason, "authority-not-enrolled");
    assert.equal(row(await submit([makeRecord(parity, human, "operator-human")]), parity.id).blockingReason, "authority-not-enrolled");
    assert.equal(row(await submit([makeRecord(decision, verifier, "independent-verifier")]), decision.id).blockingReason, "authority-not-enrolled");
    const tampered = makeRecord(parity, verifier, "independent-verifier");
    tampered.payload.checks[parity.checks[0]] = false;
    assert.equal(row(await submit([tampered]), parity.id).blockingReason, "invalid-independent-signature");
    const embedded = { ...untrusted, publicKey: trust.authorities[1].publicKey };
    fail(await submit([embedded]));
    fail(await submit([], { ...trust, authorities: [
      trust.authorities[0], { ...trust.authorities[1], publicKey: trust.authorities[0].publicKey },
    ] }));
    fail(await submit([], { ...trust, authorities: [{ ...trust.authorities[0], roles: ["human", "verifier"] }] }));
    fail(await submit([], { ...trust, authorities: [trust.authorities[0], trust.authorities[0]] }));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    fail(await submit([], { ...trust, authorities: [{ ...trust.authorities[0], publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }) }] }));
    fail(await submit([], { ...trust, authorities: [{ ...trust.authorities[0], publicKey: human.privateKey.export({ type: "pkcs8", format: "pem" }) }] }));
  });

  await t.test("repository registries and their symlink aliases are not independently enrolled", async () => {
    for (const [index, path] of [trustFile, resolve(fixtureLegacy, "authorities.json")].entries()) {
      await writeFile(path, JSON.stringify(trust));
      fail(run(["--evidence", evidenceFile, "--trusted-authorities", path]));
      const alias = resolve(directory, `trust-alias-${index}.json`);
      await symlink(path, alias);
      fail(run(["--evidence", evidenceFile, "--trusted-authorities", alias]));
    }
  });

  await t.test("explicit missing, unreadable, malformed and ambiguous inputs exit visibly nonzero", async () => {
    fail(run(["--evidence", resolve(directory, "missing"), "--trusted-authorities", "-"], trust));
    fail(run(["--evidence", directory, "--trusted-authorities", "-"], trust));
    fail(run(["--evidence", evidenceFile, "--trusted-authorities", resolve(directory, "missing")]));
    fail(await submit([], "{"));
    fail(await submit([], { schema: "pkm.readiness-evidence/v1", evidence: [] }));
    await writeFile(evidenceFile, "{");
    fail(run(["--evidence", evidenceFile, "--trusted-authorities", "-"], trust));
    await writeFile(evidenceFile, JSON.stringify({ schema: "pkm.readiness-evidence/v1", evidence: [{}] }));
    fail(run(["--evidence", evidenceFile, "--trusted-authorities", "-"], trust));
    fail(await submit([makeRecord(decision, human, "operator-human", {
      observations: { method: "Malformed fixture", decision: "not an object" },
    })]));
    fail(await submit([makeRecord(decision, human, "operator-human", {
      observations: { method: "Malformed fixture", decision: { rationale: 123 } },
    })]));
    for (const args of [
      ["--evidence", evidenceFile], ["--trusted-authorities", "-"],
      ["--evidence"], ["--unknown"], ["--json", "--json"],
      ["--evidence", evidenceFile, "--trusted-authorities", "-", "--evidence", evidenceFile],
    ]) fail(run(args, trust));
  });
});
