import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  collectNativePublicMcpContractSourcePins, nativePublicMcpContractSources, verifyNativePublicMcpContracts,
} from "../scripts/verify-native-public-mcp-contracts.mjs";

const artifactPath = "src/native-public-mcp-contracts.ts";
const exportInstruction = /python scripts\/export-native-public-mcp-contracts\.py/;
const checkedSource = await readFile(artifactPath, "utf8");
const tree = ts.createSourceFile(artifactPath, checkedSource, ts.ScriptTarget.Latest, true);
const original = JSON.parse(tree.statements[0].declarationList.declarations[0].initializer.arguments[0].text);
const artifact = value => `const contracts: unknown = JSON.parse(${JSON.stringify(JSON.stringify(value))});\nexport default contracts;\n`;

async function fixture(t) {
  const root = resolve("tests", `.native-public-pins-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of nativePublicMcpContractSources) {
    const source = resolve(root, path);
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    await writeFile(source, `owned pin fixture: ${path}\n`, { mode: 0o600 });
  }
  const catalog = structuredClone(original);
  catalog.sourcePins = collectNativePublicMcpContractSourcePins(root);
  const destination = resolve(root, artifactPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, artifact(catalog), { mode: 0o600 });
  return { root, catalog, destination };
}

test("catalog build verification is Node-only and validates the real checked artifact without executing it", async t => {
  const command = execFileSync(process.execPath, ["scripts/verify-native-public-mcp-contracts.mjs"], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: "", PYTHON: "unavailable", PKM_TEST_PYTHON: "unavailable" },
  });
  const report = JSON.parse(command);
  assert.equal(report.sourceFiles, nativePublicMcpContractSources.length);
  assert.equal(report.operations, original.contracts.length);
  assert.equal(report.profiles, 5);
  const { root } = await fixture(t);
  assert.deepEqual(verifyNativePublicMcpContracts(root), report);
});

test("catalog pins reject changed sources and every unapproved path before reading source inputs", async t => {
  const { root, catalog, destination } = await fixture(t);
  const source = resolve(root, nativePublicMcpContractSources[0]);
  await writeFile(source, "source changed after export\n");
  assert.throws(() => verifyNativePublicMcpContracts(root), error =>
    /stale defining source/.test(error.message) && exportInstruction.test(error.message));
  await rm(source);
  for (const path of ["../outside.py", "/unapproved/absolute.py", "C:\\outside.py", "__proto__", "compat/unapproved.py"]) {
    const changed = structuredClone(catalog);
    delete changed.sourcePins[nativePublicMcpContractSources[0]];
    Object.defineProperty(changed.sourcePins, path, { enumerable: true, value: "a".repeat(64) });
    await writeFile(destination, artifact(changed));
    assert.throws(() => verifyNativePublicMcpContracts(root), error =>
      /exactly the approved relative defining-source paths/.test(error.message) && exportInstruction.test(error.message), path);
  }
  const changed = structuredClone(catalog);
  changed.sourcePins[nativePublicMcpContractSources[0]] = "not-a-sha256";
  await writeFile(destination, artifact(changed));
  assert.throws(() => verifyNativePublicMcpContracts(root), exportInstruction);
});

test("catalog verifier rejects executable TypeScript, unknown schemas and invalid input schemas with export guidance", async t => {
  const { root, catalog, destination } = await fixture(t);
  const payload = JSON.stringify(JSON.stringify(catalog));
  const marker = "__nativePublicCatalogMustNotExecute";
  delete globalThis[marker];
  for (const source of [
    `const contracts: unknown = JSON.parse((globalThis.${marker} = true, ${payload})); export default contracts;`,
    `const contracts: unknown = JSON.parse(\`${JSON.stringify(catalog)}\`); export default contracts;`,
    `${artifact(catalog)}globalThis.${marker} = true;`,
    `const contracts: unknown = JSON.parse(${payload}); export default {};`,
  ]) {
    await writeFile(destination, source);
    assert.throws(() => verifyNativePublicMcpContracts(root), exportInstruction);
    assert.equal(globalThis[marker], undefined);
  }
  for (const change of [
    value => { value.schema = "pkm.native-public-mcp-contracts/unknown"; },
    value => { value.unrecognizedField = true; },
    value => { value.contracts[0].inputSchema = "not-a-schema"; },
    value => { value.definitions[0].inputSchema = { type: "object" }; },
  ]) {
    const changed = structuredClone(catalog);
    change(changed);
    await writeFile(destination, artifact(changed));
    assert.throws(() => verifyNativePublicMcpContracts(root), exportInstruction);
  }
});

test("catalog pins require existing regular sources and reject symlinked ancestors and artifacts", async t => {
  const missing = await fixture(t);
  await rm(resolve(missing.root, nativePublicMcpContractSources[0]));
  assert.throws(() => verifyNativePublicMcpContracts(missing.root), exportInstruction);

  const linked = await fixture(t);
  const source = resolve(linked.root, nativePublicMcpContractSources[0]);
  await rm(source);
  await symlink(resolve(linked.root, nativePublicMcpContractSources[1]), source);
  assert.throws(() => verifyNativePublicMcpContracts(linked.root), /without symlink ancestors/);

  const ancestor = await fixture(t);
  await rename(resolve(ancestor.root, "compat"), resolve(ancestor.root, "compat-owned"));
  await symlink(resolve(ancestor.root, "compat-owned"), resolve(ancestor.root, "compat"), "dir");
  assert.throws(() => verifyNativePublicMcpContracts(ancestor.root), /without symlink ancestors/);

  const linkedArtifact = await fixture(t);
  const originalArtifact = `${linkedArtifact.destination}.owned`;
  await rename(linkedArtifact.destination, originalArtifact);
  await symlink(originalArtifact, linkedArtifact.destination);
  assert.throws(() => verifyNativePublicMcpContracts(linkedArtifact.root), /without symlink ancestors/);
});
