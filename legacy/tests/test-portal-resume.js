const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { cleanupLegacyPortals } = require("../dist/chatroom/portal-cleanup");

test("ephemeral pairing rejects legacy resume packets, loses all receipts and aborts work on disconnect",async()=>{
  let a,b,finish,signal,runs=0;
  const errors=[];
  const common={roomId:"temporary",connected:()=>true,changed(){},error:error=>errors.push(error.message),
    approvePair:async()=>true,approveSwap:async()=>true,approveTask:async()=>true,
    execute:async(_prompt,current)=>{runs++;signal=current;return new Promise(resolve=>{finish=resolve;});}};
  a=new PeerSession({...common,chatId:randomUUID(),send:(_target,packet)=>void b.receive({from:"a",fromName:"A",packet})});
  b=new PeerSession({...common,chatId:randomUUID(),send:(_target,packet)=>void a.receive({from:"b",fromName:"B",packet})});
  try {
    b.accept("a",a.offer());
    for(let n=0;!a.binding&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(a.binding&&b.binding);
    assert(!a.binding.peerCapabilities.includes("resume-v1"));
    const pairId=a.binding.pairId;
    a.submit("one approved task");
    for(let n=0;!finish&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(runs,1);
    a.revoke();
    assert(signal.aborted);
    finish({content:"effects may remain"});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(a.receipts.size,0);assert.equal(b.receipts.size,0);
    assert.equal(a.observations.size,0);assert.equal(b.tasks.size,0);
    await b.receive({from:"a",fromName:"A",packet:{protocol:"pkm.peer/v1",operation:"resume",pairId,requestId:randomUUID(),payload:{}}});
    assert(errors.some(error=>/temporary.*fresh invitation/.test(error)));
    assert.equal(b.binding,undefined);
    assert.equal(runs,1);
  } finally {a.dispose();b.dispose();}
});

test("legacy cleanup removes only Portal data and preserves Chat and Room histories",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pkm-portal-cleanup-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,"knowledge"),journal=path.join(root,".pkm/state/peer-tasks");
  await fs.mkdir(journal,{recursive:true});
  await fs.writeFile(path.join(journal,"a".repeat(64)+".json"),'{"receipt":{"state":"completed"}}');
  for(const name of ["chats/history.json","chatrooms/history.db"]){
    await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});
    await fs.writeFile(path.join(root,name),"preserve exact history");
  }
  const id=randomUUID(),data=new Map([["pkm.portal.resume.index",JSON.stringify([id])],
    [`pkm.portal.resume.${id}`,JSON.stringify({root,record:{resumeSecret:"private"}})],["chat.secret","preserve"]]);
  const deleted=[],updates=[];
  const secrets={get:async key=>data.get(key),delete:async key=>{deleted.push(key);data.delete(key);}};
  const host=randomUUID(),requests=path.join(root,".pkm/state/api-chat-control/requests",host),requestId="b".repeat(64),chatId="c".repeat(64);
  await fs.mkdir(requests,{recursive:true});
  const record={schema:"pkm.api-chat.request/v1",hostId:host,status:"succeeded"};
  await fs.writeFile(path.join(requests,requestId+".json"),JSON.stringify({...record,requestId,operation:"portal",result:{private:"old Portal receipt"}}));
  const chatRecord=JSON.stringify({...record,requestId:chatId,operation:"send",result:{history:"preserve"}});
  await fs.writeFile(path.join(requests,chatId+".json"),chatRecord);
  await cleanupLegacyPortals({update:async(...args)=>updates.push(args)},secrets,root);
  await assert.rejects(fs.stat(journal),{code:"ENOENT"});
  assert.equal(await fs.readFile(path.join(root,"chats/history.json"),"utf8"),"preserve exact history");
  assert.equal(await fs.readFile(path.join(root,"chatrooms/history.db"),"utf8"),"preserve exact history");
  assert.equal(data.get("chat.secret"),"preserve");
  await assert.rejects(fs.stat(path.join(requests,requestId+".json")),{code:"ENOENT"});
  assert.equal(await fs.readFile(path.join(requests,chatId+".json"),"utf8"),chatRecord);
  assert.equal(deleted.length,2);
  assert.deepEqual(updates,[["pkm.portal.connections.v1",undefined],["pkm.portal.windows.v1",undefined]]);
  await cleanupLegacyPortals({update:async()=>{}},secrets,root);
  await fs.mkdir(journal);
  await fs.writeFile(path.join(journal,"d".repeat(64)+".json"),"old receipt");
  await Promise.all([cleanupLegacyPortals({update:async()=>{}},secrets,root),cleanupLegacyPortals({update:async()=>{}},secrets,root)]);
  await assert.rejects(fs.stat(journal),{code:"ENOENT"});
});

test("legacy cleanup refuses symlink escapes and unknown receipt members explicitly",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pkm-portal-cleanup-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,"knowledge"),state=path.join(root,".pkm/state"),outside=path.join(directory,"outside");
  await fs.mkdir(state,{recursive:true});await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,"a".repeat(64)+".json"),"do not touch");
  await fs.symlink(outside,path.join(state,"peer-tasks"));
  const secrets={get:async()=>undefined,delete:async()=>assert.fail("failed cleanup must retain credential index for retry")};
  await assert.rejects(cleanupLegacyPortals({update:async()=>{}},secrets,root),/symbolic links/);
  assert.equal(await fs.readFile(path.join(outside,"a".repeat(64)+".json"),"utf8"),"do not touch");
  await fs.unlink(path.join(state,"peer-tasks"));await fs.mkdir(path.join(state,"peer-tasks"));
  await fs.writeFile(path.join(state,"peer-tasks/not-a-receipt.txt"),"preserve");
  await assert.rejects(cleanupLegacyPortals({update:async()=>{}},secrets,root),/Unexpected legacy Portal/);
});
