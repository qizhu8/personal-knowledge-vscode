import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pinnedOriginalKnowledgeWriterFixture } from "../../tests/original-knowledge-writer-fixture.mjs";
import { prepareInstalledHeldScriptCustodyParser, verifyInstalledHeldScriptCustodyParser }
  from "./installed-held-script-custody-parser.mjs";
import { assertInstalledNativeScriptUi, waitInstalledNativeScriptUi, installedNativeScriptUiFile } from "./installed-native-script-ui.mjs";
import { assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt,
  readInstalledKnowledgeMoveRestoredReceipt, installedKnowledgeMoveFixtureUtilities as u }
  from "./installed-native-knowledge-move.mjs";

const states = new WeakMap(), denials = new WeakMap(), publicPath = "scripts/ScriptFixture/immutable.py";
const privatePath = "scripts/Private/NativeSecret.py";
export const installedNativeScriptPrivacyPolicy = Object.freeze({ schema: 1, private: Object.freeze({
  notes: Object.freeze(["Private"]), skills: Object.freeze(["Private"]), papers: Object.freeze(["Private"]),
  scripts: Object.freeze(["Private"]),
}) });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value, phase) {
  const state = states.get(value);
  if (!state) fail("INSTALLED_SCRIPT_ACTUAL_PREPARATION_REQUIRED");
  if (phase && state.phase !== phase) fail("INSTALLED_SCRIPT_VERIFIED_PHASE_REQUIRED");
  return state;
}
export function assertInstalledNativeScriptPriorDenial(value) {
  const denial = denials.get(value);
  if (!denial || denial.state.phase !== "host-denied")
    fail("INSTALLED_SCRIPT_ACTUAL_DENIAL_REQUIRED");
  return Object.freeze({ installed: denial.state.installed, componentFixture: denial.state.componentFixture,
    root: denial.binding.root, workspaceId: denial.binding.workspaceId, epoch: denial.binding.epoch,
    runId: denial.runId, binding: denial.binding });
}
function noPrivate(state, response) {
  assert(!JSON.stringify(response).includes(state.secret), "Private Script bytes must not enter public evidence.");
}
function value(state, response) {
  noPrivate(state, response);
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
}
async function originalScriptOracle(writer, directory, root, python, legacyVsix, marker) {
  writer.assertPinned();
  const release = join(directory, "release");
  execFileSync(python, ["-I", "-B", "-c", `
import io,posixpath,re,stat,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 names=archive.namelist();pending=["dist/knowledge/storage.js","dist/retrieval/retrieval-snapshot.js"];seen=set();total=0
 while pending:
  member=pending.pop()
  if member in seen:continue
  seen.add(member);name="extension/"+member
  if not member.startswith("dist/") or ".." in member.split("/") or names.count(name)!=1:raise ValueError("Unsafe original Script oracle")
  info=archive.getinfo(name);total+=info.file_size
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2097152 or total>16777216 or len(seen)>64:raise ValueError("Unbounded Script oracle")
  data=archive.read(info)
  for dependency in re.findall(r'require\\(["\\x27]([^"\\x27]+)["\\x27]\\)',data.decode()):
   if dependency.startswith("."):
    path=posixpath.normpath(posixpath.join(posixpath.dirname(member),dependency))
    pending.append(path if path.endswith(".js") else path+".js")
  target=root/member;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  if target.exists():
   if target.is_symlink() or target.read_bytes()!=data:raise ValueError("Substituted Script oracle")
  else:
   with target.open("xb") as output:output.write(data)
`, release, legacyVsix], { cwd: directory, env: { ...process.env, TMPDIR: join(directory, "scratch") },
    timeout: 30000, stdio: "pipe" });
  writer.assertPinned();
  const oracle = writer.run(root, `
    const scripts=require(process.argv[1]+"/dist/knowledge/storage.js");
    const snapshot=require(process.argv[1]+"/dist/retrieval/retrieval-snapshot.js");
    scripts.setStorePath(root);
    const row=scripts.scriptGet("ScriptFixture/immutable.py");
    const projected=snapshot.createRetrievalSnapshot({skills:[],notes:[],papers:[],
      scripts:[{...row,category:"ScriptFixture",extension:".py"}],recipes:[],subscriptionGroups:[],
      readSubscription(){throw Error("No subscription oracle");}});
    return {reader:row,source:snapshot.indexedRetrievalDocument(projected.documents[0])};
  `);
  assert(oracle.reader.content.includes(marker));
  return oracle;
}

/** Parent stops the editor and independently configures privacy; only disposable pre-B0 setup writes occur here. */
export async function prepareInstalledNativeScriptFixture({ installed, componentFixture, legacyVsix, python, heldOldScriptParser }) {
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (states.has(componentFixture)) fail("INSTALLED_SCRIPT_ALREADY_PREPARED");
  for (const path of ["b0", "custody"]) await u.absent(join(componentFixture.directory, path), "INSTALLED_SCRIPT_PRE_B0_REQUIRED");
  for (const path of ["core.sqlite", ".pkm-next-original-mcp.json"]) await u.absent(join(componentFixture.root, path), "INSTALLED_SCRIPT_PRE_B0_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("INSTALLED_SCRIPT_EXACT_PYTHON_REQUIRED");
  await u.privateDirectory(join(componentFixture.root, ".pkm"), "INSTALLED_SCRIPT_SAFE_PRIVACY_REQUIRED");
  const privacyPath = join(componentFixture.root, ".pkm/content-privacy.json"), privacyStat = await lstat(privacyPath);
  if (!privacyStat.isFile() || privacyStat.isSymbolicLink() || privacyStat.nlink !== 1 || privacyStat.uid !== process.getuid()
    || privacyStat.mode & 0o077 || privacyStat.size > 2097152)
    fail("INSTALLED_SCRIPT_SAFE_PRIVACY_REQUIRED");
  const privacy = await readFile(privacyPath);
  assert.deepEqual(JSON.parse(privacy), installedNativeScriptPrivacyPolicy, "Parent must independently configure actual Script privacy before B0.");
  for (const path of ["notes", "skills", "papers", "scripts", "scripts/Private"]) {
    let stat;
    try { stat = await lstat(join(componentFixture.root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o002))
      fail("INSTALLED_SCRIPT_SAFE_SEED_PARENTS_REQUIRED");
  }
  for (const path of ["scripts/ScriptFixture", privatePath, "notes/ScriptFixture"])
    await u.absent(join(componentFixture.root, path), "INSTALLED_SCRIPT_DISJOINT_SEED_REQUIRED");
  const marker = `installedscriptpublic${randomUUID().replaceAll("-", "")}`;
  const privateMarker = `installedscriptprivate${randomUUID().replaceAll("-", "")}`;
  const raw = `# ${marker}\r\n# exact Unicode 字节 — never executed\r\n`;
  const secret = `# ${privateMarker}\r\n# private Script must not be served or executed\r\n`;
  for (const path of ["notes", "skills", "papers", "scripts/ScriptFixture", "scripts/Private"])
    await mkdir(join(componentFixture.root, path), { recursive: true, mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory: componentFixture.directory, legacyVsix, python });
  writer.run(componentFixture.root, `
    store.noteUpsert({slug:"ScriptFixture/Owner",title:"Owner",category:"ScriptFixture",type:"general",
      content:"Disposable immutable Script fixture authority.\\n"}); return {created:true};
  `);
  await writeFile(join(componentFixture.root, publicPath), raw, { mode: 0o600, flag: "wx" });
  await writeFile(join(componentFixture.root, privatePath), secret, { mode: 0o600, flag: "wx" });
  const oracle = await originalScriptOracle(writer, componentFixture.directory, componentFixture.root, python, legacyVsix, marker);
  assert.equal(oracle.reader.content, raw);
  assert.deepEqual(await readFile(privacyPath), privacy, "Preparation cannot alter the independently configured policy.");
  const baseline = await u.files(componentFixture.root);
  const held = await prepareInstalledHeldScriptCustodyParser({ installed, componentFixture, heldOldScriptParser, python });
  const prepared = Object.freeze({ kind: "pkm.installed-native-script-fixture/v1", root: componentFixture.root,
    sourceId: oracle.source.source_id, sourceRevision: oracle.source.source_revision, rawSha256: u.hash(raw),
    privateSourceId: `pkm://script/script_${u.hash(privatePath.slice("scripts/".length)).slice(0, 24)}`,
    marker, privateMarker, privacySha256: u.hash(privacy), originalPackageSha256: writer.originalPackageSha256,
    heldOldParserRequested: Boolean(heldOldScriptParser), installedReadQualified: false });
  const state = { installed, componentFixture, writer, oracle, raw, secret, privacy, baseline, held, prepared, phase: "prepared" };
  states.set(prepared, state); states.set(componentFixture, state);
  return prepared;
}

function liveTables(component) {
  const db = component.storage.connectNative();
  try {
    const exists = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return { receipts: exists("receipts") ? db.prepare("SELECT * FROM receipts ORDER BY operation_id").all() : [],
      corpus: exists("legacy_retrieval_corpus") ? db.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all() : [] };
  } finally { db.close(); }
}

/** The failed component remains Parent-owned; Parent must close it and create a new fixture/epoch. */
export async function verifyInstalledNativeScriptHostDenied({ installed, component, scriptFixture, ui }) {
  const state = stateFor(scriptFixture, "prepared");
  assertInstalledNativeScriptUi(ui, ui?.root);
  if (ui.mode !== "deny") fail("INSTALLED_SCRIPT_UI_SEGMENT_REQUIRED");
  if (state.installed !== installed || component?.fixture !== state.componentFixture || component.root !== scriptFixture.root
    || typeof component.complete !== "function" || typeof component.invoke !== "function" || !component.storage)
    fail("INSTALLED_SCRIPT_ACTUAL_COMPONENT_REQUIRED");
  (await u.load(installed, "root-owner")).assertRootOwner(component.owner);
  (await u.load(installed, "storage")).assertStorage(component.storage);
  assert.equal(component.owner.workspaceRoot(), component.root);
  assert.equal(component.storage.workspaceRoot(), component.root);
  component.owner.assertWorkspaceLease(); component.storage.assertWorkspaceLease();
  const descriptorBytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(u.hash(descriptorBytes), component.attachmentDescriptorSha256);
  await assert.rejects(component.complete(), { code: "ACCESS_DENIED" });
  await ui.done;
  const proof = await waitInstalledNativeScriptUi(ui, "host-deny");
  const dom = await waitInstalledNativeScriptUi(ui, "passed");
  assert.equal(dom.passed, true); assert.equal(dom.actualRenderedDom, true);
  assert.equal(dom.mode, "deny"); assert.equal(dom.dialogs.length, 1); assert.equal(dom.readonlyReadPhasePerformed, false);
  assert.equal(proof.runId, ui.runId); assert.equal(proof.dialog.choice, "Deny");
  assert.equal(proof.dialog.binding.root, component.root); assert.equal(proof.dialog.binding.workspaceId, component.workspaceId);
  assert.equal(proof.dialog.binding.planSha256, component.custody.planSha256);
  assert.equal(proof.dialog.binding.profileSha256, descriptor.binding.profileSha256);
  assert.equal(proof.dialog.binding.sourceCatalogSha256, descriptor.binding.catalogSha256);
  assert.equal(proof.dialog.binding.authorityId, `native-rpc:${descriptor.brokerId}`);
  assert.deepEqual(dom.dialogs[0], proof.dialog);
  await assert.rejects(component.invoke("get_script", { id: scriptFixture.sourceId }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  state.phase = "host-denied";
  const denial = Object.freeze({ kind: "pkm.installed-native-script-denial/v1", actualHostDenied: true,
    deniedComponentScriptGateClosed: true, failedEpoch: proof.dialog.binding.epoch,
    deniedRoot: component.root, runId: ui.runId, requiresParentCloseAndFreshEditorBootstrap: true,
    installedReadQualified: false });
  denials.set(denial, { state, binding: Object.freeze({ ...proof.dialog.binding,
    domains: Object.freeze([...proof.dialog.binding.domains]) }), runId: ui.runId });
  return denial;
}

/** Owns only transient readers and the supplied real observer; never closes the shared component/Owner. */
export async function verifyInstalledNativeScript({ root, installed, component, host, scriptFixture, payloadBuildId, ui, priorDenied }) {
  const state = stateFor(scriptFixture, "prepared");
  if (state.installed !== installed || component?.fixture !== state.componentFixture || component.root !== scriptFixture.root
    || typeof component.invoke !== "function" || typeof component.complete !== "function")
    fail("INSTALLED_SCRIPT_ACTUAL_COMPONENT_REQUIRED");
  const prior = assertInstalledNativeScriptPriorDenial(priorDenied);
  if (prior.installed !== installed || prior.componentFixture === state.componentFixture || prior.root === component.root)
    fail("INSTALLED_SCRIPT_FRESH_CONTEXT_REQUIRED");
  assertInstalledNativeScriptUi(ui, root);
  if (ui.mode !== "approve") fail("INSTALLED_SCRIPT_UI_SEGMENT_REQUIRED");
  if (ui.priorDenied !== priorDenied) fail("INSTALLED_SCRIPT_FRESH_CONTEXT_REQUIRED");
  try {
  const binding = await assertInstalledKnowledgeMoveComponentBinding({ root, installed, component,
    componentFixture: state.componentFixture, payloadBuildId });
  assert.equal(host, binding.host);
  assert.equal(component.custody.schema, "pkm.original-mcp-custody/v2");
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("vscode"), false);
  const approval = await waitInstalledNativeScriptUi(ui, "host-approve");
  assert.equal(approval.runId, ui.runId); assert.equal(approval.dialog.choice, "Approve this request");
  const { receiptSha256: _receipt, ...hostBody } = host.receipt;
  assert.deepEqual(approval.dialog.binding, hostBody, "The observed actual native modal must be this exact live Host receipt.");
  assert.notEqual(host.receipt.epoch, prior.epoch, "A whole fresh editor context is required after Host denial.");
  const reader = await (await u.load(installed, "original-mcp-root")).openOriginalMcpCustodyReader(component.custody);
  try {
    for (const [path, bytes] of [[publicPath, state.raw], [privatePath, state.secret]]) {
      const entry = reader.entry(path);
      assert(entry && entry.kind === "file" && entry.mutable === 0 && entry.sha256 === u.hash(bytes));
    }
  } finally { reader.close(); }
  const privateBaseline = await lstat(join(component.root, privatePath), { bigint: true });
  const before = liveTables(component), lease = { ...component.owner.workspaceLease() };
  try {
    await writeFile(installedNativeScriptUiFile(ui, "next"), JSON.stringify({ stage: "native-script-reads-start", runId: ui.runId }), { mode: 0o600 });
    await writeFile(join(root, "progress.json"), '{"stage":"native-script-reads-start"}', { mode: 0o600 });
    const ready = await waitInstalledNativeScriptUi(ui, "reads-ready");
    assert.equal(ready.observedReadonlyStart, true);
    const found = value(state, await component.invoke("search_scripts", { query: scriptFixture.marker, limit: 5, detail: "standard", route: "lexical" }));
    assert.equal(found.ok, true); assert.equal(found.semantic_status, "off"); assert.equal(found.model_invoked, false);
    assert.equal(found.hits.length, 1, "Empty/fuzzy-only retrieval cannot pass the installed basic sequence.");
    const hit = found.hits[0];
    assert.equal(hit.source_id, state.oracle.source.source_id);
    assert(hit.path_evidence.some(part => part.matched_field === "body" && part.match === "exact"));
    const read = value(state, await component.invoke("get_script", { id: hit.source_id }));
    assert.equal(read.ok, true); assert.equal(read.content, state.oracle.reader.content);
    assert.equal(u.hash(read.content), scriptFixture.rawSha256); assert.equal(read.content_hash, hit.content_hash);
    for (const key of ["source_id", "source_revision", "source_uri", "content_type", "title", "description", "read_only"])
      assert.deepEqual(read[key], state.oracle.source[key]);
    assert.deepEqual(read.metadata, state.oracle.source.metadata); assert.deepEqual(read.provenance, state.oracle.source.provenance);
    assert.deepEqual(Object.keys(read).sort(), ["content", "content_hash", "content_type", "corpus_revision", "description",
      "metadata", "ok", "provenance", "read_only", "ready_generation", "schema", "source_id", "source_revision",
      "source_uri", "stale", "title"]);
    const hidden = value(state, await component.invoke("search_scripts", { query: scriptFixture.privateMarker, limit: 5, detail: "standard", route: "lexical" }));
    assert.equal(hidden.ok, true); assert(hidden.hits.every(part => part.source_id !== scriptFixture.privateSourceId));
    const denied = value(state, await component.invoke("get_script", { id: scriptFixture.privateSourceId }));
    assert.deepEqual(denied, { ok: false, code: "not-found", error: "Knowledge source not found" });
    const privateAfter = await lstat(join(component.root, privatePath), { bigint: true });
    for (const key of ["dev", "ino", "size", "atimeNs", "mtimeNs", "ctimeNs", "mode"])
      assert.equal(privateAfter[key], privateBaseline[key], "Serving cannot open or mutate private Script bytes after B0.");
    assert.equal(await readFile(join(component.root, publicPath), "utf8"), state.raw);
    const after = liveTables(component);
    assert.deepEqual(after.receipts, before.receipts, "Readonly Script APIs cannot publish business mutation receipts.");
    assert.deepEqual(after.corpus.slice(0, before.corpus.length), before.corpus);
    assert.equal(after.corpus.at(-1).generation, read.ready_generation);
    assert.equal(after.corpus.at(-1).corpus_revision, read.corpus_revision);
    assert(!JSON.stringify(after.corpus).includes(state.raw));
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await writeFile(installedNativeScriptUiFile(ui, "next"), JSON.stringify({ stage: "native-script-complete", runId: ui.runId }), { mode: 0o600 });
    await writeFile(join(root, "progress.json"), '{"stage":"native-script-complete"}', { mode: 0o600 });
    await ui.done;
    const dom = await waitInstalledNativeScriptUi(ui, "passed");
    assert.equal(dom.passed, true); assert.equal(dom.actualRenderedDom, true); assert.equal(dom.runId, ui.runId);
    assert.equal(dom.mode, "approve"); assert.equal(dom.dialogs.length, 1); assert.equal(dom.observedReadonlyModals, 0);
    assert.equal(dom.readonlyReadPhasePerformed, true);
    assert.notEqual(prior.epoch, dom.dialogs[0].binding.epoch);
    const heldOldParser = state.held ? { performed: true, ...await verifyInstalledHeldScriptCustodyParser(state.held, { currentPlan: component.custody }) }
      : { performed: false, reason: "Explicit held old archive was not requested; no old-package proof is claimed." };
    state.b0Sha256 = component.b0.sha256; state.tables = after; state.phase = "verified";
    const proof = { passed: true, actualInstalledIdentityAndHost: true, twoObservedHostChoices: true,
      readonlyModals: 0, sourceId: read.source_id, sourceRevision: read.source_revision, contentHash: read.content_hash,
      denyContext: { root: prior.root, epoch: prior.epoch, runId: prior.runId },
      approvedContext: { root: component.root, epoch: host.receipt.epoch, runId: ui.runId },
      rawSha256: scriptFixture.rawSha256, readyGeneration: read.ready_generation, corpusRevision: read.corpus_revision,
      actualRootPrivateExclusion: true, privateServingAtimeUnchangedAfterB0: true, frozenSourceUnmodified: true,
      businessReceiptsUnchanged: true, derivedCorpusOnly: true, noScriptExecutionOrWriteApi: true,
      heldOldParser, b1AndRestoredQualified: false, fullCutoverQualified: false };
    await writeFile(join(root, "native-script-passed.json"), JSON.stringify(proof), { mode: 0o600, flag: "wx" });
    return proof;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    await ui.stop();
  }
  } catch (error) {
    state.phase = "failed"; await ui.stop(); throw error;
  }
}

export async function verifyInstalledNativeScriptB1(scriptFixture, { retirement, b1 }) {
  const state = stateFor(scriptFixture, "verified");
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({
    componentFixture: state.componentFixture, sourceRoot: scriptFixture.root, b0Sha256: state.b0Sha256,
  }, retirement);
  if (b1?.kind !== "pkm.original-mcp-component-b1/v1" || relative(state.componentFixture.directory, b1.b1Path).includes("/")
    || !/b1-[a-f0-9-]{36}$/.test(b1.b1Path) || b1.b1Sha256 !== receipt.b1Sha256)
    fail("INSTALLED_SCRIPT_ACTUAL_B1_IMAGE_REQUIRED");
  await u.privateDirectory(b1.b1Path, "INSTALLED_SCRIPT_ACTUAL_B1_IMAGE_REQUIRED");
  const bytes = await readFile(join(b1.b1Path, "manifest.json")), image = JSON.parse(bytes);
  assert.equal(u.hash(bytes), receipt.b1Sha256); assert.equal(image.root, scriptFixture.root);
  assert.equal(image.schema, "pkm.original-mcp-component-image/v1");
  const complete = JSON.parse(await readFile(join(b1.b1Path, "complete.json")));
  assert.equal(complete.sha256, receipt.b1Sha256); assert(complete.sqliteChecks >= 1);
  const archived = await u.files(retirement.archive), scriptFiles = files => u.hashes(files.filter(file => file.path.startsWith("scripts/")));
  assert.deepEqual(scriptFiles(archived), scriptFiles(state.baseline));
  assert.deepEqual(await readFile(join(retirement.archive, ".pkm/content-privacy.json")), state.privacy);
  const core = archived.find(file => file.path === "core.sqlite"), coreImage = image.rows.find(row => row.path === "core.sqlite");
  assert(core && coreImage && core.sha256 === coreImage.sha256, "The actual stopped B1 native database image must be preserved exactly.");
  return { frozenScriptsAndPrivateB1Preserved: true, stoppedNativeDatabaseImagePreserved: true,
    scriptMutationReceiptCreated: false, fullCutoverQualified: false };
}

export async function verifyInstalledNativeScriptRestored(scriptFixture, { retirement, b1, restored }) {
  const state = stateFor(scriptFixture, "verified"), b1Proof = await verifyInstalledNativeScriptB1(scriptFixture, { retirement, b1 });
  const receipt = await readInstalledKnowledgeMoveRetirementReceipt({
    componentFixture: state.componentFixture, sourceRoot: scriptFixture.root, b0Sha256: state.b0Sha256,
  }, retirement);
  await readInstalledKnowledgeMoveRestoredReceipt({
    componentFixture: state.componentFixture, sourceRoot: scriptFixture.root, b0Sha256: state.b0Sha256,
  }, retirement, restored, receipt);
  assert.deepEqual(u.hashes(await u.files(restored.root)), u.hashes(state.baseline));
  for (const path of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", ".pkm-next-workspace", ".pkm-next-original-mcp.json",
    ".pkm-next-original-mcp.commit.json", ".pkm-next-retrieval-models", ".pkm-native"])
    await u.absent(join(restored.root, path), "INSTALLED_SCRIPT_FRESH_B0_HAS_NATIVE_GRANTS");
  return { ...b1Proof, allOriginalB0BytesRestored: true, freshB0NoNativeCorpusOrGrants: true,
    originalRootOverwritten: false, fullCutoverQualified: false };
}
