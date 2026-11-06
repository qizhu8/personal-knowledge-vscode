const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const store = require("../dist/knowledge/filestore");
const { projectWorkItemProgress, inspectWorkItem } = require("../dist/knowledge/work-item-progress");
const task = (id, fields = {}) => ({ id, title: "Same title", goal: "Recorded contract", scope: "Isolated fixture",
  acceptance: ["Inspect exact records"], state: "Planning", evidence: [], ...fields });
const user = { id: "user:local", role: "user" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.setStorePath(root);
  const create = (slug, items) => {
    store.noteUpsert({ slug, title: path.posix.basename(slug), category: path.posix.dirname(slug)==="."?"":path.posix.dirname(slug),
      type: "todo", tags: [], content: "Preserved manual context" });
    for (const item of items) store.noteWorkItemUpsert(slug, store.noteWorkItemsRead(slug).digest, item);
  };
  return { root, create };
}
const reference = record => ({ slug: record.slug, id: record.item.id, digest: record.digest, knowledgeId: record.knowledgeId });

test("timeline pins its read clock and labels long-lived, waiting, absent and inconsistent audit as unverified, never compute", () => {
  const context = { window: { addEventListener() {} }, esc: value => String(value ?? ""),
    Date: class extends Date { static now() { throw Error("Timeline must use the pinned read clock"); } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/webview/panel/22-note-todo.js"), "utf8"), context);
  const at = "2026-01-01T00:00:00.000Z", readAt = "2026-11-04T12:00:00.000Z";
  const active = task("long-running", { state: "WIP",
    history: [{ at, actorId: "chat:one", action: "claim", from: "Planning", to: "WIP" }] });
  const waiting = task("approval", { state: "OnHold",
    history: [{ at, actorId: "chat:one", action: "transition", from: "WIP", to: "OnHold", reason: "Awaiting approval" }] });
  const html = context.noteTodoTimeline([active, waiting, task("unknown", { state: "WIP" })].map(item => ({ item })), false, readAt);
  assert.match(html, /Read at 2026-11-04T12:00:00.000Z/);
  assert.match(html, /WIP is not measured model compute time/);
  assert.match(html, /last recorded state; current activity unverified/);
  assert.match(html, /Unscheduled|unknown duration/);
  assert.match(html, /No recorded state intervals/);
  assert.doesNotMatch(html, /\d+(?:\.\d+)?% (?:complete|success)/);
  assert.match(context.noteTodoRecordTime({ ...active, state: "Blocked" }), /State \/ audit mismatch/);
  assert.match(context.noteTodoRecordTime(task("unknown")), /unknown \/ no matching audit/);
});

test("Project projection includes parent context, isolates dependency namespaces and separates submission/success/acceptance", t => {
  const { root, create } = fixture(t);
  create("A", [task("story", { kind: "UserStory", storyStatus: "draft" }),
    task("active", { projectId: "project-one", parentId: "story", state: "WIP", ownerId: "chat:one", dependsOn: ["local"] }),
    task("local", { projectId: "project-other" }),
    task("success", { projectId: "project-one", state: "Done", outcome: "Success", evidence: ["test://success"] }),
    task("failed", { projectId: "project-one", state: "Done", outcome: "Failed", evidence: ["test://failed"],
      acceptanceDecision: { by: "user:local", at: "2026-11-04T00:00:00Z", decision: "accepted" } }),
    task("blocked", { projectId: "project-one", state: "Blocked", blockedReason: "Needs source data" })]);
  create("B", [task("active", { projectId: "project-other" }), task("local", { projectId: "project-one" })]);
  const before = fs.readFileSync(path.join(root, "notes/A.md"), "utf8");
  const progress = projectWorkItemProgress("project-one", "2026-11-04T01:00:00Z");
  assert.equal(progress.readAt, "2026-11-04T01:00:00Z");
  assert.equal(progress.records.length, 6);
  assert.deepEqual(progress.summary, { total: 5, active: 1, remaining: 3, submitted: 2, success: 1,
    accepted: 1, unassigned: 4, blocked: 1, awaitingAcceptance: 1 });
  const record = progress.records.find(record => record.item.id === "active");
  const inspected = inspectWorkItem(reference(record));
  assert.equal(inspected.item.ownerId, "chat:one");
  assert.equal(inspected.related.find(record => record.item.id === "local").slug, "A");
  assert.equal(inspected.related.find(record => record.item.id === "local").item.projectId, "project-other");
  assert(inspected.related.some(record => record.item.kind === "UserStory"));
  assert.equal(inspected.changed, false);
  assert.equal(fs.readFileSync(path.join(root, "notes/A.md"), "utf8"), before, "all progress inspection is read only");
});

test("stable source identity follows rename, detects new revisions, refuses Trash/replacements/duplicate identities", t => {
  const { root, create } = fixture(t);
  create("A", [task("same", { projectId: "project-one" })]);
  const ref = reference(projectWorkItemProgress("project-one").records[0]);
  assert.match(ref.knowledgeId, /^knowledge_[a-f0-9]{24}$/);
  assert.equal(store.noteMove("A", "Moved"), true);
  create("A", [task("same", { projectId: "project-two", goal: "Wrong substitute" })]);
  const moved = inspectWorkItem(ref);
  assert.equal(moved.slug, "Moved/A");
  assert.equal(moved.item.goal, "Recorded contract");
  const snapshot = store.noteWorkItemsRead("Moved/A");
  store.noteWorkItemCommand("Moved/A", snapshot.digest, { action: "comment", id: "same", text: "New source revision" }, user);
  assert.equal(inspectWorkItem(ref).changed, true);
  const file = path.join(root, "notes/Moved/A.md");
  fs.copyFileSync(file, path.join(root, "notes/Duplicate.md"));
  assert.throws(() => inspectWorkItem(ref), /duplicated/i);
  fs.unlinkSync(path.join(root, "notes/Duplicate.md"));
  const trash = store.knowledgePathMoveToTrash("notes", "Moved/A.md");
  assert.throws(() => inspectWorkItem(ref), /not found|unavailable/i);
  assert.equal(store.knowledgeTrashRestore("notes", trash.id).ok, true);
  assert.equal(inspectWorkItem(ref).item.id, "same");
  const current = store.noteWorkItemsRead("Moved/A");
  store.noteWorkItemCommand("Moved/A", current.digest, { action: "delete", id: "same", reason: "Source removed" }, user);
  assert.throws(() => inspectWorkItem(ref), /unavailable/i);
});

test("unversioned, malformed and invalid source references never produce success-shaped fallback", t => {
  const { root, create } = fixture(t);
  create("A", [task("same", { projectId: "project-one" })]);
  const file = path.join(root, "notes/A.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^knowledgeId:.*\n/m, ""));
  const ref = reference(projectWorkItemProgress("project-one").records[0]);
  assert.equal(ref.knowledgeId, undefined);
  assert.equal(inspectWorkItem(ref).item.id, "same");
  fs.appendFileSync(file, "\nConcurrent manual edit\n");
  assert.throws(() => inspectWorkItem(ref), /Unversioned Note changed/);
  for (const invalid of [undefined, {}, { ...ref, id: "../escape" }, { ...ref, digest: "wrong" },
    { ...ref, knowledgeId: "bad-id" }, { ...ref, slug: "../outside" }]) assert.throws(() => inspectWorkItem(invalid));
  fs.writeFileSync(path.join(root, "notes/Broken.md"), "~~~pkm-work-item\nnot json\n~~~\n");
  assert.throws(() => projectWorkItemProgress("project-one"), /could not be read/);
});

test("Project progress resolves current Chat titles by stable ID and keeps explicit unverified identity", () => {
  const context = { window: { addEventListener() {} }, esc: value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;"),
    noteTodo: { slug:"", snapshot:null }, document: {}, vscode: { postMessage() {} },
    noteTodoProgressLink: (_record,_id,title) => `<a>${context.esc(title)}</a>`,
    noteTodoTimeline: () => "", noteTodoRecordTime: () => "Last recorded state; current activity unverified.",
    noteTodoBindInspection: () => {} };
  const container = { dataset:{projectId:"project-one"}, innerHTML:"", querySelectorAll:()=>[] };
  context.document.getElementById = id => id === "project-note-todos" ? container : null;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/webview/panel/22-note-todo.js"), "utf8"), context);
  const row = (id, ownerId) => ({ slug:"Source/Board",digest:`digest-${id}`,knowledgeId:`knowledge-${id}`,
    item:{id,title:`Task ${id}`,kind:"task",state:"WIP",ownerId,history:[]} });
  const alpha=row("alpha","chat:alpha"), beta=row("beta","chat:beta"), missing=row("missing","chat:deleted");
  const render = chats => {
    vm.runInContext('noteTodoProjectViews.set("project-one",{requestId:7})',context);
    context.noteTodoProjectResult({projectId:"project-one",requestId:7,records:[alpha,beta,missing],readAt:"2026-11-06T00:00:00Z",
      summary:{active:3,remaining:3,submitted:0,success:0,accepted:0,unassigned:0,blocked:0,awaitingAcceptance:0},
      agentIds:["alpha","beta"],chats});
    return container.innerHTML;
  };
  const initial=render([{id:"beta",title:"Shared title"},{id:"alpha",title:"Shared title"}]);
  assert.match(initial,/Shared title[\s\S]*chat:alpha/);
  assert.match(initial,/Shared title[\s\S]*chat:beta/);
  assert.match(initial,/recorded Agent; activity unverified/);
  assert.match(initial,/current activity unverified/i);
  assert.match(initial,/chat:deleted · Agent unavailable \/ missing/);
  const alphaButton=initial.match(/<button[^>]*data-todo-agent="([^"]+)"[^>]*>[^<]*Shared title/);
  assert(alphaButton,"known Chat owner is linked to its source Work Item");
  const reference=JSON.parse(alphaButton[1].replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
  assert.deepEqual(reference,{slug:"Source/Board",id:"alpha",digest:"digest-alpha",knowledgeId:"knowledge-alpha"});
  const renamed=render([{id:"alpha",title:"<img src=x onerror=alert(1)>"},{id:"beta",title:"Renamed beta"}]);
  assert.match(renamed,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(renamed,/<img src=x/);
  assert.match(renamed,/chat:alpha/);
  assert.match(renamed,/Renamed beta[\s\S]*chat:beta/);
  assert.match(renamed,/chat:deleted · Agent unavailable \/ missing/);
  const absentMapping=render([{id:"beta",title:"Renamed beta"}]);
  assert.match(absentMapping,/chat:alpha/);
  assert.match(absentMapping,/Agent unavailable \/ missing|recorded Agent; activity unverified/);
});
