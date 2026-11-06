const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const ts=require("typescript");

test("actual panel Host dispatch correlates errors, fixes user role and reads exact Project/Agent sources without mutation",async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/extension.ts"),"utf8");
  const start=source.indexOf('    case "noteTodoRead":');
  const end=source.indexOf('    case "detail":',start);
  assert(start>=0&&end>start);
  const code=ts.transpileModule(`async function dispatch(msg: Record<string,unknown>) {switch(msg.command){${source.slice(start,end)}}}`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  const replies=[],commands=[];
  let trusted=true,truncated=false,missingChat=false,changed=false,changeDuringRead=false;
  const harnessCalls=[];
  const snapshot={digest:"a".repeat(64),items:[{id:"one",projectId:"project-a"},{id:"two",projectId:"project-b"}]};
  const context={
    vscode:{workspace:{get isTrusted(){return trusted;}},commands:{async executeCommand(command,...args){
      harnessCalls.push({command,args});if(changeDuringRead)changed=true;return {sessionId:"session-exact",usage:{status:"unmeasured"}};
    }}},
    noteWorkItemsRead(slug){if(slug==="missing")throw Error("Note missing");return snapshot;},
    noteGet:()=>({content:"Exact Markdown body"}),
    noteWorkItemCommand(...args){commands.push(args);if(args[1]!==snapshot.digest)throw Error("Note changed; read the current digest.");},
    noteWorkItemNotes(query,limit){assert.equal(limit,1000);return {notes:[{slug:"Team/Tracker"}],truncated};},
    projectWorkItemProgress(projectId){
      if(truncated)throw Error("Too many Work Item Notes");
      return {readAt:"2026-11-04T00:00:00.000Z",records:snapshot.items.filter(item=>item.projectId===projectId).map(item=>({slug:"Team/Tracker",item}))};
    },
    inspectWorkItem(reference){
      if(reference?.id!=="one")throw Error("Work Item unavailable");
      return {slug:"Team/Tracker",digest:changed?"b".repeat(64):snapshot.digest,item:{id:"one",ownerId:"chat:chat-agent-1"}};
    },
    listAgentSnapshots:()=>[{snapshotId:"matching",sourceHostKind:"pkm",sourceHostSessionId:"chat-agent-1"},
      {snapshotId:"wrong-chat",sourceHostKind:"pkm",sourceHostSessionId:"other"}],
    readAgentSnapshotContents:(root,id)=>({snapshotId:id,plan:"historical, not executed"}),
    currentProjectStore:()=>({list:()=>({projects:[{projectId:"project-a",name:"A"}]})}),
    apiChatGroupSnapshots:()=>missingChat?[]:[{hostSessionId:"chat-agent-1",title:"Worker"}],
    path, getStorePath:()=>"/fixture",
    _treeProvider:{refresh(){}},
    respond:reply=>replies.push(reply),
  };
  vm.createContext(context);vm.runInContext(code,context);
  await context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:11,expectedDigest:snapshot.digest,operation:{action:"claim",id:"one"},actor:{role:"worker"}});
  assert.deepEqual(JSON.parse(JSON.stringify(commands[0][3])),{id:"user:local",role:"user"});
  assert.equal(replies.at(-1).data.requestId,11);
  assert.equal(replies.at(-1).data.snapshot,snapshot);
  await context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:12,expectedDigest:"stale",operation:{}});
  assert.match(replies.at(-1).data.error,/changed/);
  assert.equal(replies.at(-1).data.requestId,12);
  await context.dispatch({command:"noteTodoProject",projectId:"project-a",requestId:13});
  assert.equal(replies.at(-1).data.records.length,1);
  assert.equal(replies.at(-1).data.records[0].item.id,"one");
  assert.equal(replies.at(-1).data.records[0].slug,"Team/Tracker");
  truncated=true;
  await context.dispatch({command:"noteTodoProject",projectId:"project-a",requestId:14});
  assert.match(replies.at(-1).data.error,/Too many/);
  await context.dispatch({command:"noteTodoRead",slug:"missing",requestId:15});
  assert.match(replies.at(-1).data.error,/missing/);
  const reference={slug:"Team/Tracker",id:"one",digest:snapshot.digest};
  await context.dispatch({command:"noteTodoInspect",requestId:17,reference});
  assert.equal(replies.at(-1).command,"noteTodoInspectResult");
  assert.equal(replies.at(-1).data.item.id,"one");
  await context.dispatch({command:"noteTodoAgent",requestId:18,reference});
  assert.equal(replies.at(-1).data.chatId,"chat-agent-1");
  assert.equal(replies.at(-1).data.snapshots.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(harnessCalls[0])),{command:"personalKnowledge.readChatHarness",args:["chat-agent-1","snapshot",{}]});
  await context.dispatch({command:"noteTodoAgent",requestId:19,reference,snapshotId:"wrong-chat"});
  assert.match(replies.at(-1).data.error,/Snapshot.*unavailable/);
  await context.dispatch({command:"noteTodoAgent",requestId:20,reference,snapshotId:"matching"});
  assert.equal(replies.at(-1).data.contents.snapshotId,"matching");
  assert.equal(harnessCalls.length,1,"historical inspection never starts Agent or Memory");
  changeDuringRead=true;
  await context.dispatch({command:"noteTodoAgent",requestId:22,reference});
  assert.match(replies.at(-1).data.error,/changed while reading/);
  assert.equal(replies.at(-1).data.snapshot,undefined,"a changed source never leaks a stale successful Agent response");
  changed=false;changeDuringRead=false;
  missingChat=true;
  await context.dispatch({command:"noteTodoAgent",requestId:21,reference});
  assert.match(replies.at(-1).data.error,/unavailable/);
  assert.equal(harnessCalls.length,2);
  trusted=false;
  const count=commands.length;
  await context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:16,expectedDigest:snapshot.digest,operation:{}});
  assert.match(replies.at(-1).data.error,/trusted/);
  assert.equal(commands.length,count);
});
