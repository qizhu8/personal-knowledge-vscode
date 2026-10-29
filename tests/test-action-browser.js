const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
let listener, disposal, trusted = true, healthy = true;
let domains = ["automation"], nextResult = { ok: true, requests: [] };
let storePath = "/isolated/test/store";
let workspaceRoots = { linux: root };
const commands = new Map(), executions = [], serviceCalls = [], replies = [];
const baselineEvents = [];
let profiling = false;
let serviceHook;
let accelerateReviewTimeout = false;
let confirmationHook;
const disposable = { dispose() {} };
const authoringRequests = {
  group_create: { name: "Tools", parent: "" },
  action_rename: { action_id: "test.authoring", name: "Renamed" },
  action_move: { action_id: "test.authoring", category: "Tools" },
  action_delete: { action_id: "test.authoring", content_hash: "pinned" },
  definition_read: { action_id: "test.authoring" },
  definition_save: { action_id: "test.authoring", content_hash: "pinned", definition: { action_id: "test.authoring", version: 2 } },
  source_read: { action_id: "test.authoring", filename: "/host/source.py" },
  source_save: { action_id: "test.authoring", filename: "/host/source.py", content: "print(1)", source_hash: "pinned-source" },
};
const webview = { cspSource: "vscode-webview:", html: "", asWebviewUri: uri => String(uri),
  onDidReceiveMessage(callback) { listener = callback; return disposable; },
  async postMessage(message) { replies.push(message); if (message.progress?.confirmation) confirmationHook?.(message.progress.confirmation, message); } };
const vscode = {
  version: "1.100.0",
  lm: {}, LanguageModelChatMessage: {}, CancellationTokenSource: class {}, ProgressLocation: {},
  env: { async asExternalUri(uri) { return uri; }, async openExternal(uri) { executions.push(["external", String(uri)]); return true; } },
  workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: key => key === "loadProfilingEnabled" ? profiling : workspaceRoots,
    async update(key, value, target) { assert.strictEqual(key, "actions.workspaceRoots"); assert.strictEqual(target, 1); workspaceRoots = value; } }) },
  chat: { createChatParticipant() { throw Error("Deprecated Chat Participants must not be registered"); } },
  commands: { registerCommand(id, callback) { commands.set(id, callback); return disposable; },
    async executeCommand(...args) { executions.push(args); } },
  window: { createWebviewPanel: () => ({ webview, onDidDispose(callback) { disposal = callback; }, ...disposable }),
    showQuickPick() { throw Error("User choices must be in chat"); },
    showInformationMessage() { throw Error("User choices must be in chat"); },
    showInputBox() { throw Error("User choices must be in chat"); } },
  ViewColumn: { One: 1 }, Uri: { joinPath: (...parts) => parts.join("/"), parse: value => value },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ""; } appendText(text) { this.value += text; return this; }
    appendMarkdown(text) { this.value += text; return this; } },
};
const moduleExports = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "dist", "ui", "action-browser.js"), "utf8"), {
  exports: moduleExports, require(name) {
    if (name === "vscode") return vscode;
    if (name === "../knowledge/filestore") return { getStorePath: () => storePath };
    if (name === "../knowledge/knowledge-locator") return require("../dist/knowledge/knowledge-locator");
    if (name === "../runtime/action-workbench-server") return require("../dist/runtime/action-workbench-server");
    if (name === "../runtime/pkm-baseline") return { recordBaselineEvent(directory, enabled, event) {
      if (enabled) baselineEvents.push(event);
    } };
    if (name === "../mcp/mcp") return { configuredMcpFeatureDomains: () => domains,
      mcpRuntimeStatus: () => ({ healthy, python: "/managed/python", error: "Runtime unavailable" }), writeActionWorkspaceConfig() {} };
    if (name === "child_process") return { execFile(program, args, options, callback) {
      assert.strictEqual(program, "/managed/python");
      assert.strictEqual(args[2], "/isolated/test/store");
      assert.strictEqual(options.windowsHide, true);
      return { stdin: { end(input) { const request=JSON.parse(input);serviceCalls.push(request);serviceHook?.(request);callback(null, JSON.stringify(nextResult)); } } };
    } };
    return require(name);
  }, process, console, URL, setTimeout: (callback, delay) => setTimeout(callback, accelerateReviewTimeout && delay === 180000 ? 5 : delay), clearTimeout,
});

(async () => {
  const context = { extensionUri: root, extensionPath: root, globalStorageUri: { fsPath: "/isolated/global" }, subscriptions: [] };
  moduleExports.initializeActionCommands(context);
  const manifest = require("../package.json");
  assert.strictEqual(manifest.contributes.chatParticipants, undefined);
  assert(manifest.contributes.mcpServerDefinitionProviders.some(provider => provider.id === "personalKnowledge.pkm"));
  const runId = "action_run_" + "a".repeat(32), requestId = "choice_" + "b".repeat(32);
  nextResult = { ok: true };
  const beforeChoiceAnswer = executions.length;
  await commands.get("personalKnowledge.answerActionChoice")(runId, requestId, 1);
  assert.deepStrictEqual(serviceCalls.at(-1), { method: "answer_choice", params: { run_id: runId, request_id: requestId, index: 1 } });
  assert.strictEqual(executions.length, beforeChoiceAnswer, "answer must not navigate to deprecated native Chat");
  assert(webview.html.includes(runId), "answer must open Workbench for the original Run");
  await assert.rejects(commands.get("personalKnowledge.answerActionChoice")(runId, requestId, -1), /Invalid/);
  trusted = false;
  await assert.rejects(commands.get("personalKnowledge.answerActionChoice")(runId, requestId, 1), /trusted/);
  trusted = true;
  const beforeLibraryNavigation = executions.length;
  const beforeLibraryHtml = webview.html;
  moduleExports.openActionLibrary(context);
  assert.strictEqual(executions.length, beforeLibraryNavigation + 1);
  assert.strictEqual(executions.at(-1)[0], "personalKnowledge.openEmbeddedActionLibrary");
  assert.strictEqual(webview.html, beforeLibraryHtml, "Library must not create another editor webview");
  const libraryHtml = moduleExports.renderEmbeddedActionLibrary(context, { knowledgeRoot: storePath, selection: "test.authoring", query: "</script>" });
  assert.match(libraryHtml, /<title>Action Library<\/title>/);
  assert(!libraryHtml.includes('id="canvas"'));
  assert.match(libraryHtml, /script-src 'nonce-[a-f0-9]+'/);
  assert.match(libraryHtml, /\\u003c\/script>/);
  assert.match(libraryHtml, /knowledgeRoot:"\/isolated\/test\/store"/);
  const foreignLibrary = moduleExports.renderEmbeddedActionLibrary(context, { knowledgeRoot: "/other-root", launch: { run_id: "foreign-run" } });
  assert(!foreignLibrary.includes("foreign-run"), "another Root's launch must not resume observation");
  const workbenchListener = listener;
  listener = message => moduleExports.handleActionLibraryMessage(context, { knowledgeRoot: "/isolated/test/store", ...message }, reply => replies.push(reply));
  nextResult = { ok: true, actions: [{ action_id: "test.authoring" }], proposals: [{ proposal_id: "hidden" }], pending_admissions: ["hidden"] };
  await listener({ requestId: "library-catalog", method: "catalog" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(replies.at(-1).result)), { ok: true, actions: [{ action_id: "test.authoring" }] });
  for (const method of ["validate", "group_create", "source_save", "qualification_admit", "proposal_decide"]) {
    const before = serviceCalls.length;
    await listener({ requestId: "library-blocked", method, params: {} });
    assert.strictEqual(serviceCalls.length, before);
    assert.match(replies.at(-1).result.error, /Workbench/);
  }
  await listener({ requestId: "library-pending", method: "library_get", params: { action_id: "pending.action" } });
  assert.match(replies.at(-1).result.error, /not admitted/);
  await listener({ requestId: "library-explicit", method: "open_workbench", params: { action_id: "test.authoring" } });
  assert.strictEqual(executions.at(-1)[0], "personalKnowledge.openEmbeddedActions");
  assert.strictEqual(executions.at(-1)[1].actionId, "test.authoring");
  storePath = "/changed-root";
  await listener({ requestId: "library-root", method: "catalog" });
  assert.match(replies.at(-1).result.error, /Root changed/);
  storePath = "/isolated/test/store";
  await listener({ requestId: "library-no-root", knowledgeRoot: undefined, method: "call" });
  assert.match(replies.at(-1).result.error, /Root changed/);
  listener = workbenchListener;
  moduleExports.openActionWorkbench(context, runId, undefined, true);
  assert.strictEqual(executions.at(-1)[0], "personalKnowledge.openEmbeddedActions", "legacy commands focus the embedded view");
  assert.strictEqual(executions.at(-1)[1].runId, runId);
  const embedded = moduleExports.renderEmbeddedActionWorkbench(webview, context, {currentRun:runId, graph:{name:"</script>"}});
  assert.match(embedded, /channel:'pkm-actions'/);
  assert.match(embedded, /font-src data:/);
  assert.match(embedded, /data:font\/ttf;base64,/);
  assert(!embedded.includes('<link rel="stylesheet"'), "sandboxed icons must not depend on external stylesheet/font CORS");
  assert.match(fs.readFileSync(path.join(root, "src/webview/panel.html"), "utf8"), /font-src data:/,
    "the inherited parent policy must also permit the embedded icon font");
  assert.match(embedded, /open-browser/);
  assert(!embedded.includes('name:"</script>"'));
  trusted = false;
  assert.throws(()=>moduleExports.renderEmbeddedActionWorkbench(webview, context, {}), /trusted/);
  trusted = true;
  moduleExports.openActionWorkbenchTab(context);
  assert.match(webview.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.match(webview.html, /<script nonce="[a-f0-9]+">/);
  assert.strictEqual((webview.html.match(/<script>/g)||[]).length, 0, "every Workbench script must be nonce bound");
  moduleExports.openActionWorkbenchTab(context, undefined, undefined, true);
  assert(webview.html.includes("libraryOpen:true"), "main Library entry opens the searchable catalog, not an empty graph");
  assert.match(webview.html, /data:font\/ttf;base64,/);
  assert.match(webview.html, /font-src data:/);
  moduleExports.openActionWorkbenchTab(context, runId);
  assert(webview.html.includes(`currentRun:"${runId}"`), "Project source link preselects the exact Action Run in the real Workbench");
  profiling = true;
  nextResult = { ok: true, execution_ok: true, run_id: runId, state: "running", userState: "Running", launch_reused: false };
  await listener({ requestId: "durable-call", method: "call", params: { key: "same-key" } });
  assert.deepStrictEqual(baselineEvents.map(event => event.kind), ["start-request", "start-success"]);
  nextResult = { ...nextResult, launch_reused: true };
  await listener({ requestId: "durable-duplicate", method: "call", params: { key: "same-key" } });
  assert.strictEqual(baselineEvents.length, 2);
  nextResult = { ok: true, execution_ok: false, run_id: runId, state: "outcome_unknown", userState: "Reconciling" };
  for (const method of ["run", "run", "runs", "recover_runs"]) {
    await listener({ requestId: "durable-" + method, method, params: { run_id: runId } });
    assert.strictEqual(replies.at(-1).result.ok, true);
  }
  assert.deepStrictEqual(baselineEvents.map(event => event.kind), ["start-request", "start-success", "unknown-effect"]);
  assert.ok(baselineEvents.every(event => !JSON.stringify(event).includes(runId)));
  profiling = false;
  nextResult = { ok: true };
  const trustParams={action_id:"test.authoring",content_hash:"a".repeat(64),grant:true};
  nextResult={ok:true,action_id:trustParams.action_id,host:"fixture-host",platform:"Linux",policy_path:"/host/policy.json",
    content_hash:trustParams.content_hash,review_hash:"reviewed",definition:{action_id:trustParams.action_id},implementation:{kind:"program"},files:{}};
  let nativeDecision,nativePrompts=0;
  vscode.window.showWarningMessage=async(title,options,label)=>{
    nativePrompts++;
    assert.match(title,/test.authoring/);
    assert.strictEqual(options.modal,true);
    assert.match(options.detail,/NOT a sandbox/);
    assert.match(options.detail,/fixture-host/);
    assert.match(options.detail,/does not run validation/);
    assert.ok(!options.detail.includes('"implementation"'),"native confirmation uses prose rather than a JSON dump");
    if(nativeDecision==="root-change")storePath="/changed";
    if(nativeDecision==="trust-change")trusted=false;
    return nativeDecision==="cancel"?undefined:label;
  };
  nativeDecision="cancel";
  await listener({requestId:"inspect-canvas",method:"inspect_admission",params:{proposal_id:"proposal_"+"b".repeat(32)}});
  assert.strictEqual(serviceCalls.at(-1).method,"proposal_review");
  assert.strictEqual(nativePrompts,0,"opening the canvas is read-only and never asks for a grant");
  await assert.rejects(moduleExports.actionRequest(context,"inspect_admission",{}),/Unsupported/);
  await listener({requestId:"stale-canvas",method:"review_proposal",params:{
    proposal_id:"proposal_"+"b".repeat(32),grant:true,review_hash:"outdated"}});
  assert.match(replies.at(-1).result.error,/changed since the canvas review/);
  assert.strictEqual(nativePrompts,0,"a stale canvas must fail before native confirmation");
  let beforeTrust=serviceCalls.length;
  await listener({requestId:"trust-cancel",method:"review_host_trust",params:trustParams});
  assert.strictEqual(replies.at(-1).result.cancelled,true);
  assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["host_trust_review"]);
  nativeDecision="grant";
  await listener({requestId:"trust-grant",method:"review_host_trust",params:trustParams});
  assert.deepStrictEqual(serviceCalls.at(-1),{method:"host_trust_update",params:{
    action_id:trustParams.action_id,content_hash:trustParams.content_hash,review_hash:"reviewed",grant:true}});
  await listener({requestId:"trust-revoke",method:"review_host_trust",params:{...trustParams,grant:false}});
  assert.strictEqual(serviceCalls.at(-1).params.grant,false);
  await listener({requestId:"proposal-approve",method:"review_proposal",params:{proposal_id:"proposal_"+"b".repeat(32),grant:true}});
  assert.strictEqual(serviceCalls.at(-1).method,"proposal_decide");
  assert.strictEqual(serviceCalls.at(-1).params.approve,true);
  await listener({requestId:"proposal-reject",method:"review_proposal",params:{proposal_id:"proposal_"+"b".repeat(32),grant:false}});
  assert.strictEqual(serviceCalls.at(-1).params.approve,false);
  let reviewText=JSON.stringify({approved:true,summary:"Fixture code review passed",issues:[]}),modelCalls=0;
  vscode.lm={selectChatModels:async()=>[{id:"fixture",name:"Fixture review agent",vendor:"fixture",maxInputTokens:128000,countTokens:async()=>1000,async sendRequest(){
    modelCalls++;return{text:(async function*(){yield reviewText})()};
  }}]};
  vscode.LanguageModelChatMessage={User:content=>({content})};
  vscode.CancellationTokenSource=class{token={isCancellationRequested:false};cancel(){this.token.isCancellationRequested=true}dispose(){}};
  vscode.ProgressLocation={Notification:15};
  vscode.window.showQuickPick=async items=>items[0];
  vscode.window.withProgress=async(options,callback)=>callback({report(){}});
  let riskDecision="Run these tests";
  const riskNotices=[];
  const previousWarning=vscode.window.showWarningMessage;
  vscode.window.showWarningMessage=async(message,options,...choices)=>{
    assert(!choices.includes("Run these tests"),"Workbench webviews confirm risks with the inline card, not a native modal");
    return previousWarning(message,options,...choices);
  };
  const riskCards=[];
  confirmationHook=(confirmation,message)=>{
    riskCards.push({confirmation,message});riskNotices.push(JSON.stringify(confirmation.items));
    for(const item of confirmation.items)assert.deepStrictEqual(Array.from(Object.keys(item)).sort(),["action_id","content_hash","effects","examples","incomplete","issues","model","summary"]);
    Promise.resolve().then(()=>listener({requestId:"risk-decision",method:"review_decision",params:{decision_id:confirmation.id,run:riskDecision==="Run these tests"}}));
  };
  const savedReviewResult=nextResult;
  nextResult={...nextResult,state:"tested",attempt_id:"attempt_"+"c".repeat(32),definition:{action_id:trustParams.action_id,effects:["pure"]},sources:{},snapshot_hash:"snapshot"};
  beforeTrust=serviceCalls.length;
  await listener({requestId:"review-validate-success",method:"validate",params:trustParams});
  assert.ok(!replies.at(-1).result.error,replies.at(-1).result.error);
  assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["qualification_review","qualification_execute","qualification_admit"]);
  assert.strictEqual(serviceCalls.at(-2).params.report.model,"fixture:fixture");
  assert.strictEqual(modelCalls,1);
  assert.strictEqual(serviceCalls.at(-2).params.report.user_confirmed,true);
  const beforeSelfTestModels=modelCalls;
  nextResult={...nextResult,validation_kind:"environment-self-test"};
  await listener({requestId:"core-self-test",method:"validate",params:trustParams});
  assert.strictEqual(modelCalls,beforeSelfTestModels,"bundled core must not call a model");
  assert.strictEqual(serviceCalls.at(-2).params.report.model,"pkm:environment-self-test");
  delete nextResult.validation_kind;
  let modelSelections=0;
  vscode.window.showQuickPick=async items=>{modelSelections++;return items[0]};
  const beforeBatch=serviceCalls.length;
  let batchReviews=0;
  serviceHook=request=>{
    if(request.method==="qualification_review"){
      batchReviews++;
      nextResult={ok:true,definition:{action_id:request.params.action_id,effects:["pure"]},sources:{},snapshot_hash:"batch-snapshot"};
      reviewText=JSON.stringify(batchReviews===1?{approved:false,summary:"First item rejected",issues:["Missing source"]}:{approved:true,summary:"Second item passed",issues:[]});
    }else if(request.method==="qualification_execute")nextResult={ok:true,state:"tested",attempt_id:"attempt_"+"d".repeat(32)};
    else if(request.method==="qualification_admit")nextResult={ok:true,state:"succeeded"};
  };
  await listener({requestId:"validate-batch",method:"validate_batch",params:{allow_effects:true,items:[
    {action_id:"batch.first",content_hash:"first",proposal_id:"proposal_first"},
    {action_id:"batch.second",content_hash:"second",proposal_id:"proposal_second"},
  ]}});
  assert.strictEqual(modelSelections,1,"a batch selects its model once");
  const batchResult=replies.at(-1).result;
  assert.deepStrictEqual(Array.from(batchResult.results,item=>item.state),["succeeded","succeeded"]);
  assert(riskNotices.some(notice=>notice.includes("Missing source")));
  assert.deepStrictEqual(serviceCalls.slice(beforeBatch).map(item=>item.method),["qualification_review","qualification_review","qualification_execute","qualification_admit","qualification_execute","qualification_admit"],
    "every Action is assessed before any smoke test runs");
  const batchCard=riskCards.at(-1);
  assert.strictEqual(batchCard.message.requestId,"validate-batch");
  assert.deepStrictEqual(Array.from(batchCard.confirmation.items,item=>item.action_id),["batch.first","batch.second"],"a batch asks once for all Actions");
  assert.strictEqual(riskCards.filter(card=>card.message.requestId==="validate-batch").length,1);
  assert.strictEqual(batchCard.message.progress.stage,"Awaiting your confirmation");
  assert.strictEqual(serviceCalls.at(-2).params.proposal_id,"proposal_second");
  const batchProgress = replies.filter(item=>item.requestId==="validate-batch"&&item.progress).map(item=>item.progress);
  assert(batchProgress.some(item=>item.completed===1&&item.result?.state==="succeeded"));
  assert(batchProgress.some(item=>item.action_id==="batch.second"&&item.stage.startsWith("Smoke tests")));
  assert.strictEqual(batchProgress.at(-1).completed,2);
  const originalModels=vscode.lm.selectChatModels;
  const fixtureModel=(await originalModels())[0];
  for(const hangingStage of ["countTokens","sendRequest","stream"]){
    let reviews=0;
    vscode.lm.selectChatModels=async()=>[{...fixtureModel,
      countTokens:async()=>hangingStage==="countTokens"&&++reviews===1?new Promise(()=>{}):1000,
      sendRequest:async()=>{
        if(hangingStage!=="countTokens"&&++reviews===1){
          if(hangingStage==="sendRequest")return new Promise(()=>{});
          return{text:{[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{})})}};
        }
        return fixtureModel.sendRequest();
      }}];
    batchReviews=0;
    const start=serviceCalls.length;
    accelerateReviewTimeout=true;
    await listener({requestId:"timeout-batch-"+hangingStage,method:"validate_batch",params:{allow_effects:true,items:[
      {action_id:"batch.hung",content_hash:"hung"},{action_id:"batch.next",content_hash:"next"},
    ]}});
    accelerateReviewTimeout=false;
    const result=replies.at(-1).result;
    assert.deepStrictEqual(Array.from(result.results,item=>item.state),["succeeded","succeeded"]);
    assert(riskNotices.some(notice=>notice.includes("timed out after 3 minutes")));
    assert.deepStrictEqual(serviceCalls.slice(start).map(item=>item.method),["qualification_review","qualification_review","qualification_execute","qualification_admit","qualification_execute","qualification_admit"]);
    assert.strictEqual(riskCards.at(-1).confirmation.items[0].incomplete,true);
  }
  vscode.lm.selectChatModels=originalModels;
  batchReviews=0;
  const beforeChangedBatch=serviceCalls.length;
  serviceHook=request=>{
    if(request.method==="qualification_review"){
      nextResult={ok:true,definition:{action_id:request.params.action_id,effects:["pure"]},sources:{},snapshot_hash:"batch-snapshot"};
      reviewText=JSON.stringify({approved:true,summary:"Passed",issues:[]});
    }else if(request.method==="qualification_execute"){
      nextResult={ok:true,state:"tested",attempt_id:"attempt_"+"e".repeat(32)};
      storePath="/changed-by-test";
    }
  };
  await listener({requestId:"changed-batch",method:"validate_batch",params:{allow_effects:true,items:[
    {action_id:"batch.first",content_hash:"first"},
    {action_id:"batch.second",content_hash:"second"},
  ]}});
  assert.deepStrictEqual(Array.from(replies.at(-1).result.results,item=>item.state),["failed","failed"]);
  assert.deepStrictEqual(serviceCalls.slice(beforeChangedBatch).map(item=>item.method),["qualification_review","qualification_review","qualification_execute"],
    "Root changes block admission and all subsequent batch execution");
  storePath="/isolated/test/store";
  const callsBeforeInvalidBatch=serviceCalls.length;
  await listener({requestId:"invalid-batch",method:"validate_batch",params:{allow_effects:false,items:[{action_id:"batch.first",content_hash:"first"}]}});
  assert.match(replies.at(-1).result.error,/approve this batch/);
  assert.strictEqual(serviceCalls.length,callsBeforeInvalidBatch);
  await assert.rejects(moduleExports.actionRequest(context,"validate_batch",{}),/Unsupported/,"generic agent dispatch cannot authorize a batch");
  vscode.window.showQuickPick=async()=>undefined;
  await listener({requestId:"cancel-batch",method:"validate_batch",params:{allow_effects:true,items:[{action_id:"batch.first",content_hash:"first"}]}});
  assert.strictEqual(replies.at(-1).result.cancelled,true);
  assert.strictEqual(serviceCalls.length,callsBeforeInvalidBatch+1,"cancelled model selection reads only the pinned review, never executes");
  serviceHook=undefined;
  nextResult={...savedReviewResult,state:"tested",attempt_id:"attempt_"+"c".repeat(32),definition:{action_id:trustParams.action_id,effects:["pure"]},sources:{},snapshot_hash:"snapshot"};
  vscode.window.showQuickPick=async items=>items[0];
  reviewText=JSON.stringify({approved:true,summary:"Fixture code review passed",issues:[]});
  serviceHook=request=>{if(request.method==="qualification_execute")trusted=false};
  beforeTrust=serviceCalls.length;
  await listener({requestId:"trust-changed-after-tests",method:"validate",params:trustParams});
  assert.match(replies.at(-1).result.error,/trusted/);
  assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["qualification_review","qualification_execute"]);
  trusted=true;serviceHook=undefined;
  for(const output of [JSON.stringify({approved:false,summary:"Unsafe test",issues:["Writes production data"]}),"not JSON",
    JSON.stringify({approved:true,summary:"Contradictory verdict",issues:["Unresolved issue"]})]){
    reviewText=output;beforeTrust=serviceCalls.length;
    riskDecision=undefined;
    await listener({requestId:"risk-cancel",method:"validate",params:trustParams});
    assert.strictEqual(replies.at(-1).result.cancelled,true);
    assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["qualification_review"]);
    riskDecision="Run these tests";
    await listener({requestId:"risk-confirm",method:"validate",params:trustParams});
    assert.ok(!replies.at(-1).result.error,replies.at(-1).result.error);
    assert.strictEqual(serviceCalls.at(-2).params.report.user_confirmed,true);
  }
  {
    const cardsBefore=riskCards.length,warning=vscode.window.showWarningMessage,nativeTitles=[];
    vscode.window.showWarningMessage=async(message,options,...choices)=>{
      if(choices.includes("Run these tests")){nativeTitles.push(message);assert.match(options.detail,/Contradictory verdict/);return "Run these tests"}
      return warning(message,options,...choices);
    };
    const externalBefore=executions.length;
    await moduleExports.openActionWorkbenchInBrowser(context);
    const opened=new URL(executions.slice(externalBefore).find(entry=>entry[0]==="external")[1]);
    const token=new URLSearchParams(opened.hash.slice(1)).get("token");
    beforeTrust=serviceCalls.length;
    const response=await fetch(opened.origin+"/api",{method:"POST",headers:{Origin:opened.origin,"Content-Type":"application/json",Authorization:"Bearer "+token},
      body:JSON.stringify({method:"validate",params:trustParams})});
    const browserResult=await response.json();
    assert.ok(!browserResult.error,browserResult.error);
    assert.deepStrictEqual(nativeTitles,["Run tests for "+trustParams.action_id+"?"],"browser Workbench has no progress channel, so it keeps the native confirmation");
    assert.strictEqual(riskCards.length,cardsBefore);
    assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["qualification_review","qualification_execute","qualification_admit"]);
    vscode.window.showWarningMessage=warning;
  }
  vscode.window.showQuickPick=async()=>undefined;beforeTrust=serviceCalls.length;
  await listener({requestId:"review-model-cancel",method:"validate",params:trustParams});
  assert.strictEqual(replies.at(-1).result.cancelled,true);
  assert.deepStrictEqual(serviceCalls.slice(beforeTrust).map(call=>call.method),["qualification_review"]);
  nextResult=savedReviewResult;
  for(const method of ["host_trust_review","host_trust_update","proposal_review","proposal_decide","qualification_review","qualification_execute","qualification_admit"]){
    beforeTrust=serviceCalls.length;
    await listener({requestId:"bypass-"+method,method,params:trustParams});
    assert.match(replies.at(-1).result.error,/local operator review/);
    assert.strictEqual(serviceCalls.length,beforeTrust);
    await assert.rejects(moduleExports.actionRequest(context,method,trustParams),/Unsupported Action operation/);
    assert.strictEqual(serviceCalls.length,beforeTrust,"generic Chat/agent dispatch cannot mutate host trust");
  }
  nativeDecision="root-change";
  await listener({requestId:"trust-root",method:"review_host_trust",params:trustParams});
  assert.match(replies.at(-1).result.error,/Knowledge Root changed/);
  assert.strictEqual(serviceCalls.at(-1).method,"host_trust_review");
  storePath="/isolated/test/store";nativeDecision="trust-change";
  await listener({requestId:"trust-workspace",method:"review_host_trust",params:trustParams});
  assert.match(replies.at(-1).result.error,/trusted/);
  assert.strictEqual(serviceCalls.at(-1).method,"host_trust_review");
  trusted=true;nextResult={ok:true};
  for (const [method, params] of Object.entries(authoringRequests)) {
    await listener({ requestId: "native-" + method, method, params });
    assert.strictEqual(replies.at(-1).result.ok, true);
    assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
  }
  for (const method of ["library_get", "checkpoints", "respond_checkpoint", "schedule_run", "wake_run", "reconcile_run", "safety_scan", "associate_project"]) {
    const params = method === "safety_scan" ? {} : { run_id: runId };
    await listener({ requestId: "p3-" + method, method, params });
    assert.strictEqual(replies.at(-1).result.ok, true);
    assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
  }
  const beforeOpenProject = serviceCalls.length;
  await listener({ requestId: "p2-open", method: "open_project", params: { run_id: runId } });
  assert.strictEqual(replies.at(-1).result.ok, true);
  assert.deepStrictEqual(executions.at(-1), ["personalKnowledge.openActionRunProject", runId]);
  assert.strictEqual(serviceCalls.length, beforeOpenProject, "Project route does not call the Python executor");
  await listener({ requestId: "p2-invalid", method: "open_project", params: { run_id: "../wrong" } });
  assert.match(replies.at(-1).result.error, /Invalid Action Run/);
  trusted = false;
  const beforeAuthoring = serviceCalls.length;
  await listener({ requestId: "native-untrusted-source", method: "source_save", params: authoringRequests.source_save });
  assert.match(replies.at(-1).result.error, /trusted/);
  assert.strictEqual(serviceCalls.length, beforeAuthoring);
  await listener({ requestId: "p2-untrusted", method: "open_project", params: { run_id: runId } });
  assert.match(replies.at(-1).result.error, /trusted/);
  trusted = true;
  const beforeShowChoices = executions.length;
  await listener({ requestId: "1", method: "show_choices", params: { run_id: runId } });
  assert.strictEqual(replies.at(-1).result.inline_chat, true);
  assert.strictEqual(executions.length, beforeShowChoices);
  await listener({ requestId: "invalid-choices", method: "show_choices", params: { run_id: "invalid" } });
  assert.match(replies.at(-1).result.error, /Invalid Action Run/);
  await listener({ requestId: "2", method: "unknown", params: {} });
  assert.strictEqual(replies.at(-1).result.ok, false);
  domains = [];
  await listener({ requestId: "3", method: "catalog" });
  assert.match(replies.at(-1).result.error, /automation/);
  domains = ["automation"]; healthy = false;
  await listener({ requestId: "4", method: "catalog" });
  assert.match(replies.at(-1).result.error, /Runtime unavailable/);
  healthy = true;
  vscode.version = "1.90.0";
  moduleExports.initializeActionCommands(context);
  const beforeFallback = executions.length;
  await listener({ requestId: "5", method: "show_choices", params: { run_id: runId } });
  assert.strictEqual(replies.at(-1).result.inline_chat, true);
  await commands.get("personalKnowledge.answerActionChoice")(runId, requestId, 1);
  assert.strictEqual(executions.length, beforeFallback);
  disposal();
  const { createActionWorkbenchServer } = require("../dist/runtime/action-workbench-server");
  const browserServer = await createActionWorkbenchServer({ extensionPath: root,
    async request(method, params) { if (method === "access") return { ok: true }; return { ok: true, method, params }; } });
  try {
    const url = new URL(browserServer.url), token = new URLSearchParams(url.hash.slice(1)).get("token");
    browserServer.setDraft({ action_id: "draft.test" });
    const page = await fetch(url.origin);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok(!(await page.text()).includes(token));
    const font = await fetch(url.origin + "/codicon.ttf?cache=font-version");
    assert.strictEqual(font.status, 200);
    assert.strictEqual(font.headers.get("content-type"), "font/ttf");
    const headers = { Origin: url.origin, "Content-Type": "application/json", Authorization: "Bearer " + token };
    const body = JSON.stringify({ method: "session", params: {} });
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers: { ...headers, Authorization: "" }, body })).status, 403);
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin + "/api", { method: "POST", headers: { ...headers, Host: "evil.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end(body);
    });
    assert.strictEqual(forgedHostStatus, 403);
    browserServer.allowOrigin("https://forwarded.example");
    const forwardedStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin + "/api", { method: "POST",
        headers: { ...headers, Host: "forwarded.example", Origin: "https://forwarded.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end(body);
    });
    assert.strictEqual(forwardedStatus, 200);
    assert.deepStrictEqual((await (await fetch(url.origin + "/api", { method: "POST", headers, body })).json()).draft, { action_id: "draft.test" });
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
    assert.strictEqual((await fetch(url.origin + "/missing")).status, 404);
    const malformedStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin, { path: "http://[", method: "GET" }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end();
    });
    assert.strictEqual(malformedStatus, 400);
    assert.strictEqual((await fetch(url.origin)).status, 200);
  } finally { browserServer.dispose(); }
  try {
    await listener({ requestId: "6", method: "open_browser", params: { draft: { graph: { action_id: "handoff.test", nodes: [], edges: [] } } } });
    assert.strictEqual(replies.at(-1).result.ok, true);
    const url = new URL(executions.at(-1)[1]);
    const headers = { Origin: url.origin, "Content-Type": "application/json", Authorization: "Bearer " + new URLSearchParams(url.hash.slice(1)).get("token") };
    const call = async (method, params = {}) => (await fetch(url.origin + "/api", { method: "POST", headers, body: JSON.stringify({ method, params }) })).json();
    assert.strictEqual((await call("session")).draft.graph.action_id, "handoff.test");
    nextResult = { ok: true, actions: [], module_sets: [], queue: { jobs: [] } };
    assert.strictEqual((await call("catalog")).workspace_root, root);
    assert.strictEqual(serviceCalls.at(-1).method, "catalog");
    assert.strictEqual((await call("workspace", { root })).workspace_root, root);
    assert.match((await call("workspace", { root: "relative/path" })).error, /absolute directory/);
    await call("import", { local_path: "/host/selected.pkm-actions" });
    assert.strictEqual(serviceCalls.at(-1).params.local_path, "/host/selected.pkm-actions");
    await call("export", { destination: "/host/export.pkm-actions" });
    assert.strictEqual(serviceCalls.at(-1).params.destination, "/host/export.pkm-actions");
    for (const [method, params] of Object.entries(authoringRequests)) {
      assert.strictEqual((await call(method, params)).ok, true);
      assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
    }
    assert.match((await call("unknown")).error, /Unsupported/);
    trusted = false;
    assert.match((await call("catalog")).error, /trusted/);
    trusted = true; domains = [];
    assert.match((await call("catalog")).error, /automation/);
    domains = ["automation"]; healthy = false;
    assert.match((await call("session")).error, /Runtime unavailable/);
    healthy = true; storePath = "/changed/store";
    assert.match((await call("catalog")).error, /Knowledge Root changed/);
    storePath = "/isolated/test/store";
  } finally { context.subscriptions.forEach(item => item.dispose()); }
  console.log("Action Workbench choice routing, no deprecated Chat Participant, managed runtime, access gates, CSP and message dispatch passed");
})().catch(error => { console.error(error); process.exitCode = 1; });