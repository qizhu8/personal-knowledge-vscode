// Entirely synthetic original-format captures, suitable for HTTP/MCP integration.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const snapshotId = "agent_snapshot_fixture";
export const magicCode = "PKM-SNAP-AAAA-BBBB-CCCC-DDDD";
export function snapshotFixture() {
  return {
    schema: "pkm.agent.snapshot/v1", snapshotId, magicCode,
    sourceSessionId: "agent_session_fixture", sourceHostSessionId: "chat-fixture",
    sourceHostKind: "pkm", task: "Validate a synthetic capture", projectId: "",
    agent: { name: "Fixture Agent", product: "PKM" }, reason: "manual",
    createdAt: "2026-01-01T00:00:00Z",
    payload: {
      session: {
        schema: "pkm.agent.session/v1", sessionId: "agent_session_fixture",
        origin: "pkm-native", hostKind: "pkm", task: "Validate a synthetic capture",
        status: "paused", summary: "Ready to validate", projectId: "",
        todos: [{ todoId: "todo_fixture", title: "Run fixture tests", status: "pending",
          recipeRunId: "recipe_run_fixture" }],
        checkpoints: [{
          checkpointId: "checkpoint_fixture", sequence: 1, createdAt: "2026-01-01T00:00:00Z",
          reason: "manual", state: { summary: "Use only synthetic data", next_actions: ["run tests"] },
        }],
        nativeChat: { messages: [
          { role: "user", status: "complete", content: "Validate this fixture." },
          { role: "assistant", status: "complete", content: "I will run synthetic tests." },
        ] },
      },
      recipeRuns: [{
        runId: "recipe_run_fixture", recipeId: "recipe_fixture", recipeName: "Fixture recipe",
        status: "running", nodes: { validate: { state: "pending" } },
      }],
    },
  };
}
export const workspaceMarker = { schema: "pkm.next-workspace/v2", id: "synthetic-fixture" };
export const fixtureRequests = {
  list: { operation: "agent.snapshot.list", args: {}, actorId: "synthetic-trusted-reader" },
  get: { operation: "agent.snapshot.get", args: { snapshotId }, actorId: "synthetic-trusted-reader" },
  read: { operation: "agent.snapshot.read", args: { magic_code: magicCode, recent_messages: 1 }, actorId: "synthetic-trusted-reader" },
};
export async function installAgentSnapshotReadTransportFixtures(root) {
  const marker = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8"));
  if (marker.schema !== workspaceMarker.schema) throw new Error("Initialize an isolated synthetic workspace first.");
  const directory = join(root, "agent-snapshot-reads/.pkm/state/agent-snapshots");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${snapshotId}.json`), JSON.stringify(snapshotFixture()), { flag: "wx" });
}
const hash = value => createHash("sha256").update(value).digest("hex");
const fixture = snapshotFixture();
const summary = {
  snapshotId, name: fixture.task, magicCode, sourceSessionId: fixture.sourceSessionId,
  sourceHostSessionId: fixture.sourceHostSessionId, sourceHostKind: "pkm", task: fixture.task,
  projectId: "", agent: fixture.agent, reason: "manual", createdAt: fixture.createdAt,
  recipeRunCount: 1, todoCount: 1,
  checkpoint: {
    checkpointId: "checkpoint_fixture", sequence: 1, createdAt: fixture.createdAt, reason: "manual",
  },
  recoveryCount: 0,
};
const common = {
  ok: true,
  snapshotRevision: hash(JSON.stringify([[`snapshot/${snapshotId}.json`, hash(JSON.stringify(fixture))]])),
  adapters: {
    encryptedPayload: "unavailable", networkRecovery: "unavailable",
    vscode: "unavailable", restore: "unavailable",
  },
};
export const fixtureResults = {
  list: { ...common, snapshots: [summary], total: 1, nextOffset: null },
  get: { ...common, snapshot: summary },
  read: {
    ...common, read_only: true, snapshot: summary, source: "pkm-chat", task: fixture.task,
    status: "paused", summary: "Ready to validate", project_id: "",
    todos: [{
      todoId: "todo_fixture", title: "Run fixture tests", status: "pending",
      recipeRunIds: ["recipe_run_fixture"],
    }],
    checkpoints: [{ checkpointId: "checkpoint_fixture", sequence: 1, createdAt: fixture.createdAt, reason: "manual" }],
    latest_checkpoint_state: { summary: "Use only synthetic data", next_actions: ["run tests"] },
    note: "Read-only view; no Agent Session was created. Agent Sessions belong to PKM Chat: to continue "
      + "inside PKM, recover this Snapshot into a new PKM Chat from the Agent Snapshots panel. Any agent "
      + "may continue the work in its own context from this state.",
    recipe_runs: [{
      runId: "recipe_run_fixture", recipeId: "recipe_fixture", recipeName: "Fixture recipe",
      status: "running", nodes: { validate: "pending" },
    }],
    conversation: {
      message_count: 2,
      recent_messages: [{ role: "assistant", status: "complete", content: "I will run synthetic tests." }],
    },
  },
};
