const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {chromium}=require(process.env.PKM_PLAYWRIGHT_PATH||"playwright");
const store=require("../dist/knowledge/filestore");
const {startLiveMarkdownServer}=require("../dist/knowledge/live-note-server");
const {manageBrowserTodo}=require("../dist/ui/note-todo-management");
const {browserNoteTodo}=require("../dist/ui/note-todo-browser");
const {ApiChatStore}=require("../dist/chat/api-chat-store");
const {callTodoApi}=require("../dist/knowledge/todo-api");
const item=(id,extra={})=>({id,title:id,goal:"User value",scope:"Board",acceptance:["Exact result"],state:"Planning",evidence:[],...extra});

test("authenticated browser manages Board by CAS; public, cross-origin and untrusted writes fail",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-todo-management-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  const chats=new ApiChatStore(path.join(root,".pkm","state"),"0123456789abcdef");
  const chat=chats.create();
  chat.title="Actual PKM worker";
  chats.save(chat);
  let state=store.todoBoardCreate("Board","Board");
  for(const record of [item("story",{kind:"UserStory"}),item("task",{parentId:"story"})]){
    state=store.noteWorkItemCommand("Board",state.digest,{action:"create",item:record},{id:"user:local",role:"user"});
  }
  const token="test-local-management";
  const render=()=>browserNoteTodo("","","Board","Board",path.resolve(__dirname,".."),store.noteWorkItemsRead("Board"),true,true);
  const started=await startLiveMarkdownServer([],render,{},{
    accessToken:token,manageTodo:(documentPath,message)=>manageBrowserTodo(documentPath,message,true),
  });
  t.after(()=>new Promise(resolve=>started.server.close(resolve)));
  const base=started.localBaseUrl.replace(/\/$/,""),origin=new URL(base).origin;
  const message={command:"noteTodoRead",slug:"Board",requestId:1};
  const request=(headers={},body={documentPath:"/notes/Board.html",message})=>fetch(`${base}/_pkm/todo`,{
    method:"POST",headers:{"Content-Type":"application/json","X-Pkm-Todo":"1",Origin:origin,...headers},body:JSON.stringify(body),
  });
  assert.equal((await request()).status,403,"no authentication cannot write");
  const initial=await fetch(`${base}/notes/Board.html?_pkm_token=${token}`);
  const cookie=initial.headers.get("set-cookie").split(";")[0];
  assert.equal((await request({Cookie:cookie,Origin:"https://evil.example"})).status,403);
  assert.equal((await request({Cookie:cookie,"X-Pkm-Todo":""})).status,403);
  assert.equal((await request({Cookie:cookie},{documentPath:"/notes/../Board.html",message})).status,400);
  assert.equal((await request({Cookie:cookie},{documentPath:"/notes/Board.html",message:{...message,command:"noteTodoCommand",expectedDigest:"stale",operation:{action:"claim",id:"task"}}})).status,400);
  assert.throws(()=>manageBrowserTodo("/notes/Board.html",message,false),/trusted/);
  const publicServer=await startLiveMarkdownServer([],render,{},{
    manageTodo:()=>{throw Error("Public handler must not run");},
  });
  t.after(()=>new Promise(resolve=>publicServer.server.close(resolve)));
  assert.equal((await fetch(`${publicServer.localBaseUrl}/_pkm/todo`,{method:"POST"})).status,403);
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`${base}/notes/Board.html?_pkm_token=${token}`);
    await page.waitForFunction(()=>noteTodo.snapshot?.items.length===2&&!noteTodo.pending);
    assert.equal(store.noteWorkItemsRead("Board").items.find(item=>item.id==="task").ownerId,undefined,"reading never claims a task");
    const card=page.locator('[data-todo-card-id=task]');
    await card.locator("[data-todo-open]").click();
    assert.equal(await page.getByRole("dialog").count(),0);
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await card.locator("[data-todo-assign]").click();
    const dialog=page.getByRole("dialog"),form=dialog.locator("#note-todo-editor");
    await form.getByLabel("Assign to",{exact:true}).selectOption(`chat:${chat.id}`);
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    assert.equal(store.noteWorkItemsRead("Board").items.find(item=>item.id==="task").ownerId,`chat:${chat.id}`);
    const assigned=card.locator("[data-todo-copy-chat]");
    assert.match(await assigned.innerText(),/Actual PKM worker/);
    await page.context().grantPermissions(["clipboard-read","clipboard-write"],{origin});
    await assigned.click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),`pkm://chats/0123456789abcdef/${chat.id}`);
    await card.dragTo(page.locator('[data-story-row=story] [data-state=WIP]'));
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.find(item=>item.id==="task").state==="WIP");
    await card.locator("[data-todo-open]").dblclick();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    // External claims record actual identities, never a caller-provided display label.
    state=store.noteWorkItemsRead("Board");
    const task=state.items.find(item=>item.id==="task");
    state=store.noteWorkItemCommand("Board",state.digest,{action:"edit",item:{...task,ownerId:"external:claude:one",owner:"Friendly label"}},{id:"user:local",role:"user"});
    const workerToken=store.todoBoardGrantWorker("Board",state.digest,"external:claude:one");
    state=store.noteWorkItemsRead("Board");
    store.noteWorkItemExternalCommand("Board",state.digest,{action:"claim",id:"task"},workerToken);
    await page.getByRole("button",{name:"Reload from Note",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.find(item=>item.id==="task").ownerId==="external:claude:one");
    assert.match(await card.locator(".note-todo-assigned").innerText(),/external:claude:one/);
    state=store.noteWorkItemsRead("Board");
    const archived=callTodoApi("delete_workitem",{board_slug:"Board",id:"task",expected_digest:state.digest,reason:"Archive completed investigation"},"external:claude:one");
    await page.getByRole("button",{name:"Reload from Note",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.length===1);
    assert.equal(await page.locator('[data-todo-card-id=task]').count(),0,"archived tasks disappear from managed Board");
    await page.locator('[data-todo-open=story]').dblclick();
    assert.equal(await page.getByRole("dialog").locator(".note-todo-timeline-row").count(),0,"archived tasks disappear from Story Gantt");
    await page.keyboard.press("Escape");
    callTodoApi("restore_workitem",{board_slug:"Board",id:"task",expected_digest:archived.digest,reason:"Restore investigation"},"external:claude:one");
    await page.getByRole("button",{name:"Reload from Note",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.length===2);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
