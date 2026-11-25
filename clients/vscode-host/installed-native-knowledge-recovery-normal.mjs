import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import {
  installedNativeKnowledgeRecoveryStageNames, createInstalledNativeKnowledgeRecoveryStageProtocol,
  readInstalledNativeKnowledgeRecoveryObserverStatus, startInstalledNativeKnowledgeRecoveryUi,
} from "./installed-native-knowledge-recovery-ui.mjs";

const states = new WeakMap(), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const ownerPath = "notes/RecoveryPublic/Owned.md";
const originalRecovery = String.raw`
import hashlib,json,sys,zipfile
from pathlib import Path
archive=Path(sys.argv[1]).read_bytes()
if hashlib.sha256(archive).hexdigest()!="1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27":raise ValueError("Original22 required")
with zipfile.ZipFile(__import__("io").BytesIO(archive)) as z:
 name="extension/resources/knowledge_recovery.py"
 if z.namelist().count(name)!=1:raise ValueError("Missing/duplicate oracle")
 source=z.read(name)
 if hashlib.sha256(source).hexdigest()!="8e06b2ef4de7abc5be6ca855a8c148241b3a4a79e22593d1b4d976f5899788af":raise ValueError("Oracle changed")
namespace={"__name__":"sealed_original22_recovery"};exec(compile(source,name,"exec"),namespace)
tools={}
class Registry:
 def tool(self,**_):
  def register(f):tools[f.__name__]=f;return f
  return register
namespace["register_knowledge_recovery_tools"](Registry(),sys.argv[2])
before=tools["knowledge_recovery_preview"](sys.argv[3])
result=tools["knowledge_recovery_apply"](sys.argv[3],sys.argv[4])
after=tools["knowledge_recovery_preview"](sys.argv[3])
print(json.dumps({"before":before,"result":result,"after":after}))
`;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function state(value) {
  const found = states.get(value);
  if (!found) fail("INSTALLED_RECOVERY_ACTUAL_PREPARATION_REQUIRED");
  return found;
}
function verified(value) {
  const s = state(value);
  if (s.phase !== "verified") fail("INSTALLED_RECOVERY_VERIFIED_PHASE_REQUIRED");
  return s;
}
async function absent(path) {
  await assert.rejects(lstat(path), error => error.code === "ENOENT");
}
export async function prepareInstalledNativeKnowledgeRecovery({ installed, componentFixture, legacyVsix, python }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_RECOVERY_ALREADY_PREPARED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_RECOVERY_EXPLICIT_PYTHON_REQUIRED");
  await u.privateDirectory(componentFixture.root, "INSTALLED_RECOVERY_PRIVATE_ROOT_REQUIRED");
  for (const name of ["b0", "custody"]) await absent(join(componentFixture.directory, name));
  for (const name of ["core.sqlite", ".pkm-next-original-mcp.json"]) await absent(join(componentFixture.root, name));
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacy = await readFile(privacyPath);
  const privacyStat = await lstat(privacyPath);
  assert(privacyStat.isFile() && !privacyStat.isSymbolicLink() && privacyStat.nlink === 1
    && privacyStat.uid === process.getuid() && !(privacyStat.mode & 0o077));
  assert.deepEqual(JSON.parse(privacy), installedNativeKnowledgeMovePrivacyPolicy,
    "Parent must independently configure exact PUBLIC/Private policy before the Original seed.");
  for (const area of ["notes", "skills", "papers"]) {
    await mkdir(join(componentFixture.root, area), { recursive: true, mode: 0o700 });
    await absent(join(componentFixture.root, area, "Private"));
  }
  await absent(join(componentFixture.root, "notes", "RecoveryPublic"));
  await mkdir(join(componentFixture.root, "notes", "RecoveryPublic"), { mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  const record = writer.run(componentFixture.root, `
    process.umask(0o022);
    store.noteUpsert({slug:"RecoveryPublic/Owned",title:"Owned",category:"RecoveryPublic",
      content:"Sealed Original registered PUBLIC asset-free recovery bytes.\\n"});
    return store.noteGet("RecoveryPublic/Owned");
  `);
  const bytes = await readFile(join(componentFixture.root, ownerPath));
  assert.deepEqual(await readFile(privacyPath), privacy);
  assert.equal((await lstat(join(componentFixture.root, ownerPath))).mode & 0o777, 0o644,
    "Mode must originate from actual pre-B0 Original publication, not a post-seal chmod.");
  const evidence = join(componentFixture.directory, "recovery-evidence");
  await mkdir(join(evidence, "blobs"), { recursive: true, mode: 0o700 });
  const planBytes = Buffer.from(JSON.stringify({
    schema: "pkm.knowledge-recovery/v1", knowledgeRoot: componentFixture.root,
    files: [{ path: ownerPath, sha256: hash(bytes), mode: "100644" }],
  }, null, 2));
  await writeFile(join(evidence, "plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(evidence, "blobs", hash(bytes)), bytes, { flag: "wx", mode: 0o600 });
  const oracle = join(componentFixture.directory, "recovery-original22-oracle");
  await cp(componentFixture.root, oracle, { recursive: true, force: false, errorOnExist: true });
  const oracleEvidence = join(componentFixture.directory, "recovery-original22-evidence");
  await cp(evidence, oracleEvidence, { recursive: true, force: false, errorOnExist: true });
  const oraclePlan = Buffer.from(JSON.stringify({
    schema: "pkm.knowledge-recovery/v1", knowledgeRoot: oracle,
    files: [{ path: ownerPath, sha256: hash(bytes), mode: "100644" }],
  }));
  await writeFile(join(oracleEvidence, "plan.json"), oraclePlan);
  await unlink(join(oracle, ownerPath));
  const oracleResults = JSON.parse(execFileSync(python, ["-I", "-B", "-c", originalRecovery,
    legacyVsix, oracle, oracleEvidence, hash(oraclePlan)], {
    cwd: componentFixture.directory, encoding: "utf8", timeout: 30_000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, HOME: join(componentFixture.directory, "home"),
      TMPDIR: join(componentFixture.directory, "scratch"), TMP: join(componentFixture.directory, "scratch"),
      TEMP: join(componentFixture.directory, "scratch"), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
  }));
  assert.deepEqual(await readFile(join(oracle, ownerPath)), bytes);
  assert.equal((await lstat(join(oracle, ownerPath))).mode & 0o777, 0o644);
  const value = Object.freeze({ kind: "pkm.installed-recovery-normal-fixture/v1", root: componentFixture.root,
    evidence, planSha256: hash(planBytes), ownerPath, sourceOriginalSha256: writer.originalPackageSha256 });
  const baseline = await image(componentFixture.root);
  const entry = { installed, componentFixture, bytes, record, value, expected: oracleResults.result,
    previews: { before: oracleResults.before, after: oracleResults.after }, privacy, baseline,
    phase: "prepared", beforeIndex: undefined };
  states.set(value, entry); states.set(componentFixture, entry); return value;
}
/** Only the actual private disposable component can simulate loss; never native Trash or a user Root. */
export async function armInstalledNativeKnowledgeRecoveryLoss(value, component) {
  const s = state(value);
  assert.equal(s.phase, "prepared"); assert.equal(component.fixture, s.componentFixture);
  await (await load(s.installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(s.componentFixture);
  (await load(s.installed, "storage")).assertStorage(component.storage);
  await component.storage.withWorkspaceExclusive(async () => {
    const db = component.storage.connectNative();
    try {
      const index = db.prepare("SELECT id,title,revision,deleted,sha256,path,area FROM documents WHERE area='notes' AND path='RecoveryPublic/Owned.md'").get();
      assert(index); assert.equal(index.sha256, hash(s.bytes)); assert.equal(index.revision, s.record.revision);
      s.beforeIndex = { ...index };
      s.preludeKnowledge = await image(value.root, true);
      s.protectedFiles = (await u.files(value.root, true)).filter(file => file.path !== ownerPath);
      assert.deepEqual(await readFile(join(value.root, ownerPath)), s.bytes);
      const before = await lstat(join(value.root, ownerPath)); assert.equal(before.nlink, 1);
      assert.equal(before.mode & 0o777, 0o644);
      for (const area of ["notes", "skills", "papers"]) await absent(join(value.root, area, "Private"));
      await unlink(join(value.root, ownerPath));
      assert.deepEqual({ ...db.prepare("SELECT id,title,revision,deleted,sha256,path,area FROM documents WHERE id=?").get(index.id) }, s.beforeIndex);
    } finally { db.close(); }
  });
  s.phase = "lost";
}
export function installedNativeKnowledgeRecoveryStages(value) {
  const s = state(value); assert.equal(s.phase, "lost");
  const args = { evidence_directory: value.evidence };
  return Object.freeze([
    { stage: "recovery-deny-source", tool: "knowledge_recovery_preview", arguments: args, sourceChoice: "Deny", refusal: true },
    { stage: "recovery-preview", tool: "knowledge_recovery_preview", arguments: args, sourceChoice: "Read selected evidence only", writes: 0 },
    { stage: "recovery-deny-repair", tool: "knowledge_recovery_apply", publicChoice: "Approve this request",
      arguments: { ...args, approved_plan_sha256: value.planSha256 }, sourceChoice: "Read selected evidence only", repairChoice: "Deny", refusal: true },
    { stage: "recovery-wrong-hash", tool: "knowledge_recovery_apply", publicChoice: "Approve this request",
      arguments: { ...args, approved_plan_sha256: "0".repeat(64) }, sourceChoice: "Read selected evidence only", refusal: true },
    { stage: "recovery-apply", tool: "knowledge_recovery_apply", publicChoice: "Approve this request",
      arguments: { ...args, approved_plan_sha256: value.planSha256 }, sourceChoice: "Read selected evidence only",
      repairChoice: "Repair this exact missing owner", restore: true },
    { stage: "recovery-after-preview", tool: "knowledge_recovery_preview", arguments: args, sourceChoice: "Read selected evidence only", writes: 0 },
    { stage: "recovery-occupied", tool: "knowledge_recovery_apply", publicChoice: "Approve this request",
      arguments: { ...args, approved_plan_sha256: value.planSha256 }, sourceChoice: "Read selected evidence only", refusal: true },
  ].map(step => Object.freeze({ ...step, evidencePicker: value.evidence })));
}
export async function assertInstalledNativeKnowledgeRecoverySuccess(value, component, actual) {
  const s = state(value); assert.equal(s.phase, "lost"); assert.equal(component.fixture, s.componentFixture);
  const { report, ...result } = actual, { report: _oracleReport, ...expected } = s.expected;
  assert.deepEqual(result, expected);
  assert.equal(report.startsWith(`${value.evidence}/result-`), true);
  assert.deepEqual(await readFile(join(value.root, ownerPath)), s.bytes);
  assert.equal((await lstat(join(value.root, ownerPath))).mode & 0o777, 0o644);
  const audit = JSON.parse(await readFile(report, "utf8"));
  assert.equal(audit.schema, "pkm.knowledge-recovery-result/v1"); assert.equal(audit.knowledge_root, value.root);
  assert.equal(audit.plan_sha256, value.planSha256); assert.deepEqual(audit.restored, [ownerPath]);
  assert.deepEqual(audit.identical, []); assert.deepEqual(audit.preserved_existing, []);
  assert(Number.isFinite(Date.parse(audit.started_at)) && Number.isFinite(Date.parse(audit.completed_at)));
  const auditStat = await lstat(report);
  assert(auditStat.isFile() && !auditStat.isSymbolicLink() && auditStat.nlink === 1 && auditStat.uid === process.getuid());
  assert.equal(auditStat.mode & 0o777, 0o600);
  const db = component.storage.connectNative();
  let commit, receipt;
  try {
    assert.deepEqual({ ...db.prepare("SELECT id,title,revision,deleted,sha256,path,area FROM documents WHERE id=?").get(s.beforeIndex.id) }, s.beforeIndex);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM original_native_recovery_intents").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM original_native_recovery_commits").get().n, 1);
    (await load(s.installed, "original-knowledge-recovery-state")).verifyOriginalRecoveryState(db, value.root);
    commit = { ...db.prepare("SELECT * FROM original_native_recovery_commits").get() };
    const body = JSON.parse(commit.payload);
    receipt = { ...db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(commit.operation_id) };
    assert.match(commit.operation_id, /^[a-f0-9-]{36}$/);
    assert.equal(commit.workspace_id, component.workspaceId);
    assert.equal(commit.predecessor_sha256, component.custody.planSha256);
    assert.equal(receipt.operation_id, body.plan.operationId);
    assert.equal(receipt.operation, "knowledge.recovery.owner"); assert.equal(receipt.actor_id, "mcp:external");
    assert.equal(receipt.fingerprint, body.plan.repairPlanSha256);
    assert.deepEqual(JSON.parse(receipt.result), actual); assert.deepEqual(body.result, actual);
    assert.deepEqual(body.indexBefore, s.beforeIndex); assert.deepEqual(body.indexAfter, s.beforeIndex);
    assert.equal(body.plan.owner.id, s.beforeIndex.id); assert.equal(body.plan.owner.revision, s.beforeIndex.revision);
    assert.equal(body.plan.owner.sha256, hash(s.bytes)); assert.equal(body.plan.owner.mode, "100644");
    const published = await lstat(join(value.root, ownerPath), { bigint: true });
    assert.equal(body.stage.identity.inode, String(published.ino));
    assert.equal(body.successor.physicalIdentity.inode, String(published.ino));
    assert.equal(body.successor.physicalIdentity.device, String(published.dev));
  } finally { db.close(); }
  s.commit = commit; s.receipt = receipt; s.phase = "applied";
  return { actual, originalExpectedCounts: expected, rawSha256: hash(s.bytes), indexUnchanged: true, mode: 0o644,
    oneCustodyReceipt: true, operationId: receipt.operation_id, operation: receipt.operation, actorId: receipt.actor_id,
    fingerprint: receipt.fingerprint, resultSha256: hash(receipt.result), custodyReceiptSha256: commit.digest,
    scope: "one registered PUBLIC baseline owner normal repair only", fullRecovery: false, full151: false };
}

async function image(root, knowledgeOnly = false) {
  const rows = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(root, path));
      assert(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.isDirectory() || stat.isFile()));
      assert(!(stat.mode & 0o7002));
      if (stat.isFile()) assert(stat.nlink === 1 && stat.size <= 16_777_216);
      rows.push({ path, directory: stat.isDirectory(), mode: stat.mode & 0o777,
        size: stat.isDirectory() ? 0 : stat.size, sha256: stat.isDirectory() ? null : hash(await readFile(join(root, path))) });
      if (stat.isDirectory()) await walk(join(root, path), path);
    }
  }
  if (knowledgeOnly) {
    for (const area of ["notes", "papers", "skills"]) {
      const stat = await lstat(join(root, area));
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o7002));
      rows.push({ path: area, directory: true, mode: stat.mode & 0o777, size: 0, sha256: null });
      await walk(join(root, area), area);
    }
  } else await walk(root, "");
  return rows;
}
async function preservation(s, root) {
  assert(s.protectedFiles, "Prelude controls must be captured from actual live state, not stale pre-B0 Entry bytes.");
  for (const file of s.protectedFiles) {
    assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
    const stat = await lstat(join(root, file.path));
    assert.equal(stat.mode & 0o777, Number(file.identity.split(":")[2]) & 0o777);
  }
  for (const row of s.baseline.filter(row => !["notes", "papers", "skills"].includes(row.path.split("/")[0]))) {
    const stat = await lstat(join(root, row.path));
    assert.equal(stat.isDirectory(), row.directory); assert.equal(stat.mode & 0o777, row.mode);
    if (!row.directory) assert.equal(hash(await readFile(join(root, row.path))), row.sha256);
  }
}
function journal(component) {
  const db = component.storage.connectNative();
  try {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      assert.match(name, /^[a-zA-Z0-9_]+$/);
      if (["native_runtime_owner", "original_mcp_native_host_admissions"].includes(name)) continue;
      tables[name] = db.prepare(`SELECT * FROM "${name}"`).all().map(row => ({ ...row }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    const admissions = db.prepare("SELECT * FROM original_mcp_native_host_admissions ORDER BY receipt_sha256")
      .all().map(row => ({ ...row }));
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row }));
    return { tables, admissions, schema };
  } finally { db.close(); }
}
/** Schema comparison only: the caller must first verify the actual recovery state and custody. */
export function assertInstalledNativeKnowledgeRecoverySchemaPreserved(before, after, recoveryDDL) {
  const oracle = new DatabaseSync(":memory:");
  let expected;
  try {
    oracle.exec(recoveryDDL);
    expected = oracle.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row }));
  } finally { oracle.close(); }
  const tables = new Set(["original_native_recovery_intents", "original_native_recovery_commits"]);
  assert(expected.length && expected.every(row => tables.has(row.tbl_name)), "Only the exact two-table Recovery DDL is comparable.");
  const domain = rows => rows.filter(row => row.name.startsWith("original_native_recovery_") || tables.has(row.tbl_name));
  const prior = domain(before), current = domain(after);
  if (prior.length) assert.deepEqual(prior, expected, "Existing Recovery schema must be the exact declared domain.");
  assert.deepEqual(current, expected, "Recovery objects, including automatic indexes, must match the exact declared DDL.");
  const same = (a, b) => a.type === b.type && a.name === b.name && a.tbl_name === b.tbl_name && a.sql === b.sql;
  const controls = rows => rows.filter(row => !expected.some(known => same(row, known)));
  assert.deepEqual(controls(after), controls(before), "Every non-Recovery schema object/index must remain unchanged.");
}
async function preservedJournal(before, after, host, digest, repair, component, recoveryState) {
  if (repair) {
    const db = component.storage.connectNative();
    try { recoveryState.verifyOriginalRecoveryState(db, component.root); } finally { db.close(); }
    assertInstalledNativeKnowledgeRecoverySchemaPreserved(before.schema, after.schema, recoveryState.ORIGINAL_RECOVERY_PHASE1_DDL);
  } else assert.deepEqual(after.schema, before.schema);
  for (const row of before.admissions) assert.deepEqual(after.admissions.find(item => item.receipt_sha256 === row.receipt_sha256), row);
  for (const row of after.admissions.filter(row => !before.admissions.some(item => item.receipt_sha256 === row.receipt_sha256))) {
    const payload = JSON.parse(row.payload), { receiptSha256, ...body } = payload;
    assert.equal(receiptSha256, digest(body)); assert.equal(row.receipt_sha256, receiptSha256);
    assert.deepEqual(payload, host.receipt, "Only an actual current native-host admission may be added, never a success receipt.");
  }
  const ignored = repair ? ["receipts", "original_native_recovery_intents", "original_native_recovery_commits"] : [];
  const filtered = tables => Object.fromEntries(Object.entries(tables).filter(([name]) => !ignored.includes(name)));
  assert.deepEqual(filtered(after.tables), filtered(before.tables), "Every non-recovery table/index/receipt must remain unchanged.");
  if (repair) {
    const old = before.tables.receipts ?? [], added = after.tables.receipts.filter(row => !old.some(item => item.operation_id === row.operation_id));
    for (const row of old) assert.deepEqual(after.tables.receipts.find(item => item.operation_id === row.operation_id), row);
    assert.equal(added.length, 1); assert.equal(added[0].operation, "knowledge.recovery.owner");
    assert.deepEqual(after.tables.original_native_recovery_intents, []);
    assert.equal(after.tables.original_native_recovery_commits.length, 1);
  }
}
function valueOf(response) {
  assert(response && response.isError !== true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
function preview(value, original, sourceFixture) {
  const { knowledge_root: _root, plan_sha256: _plan, ...expected } = original;
  assert.deepEqual(value, { ...expected, knowledge_root: sourceFixture.root, plan_sha256: sourceFixture.planSha256 });
}
function identity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid), mode: Number(stat.mode & 0o777n),
    links: Number(stat.nlink), size: Number(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}

/** Parent owns bootstrap/common prelude, component lifetime, full editor stop and retirement. */
export async function verifyInstalledNativeKnowledgeRecovery({ root, installed, component, sourceFixture, payloadBuildId,
  python, env, port, timeoutMs = 120000 }) {
  const s = state(sourceFixture);
  assert.equal(s.phase, "prepared");
  if (s.installed !== installed || component.fixture !== s.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_RECOVERY_SAME_COMPONENT_REQUIRED");
  const { host, full } = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: s.componentFixture, payloadBuildId });
  assert.equal(full.runtime.services.modelProvider, undefined); assert.equal(host.nativeChat, undefined);
  if (!(await load(installed, "original-knowledge-recovery-native")).getOriginalRecoveryPhase1Port(component.storage, host))
    fail("INSTALLED_RECOVERY_GENUINE_SOURCE_REPAIR_PORT_REQUIRED");
  const catalog = (await load(installed, "native-public-original-mcp-contracts")).originalPublicMcpContracts();
  assert.equal(catalog.provenance.metadataSha256, host.receipt.sourceCatalogSha256);
  const publicContracts = ["knowledge_recovery_preview", "knowledge_recovery_apply"].map(tool => {
    const contract = catalog.contracts.find(row => row.transportName === tool);
    assert(contract); assert.equal(contract.id, `mcp.tool.${tool}`); assert.equal(contract.version, 1);
    assert.equal(contract.readOnly, tool === "knowledge_recovery_preview");
    return { tool, operation: contract.id, version: contract.version, readOnly: contract.readOnly };
  });
  const binding = { root: component.root, workspaceId: component.workspaceId, custodyPlanSha256: component.custody.planSha256,
    catalogSha256: host.receipt.sourceCatalogSha256, profileSha256: host.receipt.profileSha256,
    privacySha256: component.custody.privacySha256, epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const contracts = await load(installed, "original-knowledge-recovery-contracts"), digest = contracts.originalRecoveryDigest;
  const custody = await load(installed, "original-mcp-root");
  const custodyReader = await custody.openOriginalMcpCustodyReader(component.custody);
  let custodyRow;
  try { custodyRow = { ...custodyReader.entry(ownerPath) }; custodyReader.assertCurrent(); } finally { custodyReader.close(); }
  await armInstalledNativeKnowledgeRecoveryLoss(sourceFixture, component);
  const stages = installedNativeKnowledgeRecoveryStages(sourceFixture);
  assert.deepEqual(stages.map(row => row.stage), installedNativeKnowledgeRecoveryStageNames);
  const registration = (await load(installed, "original-knowledge-recovery-state")).originalRecoveryRegistrationDigest(
    component.custody.planSha256, component.custody.inventorySha256, custodyRow, s.beforeIndex);
  const expectedOwner = { area: "notes", id: s.beforeIndex.id, knowledgeId: s.beforeIndex.id,
    path: "RecoveryPublic/Owned.md", revision: s.beforeIndex.revision, sha256: hash(s.bytes), bytes: s.bytes.length,
    mode: "100644", registrationReceiptSha256: registration, custodyPredecessorSha256: component.custody.planSha256,
    indexRowSha256: digest(s.beforeIndex), privacy: "public", deleted: false, documentKind: "note", assets: [], referrers: [] };
  const evidenceFiles = [{ path: ownerPath, sha256: hash(s.bytes), mode: "100644",
    identity: identity(await lstat(join(sourceFixture.evidence, "blobs", hash(s.bytes)), { bigint: true })) }];
  s.b0Sha256 = component.b0.sha256;
  const runId = randomUUID(), abort = new AbortController(), lease = { ...component.owner.workspaceLease() };
  await writeFile(join(root, "native-knowledge-recovery-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-knowledge-recovery-ui/v1", runId, binding, publicContracts, stages,
    evidence: sourceFixture.evidence, planSha256: sourceFixture.planSha256, owner: expectedOwner, evidenceFiles,
  }), { mode: 0o600, flag: "wx" });
  let ui, protocol;
  const outcomes = [];
  try {
    ui = await startInstalledNativeKnowledgeRecoveryUi({ root, python, env, port, runId, timeoutMs });
    void ui.done.catch(error => abort.abort(error));
    const check = async () => {
      if (ui.error) throw ui.error;
      if ((await readInstalledNativeKnowledgeRecoveryObserverStatus(root, runId)).failed) {
        const failure = Object.assign(new Error("INSTALLED_RECOVERY_OBSERVER_FAILED"), { code: "INSTALLED_RECOVERY_OBSERVER_FAILED" });
        abort.abort(failure); throw failure;
      }
      abort.signal.throwIfAborted(); host.assertCurrent(); component.storage.assertWorkspaceLease();
      assert.deepEqual({ ...component.owner.workspaceLease() }, lease);
      assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
      await preservation(s, component.root);
    };
    protocol = await createInstalledNativeKnowledgeRecoveryStageProtocol({ root, runId, timeoutMs,
      stages: stages.map(row => row.stage), check });
    await ui.ready; await check();
    let actual;
    for (const step of stages) {
      const sourceIdentity = identity(await lstat(sourceFixture.evidence, { bigint: true }));
      await writeFile(join(root, `native-knowledge-recovery-ui-source-${step.stage}.json`), JSON.stringify({
        runId, stage: step.stage, directoryIdentity: sourceIdentity,
      }), { mode: 0o600, flag: "wx" });
      const beforeFiles = await u.files(component.root, true), beforeImage = await image(component.root, true),
        beforeEvidence = await u.files(sourceFixture.evidence), beforeJournal = journal(component);
      await protocol.begin(step.stage);
      let response, failure;
      try { response = await component.invoke(step.tool, step.arguments, abort.signal); } catch (error) { failure = error; }
      if (step.refusal) {
        const refused = failure ?? (response?.isError ? response.structuredContent ?? response : undefined);
        assert(refused, "Refusal must not be a success-like result; never retry a failed durable Root.");
        const text = `${refused.code ?? ""} ${refused.message ?? ""} ${JSON.stringify(response ?? null)}`;
        assert.match(text, step.stage === "recovery-deny-source" ? /RECOVERY_NATIVE_SOURCE_DENIED/
          : step.stage === "recovery-deny-repair" ? /RECOVERY_NATIVE_REPAIR_DENIED/
          : step.stage === "recovery-wrong-hash" ? /RECOVERY_PLAN_HASH_MISMATCH/ : /CONFLICT|Occupied destination/i);
        outcomes.push({ stage: step.stage, refusal: true, noEffects: true });
      } else {
        if (failure) throw failure;
        const result = valueOf(response);
        if (step.restore) {
          actual = await assertInstalledNativeKnowledgeRecoverySuccess(sourceFixture, component, result);
          assert.deepEqual(await image(component.root, true), s.preludeKnowledge);
          assert.deepEqual((await u.files(component.root, true)).filter(row => row.path !== ownerPath), beforeFiles);
          const auditName = relative(sourceFixture.evidence, result.report);
          assert.match(auditName, /^result-[A-Za-z0-9]+\.json$/);
          assert.deepEqual((await u.files(sourceFixture.evidence)).filter(row => row.path !== auditName), beforeEvidence);
          assert.equal((await u.files(sourceFixture.evidence)).length, beforeEvidence.length + 1);
          outcomes.push({ stage: step.stage, ...actual });
        } else {
          preview(result, step.stage === "recovery-preview" ? s.previews.before : s.previews.after, sourceFixture);
          outcomes.push({ stage: step.stage, actualOriginalPreview: true, noEffects: true, result });
        }
      }
      if (!step.restore) {
        assert.deepEqual(await u.files(component.root, true), beforeFiles);
        assert.deepEqual(await image(component.root, true), beforeImage);
        assert.deepEqual(await u.files(sourceFixture.evidence), beforeEvidence);
      }
      await preservedJournal(beforeJournal, journal(component), host, digest, !!step.restore, component,
        await load(installed, "original-knowledge-recovery-state"));
      await check(); await protocol.complete(step.stage);
    }
    assert.equal(s.phase, "applied", "Apply must remain applied through the final preview and occupied refusal.");
    await protocol.finish(); await ui.done; await check();
    const proof = JSON.parse(await readFile(join(root, "native-knowledge-recovery-ui-passed.json")));
    assert.equal(proof.passed, true); assert.equal(proof.actualRenderedDom, true); assert.equal(proof.runId, runId);
    const expectedDialogs = stages.flatMap(step => ["public", "source", "repair"].filter(kind => step[`${kind}Choice`])
      .map(kind => ({ stage: step.stage, kind, choice: step[`${kind}Choice`] })));
    assert.deepEqual(proof.dialogs.map(({ stage, kind, choice }) => ({ stage, kind, choice })), expectedDialogs);
    assert.deepEqual(proof.pickers.map(row => row.stage), stages.map(row => row.stage));
    assert(proof.pickers.every(row => row.directory === sourceFixture.evidence && row.actualFolderPicker && row.noActiveNavigationRow));
    assert(proof.dialogs.filter(row => row.choice === "Deny").every(row => row.focusedEnterDenial === true));
    const body = JSON.parse(s.commit.payload);
    const sourceDialog = proof.dialogs.find(row => row.stage === "recovery-apply" && row.kind === "source");
    const repairDialog = proof.dialogs.find(row => row.stage === "recovery-apply" && row.kind === "repair");
    assert.equal(sourceDialog.descriptor.requestSha256, body.provenance.sourcePayload.requestSha256);
    assert.equal(repairDialog.descriptor.requestSha256, body.provenance.repairPayload.requestSha256);
    assert.equal(repairDialog.descriptor.repairPlanSha256, s.receipt.fingerprint);
    assert.deepEqual(repairDialog.descriptor.evidence, body.plan.evidence);
    s.finalKnowledge = await image(component.root, true);
    s.evidence = { passed: true, actualNativeUi: true, actualComponentInvoke: true, actualOriginal22Oracle: true,
      originalPackageSha256: sourceFixture.sourceOriginalSha256, outcomes, binding, payloadBuildId,
      actualDialogs: proof.dialogs, actualFolderPickers: proof.pickers, acknowledgedStageCount: 7,
      canonicalReceipt: actual, liveReceiptSha256: hash(JSON.stringify(s.receipt)),
      installedHostEntrySha256: hash(await readFile(join(installed, "dist/extension.cjs"))),
      scope: "one registered PUBLIC/unshared/asset-free baseline Note at retained0644 only",
      fullRecovery: false, full151: false, b1AndB0Qualified: false, fullCutoverQualified: false };
    await writeFile(join(root, "native-knowledge-recovery-passed.json"), JSON.stringify(s.evidence), { mode: 0o600, flag: "wx" });
    s.phase = "verified"; return s.evidence;
  } catch (error) { if (protocol) await protocol.fail(error); throw error; }
  finally { if (s.phase !== "verified") s.phase = "failed"; abort.abort(); if (ui) await ui.stop(); }
}

export async function verifyInstalledNativeKnowledgeRecoveryB1(sourceFixture, { retirement, b1, stoppedCoreSha256 }) {
  const s = verified(sourceFixture);
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({ componentFixture: s.componentFixture,
    sourceRoot: sourceFixture.root, b0Sha256: s.b0Sha256 }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || b1.b1Sha256 !== receipt.b1Sha256
    || typeof b1.b1Path !== "string" || relative(s.componentFixture.directory, b1.b1Path).includes(sep)
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || !/^[a-f0-9]{64}$/.test(stoppedCoreSha256 ?? ""))
    fail("INSTALLED_RECOVERY_STOPPED_B1_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_RECOVERY_PRIVATE_B1_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), manifest = JSON.parse(bytes);
  assert.equal(hash(bytes), receipt.b1Sha256); assert.equal(manifest.root, sourceFixture.root);
  assert.equal(manifest.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  const rows = manifest.rows.map(({ identity: _identity, ...row }) => row);
  assert.deepEqual(await image(retirement.archive), rows, "The stopped archive must preserve the entire exact captured B1 image.");
  const payload = await image(join(b1.b1Path, "payload"));
  assert.deepEqual(payload.map(({ mode: _mode, ...row }) => row), rows.map(({ mode: _mode, ...row }) => row));
  assert(payload.every(row => row.mode === (row.directory ? 0o700 : 0o600)), "B1 payload must retain private image custody modes.");
  assert.deepEqual(await image(retirement.archive, true), s.finalKnowledge);
  await preservation(s, retirement.archive);
  const names = ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"];
  for (const row of rows.filter(row => row.path.startsWith("core.sqlite")))
    assert(names.includes(row.path) && row.directory === false, "Unknown SQLite sidecars remain closed.");
  for (const name of names) {
    const row = rows.find(row => row.path === name);
    if (!row) { assert.notEqual(name, "core.sqlite"); await absent(join(retirement.archive, name)); continue; }
    if (name === "core.sqlite") assert.equal(row.sha256, stoppedCoreSha256);
    if (name === "core.sqlite-wal") assert.equal(row.size, 0);
  }
  return { exactStoppedCoreAndCapturedSidecarsPreserved: true, exactB1ImagePayloadModesPreserved: true,
    repairedOriginalBytesAndModePreserved: true, unchangedIndexAndReceiptInStoppedCoreImage: true,
    preludeControlsPreserved: true, noArchivedSqliteReopen: true, b1Sha256: receipt.b1Sha256, stoppedCoreSha256 };
}
export async function verifyInstalledNativeKnowledgeRecoveryRestored(sourceFixture, options) {
  const s = verified(sourceFixture), b1 = await verifyInstalledNativeKnowledgeRecoveryB1(sourceFixture, options);
  const expected = { componentFixture: s.componentFixture, sourceRoot: sourceFixture.root, b0Sha256: s.b0Sha256 };
  const retired = await readInstalledKnowledgeMoveRetirementReceipt(expected, options.retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected, options.retirement, options.restored, retired);
  assert.deepEqual(await image(options.restored.root), s.baseline, "Fresh B0 must use pre-B0 bytes/modes, never the prelude-modified Entry.");
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace",
    ".pkm-next-original-mcp.json", ".pkm-native", ".pkm-next-locks"])
    await absent(join(options.restored.root, path));
  return { ...b1, exactOriginalB0BytesAndModesRestored: true, freshB0NoDatabaseGrantsOrNativeLocks: true,
    originalRootOverwritten: false, fullRecovery: false, full151: false, fullCutoverQualified: false };
}
