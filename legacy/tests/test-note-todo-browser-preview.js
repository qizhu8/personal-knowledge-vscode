const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {chromium}=require(process.env.PKM_PLAYWRIGHT_PATH||"playwright");
const root=process.env.PKM_TODO_BROWSER_EXTENSION||path.resolve(__dirname,"..");
const {browserNoteTodo}=require(path.join(root,"dist/ui/note-todo-browser"));
const item=(id,extra={})=>({id,title:id,goal:"User value",scope:"Note",acceptance:["Exact result"],state:"Planning",evidence:[],...extra});
const markdown=items=>items.map(record=>"~~~pkm-work-item\n"+JSON.stringify(record)+"\n~~~").join("\n");
test("browser Note reuses read-only Table/Story Board/Timeline without bridge or writes",async()=>{
  const records=[item("story",{kind:"UserStory",storyStatus:"draft"}),item("task",{parentId:"story",title:"<script>window.injected=true</script>"}),
    item("closed",{state:"Done",outcome:"Failed",evidence:["test://failure"],parentId:"story"})];
  const html=browserNoteTodo("<p>Original Markdown</p>",markdown(records),"Team/Progress","Progress",root);
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:800}});
    const errors=[],requests=[];
    page.on("pageerror",error=>errors.push(error.message));page.on("request",request=>requests.push(request.url()));
    await page.setContent(html);
    assert.equal(await page.locator("#note-todo-show-done").isChecked(),true,"completed items are visible by default");
    await page.locator("#note-todo-show-done").uncheck();
    assert.equal(await page.locator(".note-todo-table > tbody > tr").count(),1);
    assert.equal(await page.locator("[data-todo-edit],[data-todo-action],[data-todo-new],[data-todo-new-story],[data-todo-add-child]").count(),0);
    await page.locator('[data-note-view=board]').click();
    assert.equal(await page.evaluate(()=>location.hash),"#todo-board");
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.pkmDirty),"true","background reader refresh must not reset interactive progress views");
    assert.equal(await page.locator(".note-todo-swimrow").count(),1);
    assert.equal(await page.locator(".note-todo-swimstory .note-todo-card").count(),1);
    assert.equal(await page.locator('[data-todo-toggle-story=story]').getAttribute("aria-expanded"),"false","Stories start collapsed");
    assert.equal(await page.locator(".note-todo-swimcell .note-todo-card").count(),0);
    const collapsedHeight=(await page.locator(".note-todo-swimrow").boundingBox()).height;
    await page.locator('[data-todo-toggle-story=story]').click();
    assert.equal(await page.locator('[data-todo-toggle-story=story]').getAttribute("aria-expanded"),"true");
    assert.equal(await page.locator(".note-todo-swimcell .note-todo-card").count(),1);
    assert((await page.locator(".note-todo-swimrow").boundingBox()).height>collapsedHeight,"default collapse reduces row height");
    assert.equal(await page.locator(".note-todo-card .note-todo-details").count(),0);
    for (const width of [390,1100,2000]) {
      await page.setViewportSize({width,height:850});
      for (const show of [true,false]) {
        await page.locator("#note-todo-show-done").setChecked(show);
        const layout=await page.locator(".note-todo-swimboard").evaluate(board=>{
          const head=board.querySelector(".note-todo-swimhead");
          const boxes=node=>[...node.children].map(child=>{const rect=child.getBoundingClientRect();return {x:rect.x,width:rect.width};});
          return {available:board.clientWidth,head:boxes(head),row:boxes(board.querySelector(".note-todo-swimrow")),
            labels:[...head.querySelectorAll("h3")].map(node=>node.textContent)};
        });
        assert.deepEqual(layout.labels,show?["Planning","WIP","Blocked","On hold","Completed"]:["Planning","WIP","Blocked","On hold"]);
        assert.equal(layout.head[0].width,230);
        const expected=Math.max(220,(layout.available-230)/(show?5:4));
        layout.head.slice(1).forEach((box,index)=>{
          assert(Math.abs(box.width-expected)<1,"status columns share remaining width equally with a readable minimum");
          assert(Math.abs(box.x-layout.row[index+1].x)<1,"header and Story cells remain aligned");
          assert(Math.abs(box.width-layout.row[index+1].width)<1);
        });
      }
    }
    await page.locator('[data-todo-open=task]').click();
    assert.equal(await page.getByRole("dialog").count(),0,"single-click leaves cards closed");
    await page.locator('[data-todo-open=task]').dblclick();
    const dialog=page.getByRole("dialog",{name:"Work Item details"});
    await dialog.waitFor();
    assert.match(await dialog.innerText(),/User value/,"read-only details remain available by opening the Work Item");
    await dialog.getByRole("button",{name:"Close Work Item details"}).click();
    await page.locator('[data-todo-open=story]').dblclick();
    const overview=page.getByRole("region",{name:"User Story overview"});
    await overview.waitFor();
    assert.match(await overview.innerText(),/User value/);
    assert.equal(await overview.locator(".note-todo-timeline-row").count(),2,"Story Gantt includes closed children even when Board hides Done");
    assert.equal(await overview.locator(".note-todo-details,[data-todo-edit]").count(),0,"read-only overview has no edit controls or inline child details");
    await page.setViewportSize({width:390,height:850});
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true,"Story overview fits narrow readers");
    await overview.locator('[data-todo-open=task]').dblclick();
    assert.match(await dialog.innerText(),/User value/);
    await dialog.getByRole("button",{name:"Close Work Item details"}).click();
    await page.locator("#note-todo-show-done").check();
    assert.equal(await page.locator('[data-todo-toggle-story=story]').getAttribute("aria-expanded"),"true","explicit expansion survives filters and rerenders");
    assert.equal(await page.locator('.note-todo-swimcell[data-state=Done] .note-todo-card').count(),1);
    await page.locator("[data-todo-collapse-all]").click();
    assert.equal(await page.locator(".note-todo-swimcell .note-todo-card").count(),0);
    await page.locator("[data-todo-expand-all]").click();
    await page.locator('[data-note-view=timeline]').click();
    assert.equal(await page.locator(".note-todo-timeline-row").count(),2);
    await page.locator('[data-note-view=markdown]').click();
    assert.equal(await page.locator("#note-markdown").innerText(),"Original Markdown");
    await page.evaluate(()=>{noteTodoCommand({action:"claim",id:"task"});noteTodoEdit("task");noteTodoAction("accept","closed");});
    assert.equal(await page.locator("#note-todo-editor").count(),0);
    assert.equal(await page.evaluate(()=>window.injected),undefined);
    await page.setViewportSize({width:390,height:850});
    await page.locator('[data-note-view=board]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  }finally{await browser.close();}
});
test("plain Notes unchanged and malformed Work Items show explicit error with Markdown",()=>{
  assert.equal(browserNoteTodo("<p>Plain</p>","# Plain","Plain","Plain",root),"<p>Plain</p>");
  const invalid=browserNoteTodo("<p>Original</p>","~~~pkm-work-item\n{broken}\n~~~","Bad","Bad",root);
  assert.match(invalid,/role="alert"/);assert.match(invalid,/<p>Original<\/p>/);
});
test("private original Todo editor opens only an admitted Chat and retains an unsaved draft",async()=>{
  const chat={id:"2810ad91-3f21-4970-87ab-7243824c0525",title:"Original Chat",chatUrl:"pkm://chats/original/2810ad91-3f21-4970-87ab-7243824c0525"};
  const snapshot={digest:"0".repeat(64),items:[item("task",{ownerId:"chat:"+chat.id})]};
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage(),messages=[],errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("privateHost",async message=>{
      messages.push(message);
      if(message.command==="noteTodoRead")await page.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),{
        command:"noteTodoResult",data:{slug:"Team/Board",requestId:message.requestId,snapshot,chats:[chat]},
      });
    });
    await page.addInitScript(()=>{globalThis.acquireVsCodeApi=()=>({postMessage:message=>privateHost(message)});});
    await page.goto("about:blank");
    await page.setContent(browserNoteTodo("","","Team/Board","Board",root,snapshot,true,true,true));
    try { await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.chats.length===1); }
    catch(error) { assert.deepEqual(errors,[]); throw error; }
    await page.locator("[data-todo-open=task]").dblclick();
    assert.deepEqual(errors,[]);
    const form=page.locator("#note-todo-editor"),open=form.getByRole("button",{name:"Open associated Chat",exact:true});
    await form.locator("[name=goal]").fill("UNSAVED_ORIGINAL_TODO_DRAFT");
    await open.click();
    await page.waitForFunction(()=>noteTodo.editor!==null);
    assert.equal(await form.locator("[name=goal]").inputValue(),"UNSAVED_ORIGINAL_TODO_DRAFT");
    assert.deepEqual(messages.filter(message=>message.command==="nativeTodoOpenChat"),[{command:"nativeTodoOpenChat",chatUrl:chat.chatUrl}]);
    assert.equal(messages.some(message=>message.command==="noteTodoCommand"),false,"navigation must not submit or discard the user draft");
    await form.locator("[name=ownerId]").fill("chat:unadmitted");
    assert.equal(await open.isVisible(),false);
    await form.locator("[name=ownerId]").fill("user:local");
    assert.equal(await open.isVisible(),false);
    await form.locator("[name=ownerId]").fill("chat:"+chat.id);
    assert.equal(await open.isVisible(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test("private original Table identity link uses native transport without navigating or changing Work Items",async()=>{
  const uri="pkm://knowledge/knowledge_synthetic";
  const snapshot={digest:"0".repeat(64),items:[item("task",{links:[uri]})]};
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("privateHost",async message=>{
      if(message.command==="noteTodoRead")await page.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),{
        command:"noteTodoResult",data:{slug:"Team/Board",requestId:message.requestId,snapshot,chats:[]},
      });
    });
    await page.addInitScript(()=>{
      globalThis.sent=[];
      globalThis.acquireVsCodeApi=()=>({postMessage:message=>{sent.push(message);privateHost(message);}});
    });
    await page.goto("about:blank");
    await page.setContent(browserNoteTodo("","","Team/Board","Board",root,snapshot,true,true,true));
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot);
    await page.locator("[data-note-view=table]").click();
    const row=page.locator("tr[data-todo-card-id=task]");
    await row.locator("details.note-todo-details > summary").click();
    const beforeUrl=page.url();
    await row.locator(`a[href="${uri}"]`).click();
    assert.deepEqual(await page.evaluate(()=>sent.filter(message=>message.command==="nativeTodoOpenKnowledge")),
      [{command:"nativeTodoOpenKnowledge",slug:"Team/Board",uri}]);
    assert.equal(await page.evaluate(()=>sent.some(message=>message.command==="noteTodoCommand")),false);
    assert.deepEqual(await page.evaluate(()=>noteTodo.snapshot),snapshot);
    assert.equal(page.url(),beforeUrl);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test("private worker-token buttons correlate a response without submitting or losing the editor draft",async()=>{
  const actorId="external:copilot:fixture-worker",snapshot={digest:"0".repeat(64),items:[item("task",{ownerId:actorId})]};
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage(),messages=[],errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("privateHost",async message=>{
      messages.push(message);
      if(["noteTodoRead","todoBoardGrantWorker"].includes(message.command)){
        assert(Number.isSafeInteger(message.requestId));
        const granted=message.command==="todoBoardGrantWorker";
        await page.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),{
          command:"noteTodoResult",data:{slug:"Team/Board",requestId:message.requestId,
            snapshot:{...snapshot,digest:(granted?"1":"0").repeat(64)},workerSecretStatus:{[actorId]:granted?"ready":"missing"}},
        });
      }
    });
    await page.addInitScript(()=>{globalThis.acquireVsCodeApi=()=>({postMessage:message=>privateHost(message)});});
    await page.goto("about:blank");
    await page.setContent(browserNoteTodo("","","Team/Board","Board",root,snapshot,true,true,true));
    await page.waitForFunction(()=>!noteTodo.pending);
    await page.locator("[data-todo-open=task]").dblclick();
    const form=page.locator("#note-todo-editor");
    await form.locator("[name=goal]").fill("UNSAVED_DURING_WORKER_GRANT");
    await form.getByRole("button",{name:"Copy / rotate external worker token",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.workerSecretStatus?.["external:copilot:fixture-worker"]==="ready");
    assert.equal(await form.locator("[name=goal]").inputValue(),"UNSAVED_DURING_WORKER_GRANT");
    assert.equal(await form.locator("[data-native-todo-worker-secret]").innerText(),"Worker grant matches this private profile SecretStorage.");
    await page.evaluate(actorId=>{
      window.dispatchEvent(new MessageEvent("message",{data:{command:"noteTodoResult",
        data:{slug:"Team/Board",requestId:-1,workerSecretStatus:{[actorId]:"pending"}}}}));
      window.dispatchEvent(new MessageEvent("message",{data:{command:"noteTodoResult",
        data:{slug:"Another/Board",requestId:noteTodo.request,workerSecretStatus:{[actorId]:"missing"}}}}));
      window.dispatchEvent(new MessageEvent("message",{data:{command:"noteTodoResult",
        data:{slug:"Team/Board",workerSecretStatus:{[actorId]:"pending"}}}}));
    },actorId);
    assert.equal(await page.evaluate(actorId=>noteTodo.workerSecretStatus[actorId],actorId),"ready");
    assert.equal(messages.filter(message=>message.command==="todoBoardGrantWorker").length,1);
    assert.equal(messages.some(message=>message.command==="noteTodoCommand"),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test("private user UI deletes and restores one Work Item with reasons and unchanged identity",async()=>{
  const {serializeTodoBoard,readTodoBoard,commandTodoBoard}=require(path.join(root,"dist/knowledge/todo-board"));
  let raw=serializeTodoBoard([item("task")]);
  const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.exposeFunction("privateHost",async message=>{
      if(message.command==="noteTodoCommand")
        raw=commandTodoBoard(raw,message.expectedDigest,message.operation,{id:"user:local",role:"user"});
      await page.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),{
        command:"noteTodoResult",data:{slug:"Team/Board",requestId:message.requestId,snapshot:readTodoBoard(raw)},
      });
    });
    await page.addInitScript(()=>{globalThis.acquireVsCodeApi=()=>({postMessage:message=>privateHost(message)});});
    await page.goto("about:blank");
    await page.setContent(browserNoteTodo("","","Team/Board","Board",root,readTodoBoard(raw),true,true,true));
    await page.waitForFunction(()=>!noteTodo.pending);
    await page.locator("[data-todo-open=task]").dblclick();
    await page.getByRole("button",{name:"Delete Work Item",exact:true}).click();
    let dialog=page.getByRole("dialog",{name:"Todo confirmation"});
    await dialog.getByRole("textbox",{name:"Reason"}).fill("Explicit user deletion");
    await dialog.getByRole("button",{name:"Confirm",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&!noteTodo.editor);
    assert.equal(await page.locator("[data-todo-open=task]").count(),0);
    await page.locator("[data-native-todo-restore=task]").click();
    dialog=page.getByRole("dialog",{name:"Todo confirmation"});
    await dialog.getByRole("textbox",{name:"Reason"}).fill("Restore original identity");
    await dialog.getByRole("button",{name:"Confirm",exact:true}).click();
    await page.waitForFunction(()=>!noteTodo.pending&&noteTodo.snapshot.items.length===1);
    const restored=readTodoBoard(raw).items[0];
    assert.equal(restored.id,"task");assert(!restored.deletedAt);
    assert.deepEqual(restored.history.map(entry=>[entry.action,entry.actorId,entry.reason]),[
      ["delete","user:local","Explicit user deletion"],["restore","user:local","Restore original identity"],
    ]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
