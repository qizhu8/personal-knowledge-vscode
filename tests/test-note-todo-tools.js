const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../dist/knowledge/filestore");
const { createNoteTodoTools } = require("../dist/chat/note-todo-tools");
const { planReadTools } = require("../dist/chat/chat-plan");
const { reusableReadOnlyTools } = require("../dist/chat/api-chat-client");

test("native Note tools enforce approval, stable worker identity, CAS and separate acceptance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"pkm-note-native-"));
  try {
    store.setStorePath(root);
    store.noteUpsert({slug:"Team/Tracker",category:"Team",title:"Tracker",type:"general",tags:[],content:"User prose remains unchanged."});
    let snapshot = store.noteWorkItemsRead("Team/Tracker");
    const item = {id:"build-ui",title:"Deliver UI",goal:"Working tracker",scope:"Note views",
      acceptance:["Browser roundtrip passes"],state:"Planning",evidence:[]};
    snapshot = store.noteWorkItemCommand("Team/Tracker",snapshot.digest,{action:"create",item},{id:"user:local",role:"user"});
    let approved = false;
    const approvals = [];
    const signal = new AbortController().signal;
    const make = actorId => createNoteTodoTools({actorId,assertActive(){},approve:async(write,detail)=>{
      approvals.push({write,detail}); return approved;
    }});
    const [read,update] = make("chat:worker-a");
    await assert.rejects(read.execute({slug:"Team/Tracker"},signal),/declined/i);
    await assert.rejects(update.execute({slug:"Team/Tracker",expectedDigest:snapshot.digest,command:{action:"claim",id:item.id}},signal),/declined/i);
    assert.equal(store.noteWorkItemsRead("Team/Tracker").items[0].ownerId,undefined);
    approved=true;
    const discovery=JSON.parse(await read.execute({query:"Tracker"},signal));
    assert.equal(discovery.actorId,"chat:worker-a");
    assert.equal(discovery.notes.length,1);
    assert.equal(discovery.truncated,false);
    const initial=JSON.parse(await read.execute({slug:"Team/Tracker"},signal));
    const claimed=JSON.parse(await update.execute({slug:"Team/Tracker",expectedDigest:initial.digest,command:{action:"claim",id:item.id,actor:{id:"user:local",role:"user"}}},signal).catch(error=> {
      assert.match(error.message,/unknown|unsupported|unexpected/i);
      return update.execute({slug:"Team/Tracker",expectedDigest:initial.digest,command:{action:"claim",id:item.id}},signal);
    }));
    assert.equal(claimed.items[0].ownerId,"chat:worker-a");
    assert.equal(claimed.items[0].state,"WIP");
    await assert.rejects(make("chat:worker-b")[1].execute({slug:"Team/Tracker",expectedDigest:initial.digest,command:{action:"claim",id:item.id}},signal),/changed|conflict|stale/i);
    await assert.rejects(update.execute({slug:"Team/Tracker",expectedDigest:claimed.digest,command:{action:"edit",item:{...claimed.items[0],acceptance:["Weaker"]}}},signal),/protect|contract|acceptance|cannot/i);
    const done=JSON.parse(await update.execute({slug:"Team/Tracker",expectedDigest:claimed.digest,command:{
      action:"transition",id:item.id,state:"Done",outcome:"Success",evidence:["test://browser/roundtrip"],
    }},signal));
    assert.equal(done.items[0].acceptanceDecision,undefined);
    await assert.rejects(update.execute({slug:"Team/Tracker",expectedDigest:done.digest,command:{action:"accept",id:item.id,reason:"I approve myself"}},signal),/reviewer|user|delegat|accept/i);
    const reread=JSON.parse(await read.execute({slug:"Team/Tracker"},signal));
    assert.equal(reread.digest,done.digest,"repeated reads must not return a pre-mutation cached digest");
    assert.equal(approvals.some(record=>record.write&&record.detail.includes("chat:worker-a")),true);
    assert.equal(planReadTools.has("note_todo_read"),true);
    assert.equal(planReadTools.has("note_todo_update"),false);
    assert.equal(reusableReadOnlyTools.has("note_todo_read"),false);
    assert.match(store.noteGet("Team/Tracker").content,/User prose remains unchanged/);
    const aborted = new AbortController(); aborted.abort();
    const count=approvals.length;
    await assert.rejects(read.execute({slug:"Team/Tracker"},aborted.signal),/cancelled/i);
    assert.equal(approvals.length,count);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("Todo tool inputs, cancellation after approval and remote wiring stay bounded",async()=>{
  const controller=new AbortController();
  const [read,update]=createNoteTodoTools({actorId:"chat:test",assertActive(){},approve:async()=>{
    controller.abort();return true;
  }});
  await assert.rejects(read.execute({slug:"Note"},controller.signal),/cancelled/i);
  const fresh=new AbortController().signal;
  await assert.rejects(read.execute({slug:"Note",query:"mixed"},fresh),/either/i);
  await assert.rejects(read.execute({limit:1001},fresh),/limit/i);
  await assert.rejects(update.execute({slug:"Note",expectedDigest:"bad",command:{}},fresh),/digest/i);
  const view=fs.readFileSync(path.resolve(__dirname,"../src/chat/api-chat-view.ts"),"utf8");
  assert.match(view,/write && this\.remoteControlledRequests\.has\(chat\.id\).*throw new Error\("Portal-controlled requests cannot modify/s);
  assert.match(view,/actorId: `chat:\$\{chat\.id\}`/);
});
