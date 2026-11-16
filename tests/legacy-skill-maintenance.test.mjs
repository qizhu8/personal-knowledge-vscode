import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { initialize, Storage } from "../dist/storage.js";
import { legacySkillMaintenance, verifyLegacySkillMaintenance, validateLegacySkillMaintenanceArtifact } from "../dist/legacy-skill-maintenance.js";
import { originalSkillMaintenance } from "./legacy-skill-maintenance-oracle.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const actor = { id: "mcp:external", canWrite: true };
const skill = "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000099\nrevision: 1\nname: Evidence Skill\ndescription: Reusable evidence\n---\nNever overwrite this formal Skill.\n";
async function fixture(t) {
  const parent = join(root, "tests", `.skill-maintenance-${randomUUID()}`), data = join(parent, "workspace");
  await mkdir(parent); await initialize(data); await mkdir(join(data, "skills"));
  await writeFile(join(data, "skills/Evidence.md"), skill);
  const storage = await Storage.open(data);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const call = (tool, args, options) => legacySkillMaintenance(storage, actor, { tool, arguments: args }, options);
  const inspect = () => {
    const database = storage.connectNative();
    try { return verifyLegacySkillMaintenance(database, data); } finally { database.close(); }
  };
  return { parent, data, storage, call, inspect };
}
const feedback = { task: "Do not persist this raw private task.", used_skills: ["Evidence Skill"], outcome: "success",
  observations: ["Reusable finding"], evidence: ["Synthetic proof"], interaction_id: "original-interaction" };

test("captured original feedback and proposal persist exact advisory bytes without changing formal Skills", async t => {
  const f = await fixture(t);
  const result = await f.call("skill_feedback", feedback);
  assert.equal(result.value.ok, true);
  const raw = await readFile(join(f.data, "_feedback/skill-usage.jsonl"), "utf8");
  const entry = JSON.parse(raw);
  assert.equal(entry.id, result.value.feedback_id);
  assert(!raw.includes(feedback.task));
  assert.equal(entry.used_skills[0], "Evidence Skill");
  const oracleRoot = join(f.parent, "independent-original");
  await mkdir(join(oracleRoot, "skills"), { recursive: true });
  await writeFile(join(oracleRoot, "skills/Evidence.md"), skill);
  const oracleFeedback = originalSkillMaintenance({ root: oracleRoot, tool: "skill_feedback", args: feedback,
    uuid: entry.id, now: entry.created });
  assert.equal(oracleFeedback.artifacts["_feedback/skill-usage.jsonl"], raw);
  assert.deepEqual(oracleFeedback.value, result.value);
  assert.equal(oracleFeedback.text, result.text);
  const proposal = await f.call("propose_skill_update", { skill_id: "Evidence Skill", base_hash: "old-hash",
    reason: "Preserve reusable evidence", evidence: ["test proof"], proposed_content: "# Proposed Skill\n", confidence: 1.5 });
  assert.equal(proposal.value.ok, true);
  assert.equal(proposal.value.conflict, true);
  const proposalRaw = await readFile(proposal.value.proposal_path, "utf8");
  assert.match(proposalRaw, /confidence: 1.0/);
  validateLegacySkillMaintenanceArtifact(proposal.value.proposal_path.slice(f.data.length + 1), proposalRaw);
  const prefix = proposal.value.proposal_id.split("-")[1];
  const oracleProposal = originalSkillMaintenance({ root: oracleRoot, tool: "propose_skill_update",
    args: { skill_id: "Evidence Skill", base_hash: "old-hash", reason: "Preserve reusable evidence",
      evidence: ["test proof"], proposed_content: "# Proposed Skill\n", confidence: 1.5 },
    uuid: `${prefix}-0000-4000-8000-000000000000`, now: /^created: (.+)$/m.exec(proposalRaw)[1],
    stamp: proposal.value.proposal_id.split("-")[0] });
  assert.equal(oracleProposal.artifacts[proposal.value.proposal_path.slice(f.data.length + 1)], proposalRaw);
  assert.deepEqual({ ...oracleProposal.value, proposal_path: proposal.value.proposal_path }, proposal.value);
  assert.equal(oracleProposal.text.replace(oracleRoot, f.data), proposal.text);
  assert.equal(f.inspect().receiptCount, 2);
  assert.equal(await readFile(join(f.data, "skills/Evidence.md"), "utf8"), skill);
  assert.equal((await f.call("propose_skill_update", { skill_id: "missing", base_hash: "", reason: "" })).value.error, "Skill not found");
  assert.equal(f.inspect().receiptCount, 2);
});

test("advisory actor, exact replay and artifact tamper boundaries fail closed", async t => {
  const f = await fixture(t), operationId = randomUUID();
  await assert.rejects(legacySkillMaintenance(f.storage, { ...actor, canWrite: false },
    { tool: "skill_feedback", arguments: feedback }), /read-only/);
  const result = await f.call("skill_feedback", feedback, { operationId });
  assert.deepEqual(await f.call("skill_feedback", feedback, { operationId }), result);
  await assert.rejects(f.call("skill_feedback", { ...feedback, outcome: "failure" }, { operationId }), /replay arguments/);
  await assert.rejects(legacySkillMaintenance(f.storage, { ...actor, id: "other" },
    { tool: "skill_feedback", arguments: feedback }, { operationId }), /replay arguments/);
  await writeFile(join(f.data, "_feedback/skill-usage.jsonl"), "{}\n");
  assert.throws(f.inspect, /differs/);
  await assert.rejects(f.call("skill_feedback", feedback), /differs/);
});

test("complete committed advisory receipts recover after a fresh process restart without replaying planner or collector", async t => {
  const f = await fixture(t);
  const rename = fs.renameSync, operationId = randomUUID();
  try {
    fs.renameSync = (...args) => {
      if (String(args[1]).endsWith("_feedback/skill-usage.jsonl")) throw Error("Injected artifact publication failure.");
      return rename(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(f.call("skill_feedback", feedback, { operationId }), /receipt committed/);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const database = f.storage.connectNative();
  let receipt;
  try { receipt = database.prepare("SELECT * FROM legacy_skill_maintenance_receipts").get(); } finally { database.close(); }
  await writeFile(join(f.data, `_feedback/.pkm-write-${operationId}`), receipt.raw.slice(0, 15));
  await f.storage.close();
  const script = join(f.parent, "restart.mjs");
  await writeFile(script, `
import {Storage} from ${JSON.stringify(join(root, "dist/storage.js"))};
import {verifyLegacySkillMaintenance} from ${JSON.stringify(join(root, "dist/legacy-skill-maintenance.js"))};
const s=await Storage.open(process.argv[2]);
const d=s.connectNative();
try{console.log(JSON.stringify(verifyLegacySkillMaintenance(d,process.argv[2])));}
finally{d.close();await s.close();}
`);
  const value = JSON.parse(execFileSync(process.execPath, [script, f.data], { encoding: "utf8" }));
  assert.equal(value.receiptCount, 1);
  assert.equal(JSON.parse(await readFile(join(f.data, "_feedback/skill-usage.jsonl"), "utf8")).id, JSON.parse(receipt.result_json).feedback_id);
  assert.equal(fs.existsSync(join(f.data, `_feedback/.pkm-write-${operationId}`)), false);
});

test("external Skill edits and native journal commit failures publish no advisory artifact or receipt", async t => {
  const f = await fixture(t);
  const spawn = childProcess.spawn;
  try {
    childProcess.spawn = (...args) => {
      const child = spawn(...args);
      if (args[1].some(value => String(value).endsWith("legacy-knowledge-mcp.py")))
        child.once("close", () => fs.writeFileSync(join(f.data, "skills/Evidence.md"), skill + "External source edit.\n"));
      return child;
    };
    syncBuiltinESMExports();
    await assert.rejects(f.call("propose_skill_update", { skill_id: "Evidence Skill", base_hash: "", reason: "Source race" }), /source changed/);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.equal(f.inspect().receiptCount, 0);
  assert.equal(fs.existsSync(join(f.data, "_proposals")), false);
  const connect = f.storage.connectNative.bind(f.storage);
  try {
    f.storage.connectNative = () => {
      const db = connect(), exec = db.exec.bind(db);
      db.exec = sql => {
        if (sql === "COMMIT") throw Error("Injected journal commit failure.");
        return exec(sql);
      };
      return db;
    };
    await assert.rejects(f.call("skill_feedback", feedback), /journal commit failure/);
  } finally { f.storage.connectNative = connect; }
  assert.equal(f.inspect().receiptCount, 0);
  assert.equal(fs.existsSync(join(f.data, "_feedback")), false);
});

for (const tamper of ["completed-delete", "unknown-temp", "schema-trigger"])
test(`acknowledged advisory artifacts cannot be silently reconstructed or blessed (${tamper})`, async t => {
  const f = await fixture(t);
  await f.call("skill_feedback", feedback);
  if (tamper === "completed-delete") await rm(join(f.data, "_feedback/skill-usage.jsonl"));
  if (tamper === "unknown-temp") await writeFile(join(f.data, `_feedback/.pkm-write-${randomUUID()}`), "");
  if (tamper === "schema-trigger") {
    const database = f.storage.connectNative();
    try { database.exec("DROP TRIGGER legacy_skill_maintenance_projections_no_update"); } finally { database.close(); }
  }
  assert.throws(f.inspect, /differs|Unreceipted|immutability/);
  await assert.rejects(f.call("skill_feedback", feedback), /differs|Unreceipted|immutability/);
});
