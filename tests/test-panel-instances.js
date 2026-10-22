const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { PanelRegistry } = require('../dist/ui/panel-registry');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const extract = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert(node, name); return node.getText(ast);
};
function target() {
  const received = [];
  return { received, webview:{ options:{}, html:'', postMessage:m=>received.push(m) },
    reveal(){ this.revealed = true; },
    onDidChangeViewState(callback){ this.focus = callback; },
    onDidDispose(callback){ this.close = callback; },
    dispose(){ this.close(); } };
}
(async () => {
  const panels = new PanelRegistry();
  const a = target(), b = target();
  const sa = panels.add(a, {tab:'notes', view:{filter:'todo', selection:{type:'note',key:'one'}, forms:{draft:'unsaved'},scroll:{detail:41}},actions:{graph:{nodes:[]}}});
  const sb = panels.add(b, {tab:'actions'});
  sa.ready=true;sa.pendingTab='notes';sa.lastHeartbeat=100;sa.listRequests.set('skills',1);
  assert.equal(sb.listRequests.get('skills'),undefined,'one tab must not cancel another tab’s list/filter request');
  assert.equal(sb.ready,false);assert.equal(sb.pendingTab,undefined);assert.notEqual(sb.lastHeartbeat,100);
  const snapshot = panels.duplicate(a); snapshot.view.filter='done';snapshot.actions.graph.nodes.push('draft');
  assert.equal(sa.snapshot.view.filter,'todo');assert.deepEqual(sa.snapshot.actions.graph.nodes,[]);
  const gates = [];
  const first = panels.requests.run(sa, async()=>{ await new Promise(r=>gates.push(r)); assert.equal(panels.current(),sa);panels.reply(sa,{request:'a'}); });
  const second = panels.requests.run(sb, async()=>{ await new Promise(r=>gates.push(r)); assert.equal(panels.current(),sb);panels.reply(sb,{request:'b'}); });
  gates[1]();gates[0]();await Promise.all([first,second]);
  assert.deepEqual(a.received,[{request:'a'}]);assert.deepEqual(b.received,[{request:'b'}]);
  panels.broadcast({command:'sharedDataChanged'});assert.equal(a.received.length,2);assert.equal(b.received.length,2);
  panels.remove(a);panels.reply(sa,{late:true});assert.equal(a.received.length,2);assert.equal(panels.current(),sb);
  assert.equal(panels.instances.size,1);assert.equal(sb.ready,false);

  // Execute the production lifecycle, including recovery/serializer initialization, with only VS Code mocked.
  const instances = new PanelRegistry();let handlerContext;let serviceDisposals=0;
  const context={extensionUri:'extension',subscriptions:[]};
  const optionsSandbox = { vscode: { Uri: { joinPath: (...parts) => parts.join("/"), file: value => value } }, path, getStorePath: () => "/fixture" };
  vm.runInNewContext(ts.transpileModule(`${extract("makeWebviewOptions")}\nglobalThis.options = makeWebviewOptions;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, optionsSandbox);
  assert.equal(optionsSandbox.options({ extensionUri: "/extension", globalStorageUri: { fsPath: "/storage" } }).retainContextWhenHidden, true,
    "switching away must not discard the existing panel DOM and force initialization on return");
  assert.match(fs.readFileSync(path.join(root, "src/chat/api-chat-shell.ts"), "utf8"),
    /registerWebviewViewProvider\("personalKnowledge\.apiChat", shell, \{ webviewOptions: \{ retainContextWhenHidden: true \} \}\)/);
  const sandbox={ panels:instances, Buffer, Date, performance, setTimeout,clearTimeout,
    vscode:{window:{createWebviewPanel(){return target();}},ViewColumn:{One:1},Uri:{joinPath:(...p)=>p.join('/')},workspace:{getConfiguration:()=>({get:()=> 'info'})}},
    makeWebviewOptions:()=>({enableScripts:true}),getWebviewHtml:()=>'<html><head></head></html>',
    performanceStateDir:undefined,activationStartedAt:0,loadProfiler:{record(){}},log:{info(){},warn(){},debug(){}},
    scheduleRestoredWebviewRecovery:options=>{sandbox.recovery=options;},
    handleMessage:async(msg,respond)=>{ const session=instances.current();await Promise.resolve();if(msg.command==='ready')session.ready=true;respond({id:msg.id}); },
    sharedService:{dispose(){serviceDisposals++;}},
  };
  vm.createContext(sandbox);
  const functions=['panelSession','activePanel','injectPanelSnapshot','getOrCreatePanel','createPanelInstance','initializePanel'].map(extract).join('\n');
  vm.runInContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,sandbox);
  // The mocked webview tracks the actual production receive callback.
  const original = sandbox.vscode.window.createWebviewPanel;
  sandbox.vscode.window.createWebviewPanel=()=>{const t=original();t.webview.onDidReceiveMessage=callback=>{t.receive=callback;};return t;};
  const one=sandbox.createPanelInstance(context,{tab:'notes',view:{filter:'todo'}});
  const two=sandbox.createPanelInstance(context,instances.duplicate(one));
  one.receive({command:'ready',id:'one'});two.receive({id:'two'});await new Promise(setImmediate);
  assert.equal(instances.instances.get(one).ready,true);assert.equal(instances.instances.get(two).ready,false);
  assert.equal(JSON.stringify(one.received),JSON.stringify([{id:'one'}]));assert.equal(JSON.stringify(two.received),JSON.stringify([{id:'two'}]));
  two.active=true;two.focus();assert.equal(instances.active,two);
  one.dispose();assert.equal(instances.instances.size,1);assert.equal(serviceDisposals,0);
  const restored=target();restored.webview.onDidReceiveMessage=callback=>{restored.receive=callback;};
  sandbox.initializePanel(restored,context,true,{tab:'actions',actions:{graph:{name:'restored'}}});
  assert.equal(instances.instances.get(restored).snapshot.tab,'actions');assert(sandbox.recovery.restored);
  const encoded=restored.webview.html.match(/content="([^"]+)"/)[1];assert.equal(JSON.parse(Buffer.from(encoded,'base64')).actions.graph.name,'restored');
  assert.equal(restored.received.length,0,'restore must not replay requests or operations');
  const serializerStart=source.indexOf('async deserializeWebviewPanel(webviewPanel, state)');
  const serializerEnd=source.indexOf('\n    },',serializerStart);
  const serializerSource=source.slice(serializerStart,serializerEnd).replace('async deserializeWebviewPanel','async function deserializeWebviewPanel')+'\n}';
  sandbox.context=context;sandbox.configuredPath='configured';
  vm.runInContext(ts.transpileModule(serializerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  function restorable(){const t=target();t.webview.onDidReceiveMessage=()=>{};return t;}
  const configured=restorable();await sandbox.deserializeWebviewPanel(configured,{tab:'papers'});
  assert.equal(instances.instances.get(configured).snapshot.tab,'papers');assert.equal(instances.instances.get(configured).pendingTab,undefined);
  sandbox.configuredPath='';const unconfigured=restorable();await sandbox.deserializeWebviewPanel(unconfigured,{tab:'actions'});
  assert.equal(instances.instances.get(unconfigured).pendingTab,'mcp');
  assert.equal(instances.instances.get(configured).snapshot.tab,'papers');

  // Invoke the real command callback: Run/Action routing must target this tab, even before ready.
  let commandCallback;
  function findCommand(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast).endsWith('registerCommand')
      && node.arguments[0]?.getText(ast) === '"personalKnowledge.openEmbeddedActions"') commandCallback=node.arguments[1].getText(ast);
    ts.forEachChild(node,findCommand);
  }
  findCommand(ast);assert(commandCallback);
  vm.runInContext(ts.transpileModule('const embeddedCommand = '+commandCallback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';this.embeddedCommand=embeddedCommand;',sandbox);
  instances.focus(two);const routed=instances.instances.get(two);routed.ready=false;
  routed.snapshot.actions={lastRun:'older-run',targetAction:'old.action',graph:{name:'draft'}};
  sandbox.embeddedCommand({runId:'action_run_'+'a'.repeat(32)});
  assert.equal(routed.pendingActions.currentRun,'action_run_'+'a'.repeat(32));
  assert.equal(routed.pendingActions.lastRun,routed.pendingActions.currentRun);assert.equal(routed.pendingActions.targetAction,undefined);
  routed.ready=true;const beforeReplies=two.received.length;
  sandbox.embeddedCommand({actionId:'test.action'});
  assert.equal(two.received.length,beforeReplies+1);assert.equal(two.received.at(-1).command,'openEmbeddedActions');
  assert.equal(two.received.at(-1).state.targetAction,'test.action');assert.equal(two.received.at(-1).state.currentRun,null);
  assert.equal(two.received.at(-1).state.graph.name,'draft');

  // Optimistic revisions reject a stale draft without writing or replaying anything.
  let document={name:'fixture',content:'original'};
  sandbox.skillGet=()=>document;sandbox.noteGet=()=>undefined;sandbox.paperGet=()=>undefined;sandbox.scriptGet=()=>undefined;
  sandbox.createHash=require('node:crypto').createHash;
  vm.runInContext(ts.transpileModule(['panelEditIdentity','panelEditValue','panelEditRevision','checkPanelEdit'].map(extract).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  const editing=instances.instances.get(two);instances.focus(two);
  editing.snapshot.editRevisions={'skill:fixture':sandbox.panelEditRevision(document)};
  assert.doesNotThrow(()=>sandbox.checkPanelEdit({command:'saveSkill',name:'fixture'}));
  document={...document,content:'another tab saved'};
  assert.throws(()=>sandbox.checkPanelEdit({command:'saveSkill',name:'fixture'}),/draft was kept/);
  assert.equal(document.content,'another tab saved');

  const manifest=require('../package.json');assert(manifest.contributes.commands.some(c=>c.command==='personalKnowledge.duplicatePanel'));
  assert.equal(manifest.contributes.menus['editor/title/context'].find(c=>c.command==='personalKnowledge.duplicatePanel').when,'activeWebviewPanelId == personalKnowledge');
  console.log('panel instances: isolation, async targeted replies, snapshots, focus/dispose, lifecycle and serializer passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
