const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { activeTaskContextCheckpoint, readTaskContextInput } = require("../../dist/chat/task-context-checkpoint");

module.exports = async function reviewController(ApiChatView, context, nativeClient, models) {
  const calls = [], requests = [];
  const invocation = { requestId:"controller-query", requestedRoute:"dual", servedRoute:"lexical+semantic",
    semanticStatus:"ready", modelInvoked:true, readyGeneration:1, corpusRevision:"fixture", retrievalId:"controller-retrieval",
    adaptive:{enabled:true,applied:false,reason:"insufficient-feedback",original_count:0,returned_count:0,invocation:1} };
  const retrieval = Object.assign(async()=>({candidates:[],invocation}), {
    feedback:async(id, relevant)=>{calls.push({id,relevant});return {ok:true,trained:true,provenance:"user",
      revision:1,ranker_revision:1,calibrator_revision:1,model_labels:0,user_labels:1};},
  });
  const provider = new ApiChatView(context,retrieval);
  const originalActive=context.workspaceState.get("apiChat.active");
  const originalDefault=context.globalState.get("apiChat.defaultModel");
  const originalStream = nativeClient.streamVscodeChat, originalDiscovery = nativeClient.discoverVscodeModels;
  nativeClient.discoverVscodeModels = async()=>models;
  nativeClient.streamVscodeChat = async(_model,request,onText)=>{
    if(request.purpose === "memory"){
      onText(request.messages[0].content.includes("CURRENT user input") ? '{"focus":[]}' : '{"statements":[]}');
    }else{
      request.beforeRound(request.messages,request.maxOutputTokens);
      const transport=require("../../dist/chat/api-chat-client").chatTransportReceipt("vscode",request.messages,[]);
      request.onTransportPrepared(transport);request.onTransportSent(transport);
      requests.push(request);onText("Read-only fixture response.");
    }
  };
  const pending = async()=>{
    for(let attempt=0;attempt<100;attempt++){
      const decision=[...provider.decisions.entries()][0];
      if(decision)return decision;
      await delay(5);
    }
    assert.fail("Expected explicit user confirmation, not an implicit state change");
  };
  const decide = (id,value,answer)=>provider.handle({type:"decision",id,value,answer});
  const portalPending=async()=>{
    for(let attempt=0;attempt<100;attempt++){
      const id=[...provider.portalDecisions.keys()][0];
      if(id)return id;
      await delay(5);
    }
    assert.fail("Expected a local Portal card");
  };
  try{
    await provider.handle({type:"new"});
    let chat=provider.chat;
    const localSnapshot=JSON.stringify(provider.store.load(chat.id,false));
    const portalForm={title:"Local Portal setup",detail:"Never send link fields to a model",
      choices:[{value:"submit",label:"Connect"},{value:"cancel",label:"Cancel"}],
      secretFields:["link"],form:{type:"object",required:["link"],properties:{link:{type:"string",maxLength:4000}}},
      verify:async fields=>{if(fields.link!=="fixture-private-portal-link")throw new Error("Invalid private link.");}};
    let current=true;
    const local=provider.requestPortalInteraction(chat.id,portalForm,()=>current);
    let portalId=await portalPending();
    await assert.rejects(provider.handle({type:"decision",id:portalId,value:"submit",answer:{link:"fixture-private-portal-link"}}),/no longer pending/);
    await assert.rejects(provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{link:"invalid"}}),/Invalid private link/);
    assert.equal(provider.portalDecisions.size,1,"invalid input must remain on the card");
    const notices=[];
    provider.view={visible:true,webview:{postMessage:message=>notices.push(message)}};
    provider.notify(new Error("Invalid private link."),{type:"portalDecision",id:portalId});
    provider.view=undefined;
    assert(notices.some(message=>message.type==="error"&&message.confirmationId===portalId),"local form errors must target the original card for retry");
    await provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{link:"fixture-private-portal-link"}});
    assert.deepEqual(await local,{action:"submit",fields:{link:"fixture-private-portal-link"}});
    assert.equal(JSON.stringify(provider.store.load(chat.id,false)),localSnapshot,"private UI fields must not enter stored Chat data");
    assert.equal(requests.length,0,"local Portal interaction never calls a model");
    const revoked=provider.requestPortalInteraction(chat.id,portalForm,()=>current);
    portalId=await portalPending();current=false;
    await assert.rejects(provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{link:"fixture-private-portal-link"}}),/Portal changed/);
    assert.equal(await revoked,undefined);
    current=true;
    const running=new AbortController();provider.running.set(chat.id,running);
    const duringTool=provider.requestPortalInteraction(chat.id,{title:"Authorize pending tool",detail:"Local only",
      choices:[{value:"confirm",label:"Allow once"},{value:"cancel",label:"Deny"}]},()=>current);
    portalId=await portalPending();
    await provider.handle({type:"portalDecision",id:portalId,value:"confirm"});
    assert.equal((await duringTool).action,"confirm","Portal cards must work while a tool is waiting");
    provider.running.delete(chat.id);
    const longForm={title:"Send task",detail:"Exact instruction",choices:[{value:"submit",label:"Send task"}],
      form:{type:"object",required:["prompt"],properties:{prompt:{type:"string",minLength:1,maxLength:16000}}}};
    const longTask=provider.requestPortalInteraction(chat.id,longForm,()=>current);
    portalId=await portalPending();
    await assert.rejects(provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{prompt:"x".repeat(16001)}}),/Text length/);
    const instruction='"\n'.repeat(8000);
    await provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{prompt:instruction}});
    assert.equal((await longTask).fields.prompt,instruction,"Portal task entry preserves the 16,000-character protocol limit");
    const {validateQuestionAnswer}=require("../../dist/chat/chat-questions");
    assert.throws(()=>validateQuestionAnswer(longForm.form,{prompt:"x".repeat(4001)}),/Text length/,"model question limits stay unchanged");
    let finishVerify;
    const stale=provider.requestPortalInteraction(chat.id,{...portalForm,verify:()=>new Promise(resolve=>{finishVerify=resolve;})},()=>current);
    portalId=await portalPending();
    const approval=provider.handle({type:"portalDecision",id:portalId,value:"submit",answer:{link:"fixture-private-portal-link"}});
    for(let attempt=0;!finishVerify&&attempt<100;attempt++)await delay(5);
    assert(finishVerify);
    current=false;finishVerify();
    await assert.rejects(approval,/Portal changed during/);
    assert.equal(await stale,undefined);
    current=true;
    const wrongChat=provider.requestPortalInteraction(chat.id,portalForm,()=>current);
    portalId=await portalPending();
    await provider.handle({type:"new"});
    await assert.rejects(provider.handle({type:"portalDecision",id:portalId,value:"cancel"}),/selected Chat/);
    provider.chat=chat;
    await assert.rejects(provider.handle({type:"portalDecision",id:portalId,value:"allow-everything"}),/available Portal action/);
    await provider.handle({type:"portalDecision",id:portalId,value:"cancel"});
    assert.equal((await wrongChat).action,"cancel");
    provider.store.startTask(chat,"Checkpoint review fixture");
    Object.assign(chat,{modelProvider:"vscode",
      vscodeModelId:nativeClient.vscodeModelProfile(models[1]).id,permissionMode:"read-only",
      builtinTools:["session_info"],vscodeTools:[],mcpServers:[]});
    chat.messages=Array.from({length:4},(_,index)=>({id:randomUUID(),taskId:chat.sessionId,role:"user",status:"complete",
      content:`Original input ${index}: `+"Do not deploy. ".repeat(100)}));
    provider.persist(chat);
    const original=JSON.stringify(chat.messages);
    let action=provider.handle({type:"taskCheckpoint",chatId:chat.id});
    let [id]=await pending();
    await assert.rejects(decide(id,"submit",{summary:"Keep read-only. Do not deploy.",reviewed:false}),/Explicit review/);
    assert.equal(chat.taskContextCheckpoints,undefined);
    await decide(id,"cancel");await action;
    assert.equal(JSON.stringify(chat.messages),original);
    action=provider.handle({type:"taskCheckpoint",chatId:chat.id});[id]=await pending();
    provider.store.save(provider.store.load(chat.id,false));
    await assert.rejects(decide(id,"submit",{summary:"Keep read-only. Do not deploy.",reviewed:true}),/changed while awaiting confirmation/);
    await action;
    assert.equal(provider.decisions.has(id),false,"stale reviews must be closed rather than silently retried");
    await provider.handle({type:"select",id:chat.id});chat=provider.chat;
    action=provider.handle({type:"taskCheckpoint",chatId:chat.id});[id]=await pending();
    await decide(id,"submit",{summary:"Keep read-only. Do not deploy.",reviewed:true});await action;
    const checkpoint=activeTaskContextCheckpoint(chat);
    assert(checkpoint);
    assert.equal(chat.permissionMode,"read-only","a checkpoint must never grant new permissions");
    assert.equal(JSON.stringify(chat.messages),original);
    assert.equal(provider.store.load(chat.id,false).taskContextCheckpoints[0].id,checkpoint.id);
    assert.equal(requests.length,0,"creating/reviewing a checkpoint does not call a model");
    await provider.handle({type:"send",text:"What constraints apply now?"});
    const request=requests.at(-1),reply=chat.messages.at(-1);
    assert.equal(reply.status,"complete",reply.error);
    assert(request.messages.some(message=>message.content.includes("User-approved Task context checkpoint")));
    assert(!request.messages.some(message=>message.content.includes("fixture-private-portal-link")));
    assert(!request.messages.some(message=>message.content.includes("Original input 0:")));
    assert.deepEqual(reply.retrieval.invocation,invocation);
    assert.deepEqual(reply.retrievalActivity.attempts.find(item=>item.kind==="knowledge").receipt.invocation,invocation);
    assert.deepEqual(reply.retrievalActivity.rounds[0].receipt.invocation,invocation);
    assert.deepEqual(provider.store.load(chat.id,false).messages.at(-1).retrieval.invocation,invocation);
    assert.equal(calls.length,0,"automatic retrieval and prompt selection never submit judgments");
    const info=request.tools.find(tool=>tool.name==="session_info");
    const snapshot=JSON.parse(await info.execute({},request.signal));
    assert.equal(snapshot.taskCheckpoint.id,checkpoint.id);
    const page=JSON.parse(await info.execute({checkpointAfter:0},request.signal));
    assert.deepEqual(page.sourceInputIds,checkpoint.sourceInputIds);
    const preview=JSON.parse(await info.execute({taskInputId:checkpoint.sourceInputIds[0]},request.signal));
    assert.equal(preview.content,JSON.parse(readTaskContextInput(chat,checkpoint.sourceInputIds[0])).content);
    const exact=JSON.parse(await info.execute({taskInputId:preview.inputId,inputStart:3,inputEnd:30,inputHash:preview.contentHash},request.signal));
    assert.equal(exact.content,preview.content.slice(3,30));
    await assert.rejects(info.execute({taskInputId:preview.inputId,evidenceCallId:"ambiguous"},request.signal),/must be separate/);
    await assert.rejects(provider.handle({type:"reviewRetrieval",chatId:randomUUID(),id:reply.id}),/unavailable/);
    action=provider.handle({type:"reviewRetrieval",chatId:chat.id,id:reply.id});[id]=await pending();
    await decide(id,"cancel");await action;assert.equal(calls.length,0);
    const submit=retrieval.feedback;
    retrieval.feedback=async()=>{throw new Error("Retrieval feedback receipt expired.");};
    action=provider.handle({type:"reviewRetrieval",chatId:chat.id,id:reply.id});[id]=await pending();
    await assert.rejects(decide(id,"submit",{complete:true}),/receipt expired/);
    await decide(id,"cancel");await action;assert.equal(calls.length,0);retrieval.feedback=submit;
    action=provider.handle({type:"reviewRetrieval",chatId:chat.id,id:reply.id});[id]=await pending();
    await assert.rejects(decide(id,"submit",{missed:"missed-source",complete:false}),/Complete relevance/);
    assert.equal(calls.length,0);
    await decide(id,"submit",{missed:"missed-source",complete:true});await action;
    assert.deepEqual(calls,[{id:invocation.retrievalId,relevant:["missed-source"]}]);
    action=provider.handle({type:"revokeTaskCheckpoint",chatId:chat.id});[id]=await pending();
    await decide(id,"confirm");await action;
    assert.equal(activeTaskContextCheckpoint(chat),undefined);
    assert.equal(provider.store.load(chat.id,false).taskContextCheckpoints[0].revokedAt,checkpoint.revokedAt);
    const disposedCard=provider.requestPortalInteraction(chat.id,portalForm,()=>current);
    await portalPending();provider.dispose();
    assert.equal(await disposedCard,undefined,"disposing Chat cancels pending local consent");
    console.log("Chat reviews: real confirmation flow, exact original readback, persisted checkpoint/revocation and explicit-only retrieval feedback OK");
  }finally{
    nativeClient.streamVscodeChat=originalStream;nativeClient.discoverVscodeModels=originalDiscovery;
    provider.dispose();await provider.memory?.service.close();
    await context.workspaceState.update("apiChat.active",originalActive);
    await context.globalState.update("apiChat.defaultModel",originalDefault);
  }
};
