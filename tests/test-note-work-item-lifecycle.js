const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { commandNoteWorkItem, readNoteWorkItems, upsertNoteWorkItem, validateNoteWorkItem } = require("../dist/knowledge/note-work-items");
const store = require("../dist/knowledge/filestore");

const user = { id:"user:alice", role:"user" };
const worker = { id:"chat:one", role:"worker" };
const other = { id:"chat:two", role:"worker" };
const item = { id:"one", title:"Verify", goal:"Correct response", scope:"GET /health",
  acceptance:["200 and exact JSON"], state:"Planning", evidence:[] };
function lifecycle(markdown = "") {
  return {
    read:() => readNoteWorkItems(markdown),
    markdown:() => markdown,
    run(command, actor = worker) {
      markdown = commandNoteWorkItem(markdown, readNoteWorkItems(markdown).digest, command, actor);
      return readNoteWorkItems(markdown).items.find(value => value.id === (command.id ?? command.item.id));
    },
  };
}
function bridge(root, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../resources/knowledge_mutations.js"), path.resolve(__dirname, ".."), root],
      { stdio:["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

test("claim, protected edits, evidence, explicit reviewer acceptance and reopen are audited", () => {
  const flow = lifecycle();
  let value = flow.run({ action:"create", item:{ ...item, projectId:"existing-project", reviewerIds:[other.id] } }, user);
  assert.equal(value.history.length, 1);
  assert.equal(value.history[0].actorId, user.id);
  value = flow.run({ action:"claim", id:item.id });
  assert.equal(value.ownerId, worker.id);
  assert.equal(value.owner, worker.id);
  assert.equal(value.state, "WIP");
  assert.throws(() => flow.run({ action:"claim", id:item.id }, other), /another actor/);
  for (const [field, replacement] of Object.entries({
    title:"Easier", goal:"Different", scope:"Less", acceptance:["Lower bar"], owner:"Other",
    ownerId:other.id, dependsOn:["missing"], plannedStart:"2026-01-01", projectId:"other-project", reviewerIds:[worker.id],
  })) {
    const edit = { ...value, [field]:replacement };
    if (field === "plannedStart") edit.plannedEnd = "2026-01-02";
    assert.throws(() => flow.run({ action:"edit", item:edit }), /protected/);
  }
  assert.throws(() => flow.run({ action:"edit", item:{ ...value, history:[] } }), /protected/);
  assert.throws(() => flow.run({ action:"edit", item:value }, other), /owned/);
  value = flow.run({ action:"edit", item:{ ...value, evidence:["run:123"], links:["recipe:health"],
    verification:[{ layer:"unit", status:"passed", evidence:["run:123"] }] } });
  assert.throws(() => flow.run({ action:"transition", id:item.id, state:"Done" }), /outcome/);
  value = flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Unsure", evidence:["functional:pending"] });
  assert.equal(value.acceptanceDecision, undefined, "Done is not accepted");
  assert.equal(value.outcome, "Unsure");
  assert.deepEqual(value.evidence, ["run:123", "functional:pending"]);
  assert.throws(() => flow.run({ action:"accept", id:item.id, reason:"I wrote it" }), /reviewer/);
  assert.throws(() => flow.run({ action:"accept", id:item.id }, other), /reason/i);
  assert.throws(() => flow.run({ action:"edit", item:value }), /reopened/);
  value = flow.run({ action:"accept", id:item.id, reason:"Reviewed evidence; follow-up tracked" }, other);
  assert.equal(value.acceptanceDecision.by, other.id);
  assert.equal(value.history.at(-1).action, "accept");
  assert.throws(() => flow.run({ action:"reopen", id:item.id, reason:"Try again" }, other), /Only a user/);
  assert.throws(() => flow.run({ action:"reopen", id:item.id }, user), /reason/i);
  const history = value.history;
  value = flow.run({ action:"reopen", id:item.id, reason:"Need definitive result" }, user);
  assert.equal(value.state, "Planning");
  assert.equal(value.outcome, undefined);
  assert.equal(value.acceptanceDecision, undefined);
  assert.deepEqual(value.evidence, ["run:123", "functional:pending"]);
  assert.deepEqual(value.history.slice(0, -1), history);
  assert.equal(value.history.at(-1).from, "Done");
});

test("release, Blocked reason and worker creation rules", () => {
  const flow = lifecycle();
  for (const forged of [{ owner:"label" }, { ownerId:worker.id }, { projectId:"project" }, { reviewerIds:[worker.id] },
    { history:[] }, { state:"WIP" }]) {
    assert.throws(() => flow.run({ action:"create", item:{ ...item, ...forged } }));
  }
  flow.run({ action:"create", item });
  flow.run({ action:"claim", id:item.id });
  assert.throws(() => flow.run({ action:"transition", id:item.id, state:"Blocked" }), /reason/);
  let value = flow.run({ action:"transition", id:item.id, state:"Blocked", blockedReason:"Waiting on API" });
  assert.equal(value.history.at(-1).reason, "Waiting on API");
  assert.throws(() => flow.run({ action:"release", id:item.id }), /reason/i);
  assert.throws(() => flow.run({ action:"release", id:item.id, reason:"handoff" }, other), /owned/);
  value = flow.run({ action:"release", id:item.id, reason:"handoff" });
  assert.equal(value.state, "Planning");
  assert.equal(value.ownerId, undefined);
  assert.equal(value.owner, undefined);
  assert.equal(value.blockedReason, undefined);
  value = flow.run({ action:"claim", id:item.id }, other);
  assert.equal(value.ownerId, other.id);
});

test("user accepts only Done with evidence and explicit reason, never inferred from Success", () => {
  const flow = lifecycle();
  flow.run({ action:"create", item });
  assert.throws(() => flow.run({ action:"accept", id:item.id, reason:"approved" }, user), /Done/);
  flow.run({ action:"claim", id:item.id });
  assert.throws(() => flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Success" }), /evidence/);
  assert.throws(() => flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Success", evidence:["log"] }, other), /owned/);
  let value = flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Success", evidence:["log"] });
  assert.equal(value.acceptanceDecision, undefined);
  value = flow.run({ action:"accept", id:item.id, reason:"Reviewed exact criteria and log" }, user);
  assert.equal(value.acceptanceDecision.by, user.id);
  assert.equal(value.acceptanceDecision.at, value.history.at(-1).at);
  assert.throws(() => flow.run({ action:"accept", id:item.id, reason:"again" }, user), /already accepted/);
});

test("user edits can revise the contract and report Done without accepting it", () => {
  const flow = lifecycle();
  let value = flow.run({ action:"create", item }, user);
  value = flow.run({ action:"edit", item:{ ...value, goal:"Updated goal", scope:"Updated scope",
    acceptance:["Updated exact criteria"], state:"Done", outcome:"Failed", evidence:["failure-log"] },
  reason:"User revised contract and recorded observed failure" }, user);
  assert.equal(value.state, "Done");
  assert.equal(value.outcome, "Failed");
  assert.equal(value.acceptanceDecision, undefined);
  assert.equal(value.history.at(-1).from, "Planning");
  assert.equal(value.history.at(-1).to, "Done");
  assert.equal(value.goal, "Updated goal");
});

test("user draft audit fields never replace authoritative history or forge acceptance", () => {
  const flow = lifecycle();
  const draft = flow.run({ action:"create", item }, user);
  const claimed = flow.run({ action:"claim", id:item.id });
  let value = flow.run({ action:"edit", item:{ ...draft, state:"WIP", ownerId:worker.id, owner:worker.id,
    history:[{ at:"2026-01-01T00:00:00Z", actorId:"forged", action:"accept" }],
    acceptanceDecision:{ by:"forged", at:"2026-01-01T00:00:00Z", decision:"accepted" } } }, user);
  assert.deepEqual(value.history.slice(0, -1), claimed.history);
  assert.equal(value.acceptanceDecision, undefined);
  const history = value.history;
  value = flow.run({ action:"edit", item:{ ...value, state:"Done", outcome:"Success", evidence:["log"],
    history:[], acceptanceDecision:{ by:"forged", at:"2026-01-01T00:00:00Z", decision:"accepted" } } }, user);
  assert.deepEqual(value.history.slice(0, -1), history);
  assert.equal(value.acceptanceDecision, undefined);
});

test("strict extended validation and dependency graph reject invalid writes atomically", () => {
  for (const fields of [
    { plannedStart:"2026-02-29", plannedEnd:"2026-03-01" }, { plannedStart:"2026-01-01" },
    { plannedStart:"2026-03-02", plannedEnd:"2026-03-01" }, { plannedStart:"2026-1-01", plannedEnd:"2026-01-02" },
    { dependsOn:"one" }, { dependsOn:["one", "one"] }, { ownerId:" " }, { reviewerIds:[2] }, { links:[false] },
    { verification:[{ layer:"unit", status:"passed", evidence:[] }] },
    { verification:[{ layer:"unit", status:"not-applicable", evidence:[] }] },
    { verification:[{ layer:"unit", status:"not-run", evidence:[], forged:true }] },
    { history:[{ at:"yesterday", actorId:"a", action:"edit" }] },
    { history:[{ at:"2026-02-30T00:00:00Z", actorId:"a", action:"edit" }] },
    { acceptanceDecision:{ by:"a", at:"2026-01-01T00:00:00Z", decision:"accepted" } },
  ]) assert.throws(() => validateNoteWorkItem({ ...item, ...fields }), JSON.stringify(fields));
  const flow = lifecycle();
  flow.run({ action:"create", item }, user);
  const before = flow.markdown();
  assert.throws(() => flow.run({ action:"create", item:{ ...item, id:"two", dependsOn:["missing"] } }, user), /Missing/);
  assert.throws(() => flow.run({ action:"edit", item:{ ...flow.read().items[0], dependsOn:["one"] } }, user), /cycle/);
  assert.equal(flow.markdown(), before);
  flow.run({ action:"create", item:{ ...item, id:"two", dependsOn:["one"], plannedStart:"2028-02-29", plannedEnd:"2028-03-01" } }, user);
  assert.throws(() => flow.run({ action:"edit", item:{ ...flow.read().items[0], dependsOn:["two"] } }, user), /cycle/);
  assert.throws(() => flow.run({ action:"claim", id:"one", role:"user" }), /Unknown/);
  assert.throws(() => flow.run({ action:"claim", id:"one" }, { ...worker, role:"admin" }), /role/);
  for (const command of [null, [], "claim", {}, { action:"claim", id:5 }, { action:"transition", id:"one", state:["WIP"] }]) {
    assert.throws(() => flow.run(command));
  }
});

test("legacy blocks keep no inferred history and unrelated raw Markdown stays byte-identical", () => {
  const prefix = "\uFEFF---\r\ntitle: Manual\r\n---\r\n# Keep  spaces  \r\n";
  const legacy = "```pkm-work-item\r\n" + JSON.stringify(item) + "\r\n```\r\n";
  const untouched = "~~~pkm-work-item\r\n" + JSON.stringify({ ...item, id:"untouched", owner:"legacy label" }) + "\r\n~~~\r\n";
  const suffix = "\r\nManual tail  \r\n";
  const flow = lifecycle(prefix + legacy + untouched + suffix);
  assert.equal(flow.read().items[0].history, undefined);
  assert.throws(() => flow.run({ action:"claim", id:"untouched" }), /Legacy/);
  flow.run({ action:"claim", id:"one" });
  assert(flow.markdown().startsWith(prefix));
  assert(flow.markdown().endsWith(untouched + suffix));
  assert.equal(flow.read().items[0].history.length, 1);
  assert.equal(flow.read().items[1].history, undefined);
  assert.throws(() => commandNoteWorkItem(flow.markdown(), readNoteWorkItems("").digest, { action:"claim", id:"one" }, worker), /Note changed/);
  assert.deepEqual(readNoteWorkItems(upsertNoteWorkItem("", readNoteWorkItems("").digest, item)).items, [item]);
});

test("shared lock gives exactly one competing claim; MCP cannot escalate and discovery is bounded", async t => {
  const root = fs.mkdtempSync(path.join(__dirname, ".note-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  store.setStorePath(root);
  store.noteUpsert({ slug:"Plan", title:"Plan", content:"# Manual", type:"todo", tags:[] });
  let read = store.noteWorkItemsRead("Plan");
  read = store.noteWorkItemCommand("Plan", read.digest, { action:"create", item }, user);
  const request = { operation:"work-item-command", area:"notes", path:"Plan.md", expectedDigest:read.digest,
    command:{ action:"claim", id:item.id }, actor:{ id:"forged-user", role:"user" } };
  const results = await Promise.all([bridge(root, request), bridge(root, request)]);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find(result => result.code !== 0).stderr, /Note changed/);
  read = store.noteWorkItemsRead("Plan");
  assert.equal(read.items[0].ownerId, "mcp:external");
  assert.equal(read.items[0].history.at(-1).actorId, "mcp:external");
  const denied = await bridge(root, { ...request, expectedDigest:read.digest,
    operation:"work-item-upsert", item:{ ...read.items[0], acceptance:["lowered"] } });
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /protected/);
  fs.writeFileSync(path.join(root, "notes", "Malformed.md"), "~~~pkm-work-item\nnot json\n~~~\n");
  store.noteUpsert({ slug:"Plain", title:"Plain", content:"- [ ] not explicit", type:"general", tags:[] });
  const discovered = store.noteWorkItemNotes("", 20).notes;
  assert.equal(discovered.length, 2);
  assert.equal(discovered.find(note => note.slug === "Plan").count, 1);
  assert.match(discovered.find(note => note.slug === "Malformed").error, /Invalid Work Item JSON/);
  assert.equal(store.noteWorkItemNotes("Plan", 1).notes.length, 1);
  assert.equal(store.noteWorkItemNotes("Plain", 1).notes.length, 0);
  assert.equal(store.noteWorkItemNotes("", 1).truncated, true);
  assert.equal(store.noteWorkItemNotes("", 1000).truncated, false);
  assert.throws(() => store.noteWorkItemNotes("", 1001), /limit/);
  const discovery = await bridge(root, { operation:"work-item-notes", area:"notes", path:"_discovery.md", query:"Plan", limit:1 });
  assert.equal(discovery.code, 0, discovery.stderr);
  assert.equal(JSON.parse(discovery.stdout).notes[0].slug, "Plan");
  read = store.noteWorkItemCommand("Plan", read.digest, { action:"create", item:{ ...item, id:"competing" } }, user);
  const claim = actorId => new Promise((resolve, reject) => {
    const script = `
      const store = require(process.argv[1]);
      store.setStorePath(process.argv[2]);
      try {
        console.log(JSON.stringify(store.noteWorkItemCommand("Plan", process.argv[3],
          {action:"claim", id:"competing"}, {id:process.argv[4], role:"worker"})));
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const child = spawn(process.execPath, ["-e", script, path.resolve(__dirname, "../dist/knowledge/filestore"), root, read.digest, actorId],
      { stdio:["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr, actorId }));
  });
  const competing = await Promise.all([claim(worker.id), claim(other.id)]);
  assert.equal(competing.filter(result => result.code === 0).length, 1, JSON.stringify(competing));
  assert.match(competing.find(result => result.code !== 0).stderr, /Note changed/);
  assert.equal(store.noteWorkItemsRead("Plan").items.find(value => value.id === "competing").ownerId,
    competing.find(result => result.code === 0).actorId);
  fs.mkdirSync(path.join(root, "notes", "System"));
  fs.writeFileSync(path.join(root, "notes", "System", "Rules.md"), "Protected");
  assert.throws(() => store.noteWorkItemCommand("System/Rules", readNoteWorkItems("Protected").digest, { action:"create", item }, user), /read-only/);
});
