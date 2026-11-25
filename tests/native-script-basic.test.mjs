import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot, verifyOriginalMcpCustody } from "../dist/original-mcp-root.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  parseOriginalMcpNativeRequest, originalMcpNativeResult, createOriginalMcpNativeRequestPolicy,
  waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { originalMcpPlanV1Schema, originalMcpJournalV1Schema, originalMcpJournalSchema, parseOriginalMcpPlan,
  readOriginalMcpJournal, jsonDigest } from "../dist/original-mcp-root-custody.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private test framework.");
process.umask(0o077);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const value = response => response.structuredContent ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
const publicPath = "scripts/Native/immutable.py", privatePath = "scripts/Private/secret.py";
const body = "# nativescriptpublicmarker7834\r\n# 字节 preserved; never executed\r\n";
const secret = "# nativescriptprivatemarker9812\r\n# never opened by serving\r\n";
const actor = Object.freeze({ id: "mcp:external", canWrite: false });
const invoke = (f, tool, args) => f.backend.invoke("original_mcp_public", { tool, arguments: args });

async function fixture(t) {
  const directory = resolve("tests", `.native-script-${randomUUID()}`), root = join(directory, "root");
  const endpointDirectory = resolve(`.script-socket-${randomBytes(4).toString("hex")}`);
  let opened, server, socket, backend, bare, host;
  await mkdir(directory, { mode: 0o700 }); await mkdir(endpointDirectory, { mode: 0o700 });
  t.after(async () => {
    try { await backend?.close(); await bare?.close(); await host?.close(); socket?.destroy(); await server?.close(); await opened?.owner.close(); }
    finally { await rm(endpointDirectory, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
  });
  for (const path of ["notes", "skills", "papers", ".pkm", "scripts/Native", "scripts/Private"])
    await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(root, publicPath), body, { mode: 0o600 });
  await writeFile(join(root, privatePath), secret, { mode: 0o600 });
  const oracle = pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix: process.env.PKM_LEGACY_VSIX,
    python: process.env.PKM_TEST_PYTHON });
  oracle.run(root, `
    store.noteUpsert({slug:"ScriptFixture/Owner",title:"Owner",category:"ScriptFixture",type:"general",
      content:"Owned disposable native Script fixture authority.\\n"});
    privacy.setTopLevelPrivacy("scripts","Private",true); return {configured:true};
  `);
  execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c", `
import stat,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 for member in ["dist/knowledge/storage.js","dist/knowledge/knowledge-locator.js"]:
  name="extension/"+member
  if archive.namelist().count(name)!=1: raise ValueError("Missing or duplicate Script reader")
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024: raise ValueError("Unsafe Script reader")
  with (root/member).open("xb") as output: output.write(archive.read(info))
`, join(directory, "release"), process.env.PKM_LEGACY_VSIX], {
    cwd: directory, env: { ...process.env, TMPDIR: join(directory, "scratch") }, stdio: "pipe", timeout: 30000,
  });
  oracle.assertPinned();
  const original = oracle.run(root, `
    const scripts=require(process.argv[1]+"/dist/knowledge/storage.js"); scripts.setStorePath(root);
    return scripts.scriptGet("Native/immutable.py");
  `);
  assert.equal(original.content, body);
  assert.equal(original.lang, "Python");
  const profileSha256 = hash("native-script-signed-public-only-fixture");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "native-script-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 1048576, maxFileBytes: 1048576 } });
  opened = await openOriginalMcpRoot(plan);
  assert.equal(plan.schema, "pkm.original-mcp-custody/v2");
  assert.equal(readOriginalMcpJournal(root).schema, "pkm.original-mcp-root/v2");
  const inventory = new DatabaseSync(join(plan.backup, "inventory.sqlite"), { readOnly: true });
  try {
    for (const [path, bytes] of [[publicPath, body], [privatePath, secret]]) {
      const entry = inventory.prepare("SELECT * FROM inventory WHERE path=?").get(path);
      assert(entry && entry.mutable === 0 && entry.sha256 === hash(bytes), "Both Script sources require real immutable B0 custody.");
      assert.equal(await readFile(join(plan.backup, "blobs", entry.blob), "utf8"), bytes);
    }
  } finally { inventory.close(); }
  const privateBaseline = await lstat(join(root, privatePath), { bigint: true });
  bare = createNativePublicOwnerBackend(opened.owner, { actor });
  await assert.rejects(bare.invoke("legacy_indexed_knowledge_read", {
    tool: "search_scripts", arguments: { query: "nativescriptpublicmarker7834", route: "lexical", detail: "standard" },
  }), { code: "NOT_AVAILABLE" }, "Custody alone grants no Script serving.");
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const catalog = originalPublicMcpContracts(), binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: catalog.provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("native-script-source-fixture-payload"), hostEntrySha256: hash("native-script-source-fixture-host") };
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpointDirectory, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  socket = connect(join(endpointDirectory, "n"));
  let buffer = "", session, attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; }), requests = [], controls = { admit: false };
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", bytes => {
    buffer += bytes.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, originalMcpNativeRequestSession(session));
        requests.push(request);
        if (request.method === "admission.approve")
          send(originalMcpNativeResult(request, { decision: controls.admit ? "approve" : "deny" }));
        else {
          assert.equal(request.method, "public.approve", "No model, credential, tool or new source-domain permission may be requested.");
          assert.equal(request.payload.request.readOnly, true);
          send(originalMcpNativeResult(request, { decision: "approve" }));
        }
      }
    }
  });
  await attached; session = await server.waitForSession({ timeoutMs: 1000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  const policy = createOriginalMcpNativeRequestPolicy(session);
  assert.deepEqual(policy.models.configuration, {});
  await assert.rejects(createOriginalMcpNativeHost(opened.storage, policy), { code: "ACCESS_DENIED" });
  controls.admit = true;
  host = await createOriginalMcpNativeHost(opened.storage, policy);
  backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
  const rows = () => {
    const db = opened.storage.connectNative();
    try {
      return { receipts: db.prepare("SELECT COUNT(*) AS count FROM receipts").get().count,
        corpus: db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_corpus'").get()
          ? db.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all() : [] };
    } finally { db.close(); }
  };
  return { directory, root, plan, opened, backend, original, privateBaseline, requests, rows, host, session };
}

test("native Script signed public admission serves exact current get/search while actual Root privacy refuses private sources before serving bytes", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = f.rows();
  const found = value(await invoke(f, "search_scripts", { query: "nativescriptpublicmarker7834", route: "lexical", detail: "standard", limit: 5 }));
  assert.equal(found.ok, true, JSON.stringify(found)); assert.equal(found.hits.length, 1);
  assert.equal(found.semantic_status, "off"); assert.equal(found.model_invoked, false);
  const hit = found.hits[0], id = hit.source_id;
  assert.equal(id, `pkm://script/${f.original.knowledgeId}`);
  assert(hit.path_evidence.some(part => part.matched_field === "body" && part.match === "exact"));
  const read = value(await invoke(f, "get_script", { id }));
  assert.equal(read.ok, true); assert.equal(read.content, f.original.content);
  assert.equal(hash(read.content), hash(body)); assert.equal(read.content_hash, hit.content_hash);
  assert.equal(read.source_revision, hit.source_revision); assert(read.source_revision.startsWith(`sha256:${hash(body)}:`));
  assert.equal(read.source_id, id); assert.equal(read.source_uri, id); assert.equal(read.content_type, "script");
  assert.equal(read.read_only, false); assert.deepEqual(read.provenance, { provider: "pkm", collection: "scripts" });
  assert.deepEqual(Object.keys(read).sort(), ["content", "content_hash", "content_type", "corpus_revision", "description", "metadata",
    "ok", "provenance", "read_only", "ready_generation", "schema", "source_id", "source_revision", "source_uri", "stale", "title"]);
  assert.equal(read.metadata.language, f.original.lang); assert.equal(read.metadata.extension, ".py");
  assert.equal(read.metadata.legacy_uri, "pkm://scripts/Native/immutable.py");
  const hidden = value(await invoke(f, "search_scripts", { query: "nativescriptprivatemarker9812", route: "lexical", detail: "standard" }));
  const privateId = `pkm://script/script_${hash("Private/secret.py").slice(0, 24)}`;
  assert(hidden.hits.every(part => part.source_id !== privateId));
  assert.deepEqual(value(await invoke(f, "get_script", { id: privateId })),
    { ok: false, code: "not-found", error: "Knowledge source not found" });
  const privateAfter = await lstat(join(f.root, privatePath), { bigint: true });
  for (const field of ["dev", "ino", "size", "atimeNs", "mtimeNs", "ctimeNs", "mode"])
    assert.equal(privateAfter[field], f.privateBaseline[field], `Serving must not open private Script bytes (${field}).`);
  assert(!JSON.stringify([found, read, hidden]).includes(secret));
  const after = f.rows();
  assert.equal(after.receipts, before.receipts, "Read-only Script calls cannot create business mutation receipts.");
  assert.equal(after.corpus.length, 1); assert.equal(after.corpus[0].generation, 1);
  assert(!JSON.stringify(after.corpus).includes(body), "Only derived hash/generation metadata is durable.");
  assert.equal(f.requests.filter(request => request.method === "admission.approve").length, 2);
  assert(f.requests.filter(request => request.method === "public.approve").every(request =>
    ["mcp.tool.get_script", "mcp.tool.search_scripts"].includes(request.payload.request.operation)));
  await verifyOriginalMcpCustody(f.plan);
  t.diagnostic("Source fixture uses real Ed25519 attachment/request policy and typed admission/public decision double only; not installed UI authority. No model or Script executes.");
});

test("native Script immutable custody refuses an external post-seal edit without automatically publishing a new indexed baseline", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const found = value(await invoke(f, "search_scripts", { query: "nativescriptpublicmarker7834", route: "lexical", detail: "standard" }));
  const id = found.hits[0].source_id, before = f.rows();
  const inventory = new DatabaseSync(join(f.plan.backup, "inventory.sqlite"), { readOnly: true });
  let scriptRows;
  try { scriptRows = inventory.prepare("SELECT path,mutable,sha256 FROM inventory WHERE path='scripts' OR path GLOB 'scripts/*'").all(); }
  finally { inventory.close(); }
  await writeFile(join(f.root, publicPath), "# unapprovednativepostsealedmutation6721\r\n", { mode: 0o600 });
  let refusal, result;
  try { result = await invoke(f, "get_script", { id }); } catch (error) { refusal = error; }
  let custodyRefusal;
  try { await verifyOriginalMcpCustody(f.plan); } catch (error) { custodyRefusal = error; }
  t.diagnostic(`Script seal evidence: ${JSON.stringify({ auxiliary: f.plan.auxiliary, scriptRows,
    custodyRefusal: custodyRefusal ? { code: custodyRefusal.code, message: custodyRefusal.message } : null,
    beforeCorpus: before.corpus, afterCorpus: f.rows().corpus,
    warmReply: result ? value(result) : { code: refusal?.code, message: refusal?.message } })}`);
  assert(refusal || value(result).ok === false, "An immutable Script edit must not be served under the earlier native Root custody/public admission.");
  assert.equal(refusal.code, "RECOVERY_REQUIRED");
  assert.equal(custodyRefusal.code, "RECOVERY_REQUIRED");
  assert.deepEqual(f.rows().corpus, before.corpus, "Denied immutable edits must not publish a replacement corpus baseline.");
});

test("native Script frozen membership refuses unknown and missing public files before the first index publication", { timeout: 120000 }, async t => {
  for (const change of ["unknown", "missing"]) {
    const f = await fixture(t), before = f.rows();
    if (change === "unknown") await writeFile(join(f.root, "scripts/Native/new.py"), "# unadmitted member\n", { mode: 0o600 });
    else await rm(join(f.root, publicPath));
    await assert.rejects(invoke(f, "search_scripts", {
      query: "nativescriptpublicmarker7834", route: "lexical", detail: "standard",
    }), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(f.rows(), before, `${change} membership must not reach indexing or business writes.`);
    assert.equal((await lstat(join(f.root, privatePath), { bigint: true })).atimeNs, f.privateBaseline.atimeNs);
  }
});

test("native Script serving rechecks frozen public pins after the actual worker response and publishes no changed generation", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = f.rows(), spawn = childProcess.spawn;
  let mutated = false;
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    if (args[1]?.includes("--persistent")) child.stdout.once("data", () => {
      writeFileSync(join(f.root, publicPath), "# changed after the real engine response\n", { mode: 0o600 });
      mutated = true;
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(invoke(f, "get_script", { id: `pkm://script/${f.original.knowledgeId}` }), { code: "RECOVERY_REQUIRED" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(mutated, true, "The actual worker must finish before the controlled mutation.");
  assert.deepEqual(f.rows(), before, "The ambiguous worker result must never replace the frozen SQL baseline.");
  assert.equal((await lstat(join(f.root, privatePath), { bigint: true })).atimeNs, f.privateBaseline.atimeNs);
});

test("native Script privacy reclassification refuses before opening private bytes or publishing an index", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = f.rows();
  await writeFile(join(f.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await assert.rejects(invoke(f, "search_scripts", {
    query: "nativescriptprivatemarker9812", route: "lexical", detail: "standard",
  }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(f.rows(), before);
  assert.equal((await lstat(join(f.root, privatePath), { bigint: true })).atimeNs, f.privateBaseline.atimeNs);
});

test("native Script version-2 plan and journal reject the retained version-1 parser and mixed preservation scopes", { timeout: 120000 }, async t => {
  const f = await fixture(t), journal = readOriginalMcpJournal(f.root);
  assert.equal(originalMcpPlanV1Schema.safeParse(f.plan).success, false);
  assert.equal(originalMcpJournalV1Schema.safeParse(journal).success, false);
  assert.equal(originalMcpJournalSchema.safeParse({ ...journal, schema: "pkm.original-mcp-root/v1" }).success, false);
  const { planSha256: _pin, ...fields } = { ...f.plan, schema: "pkm.original-mcp-custody/v1" };
  const legacyPlan = { ...fields, planSha256: jsonDigest(fields) };
  assert.equal(parseOriginalMcpPlan(legacyPlan).schema, "pkm.original-mcp-custody/v1", "Retained v1 parsing is not a Script admission.");
  assert.equal(originalMcpJournalSchema.safeParse({ ...journal, plan: legacyPlan }).success, false);
});
