"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createCatalog } = require("./catalog.cjs");
const { selectTests } = require("./profiles.cjs");
const { prerequisites } = require("./engine.cjs");
const { summarize } = require("./report.cjs");
const { main, parseArguments } = require("./run.cjs");

const repositoryRoot = path.resolve(__dirname, "../..");
const originalGates = [
  "tests/legacy-real-note-create-adoption.test.mjs",
  "tests/legacy-ui-recipe-metadata.test.mjs",
  "tests/legacy-ui-recipe-receipts.test.mjs",
  "tests/next-room-private-admission.test.mjs",
  "tests/selected-chat-live-control-conflict.test.mjs",
];
function entry(id, layer = "component", capabilities = []) {
  return { id, file: id, role: "test", language: "node", layer, domain: "platform", capabilities };
}
function fixtureCatalog() {
  return {
    fingerprint: "candidate-fixture", aliases: [],
    entries: [
      ...originalGates.map(id => entry(id)),
      entry("tests/regular-regression.test.mjs"),
      entry("tests/new-original-private-fixture.test.mjs"),
      entry("tests/legacy-ui-recipe-receipts-extra.test.mjs"),
      entry("tests/migration.test.mjs", "integration"),
      entry("tests/provenance-readonly.test.mjs", "integration"),
      entry("tests/next-room-private-admission-simulation.test.mjs", "integration"),
      entry("tests/controlled-browser.test.mjs", "browser", ["browser"]),
      entry("tests/native-qualification.test.mjs", "native", ["native"]),
      entry("tests/current-source-qualification.test.mjs", "qualification", ["qualification"]),
      { ...entry("tests/helper.mjs"), role: "fixture" },
    ],
  };
}

test("Linux candidate excludes only closed installed-original gate identities and retains every other layer and capability", () => {
  const catalog = fixtureCatalog();
  const plan = selectTests(catalog, parseArguments(["--profile", "linux-candidate"]));
  assert.deepEqual(plan.entries.map(item => item.id).sort(), catalog.entries
    .filter(item => item.role === "test" && !originalGates.includes(item.id)).map(item => item.id).sort());
  assert.deepEqual(plan.selectionPolicy.excluded.map(item => item.id).sort(), originalGates);
  for (const omitted of plan.selectionPolicy.excluded) {
    assert(omitted.requirements.length);
    assert(omitted.reason.includes("original") || omitted.reason.includes("4.0.22"));
  }
  assert.match(plan.selectionPolicy.scope, /not production/);
  assert.match(plan.selectionPolicy.scope, /Windows/);
  assert.match(prerequisites(plan.entries.find(item => item.layer === "native"), repositoryRoot, {}), /--admit-native/);
  assert.match(prerequisites(plan.entries.find(item => item.layer === "qualification"), repositoryRoot, {}), /--admit-qualification/);
  assert.throws(() => selectTests(catalog, { profile: "linux-candidate", files: ["tests/migration.test.mjs"] }), /not both/);
});

test("candidate marker is explicit per run while default CI and other profiles retain original selection and environment behavior", () => {
  const catalog = fixtureCatalog(), inherited = process.env.PKM_TEST_QUALIFICATION;
  const candidate = selectTests(catalog, { profile: "linux-candidate" });
  assert.deepEqual(candidate.environment, { PKM_TEST_QUALIFICATION: "linux-candidate" });
  assert.equal(process.env.PKM_TEST_QUALIFICATION, inherited);
  const expectedCi = catalog.entries.filter(item => item.role === "test"
    && ["framework", "component", "integration"].includes(item.layer)).map(item => item.id).sort();
  for (const options of [{}, { profile: "ci" }, { profile: "regression" }]) {
    const selected = selectTests(catalog, options);
    assert.deepEqual(selected.entries.map(item => item.id).sort(), expectedCi);
    assert.equal(selected.environment, undefined);
    assert.equal(selected.selectionPolicy, undefined);
  }
  candidate.selectionPolicy.excluded[0].requirements.push("MUTATED");
  assert(!selectTests(catalog, { profile: "linux-candidate" }).selectionPolicy.excluded[0].requirements.includes("MUTATED"));
  const summary = summarize(candidate, candidate.entries.map(item => ({ suite: item.id, outcome: "passed" })), 1);
  assert.deepEqual(summary.selectionPolicy, candidate.selectionPolicy);
  assert.match(summary.scope, /not production/);
});

test("checkout candidate includes migration/provenance, all controlled native and browser tests and the original-controlled Room simulation", () => {
  const catalog = createCatalog(repositoryRoot), candidate = selectTests(catalog, { profile: "linux-candidate" });
  const selected = new Set(candidate.entries.map(item => item.id));
  assert.deepEqual(catalog.entries.filter(item => item.role === "test" && !selected.has(item.id)).map(item => item.id).sort(), originalGates);
  for (const id of ["tests/migration.test.mjs", "tests/provenance-readonly.test.mjs",
    "tests/next-room-private-admission-simulation.test.mjs", "tests/native-todo-user-ui.test.mjs",
    "tests/native-todo-user-host.test.mjs", "tests/native-board-lifecycle-host.test.mjs",
    "tests/native-subscription-host-ipc.test.mjs", "tests/native-subscription-ui-controller.test.mjs"])
    assert(selected.has(id), id);
  assert(candidate.entries.some(item => item.layer === "browser"));
});

test("candidate list output discloses exact exclusions and requirements in both JSON and text", async t => {
  const output = [];
  t.mock.method(console, "log", value => output.push(value));
  await main(["--profile", "linux-candidate", "--list", "--json"]);
  const json = JSON.parse(output.shift());
  assert.equal(json.profile, "linux-candidate");
  assert.deepEqual(json.environment, { PKM_TEST_QUALIFICATION: "linux-candidate" });
  assert.deepEqual(json.selectionPolicy.excluded.map(item => item.id).sort(), originalGates);
  assert(json.entries.some(item => item.id === "tests/migration.test.mjs" && item.reference));
  await main(["--profile", "linux-candidate", "--list"]);
  for (const omitted of json.selectionPolicy.excluded)
    assert(output.includes(`EXCLUDED ${omitted.id}: ${omitted.reason} Requirements: ${omitted.requirements.join(", ")}`), omitted.id);
});

test("CLI forwards the candidate marker through the existing runner environment option only for the explicit profile", async t => {
  const supervised = require("./supervised.cjs"), filename = require.resolve("./run.cjs");
  const cached = require.cache[filename], inherited = process.env.PKM_TEST_QUALIFICATION, profiles = [];
  t.after(() => { require.cache[filename] = cached; });
  t.mock.method(console, "log", () => {});
  t.mock.method(supervised, "runSupervised", async (plan, options) => {
    profiles.push(plan.profile);
    assert.deepEqual(options.environment, plan.profile === "linux-candidate"
      ? { PKM_TEST_QUALIFICATION: "linux-candidate" } : undefined);
    assert.equal(process.env.PKM_TEST_QUALIFICATION, inherited);
    return { summary: { successful: true } };
  });
  delete require.cache[filename];
  const { main: execute } = require("./run.cjs");
  await execute(["--profile", "linux-candidate", "--json"]);
  await execute(["--profile", "ci", "--json"]);
  assert.deepEqual(profiles, ["linux-candidate", "ci"]);
});
