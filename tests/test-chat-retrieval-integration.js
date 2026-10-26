const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatKnowledgeRetriever } = require("../dist/chat/chat-knowledge-retriever");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");
const { validChatRetrievalReceipt } = require("../dist/chat/chat-retrieval");

test("feedback manager validates explicit labels and requires positive worker acknowledgement",async()=>{
  const manager=Object.create(RetrievalWorkerManager.prototype);
  manager.ensure=async()=>({});
  let response={ok:false,error:"Feedback rejected."};
  manager.request=async(_endpoint,route,method,body)=>{
    assert.equal(route,"/retrieval-feedback");assert.equal(method,"POST");
    assert.deepEqual(body,{retrieval_id:"receipt",relevant_source_ids:[],complete:true});
    return response;
  };
  await assert.rejects(manager.submitFeedback("",[]),/Invalid explicit/);
  await assert.rejects(manager.submitFeedback("receipt",[""]),/Invalid explicit/);
  await assert.rejects(manager.submitFeedback("receipt",[]),/Feedback rejected/);
  response={};await assert.rejects(manager.submitFeedback("receipt",[]),/not acknowledged/);
  response={ok:true};assert.equal((await manager.submitFeedback("receipt",[])).ok,true);
});

test("Chat dual requests do not enable a model; off/invalid/cancelled status stays explicit", async()=>{
  const snapshot={corpus_revision:"off",documents:[]};
  let response={requestId:"off-query",hits:[],semantic_status:"off",model_invoked:false,readyGeneration:0,corpusRevision:"off"};
  const adapter=createChatKnowledgeRetriever(()=>({
    query:async(query,signal)=>{
      assert.equal(query.route,"dual");assert.equal(query.scope.capabilityId,"pkm-chat-context");
      assert.equal(query.generation.mode,"latest-ready");assert.equal(query.deadlineMs,5000);
      return response;
    },submitFeedback:async()=>{throw new Error("Feedback must not be called automatically");},
  }),()=>snapshot);
  const result=await adapter("query",new AbortController().signal);
  assert.equal(result.invocation.modelInvoked,false);assert.equal(result.invocation.semanticStatus,"off");
  assert.equal(result.invocation.servedRoute,"lexical");assert.equal(result.invocation.retrievalId,undefined);
  response={...response,semantic_status:undefined};
  await assert.rejects(adapter("query",new AbortController().signal),/omitted.*status/);
  const cancellation=new AbortController();cancellation.abort();
  await assert.rejects(adapter("query",cancellation.signal),/cancelled/);
});

test("production Chat adapter uses real worker dual routing, retains feedback identity, trains only explicit judgments and reports fallback", {timeout:60000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-retrieval-chain-"));
  const resources = path.resolve(__dirname, "../resources");
  const fixtureResources = path.join(root, "resources"), state = path.join(root, "state");
  fs.mkdirSync(fixtureResources); fs.mkdirSync(state);
  for (const name of fs.readdirSync(resources).filter(name => /^retrieval.*\.py$/.test(name) || name === "retrieval-default-model.json")) {
    fs.copyFileSync(path.join(resources,name), path.join(fixtureResources,name));
  }
  fs.mkdirSync(path.join(fixtureResources,"vendor"));
  for (const name of fs.readdirSync(path.join(resources,"vendor")).filter(name=>/^adaptive_skill_retrieval-.*\.whl$/.test(name))) {
    fs.copyFileSync(path.join(resources,"vendor",name),path.join(fixtureResources,"vendor",name));
  }
  const pythonFixture = fs.readFileSync(path.join(__dirname,"test-retrieval-learning.py"),"utf8");
  const serving = pythonFixture.match(/FAKE_SERVING = """([\s\S]*?)"""/);
  assert(serving, "reuse the existing synthetic encoder, not real model downloads");
  fs.writeFileSync(path.join(fixtureResources,"retrieval_serving.py"),serving[1]);
  fs.writeFileSync(path.join(state,"serving-release.json"),"{}");
  const snapshot = {corpus_revision:"chat-integration-corpus",documents:Array.from({length:10},(_,index)=>({
    skill_id:`skill:doc-${index}`,source_id:`source-${index}`,source_revision:"1",title:`doc-${index}`,description:"",
    body:"guidance",content_type:"skill",source_uri:`pkm://skills/doc-${index}`,metadata:{},provenance:{provider:"fixture"},
    read_only:false,visibility:"available",links:[],
  }))};
  const manager = new RetrievalWorkerManager(state,path.join(fixtureResources,"retrieval_worker.py"),
    process.env.PKM_RETRIEVAL_TEST_PYTHON || process.env.PYTHON || "python", "0.3.0.dev2026100504");
  t.after(async()=>{
    try {
      if(fs.existsSync(path.join(state,"worker.json"))){
        const endpoint=JSON.parse(fs.readFileSync(path.join(state,"worker.json"),"utf8"));
        await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`,{method:"POST",headers:{"X-PKM-Retrieval-Token":endpoint.token}});
        for(let attempt=0;attempt<200&&fs.existsSync(path.join(state,"worker.json"));attempt++)await new Promise(resolve=>setTimeout(resolve,25));
        assert(!fs.existsSync(path.join(state,"worker.json")),"fixture worker stopped before cleanup");
      }
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  await manager.sync(snapshot);
  let status;
  for(let attempt=0;attempt<200;attempt++){
    status=await manager.status();
    if(status.ready && status.semantic_status === "ready")break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(status.semantic_status,"ready");
  const retrieve = createChatKnowledgeRetriever(()=>manager,()=>snapshot);
  const result = await retrieve("guidance",new AbortController().signal);
  assert.equal(result.invocation.requestedRoute,"dual");
  assert.equal(result.invocation.modelInvoked,true);
  assert.equal(result.invocation.semanticStatus,"ready");
  assert(result.invocation.retrievalId);
  assert(result.candidates.length > 0 && result.candidates.every(item=>item.sourceRevision && item.contentHash));
  assert(result.candidates.some(item=>item.serving.route.includes("semantic")));
  assert(validChatRetrievalReceipt({schema:"pkm.chat.retrieval/v1",chatId:"chat",model:"fixture",query:"guidance",
    selectedCount:0,candidates:result.candidates.map(({content,...item})=>item),invocation:result.invocation},"chat"));
  assert((await manager.observeLearning()).calls.every(call=>call.recall == null),"selection is not a relevance judgment");
  const feedback = await retrieve.feedback(result.invocation.retrievalId,["source-0","source-9","missed-relevant-source"]);
  assert.equal(feedback.ok,true);
  assert((await manager.observeLearning()).calls.some(call=>call.recall !== null));
  const negative=await retrieve("guidance",new AbortController().signal);
  const negativeFeedback=await retrieve.feedback(negative.invocation.retrievalId,[]);
  assert.equal(negativeFeedback.ok,true,
    "explicit complete all-negative judgments are valid and not inferred from an empty selection");
  assert.equal(negativeFeedback.recall,null,"zero relevant sources makes Recall undefined, not a fabricated zero");
  await assert.rejects(retrieve.feedback("expired",["source-0"]), /retrieval_id|expired|receipt|Invalid/);
  const failed = await retrieve("explode",new AbortController().signal);
  assert.equal(failed.invocation.semanticStatus,"fallback");
  assert.equal(failed.invocation.modelInvoked,true);
  assert.match(failed.invocation.reason,/synthetic inference failure/);
  assert(!failed.invocation.servedRoute.includes("semantic"));
});
