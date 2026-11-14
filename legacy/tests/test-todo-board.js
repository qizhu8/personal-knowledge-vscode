const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync,spawn}=require("node:child_process");
const store=require("../dist/knowledge/filestore");
const {saveMarkdownAsset}=require("../dist/knowledge/markdown-assets");
const {readTodoBoard}=require("../dist/knowledge/todo-board");
const item=(id,extra={})=>({id,title:id,goal:"User value",scope:"Board fixture",acceptance:["Exact result"],state:"Planning",evidence:[],...extra});
const user={id:"user:local",role:"user"};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-board-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  return root;
}
function bridge(root,request) {
  const result=spawnSync(process.execPath,[path.resolve(__dirname,"../resources/knowledge_mutations.js"),path.resolve(__dirname,".."),root],{input:JSON.stringify(request),encoding:"utf8"});
  return result.status===0?JSON.parse(result.stdout):{error:result.stderr};
}
test("dedicated Board is discoverable when empty; generic Markdown and assets cannot change authoritative tasks",t=>{
  const root=fixture(t),slug="Project/Board";
  const empty=store.todoBoardCreate(slug,"Board","Project");
  assert.equal(store.noteGet(slug).documentKind,"todo-board");
  assert.equal(store.noteWorkItemNotes().notes[0].count,0);
  let state=store.noteWorkItemCommand(slug,empty.digest,{action:"create",item:item("task")},user);
  assert.equal(state.items[0].history[0].actorId,"user:local");
  const markdown=fs.readFileSync(path.join(root,"notes",slug+".md"),"utf8");
  assert(!markdown.includes("pkm-work-item"));
  assert.throws(()=>store.noteUpsert({slug,title:"Board",category:"Project",content:"~~~pkm-work-item\n{}\n~~~",type:"todo",tags:[]}),/cannot be edited as Markdown/);
  assert.throws(()=>store.writeKnowledgeMarkdown("notes",slug+".md",undefined,"# Replaced"),/cannot be edited as Markdown/);
  assert.throws(()=>store.writeKnowledgeMarkdown("notes","Forged.md",undefined,'---\ndocumentKind: "todo-board"\n---\n'),/creation/);
  assert.throws(()=>store.noteWorkItemUpsert(slug,state.digest,item("replacement")),/lifecycle commands/);
  assert.throws(()=>saveMarkdownAsset(root,"notes",slug+".md","pkm-todo-board.json",Buffer.from("{}")),/reserved/);
  assert.equal(bridge(root,{operation:"write-markdown",area:"notes",path:slug+".md",content:"# Forged"}).error.includes("cannot be edited as Markdown"),true);
  fs.appendFileSync(path.join(root,"notes",slug+".md"),"\n~~~pkm-work-item\n"+JSON.stringify(item("forged"))+"\n~~~\n");
  assert.deepEqual(store.noteWorkItemsRead(slug),state,"raw Markdown edits cannot alter Board items or their digest");
  state=store.noteWorkItemCommand(slug,state.digest,{action:"claim",id:"task"},user);
  assert.equal(state.items[0].state,"WIP");
  const backing=path.join(root,"notes",slug+".assets/pkm-todo-board.json");
  fs.unlinkSync(backing);
  assert.throws(()=>store.noteWorkItemsRead(slug),/ENOENT/,"missing authority cannot fall back to pasted Markdown blocks");
});
test("conversion requires a fresh explicit preview and preserves Story relations, acceptance and audit",t=>{
  fixture(t);
  const slug="Legacy";
  store.noteUpsert({slug,title:slug,content:"# Original history\n",type:"todo",tags:[]});
  let state=store.noteWorkItemsRead(slug);
  for(const record of [item("story",{kind:"UserStory",storyStatus:"draft"}),item("child",{parentId:"story"})]) {
    state=store.noteWorkItemCommand(slug,state.digest,{action:"create",item:record},user);
  }
  const before=store.noteGet(slug).content,preview=store.todoBoardConversionPreview(slug);
  assert.throws(()=>store.todoBoardConvert(slug,"stale"),/changed/);
  const migrated=store.todoBoardConvert(slug,preview.digest);
  assert.deepEqual(migrated.items,preview.items);
  assert.equal(store.noteGet(slug).content,before,"original Markdown retained as history only");
  assert.equal(store.noteGet(slug).documentKind,"todo-board");
  assert.throws(()=>store.todoBoardConvert(slug,migrated.digest),/already/);
  assert.throws(()=>store.noteWorkItemCommand(slug,preview.digest,{action:"claim",id:"child"},user),/changed/);
});
test("Board authority follows rename, folders, Trash, restore and explicit export/import without sharing worker grants",t=>{
  fixture(t);
  store.todoBoardCreate("Team/Board","Board","Team");
  let snapshot=store.noteWorkItemsRead("Team/Board");
  snapshot=store.noteWorkItemCommand("Team/Board",snapshot.digest,{action:"create",item:item("task",{ownerId:"external:claude:reviewer",owner:"Claude reviewer"})},user);
  store.todoBoardGrantWorker("Team/Board",snapshot.digest,"external:claude:reviewer");
  store.noteMove("Team/Board","Moved");
  assert.deepEqual(store.noteWorkItemsRead("Moved/Board").items,snapshot.items);
  const entry=store.knowledgePathMoveToTrash("notes","Moved/Board.md");
  assert(entry);
  store.knowledgeTrashRestore("notes",entry.id);
  assert.deepEqual(store.noteWorkItemsRead("Moved/Board").items,snapshot.items);
  const rows=store.noteExport();
  assert.equal(rows[0].todoBoard.workers,undefined);
  rows[0].slug="Imported/Board";rows[0].category="Imported";
  assert.equal(store.noteImport(rows),1);
  assert.deepEqual(store.noteWorkItemsRead("Imported/Board").items,snapshot.items);
  assert.throws(()=>store.noteImport([{slug:"Imported/Board",title:"Board",content:"# Overwrite"}]),/Cannot overwrite/);
});
test("Board-scoped external worker tokens distinguish Agents, retain worker restrictions and rotate with CAS",t=>{
  const root=fixture(t),slug="Board";
  store.todoBoardCreate(slug,slug);
  let state=store.noteWorkItemsRead(slug);
  for(const [id,ownerId] of [["one","external:copilot:one"],["two","external:claude:two"]]) {
    state=store.noteWorkItemCommand(slug,state.digest,{action:"create",item:item(id,{ownerId,owner:ownerId})},user);
  }
  const token=store.todoBoardGrantWorker(slug,state.digest,"external:copilot:one");
  state=store.noteWorkItemsRead(slug);
  assert(!fs.readFileSync(path.join(root,"notes/Board.assets/pkm-todo-board.json"),"utf8").includes(token));
  assert.throws(()=>store.noteWorkItemExternalCommand(slug,state.digest,{action:"claim",id:"one"}),/another actor/);
  assert.throws(()=>store.noteWorkItemExternalCommand(slug,state.digest,{action:"claim",id:"two"},token),/another actor/);
  let result=bridge(root,{operation:"work-item-command",area:"notes",path:"Board.md",expectedDigest:state.digest,command:{action:"claim",id:"one"},workerToken:token});
  assert(!result.error,result.error);
  assert.equal(result.items[0].ownerId,"external:copilot:one");
  state=store.noteWorkItemCommand(slug,result.digest,{action:"edit",item:{...result.items[0],reviewerIds:["user:local"]}},user);
  assert.throws(()=>store.noteWorkItemExternalCommand(slug,state.digest,{action:"edit",item:{...state.items[0],acceptance:["Weaken"]}},token),/protected/);
  const next=store.todoBoardGrantWorker(slug,state.digest,"external:copilot:one");
  state=store.noteWorkItemsRead(slug);
  assert.throws(()=>store.noteWorkItemExternalCommand(slug,state.digest,{action:"claim",id:"one"},token),/rotated/);
  const done=store.noteWorkItemExternalCommand(slug,state.digest,{action:"transition",id:"one",state:"Done",outcome:"Success",evidence:["test://external"]},next);
  assert.equal(done.items[0].history.at(-1).actorId,"external:copilot:one");
  assert.throws(()=>store.noteWorkItemExternalCommand(slug,done.digest,{action:"accept",id:"one",reason:"Self review"},next),/Only a user/);
  store.todoBoardCreate("Other","Other");
  assert.throws(()=>store.noteWorkItemExternalCommand("Other",store.noteWorkItemsRead("Other").digest,{action:"claim",id:"one"},next),/invalid for this Board/);
});
test("Board JSON rejects invalid graph/duplicates instead of hiding corruption",()=>{
  assert.throws(()=>readTodoBoard("bad"),/Invalid Todo Board JSON/);
  for(const items of [[item("same"),item("same")],[item("child",{parentId:"missing"})],[item("loop",{dependsOn:["loop"]})]]) {
    assert.throws(()=>readTodoBoard(JSON.stringify({schema:"pkm.todo-board/v1",items})));
  }
});
test("competing Board commands across processes have exactly one CAS winner",async t=>{
  const root=fixture(t),slug="Race";
  store.todoBoardCreate(slug,slug);
  const empty=store.noteWorkItemsRead(slug);
  const before=store.noteWorkItemCommand(slug,empty.digest,{action:"create",item:item("race")},user);
  const command=()=>new Promise(resolve=>{
    const child=spawn(process.execPath,[path.resolve(__dirname,"../resources/knowledge_mutations.js"),path.resolve(__dirname,".."),root],{stdio:["pipe","ignore","pipe"]});
    let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);
    child.on("close",code=>resolve({code,stderr}));
    child.stdin.end(JSON.stringify({operation:"work-item-command",area:"notes",path:"Race.md",expectedDigest:before.digest,command:{action:"claim",id:"race"}}));
  });
  const results=await Promise.all([command(),command()]);
  assert.equal(results.filter(result=>result.code===0).length,1);
  assert.match(results.find(result=>result.code!==0).stderr,/changed/);
});
