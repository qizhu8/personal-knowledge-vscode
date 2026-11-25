import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { scanMarkdown } from "../dist/markdown.js";
import { knowledgeMutationScanRevision, planKnowledgeMutation } from "../dist/knowledge-mutations.js";
import { assertNoNewPrivateResourceReferences } from "../dist/document-legacy-assets.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import {
  originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport,
} from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest, originalMcpRequestDigest } from "../dist/original-mcp-native-host.js";
import { createNativePrivateResourcePublicationPort, withNativePrivateResourcePublicationContext } from "../dist/private-resource-publication-native.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { originalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { seedOriginalPrivateResourcePublication } from "./original-private-resource-publication-fixture.mjs";

// Genuine signed local public-request/Core fixture; not installed UI or private-resource approval evidence.
assert(process.env.PKM_TEST_WORKSPACE); assert(process.env.PKM_LEGACY_VSIX);
const hash = value => createHash("sha256").update(value).digest("hex"), actor = { id: "mcp:external", canWrite: true };
const areas = { note: "notes", skill: "skills", paper: "papers" };
async function snapshot(root) {
  const result = [], folders = [];
  async function walk(directory, prefix) {
    const info = await lstat(directory);
    if (prefix.includes("/Private")) folders.push({ path: prefix, identity: [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.mtimeMs, info.ctimeMs].join(":") });
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), member = `${prefix}/${name}`, stat = await lstat(path);
      if (stat.isDirectory()) await walk(path, member);
      else result.push({ path: member, bytes: await readFile(path),
        identity: [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") });
    }
  }
  for (const area of Object.values(areas)) await walk(join(root, area), area);
  return { files: result, folders };
}
function journal(root) {
  const db = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { intents: db.prepare("SELECT * FROM migration_runtime_intents").all().map(row => ({ ...row })),
    receipts: db.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.update'").all().map(row => ({ ...row })),
    commits: db.prepare("SELECT * FROM migration_runtime_knowledge_commits").all().map(row => ({ ...row })) }; } finally { db.close(); }
}
async function fixture(t) {
  const directory = resolve("tests", `.native-private-inplace-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of [...Object.values(areas), ".pkm"]) await mkdir(join(root, name), { mode: 0o700 });
  const policy = Buffer.from(JSON.stringify({ schema: 1, private: { notes: ["Private"], skills: ["Private"], papers: ["Private"] } }));
  await writeFile(join(root, ".pkm/content-privacy.json"), policy, { mode: 0o600 });
  let opened, host, server, socket, endpoint;
  t.after(async () => {
    try { socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close(); }
    finally { if (endpoint) await rm(endpoint, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
  });
  const original = originalKnowledgeWriterFixture(directory), rows = original.run(root, seedOriginalPrivateResourcePublication);
  original.run(root, `
    for(const [kind,area] of [["note","notes"],["skill","skills"],["paper","papers"]]){
      const content="Private unreviewed-resource owner\\n![owned](_assets/unreviewed.BIN)\\n";
      store[kind+"Upsert"]({slug:"Private/Unreviewed",title:"Unreviewed",name:"Unreviewed",category:"Private",type:"general",content});
      const bytes=Buffer.from("SYNTHETIC_UNREVIEWED_PRIVATE_RESOURCE");
      assets.importMarkdownAssetBundle(root,[{type:area,path:"Private/_assets/unreviewed.BIN",data:bytes.toString("base64"),
        digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
        [{area,path:"Private/Unreviewed.md",content}]);
    }
    return true;
  `);
  const oracle = join(directory, "oracle"); await cp(root, oracle, { recursive: true });
  const profileSha256 = hash("nonpublishing-inplace-fixture");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "native-inplace-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 1048576 } });
  opened = await openOriginalMcpRoot(plan); const full = await opened.owner.ensureFull();
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  endpoint = resolve("tests", `.i-${randomBytes(4).toString("hex")}`); await mkdir(endpoint, { mode: 0o700 });
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, payloadBuildId: hash("synthetic-payload"), hostEntrySha256: hash("synthetic-host") },
    maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  socket = connect(join(endpoint, "n")); socket.on("error", () => socket.destroy());
  let buffer = "", readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; }), frames = [], controls = { publicDecision: "approve" };
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("data", chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") readyResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        // Never approve, mint or simulate a private publication grant.
        send(originalMcpNativeResult(frame, frame.method === "knowledge.asset.publish" ? null
          : { decision: frame.method === "public.approve" ? controls.publicDecision : "approve" }));
      }
    }
  });
  await ready; const session = await server.waitForSession({ timeoutMs: 1000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
  const port = createNativePrivateResourcePublicationPort(opened.storage, host, session);
  const request = (kind, args) => ({ tool: `update_${kind}`, arguments: { ...(kind === "skill" ? { name: "Before" } : { slug: "Old/Before" }), ...args } });
  const invoke = value => withOriginalMcpPublicRequest(opened.storage, host, {
    operation: `mcp.tool.${value.tool}`, version: 1, tool: value.tool, readOnly: false,
    arguments: value.arguments, argumentsDigest: originalMcpRequestDigest(value.arguments),
  }, () => withNativePrivateResourcePublicationContext(port, () => legacyKnowledgeWrite(full.runtime.core, opened.storage, actor, value)));
  return { root, rows, oracle, original, frames, controls, request, invoke, policy, opened, full };
}
for (const [kind, area] of Object.entries(areas))
for (const mode of ["content", "metadata"])
test(`current v5 ${kind} same-path ${mode} matches original nonpublication with public approval and canonical revision/receipt`, { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), originalBefore = f.rows[kind];
  const args = mode === "content" ? { content: originalBefore.content.replace("Original private-resource owner", "Native inplace body") } : { tags: ["native-inplace"] };
  const expected = f.original.run(f.oracle, `
    const before=store[input.kind+"Get"](input.kind==="skill"?"Before":"Old/Before");
    store[input.kind+"Upsert"]({...before,tags:input.args.tags??(typeof before.tags==="string"?JSON.parse(before.tags):before.tags),
      content:input.args.content??before.content});
    return store[input.kind+"Get"](input.kind==="skill"?"Before":"Old/Before");
  `, { kind, args });
  const reply = JSON.parse((await f.invoke(f.request(kind, args))).text);
  assert.deepEqual(reply, kind === "skill" ? { ok: true, name: "Before" } : { ok: true, slug: "Old/Before" });
  const document = scanMarkdown(f.root).find(row => row.record.area === area && row.record.path === "Old/Before.md"); assert(document);
  assert.equal(document.record.id, originalBefore.knowledgeId); assert.equal(document.record.revision, originalBefore.revision + 1);
  assert.equal(document.record.revision, expected.revision); assert.equal(document.record.content, expected.content);
  if (kind === "paper") assert.equal(document.metadata.get("file"), expected.file);
  const after = await snapshot(f.root);
  assert.deepEqual(after.files.filter(file => file.path !== `${area}/Old/Before.md`), before.files.filter(file => file.path !== `${area}/Old/Before.md`));
  assert.deepEqual(after.folders, before.folders); assert.deepEqual(await readFile(join(f.root, ".pkm/content-privacy.json")), f.policy);
  assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
  assert.equal(f.frames.filter(frame => frame.method === "public.approve").length, 1);
  const state = journal(f.root); assert.equal(state.intents.length, 0); assert.equal(state.receipts.length, 1); assert.equal(state.commits.length, 1);
  const result = JSON.parse(state.receipts[0].result), plan = JSON.parse(state.commits[0].plan_json);
  assert.equal(result.id, document.record.id); assert.equal(result.revision, document.record.revision); assert.equal(result.path, "Old/Before.md");
  assert.equal(result.sha256, document.record.sha256); assert.equal(state.receipts[0].actor_id, "mcp:external");
  assert.equal(plan.relocation, undefined, "Nonpublication must not fabricate a move/publication plan.");
});
test("fresh public denial performs no same-path write or private review", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), state = journal(f.root); f.controls.publicDecision = "deny";
  await assert.rejects(f.invoke(f.request("note", { tags: ["denied"] })), { code: "ACCESS_DENIED" });
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), state);
  assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
});
for (const kind of Object.keys(areas))
test(`same-path ${kind} new submitted private URI remains closed without publication authority`, { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), state = journal(f.root);
  const submitted = f.request(kind, { content: f.rows[kind].content + "\n![unreviewed](../Private/_assets/unreviewed.BIN)\n" });
  let failure, response;
  try { response = await f.invoke(submitted); } catch (error) { failure = error; }
  if (!failure) {
    const document = scanMarkdown(f.root).find(row => row.record.area === areas[kind] && row.record.path === "Old/Before.md");
    const current = journal(f.root);
    assert(document.record.content.includes("../Private/_assets/unreviewed.BIN"));
    assert.equal(current.receipts.length, state.receipts.length + 1);
    assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
    const after = await snapshot(f.root), owner = `${areas[kind]}/Old/Before.md`;
    assert.deepEqual(after.files.filter(file => file.path !== owner), before.files.filter(file => file.path !== owner));
    assert.deepEqual(after.folders, before.folders);
    t.diagnostic(JSON.stringify({ acceptedReply: JSON.parse(response.text), newPrivateUriPersisted: true,
      nativeReceiptAdded: true, privatePublicationRequests: 0, privateBytesCopied: false,
      note: "The reference-denial regression must refuse before owner writes/receipts." }));
  }
  assert(failure && failure.code === "ACCESS_DENIED",
    "New private URI was accepted/persisted with a native receipt instead of refusal.");
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), state);
  assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
});
test("same logical stored private sources allow normalized spelling/suffix/forms, Private prose/code and external URLs without private publication", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  const content = f.rows.note.content
    .replace("../Private/_assets/a.PNG?q=1#view", "../%50rivate/_assets/./a.PNG?changed=2#same")
    .replace('src="../Private/_assets/a.PNG?html=1#image"', 'src="../Private/_assets/../_assets/a.PNG?html=2#same"')
    .replace("../Private/_assets/b.BIN?definition=1#doc", "../Private/_assets/./b.BIN?definition=2#same")
    + "\nPrivate words are prose.\n`![example](../Private/_assets/not-reviewed.BIN)`\n"
    + "```md\nfile: ../Private/_assets/not-reviewed.BIN\n```\n"
    + "[external](https://example.invalid/Private/_assets/not-reviewed.BIN)\n";
  await f.invoke(f.request("note", { content }));
  const document = scanMarkdown(f.root).find(row => row.record.area === "notes" && row.record.path === "Old/Before.md");
  assert.equal(document.record.content, content);
  const after = await snapshot(f.root);
  assert.deepEqual(after.files.filter(file => file.path !== "notes/Old/Before.md"), before.files.filter(file => file.path !== "notes/Old/Before.md"));
  assert.deepEqual(after.folders, before.folders);
  assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
});
test("HTML, definitions, YAML file lines and cross-area/unknown private targets deny before intent without opening private bytes", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), state = journal(f.root);
  for (const addition of [
    '<img src="../Private/_assets/unreviewed.BIN?html=1#secret">',
    "[secret]: <../Private/_assets/unreviewed.BIN?definition=1#secret>",
    'file: "../Private/_assets/unreviewed.BIN?file=1#secret"',
    "[unknown](../Private/_assets/does-not-exist.BIN)",
    "[other area](../../papers/Private/_assets/unreviewed.BIN)",
  ]) {
    await assert.rejects(f.invoke(f.request("note", { content: f.rows.note.content + "\n" + addition + "\n" })), { code: "ACCESS_DENIED" });
    assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), state);
  }
  assert.equal(f.frames.filter(frame => frame.method === "knowledge.asset.publish").length, 0);
});
test("canonical direct create/update and planning cannot bypass the same-writer private-reference denial", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), state = journal(f.root), records = scanMarkdown(f.root);
  const source = records.find(row => row.record.area === "notes" && row.record.path === "Old/Before.md").record;
  const pin = { operationId: randomUUID(), id: source.id, expectedRevision: source.revision, expectedSha256: source.sha256,
    expectedScanRevision: knowledgeMutationScanRevision(records), preserveIdentity: true };
  const update = { operation: "knowledge.note.update", actorId: actor.id,
    args: { ...pin, content: f.rows.note.content + "\n![new](../Private/_assets/unreviewed.BIN)\n" } };
  await assert.rejects(f.opened.storage.withWorkspaceExclusive(() => planKnowledgeMutation(f.root, update)), { code: "ACCESS_DENIED" });
  const cases = [
    update,
    { operation: "knowledge.note.create", actorId: actor.id, args: { operationId: randomUUID(), expectedScanRevision: pin.expectedScanRevision,
      title: "NotCreated", category: "Old", content: "![new](../Private/_assets/unreviewed.BIN)" } },
    { operation: "knowledge.research.create", actorId: actor.id, args: { operationId: randomUUID(), expectedScanRevision: pin.expectedScanRevision,
      title: "NotCreated", file: "Private/_assets/unreviewed.BIN", url: "https://example.invalid/Private" } },
  ];
  for (const request of cases) {
    const response = await f.full.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args }, actor);
    assert.equal(response.error?.code, "ACCESS_DENIED");
    assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), state);
  }
});
test("actual Paper YAML file reference normalization preserves stored logical source but denies a newly selected private source", { timeout: 120000 }, async t => {
  const f = await fixture(t), record = scanMarkdown(f.root).find(row => row.record.area === "papers" && row.record.path === "Old/Before.md");
  const same = record.raw.replace(/^file:[^\r\n]*$/m, 'file: "../%50rivate/_assets/./a.PNG?file=2#same"');
  assert.notEqual(same, record.raw);
  assert.doesNotThrow(() => assertNoNewPrivateResourceReferences(f.root, "papers", record.record.path, record.raw, same));
  const changed = record.raw.replace(/^file:[^\r\n]*$/m, 'file: "../Private/_assets/unreviewed.BIN?file=2#secret"');
  assert.throws(() => assertNoNewPrivateResourceReferences(f.root, "papers", record.record.path, record.raw, changed), { code: "ACCESS_DENIED" });
  assert.equal(journal(f.root).intents.length, 0); assert.equal(journal(f.root).receipts.length, 0);
});
