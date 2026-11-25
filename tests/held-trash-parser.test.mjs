import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  prepareInstalledHeldTrashParser, verifyInstalledHeldTrashParser, verifyInstalledHeldTrashNoteSchemaControl,
} from "../clients/vscode-host/installed-held-trash-parser.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the real isolated private framework.");
assert(process.env.PKM_TEST_PYTHON);
process.umask(0o077);
const pin = Object.freeze({
  vsixPath: "/home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-public-trash-candidate.vsix",
  vsixSha256: "e87602ed6ef34660c0af0c577ad33d5e9cd841b3a6b0d8e47a69763e20d71725",
  buildId: "6116952f74b1087cd364a21dbaad8908f7193245ae8bf6de7c239d0d0d0b63cf",
});
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function fixture(t) {
  const directory = resolve("tests", `.held-trash-parser-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const identity = await lstat(directory, { bigint: true });
  t.after(async () => {
    const stat = await lstat(directory, { bigint: true });
    assert.equal(stat.dev, identity.dev); assert.equal(stat.ino, identity.ino); assert.equal(stat.uid, identity.uid);
    await rm(directory, { recursive: true });
  });
  return { directory, heldOldTrashParser: pin, python: process.env.PKM_TEST_PYTHON };
}
function noteControl(directory) {
  const epoch = randomUUID(), brokerId = randomUUID(), root = join(directory, "schema-only-note-root");
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root, workspaceId: randomUUID(),
    planSha256: "a".repeat(64), profileSha256: "b".repeat(64), sourceCatalogSha256: "c".repeat(64),
    authorityId: `native-rpc:${brokerId}`, epoch, actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "d".repeat(64) };
  const session = { brokerId, activationId: epoch, epoch, identitySha256: "e".repeat(64),
    binding: { root, workspaceId: binding.workspaceId, planSha256: binding.planSha256,
      catalogSha256: binding.sourceCatalogSha256, profileSha256: binding.profileSha256,
      payloadBuildId: "f".repeat(64), hostEntrySha256: "e".repeat(64) } };
  const subject = { root, workspaceId: binding.workspaceId, custodyPlanSha256: binding.planSha256,
    catalogSha256: binding.sourceCatalogSha256, profileSha256: binding.profileSha256, actorId: "mcp:external",
    operationId: randomUUID(), canonicalArgumentsDigest: "a".repeat(64), privacySha256: "b".repeat(64),
    sourceOriginalSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    custodyPredecessorSha256: "c".repeat(64), transitionSha256: digest([]),
    historyBeforeSha256: null, historyAfterSha256: null, action: "list", operation: "knowledge.trash.list", selection: [] };
  const request = { schema: "pkm.original-native-trash-request/v1", phase: "execute", subject,
    nativeHostReceiptSha256: digest(binding), nativeEpoch: epoch };
  return { session, payload: { binding, defaultDecision: "deny", request, requestSha256: digest(request) } };
}
test("held Trash receiver requires explicit archive pins; missing option is unperformed, not a refusal pass", async t => {
  const args = await fixture(t);
  assert.equal(await prepareInstalledHeldTrashParser({ ...args, heldOldTrashParser: undefined }), undefined);
  await assert.rejects(prepareInstalledHeldTrashParser({ ...args, heldOldTrashParser: { ...pin, vsixSha256: "0".repeat(64) } }),
    { code: "HELD_TRASH_PARSER_ARCHIVE_CHANGED" });
  await assert.rejects(prepareInstalledHeldTrashParser({ ...args, heldOldTrashParser: { ...pin, vsixSha256: "missing" } }),
    { code: "HELD_TRASH_PARSER_EXACT_ARCHIVE_PIN_REQUIRED" });
  assert.deepEqual(await readdir(args.directory), []);
});
test("actual e876 sealed Note-v1 parser accepts only a schema control under closed permissions; forged v2 witness handles cannot qualify", {
  timeout: 90000,
}, async t => {
  const args = await fixture(t), handle = await prepareInstalledHeldTrashParser(args), control = noteControl(args.directory);
  assert.equal(handle.buildId, pin.buildId); assert.equal(handle.vsixSha256, pin.vsixSha256);
  const proof = await verifyInstalledHeldTrashNoteSchemaControl(handle, { noteV1Control: control });
  assert.equal(proof.compatibleNoteV1DtoAccepted, true); assert.equal(proof.noteControlSchemaOnly, true);
  assert.equal(proof.currentV2RefusalQualified, false); assert.deepEqual(proof.refused, []);
  assert.equal(proof.oldOwnerServingQualified, false); assert.equal(proof.oldNativeServiceDispatchQualified, false);
  assert.equal(proof.noFsWritesWorkersChildrenAddonsNetworkOrSqlite, true);
  assert(proof.heldImportClosure.some(row => row.path === "dist/original-native-trash-contracts.js"));
  assert(!proof.heldImportClosure.some(row => /storage|worker|native-runtime|original-mcp-root\.js/.test(row.path)));
  await assert.rejects(verifyInstalledHeldTrashParser({ ...handle }, {}), { code: "HELD_TRASH_PARSER_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledHeldTrashParser(handle, { sourceFixture: { passed: true }, noteV1Control: control }),
    { code: "INSTALLED_SKILL_PAPER_TRASH_ACTUAL_PREPARATION_REQUIRED" });
  const changed = structuredClone(control); changed.payload.defaultDecision = "approve";
  await assert.rejects(verifyInstalledHeldTrashNoteSchemaControl(handle, { noteV1Control: changed }), /ZodError/);
  await assert.rejects(lstat(join(args.directory, "schema-only-note-root")), { code: "ENOENT" });
});
test("held Trash exact dependency pins reject member drift before invoking the parser", { timeout: 90000 }, async t => {
  const args = await fixture(t), handle = await prepareInstalledHeldTrashParser(args);
  const path = join(args.directory, "held-old-trash-parser/dist/document-path.js");
  const bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from("\n// fixture-only drift\n")]), { mode: 0o600 });
  await assert.rejects(verifyInstalledHeldTrashNoteSchemaControl(handle, { noteV1Control: noteControl(args.directory) }), /closure changed/);
});
