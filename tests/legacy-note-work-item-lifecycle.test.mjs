import { test } from "node:test";
import assert from "node:assert/strict";
import { commandNoteWorkItem, readNoteWorkItems, upsertNoteWorkItem, validateNoteWorkItem, workItemIcons } from "../dist/domain/note-work-items.js";

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

test("collaboration and monitoring contracts validate bounded metadata without granting owner or reviewer powers", () => {
  for (const invalid of [{ description:"" }, { description:"x".repeat(16001) }, { icon:'bug" onclick="unsafe' },
    { collaboratorIds:["Just a name"] }, { collaboratorIds:[other.id,other.id] },
    { collaboratorIds:Array.from({length:21},(_,i)=>`chat:${i}`) }, { collaboratorIds:[worker.id], ownerId:worker.id },
    { monitoring:{} }, { monitoring:[] }, { monitoring:{ until:"2026-02-30T00:00:00Z" } },
    { monitoring:{ until:"2026-11-04" } }, { monitoring:{ endCondition:" " } },
    { monitoring:{ endCondition:"x".repeat(8001) } }, { monitoring:{ autoComplete:true,endCondition:"Finish" } }]) {
    assert.throws(()=>validateNoteWorkItem({...item,...invalid}),JSON.stringify(invalid).slice(0,100));
  }
  for(const icon of workItemIcons)assert.equal(validateNoteWorkItem({...item,icon}).icon,icon);
  const flow=lifecycle();
  assert.throws(()=>flow.run({action:"create",item:{...item,collaboratorIds:[other.id]}}),/Only users/);
  let value=flow.run({action:"create",item:{...item,icon:"eye",description:"Inspect <script> as literal text",
    collaboratorIds:[other.id],monitoring:{until:"2020-01-01T00:00:00Z",endCondition:"Report observed sample and stop"}}},user);
  assert.equal(value.state,"Planning","a past observation deadline is a contract, not automatic completion");
  value=flow.run({action:"claim",id:item.id});
  assert.throws(()=>flow.run({action:"claim",id:item.id},other),/another actor/);
  assert.throws(()=>flow.run({action:"transition",id:item.id,state:"Done",outcome:"Success",evidence:["collaborator"]},other),/owned/);
  for(const changes of [{description:"Changed"},{icon:"bug"},{collaboratorIds:[]},{monitoring:{endCondition:"Forever-ish"}}]){
    assert.throws(()=>flow.run({action:"edit",item:{...value,...changes}}),/protected/);
  }
  value=flow.run({action:"transition",id:item.id,state:"Done",outcome:"Unsure",evidence:["test://inconclusive-window"]});
  assert.throws(()=>flow.run({action:"accept",id:item.id,reason:"I collaborated"},other),/reviewer/);
  assert.equal(value.acceptanceDecision,undefined);
  assert.equal(value.monitoring.endCondition,"Report observed sample and stop");
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

test("verification absence and empty reports never default to passed", () => {
  for (const fields of [{}, { verification:[] }, ...["unit", "functional", "e2e"].flatMap(layer => [
    { verification:[{ layer, status:"not-run", evidence:[], reason:"Not executed" }] },
    { verification:[{ layer, status:"blocked", evidence:[] }] },
    { verification:[{ layer, status:"not-applicable", evidence:[], reason:"No applicable surface in fixture" }] },
  ])]) {
    const flow = lifecycle();
    flow.run({ action:"create", item:{ ...item, ...fields } }, user);
    flow.run({ action:"claim", id:item.id });
    let value = flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Unsure", evidence:["fixture://unverified-outcome"] });
    assert.deepEqual(value.verification, fields.verification);
    assert.equal(value.acceptanceDecision, undefined);
    value = flow.run({ action:"reopen", id:item.id, reason:"Still needs verification" }, user);
    assert.deepEqual(value.verification, fields.verification);
    assert.equal(value.acceptanceDecision, undefined);
  }
});

test("invalid verification rejects canonical and lifecycle writes without changing the Note", () => {
  const flow = lifecycle("Unrelated Note text.\n");
  flow.run({ action:"create", item:{ ...item,
    verification:[{ layer:"functional", status:"failed", evidence:["fixture://retained-failure"], reason:"Observed failure" }] } }, user);
  flow.run({ action:"claim", id:item.id });
  const before = flow.markdown();
  const stored = flow.read();
  const invalid = [null, {}, ...["unit", "functional", "e2e"].flatMap(layer => [
    ...[undefined, "", " \n ", 7].map(reason => [{ layer, status:"not-applicable", evidence:[], ...(reason === undefined ? {} : { reason }) }]),
    ...["passed", "failed"].map(status => [{ layer, status, evidence:[] }]),
    ...["PASSED", "unknown", "", null].map(status => [{ layer, status, evidence:["fixture://invalid"] }]),
    [{ layer, evidence:[] }],
    [{ layer, status:"not-run", evidence:"not-a-list" }],
    [{ layer, status:"not-run", evidence:[""] }],
  ]), ...["integration", "E2E", "", null].map(layer => [{ layer, status:"not-run", evidence:[] }]),
    [{ status:"not-run", evidence:[] }]];
  for (const verification of invalid) {
    // Include a valid report before each malformed record: validation must not partially commit it.
    const candidate = Array.isArray(verification)
      ? [{ layer:"unit", status:"passed", evidence:["fixture://must-not-commit"] }, ...verification] : verification;
    assert.throws(() => upsertNoteWorkItem(before, stored.digest, { ...stored.items[0], verification:candidate }));
    assert.throws(() => flow.run({ action:"edit", item:{ ...stored.items[0], verification:candidate } }));
    assert.throws(() => flow.run({ action:"transition", id:item.id, state:"Done", outcome:"Success",
      evidence:["fixture://must-not-commit"], verification:candidate }));
    assert.equal(flow.markdown(), before, "failed write leaves the stored Note byte-for-byte unchanged");
    assert.deepEqual(flow.read(), stored, "digest, state, failure, reason, evidence and audit remain unchanged");
  }
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

test("state x actor transition matrix follows documented owner and terminal/outcome rules", () => {
  const states = ["Planning", "WIP", "Blocked", "OnHold", "Done"];
  const nonterminal = states.filter(state => state !== "Done");
  const owners = [user, worker];
  const outcomes = ["Success", "Failed", "Unsure"];
  let checked = 0;
  function seeded(state, owner) {
    const flow = lifecycle();
    flow.run({ action:"create", item:{ ...item, evidence:["baseline:evidence"],
      verification:[{ layer:"unit", status:"passed", evidence:["baseline:verification"] }] } }, user);
    flow.run({ action:"claim", id:item.id }, owner);
    if (state !== "WIP") flow.run({ action:"transition", id:item.id, state,
      ...(state === "Blocked" ? { blockedReason:"Baseline dependency" } : {}),
      ...(state === "OnHold" ? { reason:"Baseline review hold" } : {}),
      ...(state === "Done" ? { outcome:"Unsure", evidence:["baseline:done"] } : {}) }, owner);
    return flow;
  }
  function transition(state, outcome) {
    return { action:"transition", id:item.id, state,
      ...(state === "Blocked" ? { blockedReason:"Waiting for dependency" } : {}),
      ...(state === "OnHold" ? { reason:"Awaiting user decision" } : {}),
      ...(state === "Done" ? { outcome, evidence:["transition:evidence"] } : {}) };
  }

  // The documented contract allows an owner to transition any nonterminal item.
  // Done requires an explicit result and evidence; all three declared outcomes
  // are valid reports, not acceptance decisions.
  for (const from of nonterminal) for (const actor of owners) {
    for (const to of nonterminal) {
      const flow = seeded(from, actor);
      const before = flow.read().items[0];
      const value = flow.run(transition(to), actor);
      assert.equal(value.id, before.id, `${actor.role} ${from}->${to} keeps stable identity`);
      assert.equal(value.state, to, `${actor.role} ${from}->${to}`);
      assert.equal(value.history.at(-1).from, from);
      assert.equal(value.history.at(-1).to, to);
      assert.equal(value.history.at(-1).actorId, actor.id);
      assert.deepEqual(value.evidence, ["baseline:evidence"]);
      assert.deepEqual(value.verification, before.verification);
      assert.equal(value.outcome, undefined);
      assert.equal(value.acceptanceDecision, undefined);
      if (to === "Blocked") assert.equal(value.blockedReason, "Waiting for dependency");
      else assert.equal(value.blockedReason, undefined);
      checked++;
    }
    for (const outcome of outcomes) {
      const flow = seeded(from, actor);
      const before = flow.read().items[0];
      const value = flow.run(transition("Done", outcome), actor);
      assert.equal(value.id, before.id, `${actor.role} ${from}->Done keeps stable identity`);
      assert.equal(value.state, "Done");
      assert.equal(value.outcome, outcome);
      assert.equal(value.acceptanceDecision, undefined, "reporting an outcome is not acceptance");
      assert.deepEqual(value.evidence, ["baseline:evidence", "transition:evidence"]);
      assert.deepEqual(value.verification, before.verification);
      assert.equal(value.history.at(-1).from, from);
      assert.equal(value.history.at(-1).to, "Done");
      checked++;
    }
  }

  // Done is terminal for transition commands; nonowners cannot mutate any
  // nonterminal state. Rejected commands must leave the entire serialized Note
  // unchanged, including state, history/attempt events, evidence and verification.
  for (const actor of owners) for (const to of states) {
    const flow = seeded("Done", actor);
    const before = flow.read().items[0];
    const markdown = flow.markdown();
    assert.throws(() => flow.run(transition(to, "Success"), actor), /Done Work Items must be reopened/);
    assert.equal(flow.markdown(), markdown);
    const after = flow.read().items[0];
    assert.equal(after.id, before.id);
    assert.equal(after.state, before.state);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.verification, before.verification);
    checked++;
  }
  for (const from of nonterminal) for (const actor of owners) {
    const owner = actor === worker ? user : worker;
    const flow = seeded(from, owner);
    const before = flow.read().items[0];
    const markdown = flow.markdown();
    assert.throws(() => flow.run(transition("WIP"), actor), /owned by this actor/);
    assert.equal(flow.markdown(), markdown);
    const after = flow.read().items[0];
    assert.equal(after.id, before.id);
    assert.equal(after.state, before.state);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.verification, before.verification);
    checked++;
  }
  assert.equal(checked, 74);
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
