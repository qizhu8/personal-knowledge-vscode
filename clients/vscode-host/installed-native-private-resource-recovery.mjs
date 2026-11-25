import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u,
  assertInstalledKnowledgeMoveComponentBinding, readInstalledKnowledgeMoveRetirementReceipt, readInstalledKnowledgeMoveRestoredReceipt,
} from "./installed-native-knowledge-move.mjs";
import { pinnedOriginalKnowledgeWriterFixture, moveOriginalKnowledge } from "../../tests/original-knowledge-writer-fixture.mjs";
import { assertInstalledNativePrivateResourceRecoveryMount, resizeInstalledNativePrivateResourceRecoveryMount } from "./installed-native-private-resource-recovery-mount.mjs";
import { startInstalledNativePrivateResourceRecoveryUi } from "./installed-native-private-resource-recovery-ui.mjs";

export { mountInstalledNativePrivateResourceRecoveryParent, releaseInstalledNativePrivateResourceRecoveryMount } from "./installed-native-private-resource-recovery-mount.mjs";
// Parent-only profile order: mount -> brand/seed -> cold B0/custody -> fault -> owner/reader/editor exit.
// Reopen the same plan, handle ordinary native admission, deny B, close epoch/editor; reopen again and approve B.
// Preserve B1 through the original closed cold component's fixture, retire/restore fresh B0, then unmount.
// Keep USER/MOUNT/NET/PID namespace alive throughout; never repeat cold bootstrap or recapture custody.
const states = new WeakMap(), epochs = new WeakMap(), fileBytes = 2097152;
const names = ["recovery-A.PNG","recovery-B.BIN"], payloads = names.map((_,index)=>Buffer.alloc(fileBytes, 0x61+index));
const identity = s => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(":");
const rootIdentity = s => [s.dev,s.ino,s.mode,s.uid,s.gid].join(":");
const target = index => `${u.hash(payloads[index]).slice(0,16)}${index===0?".png":".bin"}`;
const sorted = values => [...values].sort((a,b)=>a.path.localeCompare(b.path));
function fail(code) { throw Object.assign(new Error(code),{code}); }
function stateFor(value) { const state=states.get(value);if(!state)fail("PRIVATE_RECOVERY_ACTUAL_PREPARATION_REQUIRED");return state; }
function noPrivate(value) {
  u.noPrivatePublication(value);
  const text=JSON.stringify(value);
  assert(!text.includes("PRIVATE_RECOVERY_REFERRER")&&!text.includes("a".repeat(128))&&!text.includes("b".repeat(128)));
}
export const seedOriginalPrivateResourceRecovery = `
 const content="Original recovery owner\\n![A](../Private/_assets/recovery-A.PNG?q=1#view)\\n[B](../Private/_assets/recovery-B.BIN)\\n";
 store.noteUpsert({slug:"Old/Before",title:"Before",category:"Old",type:"general",content});
 for(const [index,name] of ["recovery-A.PNG","recovery-B.BIN"].entries()){
  const bytes=Buffer.alloc(2097152,0x61+index);
  assets.importMarkdownAssetBundle(root,[{type:"notes",path:"Private/_assets/"+name,data:bytes.toString("base64"),
   digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
   [{area:"notes",path:"Old/Before.md",content}]);
 }
 store.noteUpsert({slug:"Private/Secret",title:"Secret",category:"Private",type:"general",
  content:"PRIVATE_RECOVERY_REFERRER\\n![A](_assets/recovery-A.PNG)\\n"});
 return store.noteGet("Old/Before");
`;
/** Parent mounts its capacity parent BEFORE createOriginalMcpColdComponentFixture; never mount over a branded root. */
export async function prepareInstalledNativePrivateResourceRecoveryFixture({ installed, componentFixture, mount, legacyVsix, python }) {
  await assertInstalledNativePrivateResourceRecoveryMount(mount);
  const member=relative(mount.directory,componentFixture.directory);
  if(!member||member===".."||member.startsWith(`..${sep}`)||isAbsolute(member))fail("PRIVATE_RECOVERY_MOUNTED_FIXTURE_REQUIRED");
  await(await u.load(installed,"original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if(states.has(componentFixture))fail("PRIVATE_RECOVERY_ALREADY_PREPARED");
  for(const path of [join(componentFixture.directory,"b0"),join(componentFixture.directory,"custody"),join(componentFixture.root,"core.sqlite")])
    await u.absent(path,"PRIVATE_RECOVERY_PRESEAL_REQUIRED");
  if(!isAbsolute(python??""))fail("PRIVATE_RECOVERY_EXPLICIT_PYTHON_REQUIRED");
  const policyPath=join(componentFixture.root,".pkm/content-privacy.json"),policyStat=await lstat(policyPath);
  if(!policyStat.isFile()||policyStat.isSymbolicLink()||policyStat.nlink!==1||policyStat.uid!==process.getuid()||policyStat.mode&0o077)
    fail("PRIVATE_RECOVERY_INDEPENDENT_PRIVACY_REQUIRED");
  const privacyBytes=await readFile(policyPath);
  assert.deepEqual(JSON.parse(privacyBytes),installedNativeKnowledgeMovePrivacyPolicy,"Independently configure all three Private areas.");
  for(const area of Object.values(u.areas))await mkdir(join(componentFixture.root,area),{recursive:true,mode:0o700});
  for(const path of ["Old","New","Private"])await u.absent(join(componentFixture.root,"notes",path),"PRIVATE_RECOVERY_DISJOINT_SEED_REQUIRED");
  const writer=pinnedOriginalKnowledgeWriterFixture({directory:componentFixture.directory,legacyVsix,python});
  const row=writer.run(componentFixture.root,seedOriginalPrivateResourceRecovery);
  const baseline=await u.files(componentFixture.root),oracle=join(componentFixture.directory,"original-private-recovery-oracle");
  await cp(componentFixture.root,oracle,{recursive:true,force:false,errorOnExist:true});
  const expected=writer.run(oracle,moveOriginalKnowledge,{kind:"note",content:row.content});
  for(let index=0;index<2;index++)assert.deepEqual(await readFile(join(oracle,"notes/New/After.assets",target(index))),payloads[index]);
  await u.absent(join(oracle,"notes/Private/_assets/recovery-B.BIN"),"PRIVATE_RECOVERY_ORIGINAL_POLICY_DIFFERENCE_REQUIRED");
  assert.deepEqual(await readFile(policyPath),privacyBytes);
  const value=Object.freeze({kind:"pkm.installed-private-resource-recovery-fixture/v1",root:componentFixture.root,
    originalPackageSha256:writer.originalPackageSha256,privacySha256:u.hash(privacyBytes),environmentFaultInjection:true,
    files:Object.freeze(u.hashes(baseline).map(Object.freeze))});
  const privateFolders=await Promise.all(["notes/Private","notes/Private/_assets"].map(async path=>({path,identity:identity(await lstat(join(componentFixture.root,path)))})));
  const state={installed,componentFixture,mount,row,expected,baseline,privacyBytes,privateFolders,rootPin:rootIdentity(await lstat(componentFixture.root)),phase:"prepared",priorEpochs:[]};
  states.set(value,state);states.set(componentFixture,state);return value;
}
async function unchanged(state,root){
  assert.deepEqual(sorted((await u.files(root,true)).filter(file=>file.path.includes("/Private/"))),state.privateBefore);
  for(const folder of state.privateFolders)assert.equal(identity(await lstat(join(root,folder.path))),folder.identity);
  for(const file of state.before.filter(file=>file.path!=="notes/Old/Before.md"))assert.deepEqual(await readFile(join(root,file.path)),file.bytes);
  await u.unchangedOriginalControls(state,root);
}
function pending(root){
  const db=new DatabaseSync(join(root,"core.sqlite"),{readOnly:true});
  try{
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0],"ok");
    const rows=db.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all();
    return {rows:rows.map(row=>({...row})),receipts:db.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.update' ORDER BY operation_id").all().map(row=>({...row}))};
  }finally{db.close();}
}
function bindIntent(state,row){
  const binding=[row.operation_id,row.workspace_id,row.root_path,row.actor_id,row.operation,row.fingerprint,row.request_json,row.plan_json];
  assert.equal(row.digest,u.hash(JSON.stringify(binding)));assert.equal(row.root_path,state.componentFixture.root);
  assert.equal(row.workspace_id,state.workspaceId);assert.equal(row.actor_id,"mcp:external");assert.equal(row.operation,"knowledge.note.update");
  const request=JSON.parse(row.request_json),plan=JSON.parse(row.plan_json),relocation=JSON.parse(plan.relocation);
  assert.equal(request.args.operationId,row.operation_id);assert.equal(request.actorId,row.actor_id);assert.equal(request.operation,row.operation);
  assert.equal(row.fingerprint,u.hash(JSON.stringify(request)));
  assert.equal(plan.operationId,row.operation_id);assert.equal(plan.actorId,row.actor_id);
  assert.equal(relocation.legacyAssets.protocol,"pkm.document-private-resource-publication/v1");assert.equal(relocation.legacyAssets.copies.length,2);
  return {request,plan,relocation};
}
function uiContract(state,mode,resources){
  return {schema:"pkm.installed-private-resource-recovery-ui/v1",root:state.componentFixture.root,workspaceId:state.workspaceId,
    custodyPlanSha256:state.custody.planSha256,catalogSha256:state.catalogSha256,profileSha256:state.custody.profileSha256,
    privacySha256:state.custody.privacySha256,owner:state.owner,resources,arguments:state.args,
    oldEpoch:state.oldEpoch,oldHostReceiptSha256:state.oldHostReceiptSha256,
    priorEpochs:state.priorEpochs,operationId:state.intent?.operation_id,
    canonicalArgumentsDigest:state.bound?.relocation.legacyAssets.copies[0].publication.subject.canonicalArgumentsDigest};
}
async function observer(state,options,mode,resources){
  const runId=randomUUID();
  await writeFile(join(options.root,`native-private-resource-recovery-${mode}-ui-contract.json`),JSON.stringify({...uiContract(state,mode,resources),runId}),
    {mode:0o600,flag:"wx"});
  return {runId,ui:await startInstalledNativePrivateResourceRecoveryUi({...options,mode,runId})};
}
async function uiProof(options,mode,runId,ui){
  await ui.done;
  const proof=JSON.parse(await readFile(join(options.root,`native-private-resource-recovery-${mode}-ui-passed.json`)));
  assert.equal(proof.passed,true);assert.equal(proof.actualRenderedDom,true);assert.equal(proof.runId,runId);return proof;
}
/** Real quota failure. Full rollback/no exact pending-first-copy phase is a blocker, never a fabricated fixture. */
export async function verifyInstalledNativePrivateResourceRecoveryEnospc(options){
  const {installed,component,sourceFixture}=options,state=stateFor(sourceFixture);
  if(state.phase!=="prepared")fail("PRIVATE_RECOVERY_FAULT_ORDER_REQUIRED");
  if(state.installed!==installed||component.fixture!==state.componentFixture)fail("PRIVATE_RECOVERY_SAME_COMPONENT_REQUIRED");
  await assertInstalledNativePrivateResourceRecoveryMount(state.mount);
  const {host}=await assertInstalledKnowledgeMoveComponentBinding({...options,componentFixture:state.componentFixture});
  assert.equal(host.nativeChat,undefined);
  for(const provider of ["vscode","openai-compatible","azure-openai"])assert.equal(host.options.providerTransport.supports(provider),false);
  state.oldComponent=component;state.custody=structuredClone(component.custody);state.b0Sha256=component.b0.sha256;
  state.payloadBuildId=options.payloadBuildId;state.hostEntrySha256=u.hash(await readFile(join(installed,"dist/extension.cjs")));
  state.workspaceId=component.workspaceId;state.oldEpoch=host.receipt.epoch;state.priorEpochs.push(state.oldEpoch);
  state.oldHostReceiptSha256=host.receipt.receiptSha256;state.catalogSha256=host.receipt.sourceCatalogSha256;
  state.before=await u.files(component.root,true);state.privateBefore=sorted(state.before.filter(file=>file.path.includes("/Private/")));
  assert.deepEqual(state.privateBefore,sorted(state.baseline.filter(file=>file.path.includes("/Private/"))));
  const markdown=await u.load(installed,"markdown"),contracts=await u.load(installed,"private-resource-publication-contracts");
  const doc=markdown.scanMarkdown(component.root).find(row=>row.record.area==="notes"&&row.record.path==="Old/Before.md");assert(doc);
  state.owner={area:"notes",id:doc.record.id,beforePath:"Old/Before.md",afterPath:"New/After.md",revision:doc.record.revision,sha256:doc.record.sha256};
  state.resources=await Promise.all(names.map(async(name,index)=>({sourcePath:`Private/_assets/${name}`,sha256:u.hash(payloads[index]),
    size:fileBytes,sourceIdentity:identity(await lstat(join(component.root,"notes/Private/_assets",name))),targetPath:`New/After.assets/${target(index)}`})));
  state.args={slug:"Old/Before",title:"After",category:"New"};
  const old=pending(component.root);assert.equal(old.rows.length,0);
  const info=statfsSync(state.mount.directory),used=(info.blocks-info.bfree)*info.bsize;
  // One 2 MiB copy plus 1 MiB/256 KiB reserve: second 2 MiB copy cannot fit, but its failed stage can be cleaned.
  state.faultCapacity=used+fileBytes+1048576+262144;
  await resizeInstalledNativePrivateResourceRecoveryMount(state.mount,state.faultCapacity);
  // Independent OS calibration outside managed root: four MiB cannot fit in the exact physical reserve.
  const pressureProbe=join(state.mount.directory,"environment-enospc-calibration.bin");
  let calibratedError;
  try{await writeFile(pressureProbe,Buffer.alloc(fileBytes*2),{mode:0o600,flag:"wx"});}
  catch(error){calibratedError=error;}
  finally{await rm(pressureProbe,{force:true});}
  assert.equal(calibratedError?.code,"ENOSPC","Only a genuine physical quota fault qualifies this environment.");
  const {runId,ui}=await observer(state,options,"fault",state.resources);
  const abort=new AbortController();void ui.done.catch(error=>abort.abort(error));
  try{
    await ui.ready;let failure;
    try{const response=await component.invoke("update_note",state.args,abort.signal);noPrivate(response);if(response.isError)failure=new Error(JSON.stringify(response));}
    catch(error){failure=error;}
    if(!failure)fail("PRIVATE_RECOVERY_ENOSPC_NOT_OBSERVED");
    noPrivate({message:failure.message});
    const nativeCode=failure.code??/\b(RECOVERY_CONFLICT):/.exec(failure.message)?.[1];
    assert.equal(nativeCode,"RECOVERY_CONFLICT","Authority/expiry/timeout failure is not physical-copy recovery evidence.");
    host.assertCurrent();component.storage.assertWorkspaceLease();
    const proof=await uiProof(options,"fault",runId,ui);assert.equal(proof.dialogs.length,2);
    const found=pending(component.root),added=found.rows.filter(row=>!old.rows.some(prior=>prior.operation_id===row.operation_id));
    if(added.length!==1)fail("PRIVATE_RECOVERY_NO_ACTUAL_PENDING_INTENT");
    assert.deepEqual(found.receipts,old.receipts);
    state.intent=added[0];state.bound=bindIntent(state,state.intent);
    for(const copy of state.bound.relocation.legacyAssets.copies){
      assert.equal(copy.visibility,"private");assert.equal(copy.disposition,"retain");
      contracts.validatePrivateResourcePublicationProvenance(copy.publication);
      assert(copy.publication.decision.expiresAtMs>Date.now(),"Expired decisions are not ENOSPC evidence.");
      const observed=proof.dialogs.find(row=>row.request.subject.resource.sourcePath===copy.source);assert(observed);
      assert.deepEqual(observed.request.subject,copy.publication.subject);
      assert.equal(observed.requestSha256,copy.publication.decision.requestSha256);
    }
    const mutations=await u.load(installed,"knowledge-mutations");
    await component.storage.withWorkspaceExclusive(()=>mutations.assertKnowledgeMutationRequestPlan(component.root,
      mutations.deserializeKnowledgeMutationPlan(state.intent.plan_json),state.bound.request));
    const first=join(component.root,state.bound.relocation.documentCas.area,state.resources[0].targetPath);
    assert.deepEqual(await readFile(first),payloads[0]);state.completed={path:state.resources[0].targetPath,identity:identity(await lstat(first)),sha256:u.hash(payloads[0])};
    await u.absent(join(component.root,"notes",state.resources[1].targetPath),"PRIVATE_RECOVERY_EXPECTED_MISSING_SECOND_COPY");
    await u.absent(join(component.root,"notes/New/After.md"),"PRIVATE_RECOVERY_OWNER_ALREADY_PUBLISHED");
    assert.deepEqual(await readFile(join(component.root,"notes/Old/Before.md")),state.before.find(file=>file.path==="notes/Old/Before.md").bytes);
    await unchanged(state,component.root);state.pendingKnowledge=u.hashes(await u.files(component.root,true));state.phase="pending";
    const result={passed:true,scope:"actual pending ENOSPC phase only; not recovered",environmentFaultInjection:true,
      actualPendingIntent: true,exactFirstPrivateCopyAndMissingSecond:true,nativeDatabaseIntegrityPreserved:true,
      realPhysicalEnospcCalibrated:true,nativeFailureCode:nativeCode,nativeErrnoDirectlyExposed:false,
      faultCapacityBytes:state.faultCapacity,actualPendingIntentCount:added.length,originalNativeEpoch:state.oldEpoch,
      completedPrivateCopyBytes:fileBytes,completedPrivateCopySha256:state.completed.sha256,
      noSuccessReceipt:true,operationId:state.intent.operation_id,installedRecoveryQualified:false,fullCutoverQualified:false};
    await writeFile(join(options.root,"native-private-resource-recovery-enospc-passed.json"),JSON.stringify(result),{mode:0o600,flag:"wx"});return result;
  }finally{abort.abort();await ui.stop();if(state.phase!=="pending")state.phase="fault-failed";}
}
/** Call after the previous complete editor exits, before launching the next one. Existing same-plan native bootstrap only. */
export async function reopenInstalledNativePrivateResourceRecovery({installed,sourceFixture,attachment}){
  const state=stateFor(sourceFixture);
  if(!["pending","denied"].includes(state.phase)||state.activeEpoch)fail("PRIVATE_RECOVERY_REOPEN_ORDER_REQUIRED");
  if(installed!==state.installed||attachment?.payloadBuildId!==state.payloadBuildId||attachment?.hostEntrySha256!==state.hostEntrySha256)
    fail("PRIVATE_RECOVERY_SAME_INSTALLED_CANDIDATE_REQUIRED");
  await state.oldComponent.close(); // Existing component owns and closes its legacy reader before RootOwner.
  await assertInstalledNativePrivateResourceRecoveryMount(state.mount);
  await resizeInstalledNativePrivateResourceRecoveryMount(state.mount,67108864);
  assert.equal(rootIdentity(await lstat(state.componentFixture.root)),state.rootPin);
  assert.deepEqual(u.hashes(await u.files(state.componentFixture.root,true)),state.pendingKnowledge);
  const roots=await u.load(installed,"original-mcp-root"),native=await u.load(installed,"original-mcp-native-bootstrap");
  const fence=await roots.acquireOriginalMcpRootFence(state.componentFixture.root);
  let bootstrap;
  try{bootstrap=await native.bootstrapOriginalMcpNativeRuntime({plan:state.custody,writerFence:fence,attachment});}
  catch(error){await fence.release();throw error;}
  const value=Object.freeze({kind:"pkm.installed-private-recovery-epoch/v1",bootstrap});
  epochs.set(value,{state,bootstrap,closed:false});state.activeEpoch=value;return value;
}
/** Parent independently handles the normal native admission modal; this observer owns only pending resource review. */
export async function verifyInstalledNativePrivateResourceRecoveryEpoch(options){
  const {installed,sourceFixture,epoch,decision}=options,state=stateFor(sourceFixture),entry=epochs.get(epoch);
  if(installed!==state.installed||!entry||entry.state!==state||entry.closed||state.activeEpoch!==epoch||!["deny","approve"].includes(decision))fail("PRIVATE_RECOVERY_ACTUAL_EPOCH_REQUIRED");
  if(decision==="deny"&&state.phase!=="pending"||decision==="approve"&&state.phase!=="denied")fail("PRIVATE_RECOVERY_DENY_BEFORE_APPROVE_REQUIRED");
  const native=await u.load(installed,"original-mcp-native-bootstrap");native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap);
  assert.equal(entry.bootstrap.root,state.componentFixture.root);assert.equal(entry.bootstrap.workspaceId,state.workspaceId);
  assert.equal(entry.bootstrap.planSha256,state.custody.planSha256);
  const before=pending(entry.bootstrap.root),uiResources=[state.resources[1]],{runId,ui}=await observer(state,options,decision,uiResources);
  try{
    await ui.ready;let host,failure;
    try{host=await entry.bootstrap.complete({enableModels:false});}catch(error){failure=error;}
    if(decision==="deny"){
      if(!failure)fail("PRIVATE_RECOVERY_DENIAL_SUCCEEDED");
      const code=failure.code??/\b(PRIVATE_RESOURCE_PUBLICATION_DENIED):/.exec(failure.message)?.[1];
      if(code!=="PRIVATE_RESOURCE_PUBLICATION_DENIED")throw failure;
    }else if(failure)throw failure;
    const proof=await uiProof(options,decision,runId,ui);assert.equal(proof.dialogs.length,1);
    const dialog=proof.dialogs[0],newEpoch=dialog.request.nativeEpoch;
    assert(!state.priorEpochs.includes(newEpoch));assert.equal(dialog.request.subject.operationId,state.intent.operation_id);
    const first=join(entry.bootstrap.root,"notes",state.completed.path);
    assert.equal(identity(await lstat(first)),state.completed.identity);assert.deepEqual(await readFile(first),payloads[0]);
    if(decision==="deny"){
      const code=failure.code??/\b(PRIVATE_RESOURCE_PUBLICATION_DENIED):/.exec(failure.message)?.[1];assert.equal(code,"PRIVATE_RESOURCE_PUBLICATION_DENIED");
      noPrivate({message:failure.message});
      assert.deepEqual(pending(entry.bootstrap.root),before);
      assert.deepEqual(u.hashes(await u.files(entry.bootstrap.root,true)),state.pendingKnowledge);
      await unchanged(state,entry.bootstrap.root);state.phase="denied";
    }else{
      native.assertOriginalMcpNativeRuntimeBootstrap(entry.bootstrap,true);
      assert.equal(host.receipt.epoch,newEpoch);assert.equal(host.nativeChat,undefined);
      for(const provider of ["vscode","openai-compatible","azure-openai"])assert.equal(host.options.providerTransport.supports(provider),false);
      const current=pending(entry.bootstrap.root);assert.equal(current.rows.length,0);
      const receipts=current.receipts.filter(row=>row.operation_id===state.intent.operation_id);assert.equal(receipts.length,1);state.receipt=receipts[0];
      assert.equal(state.receipt.actor_id,state.intent.actor_id);assert.equal(state.receipt.operation,state.intent.operation);
      assert.equal(state.receipt.fingerprint,state.intent.fingerprint);
      const db=entry.bootstrap.storage.connectNative();
      try{
        const raw=db.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(state.intent.operation_id);assert(raw);state.commit={...raw};
      }finally{db.close();}
      assert.equal(state.commit.request_json,state.intent.request_json);
      assert.equal(state.commit.workspace_id,state.workspaceId);assert.equal(state.commit.operation_id,state.intent.operation_id);
      assert.equal(state.commit.digest,u.hash(JSON.stringify([state.commit.sequence,state.commit.workspace_id,state.commit.operation_id,
        state.commit.request_json,state.commit.plan_json,state.commit.result_json])));
      assert.equal(state.commit.result_json,state.receipt.result);
      const plan=JSON.parse(state.commit.plan_json),relocation=JSON.parse(plan.relocation),copies=relocation.legacyAssets.copies;
      assert.deepEqual(copies[0],state.bound.relocation.legacyAssets.copies[0],"Completed first copy is readonly history, not renewed authority.");
      assert.deepEqual(copies[1].publication.subject,dialog.request.subject);assert.equal(copies[1].publication.phase,"recover");
      assert.equal(copies[1].publication.decision.requestSha256,dialog.requestSha256);
      assert.equal(copies[1].publication.decision.epoch,newEpoch);assert.equal(copies[1].publication.nativeHostReceiptSha256,host.receipt.receiptSha256);
      const markdown=await u.load(installed,"markdown"),document=markdown.scanMarkdown(entry.bootstrap.root).find(row=>row.record.area==="notes"&&row.record.path==="New/After.md");assert(document);
      assert.equal(document.record.id,state.expected.knowledgeId);assert.equal(document.record.revision,state.expected.revision);assert.equal(document.record.content,state.expected.content);
      const result=JSON.parse(state.receipt.result);noPrivate(result);
      assert.equal(result.operationId,state.intent.operation_id);assert.equal(result.id,document.record.id);
      assert.equal(result.revision,document.record.revision);assert.equal(result.sha256,document.record.sha256);assert.equal(result.path,"New/After.md");
      for(let index=0;index<2;index++)assert.deepEqual(await readFile(join(entry.bootstrap.root,"notes/New/After.assets",target(index))),payloads[index]);
      await u.absent(join(entry.bootstrap.root,"notes/Old/Before.md"),"PRIVATE_RECOVERY_OLD_OWNER_REMAINED");
      await unchanged(state,entry.bootstrap.root);
      const mutations=await u.load(installed,"knowledge-mutations");
      await entry.bootstrap.storage.withWorkspaceExclusive(()=>mutations.assertKnowledgeMutationRequestPlan(entry.bootstrap.root,
        mutations.deserializeKnowledgeMutationPlan(state.commit.plan_json),JSON.parse(state.commit.request_json)));
      noPrivate(JSON.parse(state.receipt.result));noPrivate(markdown.scanMarkdown(entry.bootstrap.root).map(row=>({...row.record})));
      state.b1Knowledge=u.hashes(await u.files(entry.bootstrap.root,true));state.phase="recovered";
    }
    state.priorEpochs.push(newEpoch);entry.verified=true;
    const result={passed:true,decision,genuinelyFreshNativeEpoch:newEpoch,completedCopyReadonlyWithoutNewApproval:true,
      operationId:state.intent.operation_id,
      missingSecondResourceReviewed:true,denialNoEffects:decision==="deny",actualPendingPrivateRecoveryQualified:decision==="approve",
      environmentFaultInjection:true,publicMutationReplayAttempted:false,internalCoreMutationReplayAttempted:false,fullCutoverQualified:false};
    await writeFile(join(options.root,`native-private-resource-recovery-${decision}-passed.json`),JSON.stringify(result),{mode:0o600,flag:"wx"});return result;
  }finally{await ui.stop();}
}
export async function closeInstalledNativePrivateResourceRecoveryEpoch(epoch){
  const entry=epochs.get(epoch);if(!entry||entry.closed)fail("PRIVATE_RECOVERY_ACTUAL_EPOCH_REQUIRED");
  await entry.bootstrap.close();entry.closed=true;entry.state.activeEpoch=undefined;
}
export async function verifyInstalledNativePrivateResourceRecoveryB1(sourceFixture,{retirement}){
  const state=stateFor(sourceFixture);if(state.phase!=="recovered"||state.activeEpoch)fail("PRIVATE_RECOVERY_CONFIRMED_CLOSED_RECOVERY_REQUIRED");
  await readInstalledKnowledgeMoveRetirementReceipt({componentFixture:state.componentFixture,sourceRoot:sourceFixture.root,b0Sha256:state.b0Sha256},retirement);
  assert.deepEqual(u.hashes(await u.files(retirement.archive,true)),state.b1Knowledge);await unchanged(state,retirement.archive);
  const db=new DatabaseSync(join(retirement.archive,"core.sqlite"),{readOnly:true});
  try{
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0],"ok");
    assert.equal(db.prepare("SELECT count(*) AS n FROM migration_runtime_intents").get().n,0);
    assert.deepEqual({...db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(state.intent.operation_id)},state.receipt);
    assert.deepEqual({...db.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(state.intent.operation_id)},state.commit);
  }finally{db.close();}
  return {recoveryB1ExactPairsPrivateSourcesAndNewEpochHistoricalProvenancePreserved:true};
}
export async function verifyInstalledNativePrivateResourceRecoveryRestored(sourceFixture,{retirement,restored}){
  const state=stateFor(sourceFixture),b1=await verifyInstalledNativePrivateResourceRecoveryB1(sourceFixture,{retirement});
  const expected={componentFixture:state.componentFixture,sourceRoot:sourceFixture.root,b0Sha256:state.b0Sha256};
  const retired=await readInstalledKnowledgeMoveRetirementReceipt(expected,retirement);
  await readInstalledKnowledgeMoveRestoredReceipt(expected,retirement,restored,retired);
  assert.deepEqual(u.hashes(await u.files(restored.root)),u.hashes(state.baseline));
  for(const path of ["core.sqlite","core.sqlite-wal","core.sqlite-shm",".pkm-next-workspace",".pkm-next-original-mcp.json",".pkm-native"])
    await u.absent(join(restored.root,path),"PRIVATE_RECOVERY_B0_NATIVE_STATE_OR_GRANT");
  return {...b1,allOriginalRecoveryB0BytesRestored:true,freshB0NoNativeDatabaseOrGrant:true,originalRootOverwritten:false,fullCutoverQualified:false};
}
