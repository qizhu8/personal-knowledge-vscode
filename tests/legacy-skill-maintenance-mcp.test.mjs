import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { originalSkillMaintenance } from "./legacy-skill-maintenance-oracle.mjs";
const root = resolve(import.meta.dirname, "..");
const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const formal = "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000099\nrevision: 1\nname: Evidence Skill\n---\nFormal immutable evidence.\n";
const args = { task: "Do not retain this raw private task.", used_skills: ["Evidence Skill"], outcome: "success",
  observations: ["Reusable fact"], evidence: ["Synthetic proof"] };

for (const profile of ["compact", "legacy"])
test(`actual original Skill artifacts import, ${profile} MCP successors, read-only restart and relocated backup preserve genesis and formal Skill`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.skill-maintenance-mcp-${randomUUID()}`);
    const source = join(parent, "source"), target = join(parent, "target"), relocated = join(parent, "relocated");
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    await mkdir(join(source, "skills"), { recursive: true });
    await mkdir(join(source, "notes"));
    await writeFile(join(source, "skills/Evidence.md"), formal);
    const originalFeedback = originalSkillMaintenance({ root: source, tool: "skill_feedback", args,
      uuid: "10000000-0000-4000-8000-000000000001", now: "2001-02-03T04:05:06.123456" });
    const originalProposal = originalSkillMaintenance({ root: source, tool: "propose_skill_update",
      args: { skill_id: "Evidence Skill", base_hash: "", reason: "Original retained proposal", evidence: ["original proof"],
        proposed_content: "# Suggested only" },
      uuid: "20000000-0000-4000-8000-000000000002", now: "2001-02-03T04:05:07.123456" });
    const plan = await planLegacyImport(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    await importLegacyWorkspace(plan, target, { pythonExecutable: python });
    const managed = await legacyManagedFixture(parent);
    const connect = async (data, writable = true) => {
      client = new Client({ name: "original-skill-maintenance-test", version: "1" });
      await client.connect(new StdioClientTransport({ command: python,
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          ...(writable ? ["--allow-writes"] : []), "--managed-generation", managed],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PKM_CAPABILITY_PROFILE: profile }, stderr: "pipe" }));
    };
    const call = (name, arguments_) => client.callTool(profile === "legacy" ? { name, arguments: arguments_ }
      : { name: "capability_call", arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: arguments_ } });
    const invoke = async (name, arguments_) => {
      const result = await call(name, arguments_);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const close = async () => { await closeLegacyManagedFixture(client); client = undefined; };
    await connect(target);
    if (profile === "legacy") {
      const tools = (await client.listTools()).tools;
      for (const [name, contract] of Object.entries(originalFeedback.contracts)) {
        const tool = tools.find(tool => tool.name === name);
        assert.deepEqual(tool.inputSchema, contract.inputSchema);
        assert.equal(tool.annotations.readOnlyHint, false);
      }
    }
    const feedback = await invoke("skill_feedback", args);
    assert.equal(feedback.ok, true);
    const raw = await readFile(join(target, "_feedback/skill-usage.jsonl"), "utf8");
    assert(raw.startsWith(originalFeedback.artifacts["_feedback/skill-usage.jsonl"]));
    assert.equal(raw.trimEnd().split("\n").length, 2);
    assert.equal(JSON.parse(raw.trimEnd().split("\n")[1]).id, feedback.feedback_id);
    assert(!raw.includes(args.task));
    const proposal = await invoke("propose_skill_update", { skill_id: "Evidence Skill", base_hash: "stale-base",
      reason: "Keep formal knowledge reviewable", proposed_content: "# Proposed only", confidence: .75 });
    assert.equal(proposal.ok, true); assert.equal(proposal.conflict, true);
    const proposalRaw = await readFile(proposal.proposal_path, "utf8");
    assert.match(proposalRaw, /# Proposed only/);
    assert.equal(await readFile(join(target, "skills/Evidence.md"), "utf8"), formal);
    assert.equal((await invoke("propose_skill_update", { skill_id: "missing", base_hash: "", reason: "" })).error, "Skill not found");
    const spoof = await call("skill_feedback", { ...args, actor: "owner", operationId: randomUUID() });
    assert.equal(spoof.isError, true);
    await close();
    await connect(target, false);
    const denied = await call("skill_feedback", args);
    assert.equal(denied.isError, true);
    await close();
    const storage = await Storage.open(target);
    try { await createWorkspaceBackup(storage, join(parent, "backup"), {
      acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    }); } finally { await storage.close(); }
    await restoreWorkspaceBackup(join(parent, "backup"), relocated, { nativeRestoreAuthority, pythonExecutable: python });
    await connect(relocated);
    const next = await invoke("skill_feedback", { ...args, outcome: "partial" });
    assert.equal(next.ok, true);
    const restoredRaw = await readFile(join(relocated, "_feedback/skill-usage.jsonl"), "utf8");
    assert(restoredRaw.startsWith(raw)); assert.equal(restoredRaw.trimEnd().split("\n").length, 3);
    assert.equal(await readFile(join(relocated, "_proposals/skills", proposal.proposal_path.split("/").at(-1)), "utf8"), proposalRaw);
    assert.equal(await readFile(join(relocated, "skills/Evidence.md"), "utf8"), formal);
    await writeFile(join(relocated, "_feedback/skill-usage.jsonl"), originalFeedback.artifacts["_feedback/skill-usage.jsonl"]);
    assert.equal((await call("skill_feedback", args)).isError, true);
    await close();
    await assert.rejects(Storage.open(relocated), /artifact differs|receipt/);
    for (const [path, content] of Object.entries(originalProposal.artifacts))
      assert.equal(await readFile(join(source, path), "utf8"), content);
  });
