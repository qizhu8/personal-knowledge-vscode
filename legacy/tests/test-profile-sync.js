const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const {randomUUID}=require("node:crypto");
const {PersonaProfileStore,portablePersonaPath,readPortablePersonas,validatePortablePersonaChanges}=require("../dist/chat/persona-profiles");
const {authorizeGitHubSyncProfiles,githubSyncProfilesAuthorized}=require("../dist/sync/github-sync-profiles");
const {GITHUB_SYNC_CONTENT_TYPES,normalizeGitHubSyncTarget,defaultGitHubSyncSelection,githubSyncTargetFingerprintState,
  validateGitHubSyncCandidate,syncGitHubTarget,GitHubSyncConflictError}=require("../dist/sync/github-sync");
const {githubSyncCatalogInWorker}=require("../dist/sync/github-sync-catalog-worker");
const card=(preferences="Concise")=>({name:"Developer",role:"SDE",focus:"Correctness",preferences,boundaries:"Ask before production changes"});
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-profile-sync-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.join(directory,"knowledge"),privateRoot=path.join(directory,"host");
  return {directory,root,privateRoot,store:new PersonaProfileStore(privateRoot,root)};
}
function catalog(root){
  const data=Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type=>[type,[]]));
  data.profiles=readPortablePersonas(root).map(record=>({id:`${record.kind}/${record.id}`,label:record.name,cat:record.kind,
    isPrivate:true,source:path.join(root,portablePersonaPath(record)),destination:portablePersonaPath(record)}));
  return data;
}
const enable=store=>store.setSyncEnabled(true,store.syncPreview().digest);

test("Default private Profiles never create repository cards; explicit root migration preserves identity, private backup and history",t=>{
  const {root,privateRoot,store}=fixture(t);
  const user=store.save("user",card()),agent=store.save("agent",card("Test first")),history=store.capture(agent.id);
  const original=JSON.stringify(history),preview=store.syncPreview();
  assert.equal(store.syncEnabled,false);
  assert.equal(fs.existsSync(path.join(root,"profiles")),false);
  assert.throws(()=>store.setSyncEnabled(true),/changed during Sync approval/);
  assert.equal(store.syncEnabled,false);
  store.setSyncEnabled(true,preview.digest);
  assert.equal(store.userDirectory,path.join(root,"profiles","user"));
  assert.deepEqual(store.capture(agent.id),history);
  store.save("user",card("Repository only"),store.user());
  assert.equal(JSON.stringify(history),original);
  const otherRoot=new PersonaProfileStore(privateRoot,path.join(root,"other"));
  assert.deepEqual(otherRoot.user(),user,"another Knowledge Root retains the original Host-global private card");
  assert.equal(otherRoot.syncEnabled,false);
  store.setSyncEnabled(false);
  assert.deepEqual(store.user(),user,"return to original private card is explicit and nondestructive");
  assert.equal(readPortablePersonas(root).find(p=>p.kind==="user").preferences,"Repository only");
});

test("Fresh devices do not adopt pulled cards without local consent and never overwrite them with private cards",t=>{
  const {directory,root,store}=fixture(t);
  const user=store.save("user",card("Repository preference"));
  enable(store);
  const other=new PersonaProfileStore(path.join(directory,"host-b"),root);
  const privateUser=other.save("user",card("Different local preference"));
  assert.deepEqual(other.user(),privateUser);
  enable(other);
  assert.deepEqual(other.user(),user,"existing repository cards win only after the explicit adoption preview");
  assert.equal(readPortablePersonas(root).filter(p=>p.kind==="user"&&!p.deleted).length,1);
  other.setSyncEnabled(false);assert.deepEqual(other.user(),privateUser);
});

test("Approval preview is CAS-bound; same-revision remote changes, corruption and duplicate users cannot silently overwrite",t=>{
  const {root,store}=fixture(t);
  const user=store.save("user",card()),preview=store.syncPreview();
  store.save("user",card("Changed during dialog"),user);
  assert.throws(()=>store.setSyncEnabled(true,preview.digest),/changed during Sync approval/);
  enable(store);
  const before=store.user(),file=path.join(root,portablePersonaPath(before));
  fs.writeFileSync(file,JSON.stringify({...before,preferences:"Remote changed same revision/time"}));
  assert.throws(()=>store.save("user",card("Stale editor"),before),/changed in another window/);
  const second={...before,id:randomUUID()};
  assert.throws(()=>validatePortablePersonaChanges(root,[{relative:portablePersonaPath(second),content:Buffer.from(JSON.stringify(second))}]),/Multiple repository User Profiles/);
  assert.equal(readPortablePersonas(root).length,1,"invalid conflict candidates were not applied");
  fs.writeFileSync(path.join(root,portablePersonaPath(second)),JSON.stringify(second));
  assert.throws(()=>store.capture(),/Multiple repository User Profiles/);
  fs.unlinkSync(path.join(root,portablePersonaPath(second)));
  fs.writeFileSync(file,"{broken");
  assert.throws(()=>store.capture(),/JSON|property/i);
});

test("Repository card directories reject symlinks and malformed path identities",t=>{
  const {directory,root,store}=fixture(t);
  const user=store.save("user",card());enable(store);
  const file=path.join(root,portablePersonaPath(user));
  fs.unlinkSync(file);fs.symlinkSync(path.join(directory,"missing"),file);
  assert.throws(()=>store.capture(),/portable Profile file/);
  assert.throws(()=>validateGitHubSyncCandidate(`profiles/agent/${user.id}.json`,Buffer.from(JSON.stringify(user))),/path or privacy mismatch/);
  assert.throws(()=>validateGitHubSyncCandidate("profiles/user/unrelated.json",Buffer.from(JSON.stringify(user))),/path or privacy mismatch/);
});

test("Profile selection is default-off, private-only, endpoint/scope-bound and cannot reuse webview-forged consent",async t=>{
  const {root,store}=fixture(t);store.save("user",card());enable(store);
  const defaults=defaultGitHubSyncSelection();
  assert.deepEqual(defaults.public.profiles,{items:[],folders:[]});
  assert.deepEqual(defaults.private.profiles,{items:[],folders:[]});
  const target=normalizeGitHubSyncTarget({id:"profiles",name:"Profiles",repository:"https://example.invalid/private.git",branch:"main"});
  target.selection.private.profiles.folders=[""];
  let approvals=0;
  await assert.rejects(authorizeGitHubSyncProfiles(target,undefined,root,true,async()=>{approvals++;return false;}),/not approved/);
  assert.equal(githubSyncProfilesAuthorized(target),false);
  await authorizeGitHubSyncProfiles(target,undefined,root,true,async()=>{approvals++;return true;});
  const previous=structuredClone(target);
  await authorizeGitHubSyncProfiles(target,previous,root,true,async()=>assert.fail("unchanged scope prompted again"));
  assert(githubSyncProfilesAuthorized(normalizeGitHubSyncTarget(target)));
  for(const mutate of [
    value=>{value.branch="other";},
    value=>{value.repository="https://example.invalid/public.git";},
    value=>{value.selection.private.profiles.items=["agent/new"];},
  ]){
    const changed=structuredClone(previous);mutate(changed);
    assert.equal(githubSyncProfilesAuthorized(changed),false);
    await assert.rejects(authorizeGitHubSyncProfiles(changed,previous,root,true,async()=>false),/not approved/);
  }
  const forged=structuredClone(previous);
  await assert.rejects(authorizeGitHubSyncProfiles(forged,undefined,root,false,async()=>true),/First enable/);
  assert.equal(forged.profileSyncConsent,undefined);
  const publicTarget=structuredClone(previous);publicTarget.selection.public.profiles.folders=[""];
  await assert.rejects(authorizeGitHubSyncProfiles(publicTarget,undefined,root,true,async()=>true),/private content/);
  const state=githubSyncTargetFingerprintState(normalizeGitHubSyncTarget({...previous,selection:defaults}),catalog(root));
  assert.deepEqual(state.files.profiles,{});
  assert.equal(approvals,2);
});

test("Catalog includes only bounded root Profile JSON, not private consent, Chat history, SQLite or credentials",async t=>{
  const {root,store}=fixture(t);store.save("user",card());store.save("agent",card());enable(store);
  const data=await githubSyncCatalogInWorker({root,servers:[],recipes:[]});
  assert.equal(data.profiles.length,2);
  for(const item of data.profiles){
    assert.equal(item.isPrivate,true);
    assert.match(item.destination,/^profiles\/(user|agent)\/[a-f0-9-]+\.json$/);
    assert(!item.destination.includes(".pkm"));
  }
});

test("Real local Git two-device Profile roundtrip, edits, tombstones and concurrent manual conflict without model calls", {timeout:60000},async t=>{
  const {directory,root:aRoot,store:a}=fixture(t);
  const git=(cwd,args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const remote=path.join(directory,"remote.git"),seed=path.join(directory,"seed");
  fs.mkdirSync(seed);git(directory,["init","--bare",remote]);git(seed,["init"]);
  git(seed,["config","user.name","Fixture"]);git(seed,["config","user.email","fixture@example.invalid"]);
  fs.writeFileSync(path.join(seed,"README.md"),"Isolated Profile test\n");
  git(seed,["add","README.md"]);git(seed,["commit","-m","seed"]);git(seed,["branch","-M","main"]);
  git(seed,["remote","add","origin",remote]);git(seed,["push","-u","origin","main"]);
  const user=a.save("user",card()),agent=a.save("agent",card("Agent card"));enable(a);
  const bRoot=path.join(directory,"machine-b"),b=new PersonaProfileStore(path.join(directory,"host-b"),bRoot);enable(b);
  const target=async(id,root)=>{
    const value=normalizeGitHubSyncTarget({id,name:id,repository:remote,branch:"main"});
    value.selection.private.profiles.folders=[""];
    await authorizeGitHubSyncProfiles(value,undefined,root,true,async()=>true);return value;
  };
  const aTarget=await target("machine-a",aRoot),bTarget=await target("machine-b",bRoot);
  const sync=async(target,root)=>{
    const result=await syncGitHubTarget(target,catalog(root),path.join(directory,"checkouts"),undefined,root);
    target.lastSync={at:new Date().toISOString(),commit:result.commit,fingerprints:result.fingerprints,
      repository:target.repository,branch:target.branch,storeRoot:root};return result;
  };
  const noConsent=normalizeGitHubSyncTarget({id:"not-approved",name:"Not approved",repository:remote});
  noConsent.selection.private.profiles.folders=[""];
  await assert.rejects(sync(noConsent,aRoot),/separate approval/);
  await assert.rejects(sync(aTarget,bRoot),/separate approval/);
  await sync(aTarget,aRoot);await sync(bTarget,bRoot);
  assert.deepEqual(b.capture(agent.id),a.capture(agent.id));
  const paths=git(directory,["--git-dir",remote,"ls-tree","-r","--name-only","main"]);
  assert(paths.includes(portablePersonaPath(user)));
  assert(!/sqlite|api-chats|profile-sync|credentials|mutation.lock/.test(paths));
  const raw=git(directory,["--git-dir",remote,"show","main:.pkm-github-sync.json"]);
  assert(raw.includes("profile-cards"),"old readers must reject unsupported Profile publications safely");
  const defaultRoot=path.join(directory,"default-off"),defaultTarget=normalizeGitHubSyncTarget({id:"default-off",name:"Default off",repository:remote,branch:"main"});
  await sync(defaultTarget,defaultRoot);
  assert.equal(fs.existsSync(path.join(defaultRoot,"profiles")),false,"an old/default target does not pull Profile cards");
  assert(git(directory,["--git-dir",remote,"ls-tree","-r","--name-only","main"]).includes(portablePersonaPath(user)),
    "an unselected Profile is retained remotely, not treated as an explicit deletion");
  const cRoot=path.join(directory,"machine-c"),c=new PersonaProfileStore(path.join(directory,"host-c"),cRoot);
  c.save("user",card("Different User identity"));enable(c);
  await assert.rejects(sync(await target("machine-c",cRoot),cRoot),error=>error instanceof GitHubSyncConflictError);
  assert.equal(c.user().preferences,"Different User identity");
  assert.equal(readPortablePersonas(cRoot).filter(p=>p.kind==="user"&&!p.deleted).length,1,
    "independently created User identities become a reviewable conflict, not a broken two-User registry");
  a.save("user",card("Edited on A"),a.user());await sync(aTarget,aRoot);await sync(bTarget,bRoot);
  assert.equal(b.user().preferences,"Edited on A");
  a.delete(a.get("agent",agent.id));await sync(aTarget,aRoot);await sync(bTarget,bRoot);
  assert.throws(()=>b.capture(agent.id),/unavailable or deleted/);
  assert.equal(readPortablePersonas(bRoot).find(p=>p.id===agent.id).deleted,true);
  a.save("user",card("Concurrent A"),a.user());b.save("user",card("Concurrent B"),b.user());
  await sync(aTarget,aRoot);
  await assert.rejects(sync(bTarget,bRoot),error=>error instanceof GitHubSyncConflictError&&error.conflicts.some(c=>c.type==="profiles"));
  assert.equal(b.user().preferences,"Concurrent B","conflicts do not replace local card or combine preferences automatically");
});
