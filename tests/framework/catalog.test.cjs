"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCatalog } = require("./catalog.cjs");
const { selectTests } = require("./profiles.cjs");
const { parseArguments } = require("./run.cjs");
const { encodeFailure, reference } = require("./report.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:core": "node --test tests/test-core.js",
  } }));
  fs.writeFileSync(path.join(root, "tests/test-core.js"), 'require("node:test")("core", () => {});');
  fs.writeFileSync(path.join(root, "tests/browser-helper.cjs"), 'module.exports = require("playwright");');
  fs.writeFileSync(path.join(root, "tests/test-browser.js"), 'require("./browser-helper.cjs"); require("node:test")("render", () => {});');
  fs.writeFileSync(path.join(root, "tests/test-windows.js"), 'const vm = require("node:vm"); const assert = require("node:assert/strict"); assert.equal(vm.runInNewContext("process.platform",{process:{platform:"win32"}}),"win32");');
  fs.writeFileSync(path.join(root, "tests/controller.py"), 'raise RuntimeError("inventory must not import fixtures")\n');
  fs.writeFileSync(path.join(root, "tests/test-python.py"), "import unittest\nclass Sample(unittest.TestCase):\n def test_example(self): self.assertEqual(1, 1)\n");
  return root;
}

test("inventory covers every visible source without executing Python; transitive browser dependencies do not turn VM Windows checks into native acceptance", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tests/extension.ts"), 'import * as vscode from "vscode"; export function activate() { return vscode.window; }');
  const catalog = createCatalog(root);
  assert.equal(catalog.files, 7);
  assert.equal(catalog.tests, 4);
  assert.equal(catalog.entries.find(entry => entry.id.endsWith("controller.py")).role, "fixture");
  assert.equal(catalog.entries.find(entry => entry.id.endsWith("test-browser.js")).layer, "browser");
  assert.equal(catalog.entries.find(entry => entry.id.endsWith("test-windows.js")).layer, "component");
  const actor = catalog.entries.find(entry => entry.id === "tests/extension.ts");
  assert.equal(actor.language, "typescript");
  assert.equal(actor.role, "host-actor");
  assert.deepEqual(actor.capabilities, ["native"]);
  assert.throws(() => selectTests(catalog, { files: [actor.id] }), /Select a catalogued test/);
  assert.deepEqual(catalog.aliases[0].members, ["tests/test-core.js"]);
  fs.appendFileSync(path.join(root, "tests/test-core.js"), "\n// changed");
  assert.notEqual(createCatalog(root).fingerprint, catalog.fingerprint);
});

test("selectors reject controllers, unknown profiles, empty matches and ambiguous combinations; repeated files run once", t => {
  const catalog = createCatalog(fixture(t));
  assert.equal(selectTests(catalog, { files: ["tests/test-core.js", "tests/test-core.js"] }).entries.length, 1);
  assert.throws(() => selectTests(catalog, { files: ["tests/controller.py"] }), /fixture|controller/);
  assert.throws(() => selectTests(catalog, { profile: "unknown" }), /Unknown profile/);
  assert.throws(() => selectTests(catalog, { domain: "absent" }), /no tests/);
  assert.throws(() => selectTests(catalog, { profile: "ci", files: ["tests/test-core.js"] }), /not both/);
  assert.throws(() => parseArguments(["--jobs", "0"]), /1-4/);
  assert.throws(() => parseArguments(["--timeout", "NaN"]), /1-3600/);
});

test("module-mock activation follows actual node:test imports and transitive helpers only", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tests/mock-helper.mjs"), [
    'import { mock as faultInjector } from "node:test";',
    'faultInjector.module("node:fs/promises", { namedExports: {} });',
  ].join("\n"));
  fs.writeFileSync(path.join(root, "tests/test-mock.mjs"), 'import "./mock-helper.mjs";');
  fs.writeFileSync(path.join(root, "tests/test-direct.mjs"),
    'import { mock } from "node:test"; mock.module("node:fs/promises", { namedExports: {} });');
  fs.writeFileSync(path.join(root, "tests/test-example.mjs"),
    'const example = \'mock.module("node:fs/promises")\'; const mock = {module() {}}; mock.module();');
  const selection = selectTests(createCatalog(root), {
    files: ["tests/test-mock.mjs", "tests/test-direct.mjs", "tests/test-example.mjs", "tests/test-core.js"],
  });
  for (const entry of selection.entries)
    assert.equal(entry.command.includes("--experimental-test-module-mocks"),
      ["tests/test-mock.mjs", "tests/test-direct.mjs"].includes(entry.id), entry.id);
});

test("active client regressions are catalogued with helper capabilities and source changes, not generated outputs", t => {
  const root = fixture(t);
  for (const client of ["vscode", "vscode-host"]) {
    const directory = path.join(root, "clients", client);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "client.test.mjs"),
      'import test from "node:test"; import "./helper.mjs"; test("client", () => {});');
    fs.writeFileSync(path.join(directory, "helper.mjs"), 'import "node:net";');
    for (const output of ["node_modules", "dist", "out", "artifacts", "next-runtime"]) {
      fs.mkdirSync(path.join(directory, output));
      fs.writeFileSync(path.join(directory, output, "unrelated.test.mjs"), "invalid generated source!");
    }
  }
  const catalog = createCatalog(root), ci = selectTests(catalog, { profile: "ci" });
  const expected = ["clients/vscode/client.test.mjs", "clients/vscode-host/client.test.mjs"];
  for (const id of expected) {
    const entry = ci.entries.find(item => item.id === id);
    assert(entry, id);
    assert.equal(entry.layer, "integration");
    assert(entry.capabilities.includes("process-io"));
    assert.equal(entry.fixtures.hostBuild, id.startsWith("clients/vscode-host/"));
  }
  assert(!catalog.entries.some(entry => /\/(?:node_modules|dist|out|artifacts|next-runtime)\//.test(entry.id)));
  fs.appendFileSync(path.join(root, "clients/vscode-host/helper.mjs"), "\n// changed");
  assert.notEqual(createCatalog(root).fingerprint, catalog.fingerprint);
});

test("host preparation follows transitive source dependencies through files and suites, not example text", t => {
  const root = fixture(t), directory = path.join(root, "clients/vscode-host");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "helper.mjs"), "export const host = true;");
  fs.writeFileSync(path.join(root, "tests/host-helper.mjs"), 'import "../clients/vscode-host/helper.mjs";');
  fs.writeFileSync(path.join(root, "tests/test-host.js"), 'require("./host-helper.mjs");');
  fs.writeFileSync(path.join(root, "tests/test-example.js"),
    'const example = \'import "../clients/vscode-host/helper.mjs";\';');
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:host": "node --test tests/test-host.js",
  } }));
  const catalog = createCatalog(root), { preparationCommand } = require("./fixtures.cjs");
  const host = selectTests(catalog, { files: ["tests/test-host.js"] }).entries[0];
  const suite = selectTests(catalog, { suites: ["test:host"] }).entries[0];
  for (const entry of [host, suite]) {
    assert.equal(entry.fixtures.hostBuild, true);
    assert.equal(entry.fixtures.compatBuild, true);
    assert(preparationCommand([entry]).includes("--host"));
    assert(preparationCommand([entry]).includes("--compat"));
  }
  const example = selectTests(catalog, { files: ["tests/test-example.js"] }).entries[0];
  assert.equal(example.fixtures.hostBuild, false);
  assert(!preparationCommand([example]).includes("--host"));
});

test("offline model fixtures stay in CI with a bounded model deadline and all shared resources", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tests/model.py"), "from sentence_transformers import SentenceTransformer\n");
  fs.writeFileSync(path.join(root, "tests/test-model.mjs"),
    'import {spawn} from "node:child_process"; import "./browser-helper.cjs"; spawn("python", ["model.py"]);');
  fs.writeFileSync(path.join(root, "tests/test-offline.mjs"),
    'import {spawn} from "node:child_process"; spawn("python", ["model.py"]);');
  const catalog = createCatalog(root), ci = selectTests(catalog, { profile: "ci" });
  const offline = ci.entries.find(entry => entry.id === "tests/test-offline.mjs");
  assert(offline);
  assert.equal(offline.timeoutMs, 600000);
  assert.deepEqual(offline.resources, ["model-runtime"]);
  const combined = selectTests(catalog, { files: ["tests/test-model.mjs"] }).entries[0];
  assert.deepEqual(combined.resources, ["browser-runtime", "model-runtime"]);
  assert.equal(ci.entries.find(entry => entry.id === "tests/test-core.js").timeoutMs, 120000);
});

test("Python helper environment outputs do not request RAM fixtures, while reads remain transitive inputs", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tests/output-helper.py"), [
    "import os",
    'os.environ["PKM_SUBSCRIPTION_TEST_RAM_ROOT"] = "/output-only"',
    'value = os.environ["PKM_FIXTURE_INPUT"]',
    'os.environ["PKM_MUTATED_INPUT"] += "-suffix"',
  ].join("\n"));
  fs.writeFileSync(path.join(root, "tests/test-output.mjs"),
    'import {spawn} from "node:child_process"; spawn("python", ["output-helper.py"]);');
  const entry = selectTests(createCatalog(root), { files: ["tests/test-output.mjs"] }).entries[0];
  assert.equal(entry.fixtures.subscriptionRam, false);
  assert.deepEqual(entry.evidence.environments, ["PKM_FIXTURE_INPUT", "PKM_MUTATED_INPUT"]);
});

test("stale wrapper paths and recursive npm suites fail catalog validation", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "test:bad": "node tests/test-missing.js" } }));
  assert.throws(() => createCatalog(root), /Stale test path/);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:a": "npm run test:b", "test:b": "npm run test:a",
  } }));
  assert.throws(() => createCatalog(root), /Cyclic/);
});

test("v5 source dependencies stay in CI while qualification preserves its original controller and provenance gates", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/verify.mjs"), 'throw Error("inventory must not execute qualification");');
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:core": "node --test tests/test-core.js", "test:qualification": "node scripts/verify.mjs",
  } }));
  fs.writeFileSync(path.join(root, "tests/source-helper.mjs"), 'import "../legacy/dist/knowledge/filestore.js";');
  fs.writeFileSync(path.join(root, "tests/test-source.js"),
    'require("./source-helper.mjs"); require("../clients/vscode/client.ts");');
  fs.writeFileSync(path.join(root, "tests/render.py"), 'from playwright.sync_api import sync_playwright\n');
  fs.writeFileSync(path.join(root, "tests/test-render.mjs"),
    'import {spawn} from "node:child_process"; spawn("python", ["render.py"]);');
  fs.writeFileSync(path.join(root, "tests/test-description.js"),
    'const example = \'import "../legacy/dist/example.js";\'; require("node:test")("description", () => {});');
  const catalog = createCatalog(root), ci = selectTests(catalog, { profile: "ci" });
  const source = ci.entries.find(entry => entry.id === "tests/test-source.js");
  assert(source.fixtures.compatBuild);
  assert(source.fixtures.clientBuild);
  assert(!ci.entries.some(entry => entry.id === "tests/test-render.mjs"));
  assert.equal(catalog.entries.find(entry => entry.id === "tests/test-render.mjs").layer, "browser");
  const { preparationCommand } = require("./fixtures.cjs");
  assert(preparationCommand([source]).includes("--compat"));
  assert(preparationCommand([source]).includes("--client"));
  const description = ci.entries.find(entry => entry.id === "tests/test-description.js");
  assert.equal(description.fixtures.compatBuild, false);
  assert(!preparationCommand([description]).includes("--compat"));
  const qualification = selectTests(catalog, { profile: "qualification" });
  assert.deepEqual(qualification.entries.map(entry => entry.id), ["test:qualification"]);
  assert.deepEqual(qualification.entries[0].command, ["npm", "run", "test:qualification"]);
  assert.equal(qualification.entries[0].ownsBuild, true);
  const { prerequisites } = require("./engine.cjs");
  assert.match(prerequisites(qualification.entries[0], root, {}), /--admit-qualification/);
  assert.equal(prerequisites(qualification.entries[0], root, { admitQualification: true }), null);
});

test("one complete failure report stays within 64 KiB while preserving every failed identity and outcome", () => {
  const results = Array.from({ length: 520 }, (_, index) => ({
    suite: `tests/test-${index}.js`, outcome: "failed", error: "failure",
    tapFailures: "\0".repeat(4096),
    stdout: "\0".repeat(4096), stderr: "\x1b".repeat(4096),
  }));
  const encoded = encodeFailure({ selected: results.length, successful: false }, results);
  assert(Buffer.byteLength(encoded) <= 64 * 1024);
  const report = JSON.parse(encoded);
  assert.deepEqual(report.taskReferences, results.map(result => reference(result.suite)));
  assert.equal(report.outcomes, "f".repeat(520));
  assert(report.omittedDetails > 0);
});
