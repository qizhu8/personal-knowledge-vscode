import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativePrivateResourcePublicationFixture, verifyInstalledNativePrivateResourcePublication,
  verifyInstalledNativePrivateResourcePublicationB1, verifyInstalledNativePrivateResourcePublicationRestored,
} from "./installed-native-private-resource-publication.mjs";
import { prepareInstalledHeldPrivateResourceParser, verifyInstalledHeldPrivateResourceParser } from "./installed-held-private-resource-parser.mjs";
import { installedNativePrivateResourcePublicationUiProgram, startInstalledNativePrivateResourcePublicationUi } from "./installed-native-private-resource-publication-ui.mjs";
import { validatePrivateResourcePublicationSubject } from "../../dist/private-resource-publication-contracts.js";
import { privatePublicationFixtureBytes as bytes } from "../../tests/original-private-resource-publication-fixture.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real private framework.");
assert(process.env.PKM_LEGACY_VSIX, "PKM_LEGACY_VSIX is required; missing oracle evidence cannot be skipped.");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, policy = installedNativeKnowledgeMovePrivacyPolicy) {
  const parent = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(parent, `private-publication-${randomUUID()}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(value.root, name), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "Common Entry.\n", { mode: 0o600 });
  await writeFile(join(value.root, "skills/Base.md"), "Common Base.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}
test("private publication preparation rejects copied cold identity, independent-policy mismatch and presealed roots before original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} }), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativePrivateResourcePublicationFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativePrivateResourcePublicationFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativePrivateResourcePublicationFixture(args), { code: "INSTALLED_PRIVATE_PUBLICATION_PRESEAL_REQUIRED" });
});
test("pinned original private copy oracle preserves controls/referrers, proves unshared deletion difference and refuses fake installed/B1/B0 evidence", {
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const policy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativePrivateResourcePublicationFixture(args), oracle = join(componentFixture.directory, "original-private-resource-oracle");
  assert.equal(source.originalPrivateCopyObserved, true); assert.equal(source.intentionalPrivateAlwaysRetainPolicyDifference, true);
  assert.equal(source.passed, undefined); assert.equal(source.heldOldPrivateParserPrepared, false);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Common Base.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), policy);
  for (const [kind, area] of Object.entries(u.areas)) {
    for (const name of Object.keys(bytes)) assert.deepEqual(await readFile(join(componentFixture.root, area, "Private/_assets", name)), bytes[name]);
    await assert.rejects(readFile(join(oracle, area, "Private/_assets/b.BIN")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(oracle, area, "Private/Secret.md")), await readFile(join(componentFixture.root, area, "Private/Secret.md")));
    const moved = await readFile(join(oracle, area, `New/${kind === "skill" ? "Before" : "After"}.md`), "utf8");
    assert(!moved.includes("Private/_assets")); assert(moved.includes("../_assets/example.PNG"), "Original ignored code examples remain unchanged.");
  }
  const component = { fixture: componentFixture, root: componentFixture.root };
  await assert.rejects(verifyInstalledNativePrivateResourcePublication({ installed, component, sourceFixture: source }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourcePublication({ sourceFixture: { ...source } }),
    { code: "INSTALLED_PRIVATE_PUBLICATION_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourcePublicationB1(source, { retirement: { passed: true } }),
    { code: "INSTALLED_PRIVATE_PUBLICATION_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourcePublicationRestored(source, { retirement: {}, restored: {} }),
    { code: "INSTALLED_PRIVATE_PUBLICATION_VERIFIED_EFFECTS_REQUIRED" });
});
test("move-only contract rejects same-path publication; explicit held-private parser pins/handles and unsafe observer startup stay closed", async t => {
  // Pure schema rejection, not a publication decision, receipt, port or grant.
  const sha = "a".repeat(64), path = "Old/Before.md";
  assert.throws(() => validatePrivateResourcePublicationSubject({
    root: resolve("."), workspaceId: randomUUID(), custodyPlanSha256: sha, catalogSha256: sha, profileSha256: sha,
    actorId: "mcp:external", operationId: randomUUID(), operation: "knowledge.note.update",
    publicRequest: { tool: "update_note", version: 1, argumentsDigest: sha }, canonicalArgumentsDigest: sha,
    owner: { area: "notes", id: "knowledge_0123456789abcdef01234567", beforePath: path, afterPath: path, revision: 1, sha256: sha },
    resource: { sourcePath: "Private/_assets/a.PNG", sourceIdentity: "pure-schema-only", sha256: sha, size: 1,
      targetPath: "Old/Before.assets/aaaaaaaaaaaaaaaa.png" }, privacySha256: sha, preservePrivateSource: true, oneResourceOneOperation: true,
  }), { code: "PRIVATE_RESOURCE_PUBLICATION_SUBJECT_MISMATCH" });
  const value = await fixture(t), args = { directory: value.directory, python };
  assert.equal(await prepareInstalledHeldPrivateResourceParser(args), undefined);
  await assert.rejects(prepareInstalledHeldPrivateResourceParser({ ...args, heldOldPrivateParser: {} }), { code: "HELD_PRIVATE_PARSER_EXACT_PIN_REQUIRED" });
  const invalid = join(value.directory, "not-old.vsix"); await writeFile(invalid, "Not provenance.", { mode: 0o600 });
  await assert.rejects(prepareInstalledHeldPrivateResourceParser({ ...args, heldOldPrivateParser: { vsixPath: invalid, vsixSha256: "0".repeat(64) } }),
    { code: "HELD_PRIVATE_PARSER_ARCHIVE_CHANGED" });
  await assert.rejects(verifyInstalledHeldPrivateResourceParser({ kind: "pkm.held-private-resource-parser/v1" }, "{}", "{}"),
    { code: "HELD_PRIVATE_PARSER_ACTUAL_PREPARATION_REQUIRED" });
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<private-publication-ui>','exec')"],
    { input: installedNativePrivateResourcePublicationUiProgram, timeout: 10000 });
  await assert.rejects(startInstalledNativePrivateResourcePublicationUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_PRIVATE_PUBLICATION_PRIVATE_UI_REQUIRED" });
});
