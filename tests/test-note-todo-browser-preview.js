const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {chromium}=require(process.env.PKM_PLAYWRIGHT_PATH||"playwright");
const {browserNoteTodo}=require("../dist/ui/note-todo-browser");
const root=path.resolve(__dirname,"..");
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
    assert.equal(await page.locator(".note-todo-swimcell .note-todo-card").count(),1);
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
