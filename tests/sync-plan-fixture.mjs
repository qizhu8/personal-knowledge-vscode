import { createHash } from "node:crypto";
import { syncPlanHash } from "../dist/sync-plan.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const file = content => ({
  path: "notes/example.md", type: "notes", itemId: "example", member: "", category: "", privacy: "public",
  digest: digest(content), contentBase64: Buffer.from(content).toString("base64"),
});
const manifest = files => ({
  schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
  files, deletions: [],
});
const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
const empty = manifest([]);
const local = manifest([file("hello")]);
export const syncPlanFixtureInput = { base: snapshot(empty), local: snapshot(local), remote: snapshot(empty) };
export const syncPlanFixtureResult = {
  schema: "pkm.sync-plan/v1",
  pins: { base: syncPlanFixtureInput.base.sha256, local: syncPlanFixtureInput.local.sha256, remote: syncPlanFixtureInput.remote.sha256 },
  proposals: [{ type: "notes", itemId: "example", source: "local", state: { kind: "live", files: local.files } }],
  conflicts: [], deletionHistory: [],
};
export const syncPlanConflictFixtureInput = {
  base: snapshot(manifest([file("base")])), local: snapshot(manifest([file("local")])), remote: snapshot(manifest([file("remote")])),
};
export const syncPlanCreateFixture = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  actorId: "fixture-actor", input: syncPlanConflictFixtureInput,
};
export function syncPlanDecisionFixture(conflictId) {
  return {
    sessionId: syncPlanCreateFixture.sessionId, operationId: "33333333-3333-4333-8333-333333333333",
    actorId: "fixture-actor", expectedRevision: 1, conflictId, choice: "remote", reason: "Reviewed the remote variant",
  };
}
