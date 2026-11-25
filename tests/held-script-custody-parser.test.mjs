import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { prepareInstalledHeldScriptCustodyParser, verifyInstalledHeldScriptCustodyParser }
  from "../clients/vscode-host/installed-held-script-custody-parser.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing isolated framework.");
process.umask(0o077);
const staged = resolve("clients/vscode-host");
const load = name => import(pathToFileURL(join(staged, "next-runtime/server/dist", `${name}.js`)).href);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const heldOldScriptParser = Object.freeze({
  vsixPath: "/home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-public-trash-candidate.vsix",
  vsixSha256: "e87602ed6ef34660c0af0c577ad33d5e9cd841b3a6b0d8e47a69763e20d71725",
  buildId: "6116952f74b1087cd364a21dbaad8908f7193245ae8bf6de7c239d0d0d0b63cf",
});

test("actual held e876 sealed v1 Script custody schemas accept compatible DTOs and refuse genuine current v2 plan/journal in a closed Source-staged probe", { timeout: 120000 }, async t => {
  const recovery = await load("original-mcp-component-recovery"), current = await load("original-mcp-root");
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await recovery.createOriginalMcpColdComponentFixture(join(base, `native-cold-${randomUUID()}`));
  const directoryPin = await lstat(fixture.directory, { bigint: true });
  let fence;
  t.after(async () => {
    try { await fence?.release(); }
    finally {
      const stat = await lstat(fixture.directory, { bigint: true });
      assert.equal(stat.dev, directoryPin.dev); assert.equal(stat.ino, directoryPin.ino); assert.equal(stat.uid, directoryPin.uid);
      await rm(fixture.directory, { recursive: true });
    }
  });
  for (const path of ["notes", "skills", "papers", ".pkm", "scripts/Public", "scripts/Private"])
    await mkdir(join(fixture.root, path), { recursive: true, mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: fixture.directory,
    legacyVsix: process.env.PKM_LEGACY_VSIX, python: process.env.PKM_TEST_PYTHON });
  writer.run(fixture.root, `
    store.noteUpsert({slug:"Owner",title:"Owner",type:"general",content:"Owned closed-parser source fixture.\\n"});
    privacy.setTopLevelPrivacy("scripts","Private",true); return {configured:true};
  `);
  await writeFile(join(fixture.root, "scripts/Public/source.py"), "# heldscriptpublic7834\r\n", { mode: 0o600 });
  await writeFile(join(fixture.root, "scripts/Private/secret.py"), "# heldscriptprivate9812\r\n", { mode: 0o600 });
  await assert.rejects(prepareInstalledHeldScriptCustodyParser({ installed: staged,
    componentFixture: { ...fixture }, heldOldScriptParser, python: process.env.PKM_TEST_PYTHON }),
  { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" }, "The outside-checkout recovery location still requires the actual WeakMap fixture brand.");
  const held = await prepareInstalledHeldScriptCustodyParser({ installed: staged, componentFixture: fixture,
    heldOldScriptParser, python: process.env.PKM_TEST_PYTHON });
  assert(held, "An explicit archive probe must be performed, never skipped as pass.");
  const limits = { maxEntries: 1000, maxDepth: 32, maxBytes: 1048576, maxFileBytes: 1048576 };
  fence = await current.acquireOriginalMcpRootFence(fixture.root);
  const b0 = await recovery.captureOriginalMcpComponentB0(fixture, limits, fence);
  assert.equal(b0.sqliteChecks, 0, "No business SQLite/engine is created for this parser fixture.");
  const plan = await current.captureOriginalMcpCustody({ root: fixture.root, backup: join(fixture.directory, "custody"),
    operatorId: "held-script-parser-fixture", profileSha256: hash("explicit-source-staged-v2-script-parser-profile"), limits },
  { writerFence: fence });
  await current.prepareOriginalMcpRoot(plan, { writerFence: fence });
  const journal = JSON.parse(await readFile(join(fixture.root, ".pkm-next-original-mcp.json")));
  assert.equal(plan.schema, "pkm.original-mcp-custody/v2"); assert.equal(journal.schema, "pkm.original-mcp-root/v2");
  await assert.rejects(lstat(join(fixture.root, "core.sqlite")), { code: "ENOENT" }, "Current preparation does not open Owner/Storage.");
  const proof = await verifyInstalledHeldScriptCustodyParser(held, { currentPlan: plan });
  assert.equal(proof.explicitHeldArchiveProbe, true);
  assert.equal(proof.heldVsixSha256, heldOldScriptParser.vsixSha256);
  assert.equal(proof.heldPayloadBuildId, heldOldScriptParser.buildId);
  assert.equal(proof.actualCurrentV2PlanRefused, true); assert.equal(proof.actualCurrentV2JournalRefused, true);
  assert.equal(proof.compatibleV1PlanDtoAccepted, true); assert.equal(proof.compatibleV1JournalDtoAccepted, true);
  assert.equal(proof.oldOwnerServingQualified, false); assert.equal(proof.noFsWritesWorkersChildrenNetworkOrSqlite, true);
  t.diagnostic(`Actual old sealed parser proof=${JSON.stringify(proof)}; current fixture is Source-staged, not installed UI or v1 serving admission.`);
});
