const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {chromium}=require(process.env.PKM_PLAYWRIGHT_PATH||"playwright");
const store=require("../dist/knowledge/filestore");
const {browserNoteTodo}=require("../dist/ui/note-todo-browser");
const item=(id,extra={})=>({id,title:id,goal:"Detailed user value",scope:"Board UI",acceptance:["Exact controlled state"],state:"Planning",evidence:[],...extra});
test("dedicated Board opens a large work-item dialog, assigns actual identities, and drags through guarded CAS",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-board-ui-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  const slug="Board";
  store.todoBoardCreate(slug,slug);
  let state=store.noteWorkItemsRead(slug);
  const verification=[
    {layer:"unit",status:"failed",evidence:["fixture://prior-failure"],reason:"Prior unit failure"},
    {layer:"functional",status:"blocked",evidence:["fixture://dependency"],reason:"Dependency unavailable"},
    {layer:"e2e",status:"not-applicable",evidence:[],reason:"No installed E2E in this fixture"},
  ];
  for(const record of [item("story",{kind:"UserStory",storyStatus:"draft"}),item("other-story",{kind:"UserStory"}),item("task",{parentId:"story",plannedStart:"2026-11-01",plannedEnd:"2026-11-10",verification})]) {
    state=store.noteWorkItemCommand(slug,state.digest,{action:"create",item:record},{id:"user:local",role:"user"});
  }
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    const errors=[],writes=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("host",async message=>{
      if(message.command==="todoBoardGrantWorker"){writes.push(message);return;}
      if(message.command==="copyText"){writes.push(message);return;}
      const data={slug:message.slug,requestId:message.requestId,chats:[{id:"pkm-worker-one",title:"PKM Worker One",chatUrl:"pkm://chats/0123456789abcdef/11111111-1111-4111-8111-111111111111"}],documentKind:"todo-board"};
      try{
        if(message.command==="noteTodoCommand"){
          writes.push(message);
          store.noteWorkItemCommand(slug,message.expectedDigest,message.operation,{id:"user:local",role:"user"});
        }
        data.snapshot=store.noteWorkItemsRead(slug);data.content=store.noteGet(slug).content;
      }catch(error){data.error=error.message;}
      await page.evaluate(data=>noteTodoResult(data),data);
    });
    await page.setContent('<style>.hidden{display:none!important}:root{--vscode-panel-border:#bbb;--vscode-foreground:#222;--vscode-descriptionForeground:#666;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-sideBar-background:#f7f7f7;--vscode-focusBorder:#087ea4;--vscode-charts-blue:#087ea4;--vscode-charts-green:#187744;--vscode-errorForeground:#a00}</style><nav><button data-note-view="board">Board</button></nav><div id="note-todo"></div><div id="note-markdown" class="hidden"></div>');
    await page.addStyleTag({path:path.resolve(__dirname,"../dist/webview/panel.css")});
    const source=fs.readFileSync(path.resolve(__dirname,"../src/webview/panel/22-note-todo.js"),"utf8");
    assert(fs.readFileSync(path.resolve(__dirname,"../dist/webview/panel.js"),"utf8").includes(source));
    await page.addScriptTag({content:`const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      let currentDetail={type:'note',documentKind:'todo-board',slug:'Board',title:'Board',content:''};
      const vscode={postMessage:message=>host(message)};const safeMarked=esc;const pkModal=options=>options.onOk('User reviewed');
      ${source}`});
    await page.evaluate(()=>noteTodoMount(currentDetail));
    await page.waitForFunction(()=>noteTodo.snapshot?.items.length===3&&noteTodo.pending===null);
    assert.equal(await page.evaluate(()=>noteTodo.view),"board");
    assert.equal(await page.locator('[data-todo-toggle-story=story]').getAttribute("aria-expanded"),"false");
    assert.equal(await page.locator(".note-todo-swimcell .note-todo-card").count(),0,"dedicated Board Stories start collapsed");
    await page.locator('[data-todo-expand-all]').click();
    assert.equal(await page.locator(".note-todo-card .note-todo-details").count(),0,"Story and task cards omit inline contract details");
    await page.locator('[data-todo-open=story]').click();
    assert.equal(await page.getByRole("dialog").count(),0,"single-click must not open a Story");
    await page.locator('[data-todo-open=story]').dblclick();
    const overview=page.getByRole("region",{name:"User Story overview"});
    await overview.waitFor();
    assert.match(await overview.innerText(),/Detailed user value/);
    assert.match(await overview.innerText(),/Board UI/);
    assert.equal(await page.locator("#note-todo-editor").count(),0,"Story opens an overview rather than an edit form");
    assert.equal(await overview.locator(".note-todo-timeline-row").count(),1,"Gantt contains only this Story's children");
    assert.equal(await overview.locator(".note-todo-time.plan").count(),1);
    await overview.getByRole("button",{name:"Edit User Story",exact:true}).click();
    assert.equal(await page.locator('#note-todo-editor [name=title]').inputValue(),"story");
    await page.getByRole("button",{name:"Close Work Item details"}).click();
    await page.locator('[data-todo-open=other-story]').dblclick();
    assert.match(await overview.innerText(),/No child Work Items yet/);
    await page.getByRole("button",{name:"Close Work Item details"}).click();
    await page.locator('[data-todo-open=story]').dblclick();
    await overview.locator('[data-todo-open=task]').dblclick();
    const dialog=page.getByRole("dialog",{name:"Work Item details"}),form=dialog.locator("#note-todo-editor");
    await dialog.waitFor();
    const box=await dialog.boundingBox();
    assert(box.width>=1200*.88&&box.height>=900*.88,"dialog occupies approximately 80% of screen area");
    assert.equal(await form.locator('[name=goal]').inputValue(),"Detailed user value");
    assert.equal(await form.locator('[name=verify-functional]').inputValue(),"blocked");
    assert.equal(await form.locator('[name=reason-functional]').inputValue(),verification[1].reason);
    assert.equal(await form.locator('[name=evidence-functional]').inputValue(),verification[1].evidence.join("\n"));
    // Edit unrelated fields: the selected blocked status and every other layer must survive save.
    await form.locator('[name=title]').fill("Task with retained blocked verification");
    await form.locator('[name=reason]').fill("Clarify title without changing reported verification");
    await form.getByLabel("Assign to",{exact:true}).selectOption("user:local");
    assert.equal(await form.locator('[name=ownerId]').inputValue(),"user:local");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    assert.equal(store.noteWorkItemsRead(slug).items.find(item=>item.id==="task").ownerId,"user:local");
    assert.deepEqual(writes.filter(message=>message.command==="noteTodoCommand").at(-1).operation.item.verification,verification);
    assert.deepEqual(store.noteWorkItemsRead(slug).items.find(item=>item.id==="task").verification,verification);
    await page.locator('[data-todo-open=task]').dblclick();
    assert.equal(await form.locator('[name=verify-functional]').inputValue(),"blocked");
    await form.getByLabel("Assign to",{exact:true}).selectOption("chat:pkm-worker-one");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    assert.equal(store.noteWorkItemsRead(slug).items.find(item=>item.id==="task").ownerId,"chat:pkm-worker-one");
    const assigned=page.locator('[data-todo-card-id=task] [data-todo-copy-chat]');
    assert.match(await assigned.innerText(),/PKM Worker One.*pkm-worker-one/);
    await assigned.click();
    assert.equal(writes.at(-1).text,"pkm://chats/0123456789abcdef/11111111-1111-4111-8111-111111111111");
    assert.equal(await page.getByRole("dialog").count(),0,"copying a Chat URL must not open details");
    await page.locator('[data-todo-open=task]').dblclick();
    await form.getByLabel("Assign to",{exact:true}).selectOption("external:claude:");
    await form.locator('[name=ownerId]').fill("external:claude:worker-one");
    await form.locator('[name=owner]').fill("Claude Worker One");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    await page.locator('[data-todo-open=task]').dblclick();
    await form.locator("[data-todo-worker-token]").click();
    assert.equal(writes.at(-1).actorId,"external:claude:worker-one");
    await dialog.getByRole("button",{name:"Close Work Item details"}).click();
    const card=page.locator('.note-todo-card[data-todo-card-id=task]');
    await card.dragTo(page.locator('[data-story-row=other-story] [data-state=WIP]'));
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.find(item=>item.id==="task").state==="WIP");
    let task=store.noteWorkItemsRead(slug).items.find(item=>item.id==="task");
    assert.equal(task.parentId,"other-story");assert.equal(task.ownerId,"external:claude:worker-one");
    assert.match(task.history.at(-1).reason,/Moved on Board/);
    const active=store.noteWorkItemsRead(slug);
    assert.equal(await page.getByRole("heading",{name:"On hold",exact:true}).count(),1);
    await card.dragTo(page.locator('[data-story-row=other-story] [data-state=OnHold]'));
    await dialog.waitFor();
    assert.equal(store.noteWorkItemsRead(slug).digest,active.digest,"On hold needs explicit confirmation before mutation");
    assert.equal(await form.locator('[name=state]').inputValue(),"OnHold");
    await form.locator('[name=reason]').fill("");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(store.noteWorkItemsRead(slug).digest,active.digest,"On hold cannot discard suspension reason");
    await form.locator('[name=reason]').fill("Pause current work explicitly");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    task=store.noteWorkItemsRead(slug).items.find(item=>item.id==="task");
    assert.equal(task.state,"OnHold");
    assert.equal(task.ownerId,"external:claude:worker-one");
    assert.equal(task.history.at(-1).reason,"Pause current work explicitly");
    assert.equal(await card.locator(".note-todo-state.onhold").innerText(),"ON HOLD");
    const before=store.noteWorkItemsRead(slug);
    await card.dragTo(page.locator('[data-story-row=other-story] [data-state=Blocked]'));
    await dialog.waitFor();
    assert.equal(store.noteWorkItemsRead(slug).digest,before.digest,"Blocked requires explicit reason before any mutation");
    await form.locator('[name=blockedReason]').fill("Dependency unavailable");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    assert.equal(store.noteWorkItemsRead(slug).items.find(item=>item.id==="task").blockedReason,"Dependency unavailable");
    // Drop to Done opens review fields; an incomplete result cannot be silently saved.
    await page.locator("#note-todo-show-done").check();
    await card.dragTo(page.locator('[data-story-row=other-story] [data-state=Done]'),{sourcePosition:{x:5,y:5}});
    await dialog.waitFor();
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(store.noteWorkItemsRead(slug).items.find(item=>item.id==="task").state,"Blocked");
    await form.locator('[name=outcome]').selectOption("Success");
    await form.locator('[name=evidence]').fill("test://board/drag");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    task=store.noteWorkItemsRead(slug).items.find(item=>item.id==="task");
    assert.equal(task.state,"Done");assert.equal(task.acceptanceDecision,undefined);
    assert.equal(await card.getAttribute("draggable"),null,"Done is not silently reopened by dragging");
    await card.locator("[data-todo-open]").dblclick();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(),0);
    await page.setViewportSize({width:390,height:850});
    await card.locator("[data-todo-open]").dblclick();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
// Use Chromium's mouse-backed dragTo, not dispatchEvent/DataTransfer proxies.
test("Story creation and header grouping persist through the real Board CAS store",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-board-groups-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  const slug="Grouping",actor={id:"user:local",role:"user"};
  store.todoBoardCreate(slug,slug);
  let snapshot=store.noteWorkItemsRead(slug);
  for(const record of [item("story-a",{kind:"UserStory"}),item("story-b",{kind:"UserStory"}),item("moving",{parentId:"story-a"})]){
    snapshot=store.noteWorkItemCommand(slug,snapshot.digest,{action:"create",item:record},actor);
  }
  let moving=snapshot.items.find(record=>record.id==="moving");
  snapshot=store.noteWorkItemCommand(slug,snapshot.digest,{action:"edit",item:{...moving,state:"Blocked",blockedReason:"Waiting for review",ownerId:"user:local",owner:"Local reviewer",evidence:["test://grouping/evidence"]},reason:"Prepare preserved fields"},actor);
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("host",async message=>{
      const data={slug,requestId:message.requestId,chats:[],documentKind:"todo-board"};
      try{
        if(message.command==="noteTodoCommand"){
          writes.push(message);
          store.noteWorkItemCommand(slug,message.expectedDigest,message.operation,actor);
        }
        data.snapshot=store.noteWorkItemsRead(slug);data.content=store.noteGet(slug).content;
      }catch(error){data.error=error.message;}
      await page.evaluate(data=>noteTodoResult(data),data);
    });
    await page.setContent('<style>.hidden{display:none!important}</style><div id="note-todo"></div><div id="note-markdown"></div>');
    await page.addStyleTag({path:path.resolve(__dirname,"../dist/webview/panel.css")});
    const source=fs.readFileSync(path.resolve(__dirname,"../src/webview/panel/22-note-todo.js"),"utf8");
    assert(fs.readFileSync(path.resolve(__dirname,"../dist/webview/panel.js"),"utf8").includes(source),"build must contain the tested production source");
    await page.addScriptTag({content:`const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      let currentDetail={type:'note',documentKind:'todo-board',slug:'Grouping',title:'Grouping',content:''};
      const vscode={postMessage:message=>host(message)};const safeMarked=esc;const pkModal=options=>options.onOk('User reviewed');
      ${source}`});
    await page.evaluate(()=>noteTodoMount(currentDetail));
    await page.waitForFunction(()=>noteTodo.snapshot?.items.length===3&&!noteTodo.pending);
    assert.equal(await page.locator('[data-todo-toggle-story=story-a]').getAttribute("aria-expanded"),"false");
    await page.locator('[data-todo-expand-all]').click();
    const header=id=>page.locator(`[data-story-row="${id}"] .note-todo-swimstory`);
    const card=()=>page.locator('[data-todo-card-id=moving]');
    // Native HTML drag needs a second target move for dragover on every Chromium path.
    // Scroll before mousedown, then use real mouse input throughout (no synthetic events).
    const dragToHeader=async id=>{
      await card().scrollIntoViewIfNeeded();
      const from=await card().boundingBox();
      assert(from,'source has real mouse geometry');
      await page.mouse.move(from.x+12,from.y+12);
      await page.mouse.down();
      await page.mouse.move(from.x+24,from.y+24,{steps:5});
      await header(id).scrollIntoViewIfNeeded();
      const to=await header(id).boundingBox();
      assert(to,'header has real mouse geometry');
      const x=to.x+Math.min(12,to.width/2),y=to.y+Math.min(12,to.height/2);
      assert.equal(await page.evaluate(({x,y,id})=>document.elementFromPoint(x,y)?.closest('[data-story-row]')?.dataset.storyRow,{x,y,id}),id,'mouse hits the intended visible group, not a sticky overlay');
      await page.mouse.move(x,y,{steps:15});
      await page.mouse.move(x+1,y+1);
      await page.mouse.up();
    };
    const persisted=()=>store.noteWorkItemsRead(slug).items.find(record=>record.id==="moving");
    const preserved=record=>{
      const {parentId,history,...rest}=record;
      return rest;
    };
    const original=preserved(persisted());
    await t.test("New User Story saves its definition and survives remount",async()=>{
      const create=page.locator('[data-todo-new-story]');
      assert.equal(await create.count(),1,"Board exposes New User Story");
      await create.click();
      const form=page.locator('#note-todo-editor');
      await form.locator('[name=title]').fill("Created through browser");
      await form.locator('[name=goal]').fill("User can organize real tasks");
      await form.locator('[name=scope]').fill("One Board");
      await form.locator('[name=acceptance]').fill("Definition persists\nChildren remain independent");
      const id=await page.evaluate(()=>noteTodo.editor.item.id);
      await form.getByRole('button',{name:'Save Work Item'}).click();
      await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
      const created=store.noteWorkItemsRead(slug).items.find(record=>record.id===id);
      assert(created,"New Story must reach the authoritative persisted store");
      assert.equal(created.kind,"UserStory");assert.equal(created.storyStatus,"draft");
      assert.equal(created.title,"Created through browser");assert.equal(created.goal,"User can organize real tasks");
      assert.equal(created.scope,"One Board");assert.deepEqual(created.acceptance,["Definition persists","Children remain independent"]);
      assert.equal(created.parentId,undefined);assert.equal(created.acceptanceDecision,undefined);
      assert.equal(writes.at(-1).operation.action,"create");
      await page.evaluate(()=>noteTodoMount(currentDetail));
      await page.waitForFunction(id=>!noteTodo.pending&&noteTodo.snapshot?.items.some(record=>record.id===id),id);
      assert.match(await header(id).innerText(),/Created through browser/);
    });
    await t.test("empty Unassigned group is visible and labelled",async()=>{
      assert.equal(await header('unassigned').count(),1,"Unassigned remains a visible target even with no children");
      assert.match(await header('unassigned').innerText(),/Unassigned Work Items/);
      assert.match(await header('unassigned').innerText(),/No parent User Story/);
    });
    await t.test("real mouse header drops A to B to Unassigned preserve every non-relation field",async()=>{
      for(const parent of ['story-b','unassigned']){
        const before=store.noteWorkItemsRead(slug),count=writes.length;
        await dragToHeader(parent);
        // Observe an actual bridge command before waiting for state; missing header handlers fail explicitly.
        assert.equal(writes.length,count+1,`header drop to ${parent} must emit exactly one CAS edit`);
        await page.waitForFunction(()=>!noteTodo.pending);
        assert.equal(writes.at(-1).expectedDigest,before.digest);
        assert.equal(writes.at(-1).operation.action,'edit');
        const saved=persisted();
        assert.equal(saved.parentId,parent==='unassigned'?undefined:parent);
        assert.deepEqual(preserved(saved),original,"grouping must not change state, blocked reason, owner, evidence or contract");
        assert.equal(await page.getByRole('dialog').count(),0,"header grouping must not open state-transition fields");
      }
      await page.evaluate(()=>noteTodoMount(currentDetail));
      await page.waitForFunction(()=>!noteTodo.pending);
      assert.equal(await page.locator('[data-story-row=unassigned] [data-todo-card-id=moving]').count(),1,"relation survives persisted reload");
    });
    await t.test("stale header drop reports CAS error without overwriting concurrent fields",async()=>{
      // A real external write makes the displayed digest stale.
      let current=store.noteWorkItemsRead(slug);
      const record=current.items.find(record=>record.id==='moving');
      current=store.noteWorkItemCommand(slug,current.digest,{action:'edit',item:{...record,title:'Concurrent change'},reason:'External edit'},actor);
      const count=writes.length;
      await dragToHeader(record.parentId==='story-a'?'story-b':'story-a');
      assert.equal(writes.length,count+1,"stale drop must reach CAS, not silently disappear");
      await page.waitForFunction(()=>!noteTodo.pending&&!!noteTodo.error);
      assert.match(await page.getByRole('alert').innerText(),/changed|reload|conflict/i);
      assert.equal(store.noteWorkItemsRead(slug).digest,current.digest,"CAS rejects the whole stale mutation");
      assert.equal(persisted().title,'Concurrent change');
      await page.locator('[data-todo-refresh]').click();
      await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.error);
      assert.equal(await page.getByRole('alert').count(),0,"explicit reload clears the error");
    });
    await t.test("collapsed Story header stays visible and accepts a real mouse drop",async()=>{
      const target=persisted().parentId==='story-b'?'story-a':'story-b';
      const toggle=page.locator(`[data-todo-toggle-story="${target}"]`);
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'),"false");
      assert.equal(await header(target).isVisible(),true,"collapsed group must retain a visible drop header");
      const before=persisted(),count=writes.length;
      await dragToHeader(target);
      assert.equal(writes.length,count+1,"collapsed header emits one edit");
      await page.waitForFunction(()=>!noteTodo.pending);
      assert.equal(persisted().parentId,target);
      assert.deepEqual(preserved(persisted()),preserved(before));
      assert.equal(await toggle.getAttribute('aria-expanded'),"false");
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test("browser Board renders empty snapshots and large read-only item dialogs without mutation controls",async()=>{
  const root=path.resolve(__dirname,"..");
  const empty=browserNoteTodo("Historical source must not appear","~~~pkm-work-item\nbad\n~~~","Board","Board",root,{digest:"a".repeat(64),items:[]});
  assert(!empty.includes("Historical source must not appear"));
  const html=browserNoteTodo("old data","old source","Board","Board",root,{digest:"b".repeat(64),items:[item("story-a",{kind:"UserStory"}),item("story-b",{kind:"UserStory"}),item("task",{parentId:"story-a"}),
    item("archived",{parentId:"story-a",deletedAt:"2026-11-04T00:00:00Z",deletedBy:"mcp:external"})]});
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.setContent(empty);
    assert.equal(await page.locator('[data-note-view=markdown]').count(),0);
    assert.equal(await page.locator(".note-todo-swimboard").count(),1);
    await page.goto("about:blank");
    await page.setContent(html);
    assert.equal(await page.locator('[data-todo-toggle-story=story-a]').getAttribute("aria-expanded"),"false","read-only dedicated Boards start compact too");
    await page.locator('[data-todo-expand-all]').click();
    const readonlyBefore=await page.evaluate(()=>JSON.stringify(noteTodo.snapshot));
    const requests=[];page.on('request',request=>requests.push(request.url()));
    const taskCard=page.locator('[data-todo-card-id=task]');
    assert.equal(await page.locator('[data-todo-card-id=archived]').count(),0,"public/export snapshots hide archived items");
    assert.equal(await taskCard.getAttribute('draggable'),null);
    await taskCard.dragTo(page.locator('[data-story-row=story-b] .note-todo-swimstory'));
    await taskCard.dragTo(page.locator('[data-story-row=story-b] [data-state=WIP]'));
    assert.equal(await page.evaluate(()=>JSON.stringify(noteTodo.snapshot)),readonlyBefore,"read-only mouse drops cannot mutate the snapshot");
    assert.equal(await page.evaluate(()=>typeof vscode),'undefined',"View in Browser exposes no write bridge");
    assert.deepEqual(requests,[],"read-only grouping does not call a mutation endpoint");
    assert.equal(await page.locator('[data-todo-new-story],[data-todo-new],[data-todo-add-child]').count(),0);
    await page.locator("[data-todo-open=task]").dblclick();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.getByRole("dialog").innerText(),/Detailed user value/);
    assert.equal(await page.locator("#note-todo-editor,[data-todo-action],[data-todo-worker-token],[draggable=true]").count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test("dedicated Board owner identity is stable across duplicate Chat names, rename, and refresh",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-board-owner-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  const slug="Owner identity",actor={id:"user:local",role:"user"};
  store.todoBoardCreate(slug,slug);
  let snapshot=store.noteWorkItemsRead(slug);
  for(const record of [
    item("story",{kind:"UserStory"}),
    item("assigned-task",{parentId:"story",ownerId:"user:local",owner:"Local user"}),
  ]) snapshot=store.noteWorkItemCommand(slug,snapshot.digest,{action:"create",item:record},actor);
  let chats=[
    {id:"chat-one",title:"Duplicate Chat",chatUrl:"pkm://chats/stable/11111111-1111-4111-8111-111111111111"},
    {id:"chat-two",title:"Duplicate Chat",chatUrl:"pkm://chats/stable/22222222-2222-4222-8222-222222222222"},
  ];
  const writes=[],grants=[],errors=[];
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("host",async message=>{
      if(message.command==="todoBoardGrantWorker"){grants.push(message);return;}
      const data={slug,requestId:message.requestId,chats,documentKind:"todo-board"};
      try{
        if(message.command==="noteTodoCommand"){
          writes.push(message);
          store.noteWorkItemCommand(slug,message.expectedDigest,message.operation,actor);
        }
        data.snapshot=store.noteWorkItemsRead(slug);data.content=store.noteGet(slug).content;
      }catch(error){data.error=error.message;}
      await page.evaluate(data=>noteTodoResult(data),data);
    });
    await page.setContent('<style>.hidden{display:none!important}:root{--vscode-panel-border:#bbb;--vscode-foreground:#222;--vscode-descriptionForeground:#666;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-focusBorder:#087ea4;--vscode-charts-blue:#087ea4;--vscode-charts-green:#187744;--vscode-errorForeground:#a00}</style><nav><button data-note-view="board">Board</button></nav><div id="note-todo"></div><div id="note-markdown" class="hidden"></div>');
    await page.addStyleTag({path:path.resolve(__dirname,"../dist/webview/panel.css")});
    const source=fs.readFileSync(path.resolve(__dirname,"../src/webview/panel/22-note-todo.js"),"utf8");
    assert(fs.readFileSync(path.resolve(__dirname,"../dist/webview/panel.js"),"utf8").includes(source),"tested browser source must match the ready build");
    await page.addScriptTag({content:`const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      let currentDetail={type:'note',documentKind:'todo-board',slug:'Owner identity',title:'Owner identity',content:''};
      const vscode={postMessage:message=>host(message)};const safeMarked=esc;const pkModal=options=>options.onOk('User reviewed');
      ${source}`});
    await page.evaluate(()=>noteTodoMount(currentDetail));
    await page.waitForFunction(()=>noteTodo.snapshot?.items.length===2&&!noteTodo.pending);
    await page.locator('[data-todo-expand-all]').click();
    await page.locator('[data-todo-edit="assigned-task"]').click();
    const form=page.locator('#note-todo-editor');
    const assignee=form.locator('[name=assignee]');
    const initialOptions=await assignee.locator('option').evaluateAll(options=>options.map(option=>({value:option.value,label:option.textContent})));
    assert.equal(initialOptions.find(option=>option.value==="chat:chat-one").label,initialOptions.find(option=>option.value==="chat:chat-two").label,"duplicate display names are allowed");
    assert.deepEqual(initialOptions.filter(option=>option.value.startsWith("chat:")).map(option=>option.value),["chat:chat-one","chat:chat-two"],"stable Chat IDs remain distinct option values");
    assert(initialOptions.some(option=>option.value==="user:local"),"existing local user assignment remains available");
    await assignee.selectOption("chat:chat-two");
    assert.equal(await form.locator('[name=ownerId]').inputValue(),"chat:chat-two");
    await form.getByRole("button",{name:"Save Work Item"}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    let persisted=store.noteWorkItemsRead(slug).items.find(record=>record.id==="assigned-task");
    assert.equal(persisted.ownerId,"chat:chat-two","the exact selected stable identity is persisted, not its title");
    assert.equal(persisted.state,"Planning");
    assert.equal(persisted.acceptanceDecision,undefined);
    assert.equal(store.noteWorkItemsRead(slug).items.find(record=>record.id==="story").kind,"UserStory");

    const writesBeforeRefresh=writes.length,grantsBeforeRefresh=grants.length;
    chats=[
      {id:"chat-two",title:"Renamed Chat",chatUrl:"pkm://chats/stable/22222222-2222-4222-8222-222222222222"},
      {id:"chat-one",title:"Duplicate Chat",chatUrl:"pkm://chats/stable/11111111-1111-4111-8111-111111111111"},
    ];
    await page.locator('[data-todo-refresh]').click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.chats[0]?.title==="Renamed Chat");
    const assigned=page.locator('[data-todo-card-id="assigned-task"] [data-todo-copy-chat]');
    assert.match(await assigned.innerText(),/Renamed Chat.*chat-two/,"owner display follows the renamed Chat and still identifies it");
    assert.equal(writes.length,writesBeforeRefresh,"rename/refresh performs no Work Item command");
    assert.equal(grants.length,grantsBeforeRefresh,"rename/refresh grants no worker authorization");
    persisted=store.noteWorkItemsRead(slug).items.find(record=>record.id==="assigned-task");
    assert.equal(persisted.ownerId,"chat:chat-two","reordered Chat results cannot transfer ownership to the duplicate-name Chat");
    await page.locator('[data-todo-edit="assigned-task"]').click();
    assert.equal(await form.locator('[name=ownerId]').inputValue(),"chat:chat-two");
    assert.equal(await assignee.inputValue(),"chat:chat-two","the refreshed editor selects the same stable identity");
    const refreshedOptions=await assignee.locator('option').evaluateAll(options=>options.map(option=>({value:option.value,label:option.textContent})));
    assert.deepEqual(refreshedOptions.filter(option=>option.value.startsWith("chat:")).map(option=>option.value),["chat:chat-two","chat:chat-one"],"reordered display metadata preserves distinct identity values");
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
