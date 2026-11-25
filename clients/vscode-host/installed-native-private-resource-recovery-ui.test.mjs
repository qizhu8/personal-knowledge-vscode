import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import test from "node:test";
import { privateResourcePublicationDigest as digest } from "../../dist/private-resource-publication-contracts.js";
import { startInstalledNativePrivateResourceRecoveryUi } from "./installed-native-private-resource-recovery-ui.mjs";

// Chromium mechanics only; no grant/intent/receipt is injected into RootOwner or native producer.
assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK,"1");
const python=execFileSync(process.env.PKM_TEST_PYTHON??"python3",["-I","-B","-c","import sys;print(sys.executable)"],{encoding:"utf8"}).trim();
async function wait(path){const until=Date.now()+20000;while(Date.now()<until){try{return JSON.parse(await readFile(path));}
  catch(error){if(error.code!=="ENOENT"&&!(error instanceof SyntaxError))throw error;}await new Promise(r=>setTimeout(r,25));}throw new Error("Recovery DOM evidence timed out");}
const html=`<!doctype html><body><script>
window.actions=[];window.index=0;window.events=[];
window.render=()=>{document.body.replaceChildren();const a=actions[index];if(!a)return;
const d=document.createElement("div");d.className="monaco-dialog-box";
const title=document.createElement("div");title.textContent=a.title;d.append(title);
const pre=document.createElement("pre");pre.textContent=JSON.stringify(a.data,null,2);d.append(pre);
for(const name of ["Publish this exact resource once","Cancel","Deny"]){const b=document.createElement("button");b.textContent=name;
b.onclick=()=>{events.push(name);index++;render();};d.append(b);}document.body.append(d);
[...d.querySelectorAll("button")].find(b=>b.textContent==="Deny").focus();};</script>`;
const browserProgram=String.raw`
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"])
with sync_playwright() as p:
 context=p.chromium.launch_persistent_context(str(Path(f["artifacts"])/"profile"),headless=True,
  args=["--remote-debugging-port="+str(f["port"]),"--remote-debugging-address=127.0.0.1","--proxy-server=http://127.0.0.1:1","--proxy-bypass-list=127.0.0.1"])
 page=context.pages[0];page.goto((root/"workbench.html").as_uri());page.wait_for_load_state("networkidle")
 page.evaluate("v=>{window.actions=v;window.render();}",f["actions"]);(root/"browser-ready.json").write_text('{"ready":true}')
 until=time.monotonic()+30
 while time.monotonic()<until and not (root/"browser-stop.json").exists():
  (root/"events.json").write_text(json.dumps(page.evaluate("window.events")));time.sleep(.025)
 context.close()
`;
async function run(t,stale){
  const root=resolve(".pkm-test-evidence",`.installed-host-${randomUUID()}`),artifacts=resolve(".pkm-test-evidence",`.recovery-browser-${randomUUID()}`);
  await mkdir(root,{recursive:true,mode:0o700});await mkdir(artifacts,{mode:0o700});
  const server=createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));
  const runId=randomUUID(),sha=digest("DOM-only"),oldEpoch=randomUUID(),epoch=stale?oldEpoch:randomUUID(),operationId=randomUUID();
  const args={slug:"Old/Before",title:"After",category:"New"},owner={area:"notes",id:"knowledge_0123456789abcdef01234567",
    beforePath:"Old/Before.md",afterPath:"New/After.md",revision:1,sha256:sha};
  const resource={sourcePath:"Private/_assets/recovery-B.BIN",sourceIdentity:"DOM-mechanics-only",sha256:sha,size:2097152,
    targetPath:`New/After.assets/${sha.slice(0,16)}.bin`};
  const subject={root:`${root}/library`,workspaceId:randomUUID(),custodyPlanSha256:sha,catalogSha256:sha,profileSha256:sha,privacySha256:sha,
    operationId,canonicalArgumentsDigest:sha,actorId:"mcp:external",operation:"knowledge.note.update",owner,resource,
    publicRequest:{tool:"update_note",version:1,argumentsDigest:digest(args)},preservePrivateSource:true,oneResourceOneOperation:true};
  const request={schema:"pkm.private-resource-publication/v1",phase:"recover",subject,nativeEpoch:epoch,nativeHostReceiptSha256:digest("new-host")};
  const contract={schema:"pkm.installed-private-resource-recovery-ui/v1",runId,...Object.fromEntries(["root","workspaceId","custodyPlanSha256","catalogSha256","profileSha256","privacySha256"].map(k=>[k,subject[k]])),
    owner,resources:[resource],arguments:args,priorEpochs:[oldEpoch],oldEpoch,oldHostReceiptSha256:sha,operationId,canonicalArgumentsDigest:sha};
  await writeFile(join(root,"native-private-resource-recovery-deny-ui-contract.json"),JSON.stringify(contract));
  await writeFile(join(root,"workbench.html"),html);
  const actions=[{title:"Publish this exact private resource into public document assets?",data:{...request,defaultDecision:"deny",requestSha256:digest(request)}}];
  const env={...process.env,TMPDIR:artifacts,TMP:artifacts,TEMP:artifacts,PYTHONDONTWRITEBYTECODE:"1"};
  const browser=spawn(python,["-B","-c",browserProgram,JSON.stringify({root,artifacts,port,actions})],{env,stdio:"inherit"});
  const browserDone=new Promise((r,j)=>{browser.once("error",j);browser.once("exit",c=>c===0?r():j(new Error(`Browser exit ${c}`)));});void browserDone.catch(()=>{});
  let ui;t.after(async()=>{try{await ui?.stop();await writeFile(join(root,"browser-stop.json"),"{}");await browserDone;}
    finally{await rm(root,{recursive:true,force:true});await rm(artifacts,{recursive:true,force:true});}});
  await wait(join(root,"browser-ready.json"));ui=await startInstalledNativePrivateResourceRecoveryUi({root,mode:"deny",runId,python,env,port,timeoutMs:5000});
  return{root,ui};
}
test("fresh-epoch missing-resource review uses actual native-default Enter denial without renewing completed-copy authority",{timeout:45000},async t=>{
  const f=await run(t,false);await f.ui.done;const proof=await wait(join(f.root,"native-private-resource-recovery-deny-ui-passed.json"));
  assert.equal(proof.actualRenderedDom,true);assert.equal(proof.actualNativeUi,undefined);assert.equal(proof.dialogs.length,1);
  assert.deepEqual(await wait(join(f.root,"events.json")),["Deny"]);
});
test("old epoch is refused before any recovery resource action despite a valid descriptor digest and default Deny",{timeout:45000},async t=>{
  const f=await run(t,true);await assert.rejects(f.ui.done);
  assert.match((await wait(join(f.root,"native-private-resource-recovery-deny-ui-passed.json"))).error,/genuinely fresh epoch/);
  assert.deepEqual(await wait(join(f.root,"events.json")),[]);
});
