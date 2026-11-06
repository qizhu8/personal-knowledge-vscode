// Source-only regressions: no dist, network, real pip, installation or build.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),{test}=require('node:test'),{execFile}=require('node:child_process');
function load(file,names,globals={}){
 const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const nodes=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));assert.equal(nodes.length,names.length);
 const js=ts.transpileModule(nodes.map(n=>n.getText(ast)).join('\n').replace(/export /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText;
 const c=vm.createContext({Date,Error,Promise,Buffer,String,process,setTimeout,clearTimeout,...globals});vm.runInContext(js,c);return c;
}
const pipNames=['mcpProgressOutput','mcpProgressReporter','mcpPipInstall'];
test('same bounded child emits live throttled bounded sanitized output',async()=>{
 let finished=false,events=[],first;const seen=new Promise(r=>first=r);
 const c=load('src/mcp/mcp.ts',pipNames,{execFile:(p,a,o,cb)=>{
 assert.equal(o.timeout,600000);assert.equal(o.maxBuffer,1<<24);assert.deepEqual(Array.from(a),['-m','pip','install','-r','fake']);
 return execFile(process.execPath,['-e',"console.log('collecting');let n=0;let t=setInterval(()=>{console.log('x'.repeat(5000)+' https://user:password@example.org/?token=abc');if(++n===12){clearInterval(t);setTimeout(()=>console.error('done'),400)}},10)"],o,cb);
 }});
 const running=c.mcpPipInstall('fake',['-r','fake'],s=>{events.push(s);first()}).then(()=>finished=true);
 await seen;assert.equal(finished,false);await running;assert(events.length>=2&&events.length<=6);
 events.forEach(s=>{assert(s.length<=2048);assert.doesNotMatch(s,/user:password|token=abc/)});assert.match(events.at(-1),/done/);
});
test('subprocess errors retain original stdout/stderr despite observer exceptions',async()=>{
 const c=load('src/mcp/mcp.ts',pipNames,{execFile:(p,a,o,cb)=>execFile(process.execPath,['-e',"console.log('original stdout');console.error('original stderr');process.exitCode=7"],o,cb)});
 await assert.rejects(c.mcpPipInstall('fake',[],()=>{throw Error('observer')}),e=>/original stdout/.test(e.message)&&/original stderr/.test(e.message));
 assert.doesNotThrow(()=>c.mcpProgressReporter(()=>{throw Error('observer')})('checking','text'));
});
function runtime(failure,healthy=true){
 const phases=[],calls=[];
 const c=load('src/mcp/mcp.ts',['mcpProgressReporter','mcpProgressOutput','ensureMcpRuntime','ensureMcpRuntimeFiles'],{
 fs:{existsSync:()=>true,mkdirSync(){},writeFileSync(){},readFileSync:f=>f==='marker'?JSON.stringify({path:'base',version:'3.11'}):Buffer.from('wheel')},path,
 ensureMcpRuntimeLocked:(ctx,report)=>c.ensureMcpRuntimeFiles(ctx,report),invalidateMcpPythonProbes(){},warmMcpPythonProbes:async()=>{},detectMcpPython:()=>({valid:true,path:'base',version:'3.11'}),mcpRuntimePath:()=>'/fake/runtime',mcpRuntimePythonPath:()=>'/fake/python',mcpRuntimeBaseMarker:()=> 'marker',validateMcpPython:()=>({path:'fake',error:''}),pyenvList:()=>[],pyenvAdd(){},pyenvUpdate(){},generateMcpServer:async()=>{},managedMcpServerDirectory:()=>'/fake',mcpPipInstall:async(p,args,out)=>{calls.push(args);out('live');if(failure)throw Error(failure)},createHash:()=>({update(){return this},digest:()=> 'digest'}),PROMPT_MANAGER_WHEEL:'prompt',PROMPT_MANAGER_WHEEL_SHA256:'digest',RETRIEVAL_ENGINE_WHEEL:'retrieval',RETRIEVAL_ENGINE_WHEEL_SHA256:'digest',mcpRuntimeStatusAsync:async()=>({healthy,error:'broken final imports'})
 });return {phases,calls,run:()=>c.ensureMcpRuntime({extensionPath:'/fake'},p=>phases.push(p))};
}
test('ordinary pip error is not fallback success; unhealthy final probe is an error',async()=>{
 const h=runtime('ordinary pip failure: detail');await assert.rejects(h.run(),/detail/);assert.equal(h.calls.length,1);assert.equal(h.phases.at(-1).phase,'error');
 const bad=runtime(undefined,false);await assert.rejects(bad.run(),/broken final imports/);assert(!bad.phases.some(p=>p.phase==='ready'));
 const fallback=runtime('uone_prompt_manager No matching distribution');await assert.rejects(fallback.run(),/No matching/);assert.equal(fallback.calls.length,2);assert(!fallback.phases.some(p=>p.phase==='ready'));
});
function host(valid=true){
 const invitations=[],messages=[];let opened=0,scheduled=0;
 const c=load('src/extension.ts',['publishIntegrationProgress','setupProgress','requireMcpPythonSetup','integrationFailureState','maintainPkmIntegration'],{
 integrationMaintenance:undefined,integrationMaintenanceState:'idle',integrationMaintenanceError:'',integrationMaintenanceErrorShown:false,integrationSetupProgress:undefined,integrationSetupPostedAt:0,missingPythonSetupInvited:false,newerPkmVersionNotice:'',path,
 backgroundTaskRegistry:{producer:()=>({queued(){},running(){},idle(){}})},withCrossProcessLock:async(p,l,t,fn)=>fn(),managedMcpServerDirectory:()=>'/fake',warmMcpPythonProbes:async()=>{},mcpStatus:()=>({current:true}),detectMcpPython:()=>({valid,error:'Python missing'}),mcpRuntimeStatus:()=>({healthy:true}),mcpRuntimeStatusAsync:async()=>({healthy:true}),refreshMcpDefinitions(){},scheduleRetrievalRefresh(){scheduled++},activePanel:()=>({}),panelSession:()=>({ready:true}),postToPanel:m=>messages.push(m),mcpPanelStatusData:()=>({automaticSetup:{state:c.integrationMaintenanceState,error:c.integrationMaintenanceError,progress:c.integrationSetupProgress},store:{valid:true}}),log:{warn(){}},openMcpSetup:()=>opened++,vscode:{window:{showInformationMessage:(...args)=>{invitations.push(args);return Promise.resolve('Later')},showWarningMessage:()=>Promise.resolve('Later')}}
 });return {c,invitations,messages,opened:()=>opened,scheduled:()=>scheduled};
}
test('missing Python stops maintenance actionably; one Later invitation, retained snapshot and usable basic store',async()=>{
 const h=host(false);await h.c.maintainPkmIntegration({});await h.c.maintainPkmIntegration({});
 const snapshot=h.messages.filter(m=>m.command==='mcpStatus').at(-1).data;
 assert.equal(snapshot.automaticSetup.state,'action-required');assert.match(snapshot.automaticSetup.error,/Python missing/);assert.match(snapshot.automaticSetup.progress.text,/Basic file Knowledge/);assert.equal(snapshot.store.valid,true);
 assert.equal(h.invitations.length,1);assert.equal(h.opened(),0);assert.equal(h.scheduled(),0);assert.equal(h.c.integrationMaintenance,undefined);
});
test('ready means runtime/server checked and retrieval scheduled, not index/client acceptance',async()=>{
 const h=host();await h.c.maintainPkmIntegration({});assert.equal(h.c.integrationMaintenanceState,'ready');assert.equal(h.scheduled(),1);assert.match(h.c.integrationSetupProgress.text,/not yet verified.*separately/);
});
