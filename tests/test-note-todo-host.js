const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const ts=require("typescript");

test("actual panel Host dispatch correlates errors, fixes user role and builds Project projection without a second store",()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/extension.ts"),"utf8");
  const start=source.indexOf('    case "noteTodoRead":');
  const end=source.indexOf('    case "detail":',start);
  assert(start>=0&&end>start);
  const code=ts.transpileModule(`function dispatch(msg: Record<string,unknown>) {switch(msg.command){${source.slice(start,end)}}}`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  const replies=[],commands=[];
  let trusted=true,truncated=false;
  const snapshot={digest:"a".repeat(64),items:[{id:"one",projectId:"project-a"},{id:"two",projectId:"project-b"}]};
  const context={
    vscode:{workspace:{get isTrusted(){return trusted;}}},
    noteWorkItemsRead(slug){if(slug==="missing")throw Error("Note missing");return snapshot;},
    noteGet:()=>({content:"Exact Markdown body"}),
    noteWorkItemCommand(...args){commands.push(args);if(args[1]!==snapshot.digest)throw Error("Note changed; read the current digest.");},
    noteWorkItemNotes(query,limit){assert.equal(limit,1000);return {notes:[{slug:"Team/Tracker"}],truncated};},
    currentProjectStore:()=>({list:()=>({projects:[{projectId:"project-a",name:"A"}]})}),
    apiChatGroupSnapshots:()=>[{hostSessionId:"chat-agent-1",title:"Worker"}],
    path, getStorePath:()=>"/fixture",
    _treeProvider:{refresh(){}},
    respond:reply=>replies.push(reply),
  };
  vm.createContext(context);vm.runInContext(code,context);
  context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:11,expectedDigest:snapshot.digest,operation:{action:"claim",id:"one"},actor:{role:"worker"}});
  assert.deepEqual(JSON.parse(JSON.stringify(commands[0][3])),{id:"user:local",role:"user"});
  assert.equal(replies.at(-1).data.requestId,11);
  assert.equal(replies.at(-1).data.snapshot,snapshot);
  context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:12,expectedDigest:"stale",operation:{}});
  assert.match(replies.at(-1).data.error,/changed/);
  assert.equal(replies.at(-1).data.requestId,12);
  context.dispatch({command:"noteTodoProject",projectId:"project-a",requestId:13});
  assert.equal(replies.at(-1).data.records.length,1);
  assert.equal(replies.at(-1).data.records[0].item.id,"one");
  assert.equal(replies.at(-1).data.records[0].slug,"Team/Tracker");
  truncated=true;
  context.dispatch({command:"noteTodoProject",projectId:"project-a",requestId:14});
  assert.match(replies.at(-1).data.error,/Too many/);
  context.dispatch({command:"noteTodoRead",slug:"missing",requestId:15});
  assert.match(replies.at(-1).data.error,/missing/);
  trusted=false;
  const count=commands.length;
  context.dispatch({command:"noteTodoCommand",slug:"Team/Tracker",requestId:16,expectedDigest:snapshot.digest,operation:{}});
  assert.match(replies.at(-1).data.error,/trusted/);
  assert.equal(commands.length,count);
});
