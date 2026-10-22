const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || 'playwright');
const root=path.join(__dirname,'..'),webview=path.join(root,'dist/webview');
const exportsObject={};
vm.runInNewContext(fs.readFileSync(path.join(root,'dist/ui/action-browser.js'),'utf8'),{
  exports:exportsObject,process,console,URL,require(name){
    if(name==='vscode')return {workspace:{isTrusted:true},Uri:{joinPath:(...parts)=>parts.join('/')}};
    if(name==='../mcp/mcp')return {configuredMcpFeatureDomains:()=>['automation']};
    if(name==='../knowledge/filestore')return {};
    if(name==='../knowledge/knowledge-locator')return {};
    if(name==='../runtime/pkm-baseline')return {};
    if(name==='../runtime/action-workbench-server')return {};
    return require(name);
  }
});
function embedded(snapshot){return exportsObject.renderEmbeddedActionWorkbench({cspSource:'http://pkm.test',asWebviewUri:uri=>uri.replace(root+'/dist/webview','http://pkm.test')},{extensionUri:root,extensionPath:root},snapshot);}
let html=fs.readFileSync(path.join(webview,'panel.html'),'utf8').replaceAll('%%CSP_SOURCE%%',"'self'").replaceAll('%%PKM_VERSION%%','test');
const assets={PANEL_JS:'panel.js',PANEL_CSS:'panel.css',CODICON_CSS:'codicon.css',AGENT_HARNESS_CSS:'agent-harness.css',MARKED_SRC:'marked.umd.js',HLJS_SRC:'hljs.js',HLJS_CSS:'hljs.css',KATEX_SRC:'katex.js',KATEX_CSS:'katex.css',CYTOSCAPE_SRC:'cytoscape.js',MERMAID_SRC:'mermaid.js',FORCEGRAPH3D_SRC:'forcegraph3d.js'};
for(const [key,file]of Object.entries(assets))html=html.replaceAll('%%'+key+'%%','http://pkm.test/'+file);
html=html.replaceAll('%%I18N_PAYLOAD_B64%%',Buffer.from(JSON.stringify({setting:'en',resolved:'en',catalogs:{en:{strings:{}}}})).toString('base64')).replace(/%%[A-Z_]+%%/g,'');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PKM_CHROMIUM_EXECUTABLE?{executablePath:process.env.PKM_CHROMIUM_EXECUTABLE}:{})});
 try{
  const errors=[];
  async function pageFor(snapshot){
   const page=await browser.newPage({viewport:{width:1200,height:900}});page.on('pageerror',e=>errors.push(e.message));
   await page.route('http://pkm.test/**',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/')return route.fulfill({contentType:'text/html',body:html});
    const file=path.join(webview,pathname);if(fs.existsSync(file))return route.fulfill({path:file});return route.fulfill({status:404,body:''});
   });
   await page.addInitScript(({snapshot,documentHtml})=>{
    window.__state=snapshot;window.__requests=[];window.__actionRequests=[];window.__duplicates=[];window.__cspViolations=[];
    window.addEventListener('securitypolicyviolation',event=>window.__cspViolations.push(event.violatedDirective));
    const deliver=message=>queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:message})));
    window.acquireVsCodeApi=()=>({getState:()=>window.__state,setState:value=>{window.__state=value;return value},postMessage:message=>{
     window.__requests.push(message);
     if(message.command==='duplicatePanel')window.__duplicates.push(message.state);
     if(message.command==='actionWorkbenchDocument')deliver({command:'actionWorkbenchDocument',html:documentHtml});
     if(message.command==='actionWorkbenchRequest'){
      window.__actionRequests.push(message.message);
      const method=message.message.method;
      let result={ok:true};
      if(method==='catalog')result={ok:true,actions:[],module_sets:[],queue:{jobs:[]}};
      if(method==='runs')result={ok:true,runs:[]};
      if(method==='queue')result={ok:true,jobs:[]};
      deliver({command:'actionWorkbenchReply',message:{requestId:message.message.requestId,result}});
     }
     if(message.command==='list') {
      const response={command:'list',tab:message.tab,q:message.q,data:[],folders:[]};
      if(window.__holdLists)(window.__heldLists ||= []).push(response);else deliver(response);
     }
     if(message.command==='detail')deliver({command:'detail',detailTab:message.detailTab,detailRequestId:message.detailRequestId,data:{type:'skill',name:message.key,content:'Original',tags:'[]',category:''}});
    }});
   },{snapshot,documentHtml:embedded(snapshot.actions||{})});
   await page.goto('http://pkm.test/');await page.waitForFunction(()=>typeof state!=='undefined');return page;
  }
  const first=await pageFor({tab:'actions',workspace:'automation',actions:{graph:{action_id:'local.graph.fixture',name:'Draft one',nodes:[],edges:[]}}});
  const frame=first.frameLocator('#embedded-action-workbench');
  await frame.locator('#name').waitFor();assert.equal(await frame.locator('#name').inputValue(),'Draft one');
  await frame.getByRole('button',{name:'Open in browser',exact:false}).waitFor({state:'visible'});
  await frame.locator('#name').fill('Draft changed without blur');
  await first.locator('#duplicate-pkm-tab').click();
  await first.waitForFunction(()=>window.__duplicates.length===1);
  const duplicate=await first.evaluate(()=>window.__duplicates[0]);assert.equal(duplicate.tab,'actions');assert.equal(duplicate.actions.graph.name,'Draft changed without blur');
  const second=await pageFor(duplicate);await second.frameLocator('#embedded-action-workbench').locator('#name').waitFor();assert.equal(await second.frameLocator('#embedded-action-workbench').locator('#name').inputValue(),'Draft changed without blur');
  await first.locator('.workspace-button[data-workspace="knowledge"]').click();await first.locator('.tab[data-tab="notes"]').click();await first.locator('.workspace-button[data-workspace="automation"]').click();await first.locator('.tab[data-tab="actions"]').click();
  assert.equal(await frame.locator('#name').inputValue(),'Draft changed without blur','view switching retains the same frame and draft');
  assert.equal(await first.evaluate(()=>window.__requests.filter(r=>r.command==='actionWorkbenchDocument').length),1);
  await frame.getByRole('button',{name:'Open in browser',exact:false}).click();
  await first.waitForFunction(()=>window.__actionRequests.some(r=>r.method==='open_browser'));
  assert.equal(await second.evaluate(()=>window.__actionRequests.some(r=>r.method==='open_browser')),false,'requests are isolated');
  assert.equal(await first.evaluate(()=>window.__actionRequests.some(r=>['call','platform_call','save_graph','recover_runs'].includes(r.method))),false,'restoring drafts must never dispatch effects');
  await first.close();assert.equal(await second.frameLocator('#embedded-action-workbench').locator('#name').inputValue(),'Draft changed without blur');
  const restore=await pageFor({tab:'skills',workspace:'knowledge',view:{filter:'all',search:'needle',selection:{type:'skill',key:'fixture'},forms:{'se-content':{value:'unsaved restored content'},'se-desc':{value:'draft description'}},scroll:{detail:0}}});
  await restore.locator('#se-content').waitFor();assert.equal(await restore.locator('#se-content').inputValue(),'unsaved restored content');
  assert.equal(await restore.locator('#searchbox').inputValue(),'needle');
  await restore.locator('#se-content').fill('independent edit');assert.equal(await second.frameLocator('#embedded-action-workbench').locator('#name').inputValue(),'Draft changed without blur');
  await restore.evaluate(()=>{const detail=document.getElementById('detail');detail.style.maxHeight='200px';detail.scrollTop=80;capturePanelViewState();});
  const scrollState=await restore.evaluate(()=>window.__state);assert.equal(scrollState.view.scroll.detail,80);
  assert.equal(await second.evaluate(()=>window.__state.view?.scroll?.detail || 0),0,'scroll belongs to one instance');
  await restore.evaluate(()=>{projectSnapshot={recipes:[{recipeId:'recipe.fixture',revision:7}]};recipeDraftRecipeId='recipe.fixture';recipeDraft={name:'draft'};capturePanelViewState();projectSnapshot.recipes[0].revision=8;});
  assert.equal(await restore.evaluate(()=>panelRecipeRevision('recipe.fixture')),7,'a background refresh must not advance a draft baseline');

  const revisit=await pageFor({tab:'notes',workspace:'knowledge'});
  await revisit.waitForFunction(()=>knowledgeListMarkup.tab==='notes');
  const beforeReturn=await revisit.evaluate(()=>{
    window.__holdLists=true;
    document.getElementById('detail').innerHTML='<textarea id="return-draft">Keep this draft</textarea>';
    document.getElementById('return-draft').focus();
    window.__returnMutations=0;
    new MutationObserver(records=>window.__returnMutations+=records.length).observe(document.getElementById('item-list'),{childList:true,subtree:true});
    const ready=window.__requests.filter(r=>r.command==='ready').length;
    const listHtml=document.getElementById('item-list').innerHTML;
    window.dispatchEvent(new MessageEvent('message',{data:{command:'panelVisible'}}));
    return {ready,listHtml};
  });
  assert.equal(await revisit.locator('#return-draft').inputValue(),'Keep this draft','returning paints the live view before any Host response');
  assert.equal(await revisit.locator('#item-list').innerHTML(),beforeReturn.listHtml);
  assert.equal(await revisit.evaluate(()=>window.__requests.filter(r=>r.command==='ready').length),beforeReturn.ready,'returning must not reinitialize the panel');
  assert.equal(await revisit.evaluate(()=>window.__heldLists.length),1,'returning silently revalidates the active surface');
  await revisit.evaluate(()=>{for(const response of window.__heldLists)window.dispatchEvent(new MessageEvent('message',{data:response}));});
  await revisit.waitForTimeout(30);
  assert.equal(await revisit.evaluate(()=>window.__returnMutations),0,'unchanged background data must not rebuild the list DOM');
  assert.equal(await revisit.locator('#return-draft').inputValue(),'Keep this draft');
  assert.equal(await revisit.locator('#return-draft').evaluate(node=>document.activeElement===node),true);
  await revisit.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{command:'list',tab:'notes',data:[{slug:'new-note',title:'New note',content:'',tags:[]}],folders:[]}})));
  await revisit.locator('#item-list .tree-cat-hdr').click();
  assert.match(await revisit.locator('#item-list').innerText(),/New note/,'changed background data still updates the view');

  assert.deepEqual(await second.evaluate(()=>window.__cspViolations),[]);
  const child=second.frames().find(frame=>frame.parentFrame());assert(child);assert.deepEqual(await child.evaluate(()=>window.__cspViolations),[],'embedded renderer must satisfy CSP');
  assert.deepEqual(errors,[]);
  console.log('Chromium panel instances: embedded CSP/bridge/browser button, view switching, live draft duplicate, isolation/dispose and restoration passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
