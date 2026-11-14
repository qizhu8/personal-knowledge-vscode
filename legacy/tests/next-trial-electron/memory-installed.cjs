"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const sha = value => createHash("sha256").update(value).digest("hex");
const metadata = file => {
  const stat = fs.lstatSync(file);
  return { inode: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs };
};

exports.run = async ({ root, node, python, extensionPath, legacy, vscode, children, traffic }) => {
  const installedExtension = vscode.extensions.getExtension("Uone.personal-knowledge");
  assert(installedExtension, "The production PKM extension must be installed in this Extension Host");
  await installedExtension.activate();
  assert((await vscode.commands.getCommands(true)).includes("personalKnowledge.nextTrialMemoryReadopt"),
    "The installed Extension Host must register the Memory re-adoption command");

  const fixture = path.join(root, "memory-installed");
  const source = path.join(fixture, "source"), parent = path.join(fixture, "import");
  const database = path.join(fixture, "closed-original.sqlite3"), target = path.join(parent, "workspace");
  const backup = path.join(fixture, "backup"), restored = path.join(fixture, "restored");
  for (const directory of [source, parent]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, "notes"));
  const sourceNote = path.join(source, "notes", "Synthetic.md");
  fs.writeFileSync(sourceNote, "---\ntitle: Memory fixture\n---\nOnly synthetic source content.\n");
  const scope = JSON.stringify({ account: "synthetic-original", project: "fixture-project", repository: "fixture-repository" });
  const foreign = JSON.stringify({ account: "synthetic-foreign", project: "foreign", repository: "foreign" });
  const references = [{ id: "s", chat: "c", revision: "r", locator: "l" }];
  const id = `explicit-${sha(`${scope}\0proposal`)}`;
  const foreignId = `explicit-${sha(`${foreign}\0foreign`)}`;
  const run = (command, args) => execFileSync(command, args, {
    cwd: fixture, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000,
  }).trim();
  run(python, ["-I", "-B", "-c", `
import hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from pkm_memory_engine import Engine
engine=Engine(sys.argv[2],"synthetic-engine")
for scope,operation in [(sys.argv[3],"proposal"),(sys.argv[4],"foreign")]:
    memory_id="explicit-"+hashlib.sha256((scope+"\\0"+operation).encode()).hexdigest()
    engine.mutate(operation,"explicit_propose",{"id":memory_id,"scope":scope,"content":"Synthetic original fact","sources":json.loads(sys.argv[5])})
    engine.mutate(operation+"-confirm","explicit_confirm",{"id":memory_id,"scope":scope,"expected_revision":1,
        "host_authorization":{"decision_id":"synthetic-historical-decision","actor_id":"human:synthetic"}})
engine.close()
`, path.join(extensionPath, "next-runtime/server/compute"), database, scope, foreign, JSON.stringify(references)]);
  fs.chmodSync(database, 0o600);
  const originalDatabase = fs.readFileSync(database), originalNote = fs.readFileSync(sourceNote);
  const databaseMetadata = metadata(database), noteMetadata = metadata(sourceNote);
  for (const suffix of ["-wal", "-shm"]) assert(!fs.existsSync(database + suffix), "Original Engine must be closed");

  const { NextManagedClient } = require(path.join(extensionPath, "dist/runtime/next-managed-client.js"));
  const originalInvoke = NextManagedClient.prototype.invoke, originalResume = NextManagedClient.prototype.resumeImport;
  const originalOpenMemory = NextManagedClient.prototype.openMemoryWorkspace;
  const originalOpen = vscode.window.showOpenDialog, originalPick = vscode.window.showQuickPick;
  const originalWarning = vscode.window.showWarningMessage, originalInput = vscode.window.showInputBox;
  const originalError = vscode.window.showErrorMessage, originalShow = vscode.window.showTextDocument;
  let attachedClient, resumedClient, restoredClient, restoredDefaultDenied = false;
  let adoptionCount = 0, adoptionDetail = "", declineReadoption = false, declinedReadoptionDetail = "", searchDocument, error;
  const readoptionDetails = [];
  const dialogs = [source, parent, node, python, database, node];
  const beginning = traffic.length, oldChildren = children.length;
  NextManagedClient.prototype.invoke = function (operation, args) {
    if (operation === "memory-search" && !attachedClient) attachedClient = this;
    return originalInvoke.call(this, operation, args);
  };
  NextManagedClient.prototype.resumeImport = async function (...args) {
    resumedClient = this;
    return originalResume.apply(this, args);
  };
  NextManagedClient.prototype.openMemoryWorkspace = async function (...args) {
    restoredClient = this;
    await originalOpenMemory.apply(this, args);
    const start = traffic.length;
    await assert.rejects(this.invoke("memory-get", { id }), /outcome unknown/i);
    assert(traffic.slice(start).some(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.error === "NOT_AVAILABLE"));
    restoredDefaultDenied = true;
  };
  vscode.window.showOpenDialog = async options => {
    assert(dialogs.length, `Unexpected dialog: ${options.openLabel}`);
    return [vscode.Uri.file(dialogs.shift())];
  };
  vscode.window.showQuickPick = async (choices, options) => {
    if (options?.placeHolder?.startsWith("Optional original Memory SQLite")) {
      assert(choices.includes("Select closed original Memory Engine COPY"));
      return "Select closed original Memory Engine COPY";
    }
    if (options?.placeHolder?.startsWith("Explicitly adopt ONE original scope")) {
      assert(choices.includes(scope) && choices.includes(foreign));
      return scope;
    }
    if (options?.placeHolder === "Imported static copy (read-only)") return undefined;
    throw new Error(`Unexpected Memory trial choice: ${options?.placeHolder}`);
  };
  vscode.window.showWarningMessage = async (message, options, ...items) => {
    if (message.startsWith("Assert this is a static legacy COPY")) {
      assert(options.modal); return "I Assert Static Copy";
    }
    if (message.startsWith("Import this static copy using the exact displayed plan digest")) {
      assert(options.modal); assert.match(options.detail, /Blockers:\nNone/);
      return "Import Exact Plan";
    }
    if (message === "Adopt this exact original Memory scope for this isolated host session?") {
      assert(options.modal && items.includes("Adopt Exact Memory Scope"));
      assert.match(options.detail, /NOT original-owner proof/);
      assert.match(options.detail, /not activated after restart or restore/);
      adoptionCount++;
      adoptionDetail = options.detail;
      return "Adopt Exact Memory Scope";
    }
    if (message === "Re-adopt this exact imported Memory scope for a NEW host session?") {
      assert(options.modal && items.includes("Approve New Memory Session"));
      assert.match(options.detail, /NOT original-owner proof/);
      assert.match(options.detail, /no old grant is inherited or extended/);
      if (declineReadoption) {
        declinedReadoptionDetail = options.detail;
        return undefined;
      }
      readoptionDetails.push(options.detail);
      return "Approve New Memory Session";
    }
    if (message === "Enable isolated_experiment writing for this copy?") {
      assert(options.modal); return "Enable Isolated Experiment";
    }
    if (message === "Resume the saved isolated_experiment?") {
      assert(options.modal); return "Resume Isolated Experiment";
    }
    return originalWarning(message, options, ...items);
  };
  vscode.window.showInputBox = async options => {
    if (options?.prompt === "Search the explicitly adopted original Memory scope (optional)") return "Synthetic";
    if (options?.prompt === "Search the explicitly re-adopted Memory scope (optional)") return "Synthetic";
    if (options?.prompt === "Type the exact target path to authorize this isolated experiment") return target;
    throw new Error(`Unexpected Memory trial input: ${options?.prompt}`);
  };
  vscode.window.showErrorMessage = async message => { error = String(message); };
  vscode.window.showTextDocument = async function (document, ...args) {
    if (document.languageId === "json") searchDocument = document.getText();
    return originalShow.call(this, document, ...args);
  };
  try {
    await vscode.commands.executeCommand("personalKnowledge.nextTrialImport");
    assert.equal(error, undefined, error);
    assert(attachedClient && children.length === oldChildren + 1, "Real production trial must attach and search Memory");
    assert.equal(adoptionCount, 1, "The real host must request one explicit scope adoption");
    const importTraffic = traffic.slice(beginning);
    const selected = importTraffic.find(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.result?.plan?.memoryPlan?.continuityScopeSha256 === sha(scope))?.message.result.plan;
    const request = importTraffic.find(item => item.direction === "receive" && item.message.type === "memory-scope-approval-request")?.message;
    const decision = importTraffic.find(item => item.direction === "send" && item.message.type === "memory-scope-approval-result")?.message;
    const receipt = importTraffic.find(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.result?.receipt?.memoryImport)?.message.result.receipt;
    const pin = importTraffic.find(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.result?.pin?.schema === "pkm.memory-host-pin/v1")?.message.result.pin;
    assert(selected && request && decision?.approval && receipt && pin, "Expected real planner, host approval IPC, receipt and host pin enrollment");
    assert.equal(request.envelope.target, target);
    assert.equal(request.envelope.request.scope, scope);
    assert.equal(request.envelope.request.actorId, "local:owner");
    assert.equal(request.envelope.request.sourceScopeSha256, sha(scope));
    assert.equal(request.envelope.request.sourceDatabaseSha256, sha(originalDatabase));
    assert.equal(request.envelope.request.importPlanSha256, selected.planSha256);
    assert.equal(request.envelope.request.importReceiptSha256, receipt.memoryImport.receiptSha256);
    assert.equal(receipt.memoryScopeContinuity.decisionId, decision.approval.decisionId);
    assert.equal(receipt.memoryScopeContinuity.scope, scope);
    assert.equal(pin.workspaceId, receipt.memoryScopeContinuity.workspaceId);
    assert.equal(pin.sourceScopeSha256, sha(scope));
    assert.equal(pin.sourceDatabaseSha256, sha(originalDatabase));
    assert.equal(pin.importPlanSha256, selected.planSha256);
    assert.equal(pin.importReceiptSha256, receipt.memoryImport.receiptSha256);
    assert.match(pin.receiptStateSha256, /^[a-f0-9]{64}$/);
    for (const value of [target, scope, selected.planSha256, receipt.memoryImport.receiptSha256, sha(originalDatabase)])
      assert(adoptionDetail.includes(value), "Confirmation must display the bound host evidence");
    const searched = JSON.parse(searchDocument);
    assert(searched.records.some(record => record.id === id));
    assert(!searched.records.some(record => record.id === foreignId));
    const record = await attachedClient.invoke("memory-get", { id });
    assert.equal(record.scope, scope);
    const audit = await attachedClient.invoke("memory-audit", { id });
    assert.equal(audit.events[1].decision_id, "synthetic-historical-decision");
    const replay = await attachedClient.invoke("memory-replay", { operation: "memory.record.propose",
      arguments: { content: "Synthetic original fact", sources: references, operation_id: "proposal" } });
    assert.equal(replay.status, "pending");
    await assert.rejects(attachedClient.invoke("memory-get", { id: foreignId }), /outcome unknown/i);
    const deniedMemoryStart = traffic.length;
    await assert.rejects(attachedClient.invoke("memory-propose", { content: "Must not be written" }),
      /read-only document\/resource reads only/i);
    assert.equal(traffic.length, deniedMemoryStart, "Imported Memory permits no mutation request");
    const assertReadoption = (start, expectedTarget, detail, previousDecisions) => {
      const items = traffic.slice(start);
      const evidence = items.find(item => item.direction === "receive" &&
        item.message.type === "result" && item.message.result?.pin?.schema === "pkm.memory-host-pin/v1")?.message.result;
      const approvalRequest = items.find(item => item.direction === "receive" && item.message.type === "memory-scope-approval-request")?.message;
      const approval = items.find(item => item.direction === "send" && item.message.type === "memory-scope-approval-result")?.message;
      assert(evidence && approvalRequest && approval?.approval, "Re-adoption must use production host evidence and approval IPC");
      assert.equal(evidence.target, expectedTarget);
      assert.deepEqual(evidence.pin, pin, "Independent host pin must match the resumed/restored workspace");
      assert.equal(approvalRequest.envelope.target, expectedTarget);
      assert.equal(approvalRequest.envelope.receiptStateSha256, pin.receiptStateSha256);
      assert.equal(approvalRequest.envelope.request.scope, scope);
      assert.equal(approvalRequest.envelope.request.importReceiptSha256, pin.importReceiptSha256);
      assert(!previousDecisions.includes(approval.approval.decisionId), "A fresh host session requires a new decision");
      for (const value of [expectedTarget, pin.workspaceId, scope, pin.sourceDatabaseSha256,
        pin.importPlanSha256, pin.importReceiptSha256, pin.receiptStateSha256]) assert(detail.includes(value));
      const hits = JSON.parse(searchDocument).records;
      assert(hits.some(item => item.id === id) && !hits.some(item => item.id === foreignId));
      return approval.approval.decisionId;
    };

    await vscode.commands.executeCommand("personalKnowledge.nextTrialEnableWrite");
    assert.equal(error, undefined, error);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    assert.equal(error, undefined, error);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialResumeWrite");
    assert.equal(error, undefined, error);
    assert(resumedClient && resumedClient !== attachedClient, "Resume must use a fresh managed client");
    const resumeTraffic = traffic.length;
    await assert.rejects(resumedClient.invoke("memory-get", { id }), /outcome unknown/i);
    assert(traffic.slice(resumeTraffic).some(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.error === "NOT_AVAILABLE"),
    "Restarted child must deny Memory without a new host admission");
    assert.equal(adoptionCount, 1, "Write resume must not silently renew Memory admission");
    const deniedReadoptionStart = traffic.length;
    declineReadoption = true;
    await vscode.commands.executeCommand("personalKnowledge.nextTrialMemoryReadopt");
    declineReadoption = false;
    assert.match(error, /outcome unknown/i);
    error = undefined;
    for (const value of [target, scope, pin.workspaceId, pin.importReceiptSha256])
      assert(declinedReadoptionDetail.includes(value), "Denied approval must still identify the exact requested scope");
    const deniedReadoptionTraffic = traffic.slice(deniedReadoptionStart);
    assert(deniedReadoptionTraffic.some(item => item.direction === "send" &&
      item.message.type === "memory-scope-approval-result" && item.message.approval === null),
    "Declining exact-scope host approval must send an explicit denial");
    const deniedMemoryReadStart = traffic.length;
    await assert.rejects(resumedClient.invoke("memory-get", { id }), /outcome unknown/i);
    assert(traffic.slice(deniedMemoryReadStart).some(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.error === "NOT_AVAILABLE"),
    "Declining re-adoption must leave Memory unavailable");
    const resumeReadoption = traffic.length;
    searchDocument = undefined;
    await vscode.commands.executeCommand("personalKnowledge.nextTrialMemoryReadopt");
    assert.equal(error, undefined, error);
    assert.equal(readoptionDetails.length, 1);
    const resumedDecision = assertReadoption(resumeReadoption, target, readoptionDetails[0], [decision.approval.decisionId]);
    assert.equal((await resumedClient.invoke("memory-get", { id })).scope, scope);
    assert.equal((await resumedClient.invoke("memory-replay", { operation: "memory.record.propose",
      arguments: { content: "Synthetic original fact", sources: references, operation_id: "proposal" } })).status, "pending");
    const deniedWriteStart = traffic.length;
    await assert.rejects(resumedClient.invoke("memory-propose", { content: "Must not be written" }), /outcome unknown/i);
    assert(traffic.slice(deniedWriteStart).some(item => item.direction === "receive" &&
      item.message.type === "result" && item.message.error === "NOT_AVAILABLE"),
    "Re-adoption admits only native reads and existing receipt replay");
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    assert.equal(error, undefined, error);
    assert.deepEqual(dialogs, []);

    const server = path.join(extensionPath, "next-runtime/server");
    run(node, [path.join(server, "dist/cli.js"), "backup", "--data", target, "--destination", backup]);
    assert(fs.existsSync(path.join(backup, ".pkm-workspace-backup.json")), "Real CLI must publish a private backup");
    const backupStat = fs.lstatSync(backup, { bigint: true });
    const restorePin = {
      schema: "pkm.native-restore-authority-request/v1", intent: "workspace-restore",
      actorId: "disposable-fixture-owner", workspaceId: receipt.memoryScopeContinuity.workspaceId,
      sourceRoot: backup, sourceDevice: String(backupStat.dev), sourceInode: String(backupStat.ino),
      manifestSha256: sha(fs.readFileSync(path.join(backup, ".pkm-workspace-backup.json"))),
      destination: restored, backupErasureEpoch: null,
    };
    const probe = JSON.parse(run(node, ["--input-type=module", "-e", `
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {pathToFileURL} from "node:url";
const root=process.argv[1], workspace=process.argv[2], backup=process.argv[3], restored=process.argv[4], python=process.argv[5], id=process.argv[6], pin=JSON.parse(process.argv[7]);
const {readManagedMemory}=await import(pathToFileURL(root+"/dist/managed-memory-reader.js"));
const {openMemoryContinuitySnapshot}=await import(pathToFileURL(root+"/dist/memory-scope-continuity.js"));
const {restoreWorkspaceBackup}=await import(pathToFileURL(root+"/dist/workspace-backup.js"));
const attempt=async fn=>{try {await fn();return "unexpected-success";}catch(e){return e.code || e.message;}};
const read=await attempt(()=>readManagedMemory(workspace,"memory-get",{id}));
const deniedRestore=await attempt(()=>restoreWorkspaceBackup(backup,restored,{pythonExecutable:python}));
assert.equal(deniedRestore,"AUTHORITY_REQUIRED");
assert(!existsSync(restored));
let approvals=0;
const nativeRestoreAuthority={actorId:pin.actorId,authorize(request){
  assert.deepEqual(request,pin); approvals++;
  return {authorityId:"private-synthetic-fixture-owner",actorId:pin.actorId,
    requestSha256:createHash("sha256").update(JSON.stringify(pin)).digest("hex"),
    expiresAt:Date.now()+60000,lineage:"unrelated",trustedEpoch:null};
}};
await restoreWorkspaceBackup(backup,restored,{pythonExecutable:python,nativeRestoreAuthority});
const restoredRead=await attempt(()=>readManagedMemory(restored,"memory-get",{id}));
const db=openMemoryContinuitySnapshot(restored);
let receipt;
try {receipt=db.prepare("SELECT receipt_sha256 FROM legacy_memory_imports WHERE singleton=1").get()?.receipt_sha256;} finally {db.close();}
console.log(JSON.stringify({read,deniedRestore,restoredRead,approvals,receipt}));
`, server, target, backup, restored, python, id, JSON.stringify(restorePin)]));
    assert.equal(probe.read, "NOT_AVAILABLE", "A different native process must not inherit the Memory session");
    assert.equal(probe.deniedRestore, "AUTHORITY_REQUIRED", "Backup alone must not authorize restore");
    assert(probe.approvals > 0, "Restoration must consult the independently pinned synthetic fixture owner");
    assert.equal(probe.restoredRead, "NOT_AVAILABLE", "Restored receipt must not activate a Memory session");
    assert.equal(probe.receipt, receipt.memoryImport.receiptSha256);
    dialogs.push(restored, node);
    const restoreReadoption = traffic.length;
    searchDocument = undefined;
    await vscode.commands.executeCommand("personalKnowledge.nextTrialMemoryReadopt");
    assert.equal(error, undefined, error);
    assert(restoredClient && restoredDefaultDenied, "Restored production client must deny before explicit re-adoption");
    assert.equal(readoptionDetails.length, 2);
    assertReadoption(restoreReadoption, restored, readoptionDetails[1], [decision.approval.decisionId, resumedDecision]);
    assert.equal((await restoredClient.invoke("memory-get", { id })).scope, scope);
    assert.equal((await restoredClient.invoke("memory-audit", { id })).events[1].decision_id, "synthetic-historical-decision");
    assert.equal((await restoredClient.invoke("memory-replay", { operation: "memory.record.propose",
      arguments: { content: "Synthetic original fact", sources: references, operation_id: "proposal" } })).status, "pending");
    assert.deepEqual(dialogs, []);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    assert.equal(error, undefined, error);
    assert.deepEqual(fs.readFileSync(database), originalDatabase, "Closed original Engine must remain unchanged");
    assert.deepEqual(fs.readFileSync(sourceNote), originalNote, "Original synthetic copy must remain unchanged");
    assert.deepEqual(metadata(database), databaseMetadata);
    assert.deepEqual(metadata(sourceNote), noteMetadata);
    for (const suffix of ["-wal", "-shm"]) assert(!fs.existsSync(database + suffix));
    console.log("Trial Electron: installed Memory adoption, reads/receipt, default-denied resume/restore and explicit fresh host re-adoption verified.");
  } finally {
    try { await vscode.commands.executeCommand("personalKnowledge.nextTrialClose"); }
    finally {
      NextManagedClient.prototype.invoke = originalInvoke;
      NextManagedClient.prototype.resumeImport = originalResume;
      NextManagedClient.prototype.openMemoryWorkspace = originalOpenMemory;
      vscode.window.showOpenDialog = originalOpen;
      vscode.window.showQuickPick = originalPick;
      vscode.window.showWarningMessage = originalWarning;
      vscode.window.showInputBox = originalInput;
      vscode.window.showErrorMessage = originalError;
      vscode.window.showTextDocument = originalShow;
    }
  }
};
