import { createHash, randomUUID } from "node:crypto";
import { syncPlanHash } from "../dist/sync-plan.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const content = Buffer.from("# Offline Apply\r\nPreserve original bytes.\r\n");
const file = {
  path: "notes/offline-apply.md", type: "notes", itemId: "offline-apply", member: "",
  category: "", privacy: "public", digest: sha(content), contentBase64: content.toString("base64"),
};
const manifest = files => ({
  schema: 3,
  capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
  files, deletions: [],
});
const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
const empty = manifest([]);

export const syncApplyFixtureInput = {
  base: snapshot(empty),
  local: snapshot(empty),
  remote: snapshot(manifest([file])),
};
export const syncApplyFixtureCreate = {
  sessionId: "44444444-4444-4444-8444-444444444444",
  operationId: "55555555-5555-4555-8555-555555555555",
  actorId: "fixture-owner",
  input: syncApplyFixtureInput,
};
export const syncApplyFixtureBytes = content;
export const syncApplyFixtureIdentity = {
  sessionId: syncApplyFixtureCreate.sessionId,
  actorId: syncApplyFixtureCreate.actorId,
  input: syncApplyFixtureInput,
};
export const syncApplyFixtureExpectedPlan = {
  schema: "pkm.sync-apply-plan/v1",
  sessionId: "44444444-4444-4444-8444-444444444444",
  revision: 1,
  actorId: "fixture-owner",
  sourcePins: {
    base: "726cb1a5001083aad343c6cc199a7bb4b9bffbd11746d01caa3dc3028a7088ba",
    local: "726cb1a5001083aad343c6cc199a7bb4b9bffbd11746d01caa3dc3028a7088ba",
    remote: "3659c1c859279589859ac41d5021fffb01d4b917f68cd2da473706d9e837a972",
  },
  sessionHash: "6f56d28acfb2f23abe0c3217912882e02a721c5fb3e6982068f513809e901e7d",
  decisions: [],
  guards: [{ path: "notes/offline-apply.md", sha256: null }],
  actions: [{
    path: "notes/offline-apply.md", type: "notes", itemId: "offline-apply", member: "", privacy: "public",
    beforeSha256: null, afterSha256: "4e00fa81174f4c812505a39c1efa375861beda39dedcc54c92114cdb247e07db",
    contentBase64: "IyBPZmZsaW5lIEFwcGx5DQpQcmVzZXJ2ZSBvcmlnaW5hbCBieXRlcy4NCg==",
  }],
  tombstones: [],
  planHash: "47c472f931ec68c3e97c73814423e158be5707942ae9d456c8f61b9bcb0b8c06",
};

export function newSyncApplyConflictFixture() {
  const contents = ["base\n", "local\r\n", "remote\n"].map(value => Buffer.from(value));
  const toFile = bytes => ({
    path: "notes/conflict.md", type: "notes", itemId: "conflict", member: "",
    category: "", privacy: "public", digest: sha(bytes), contentBase64: bytes.toString("base64"),
  });
  const side = bytes => snapshot(manifest([toFile(bytes)]));
  const input = { base: side(contents[0]), local: side(contents[1]), remote: side(contents[2]) };
  return { input, contents, create: { sessionId: randomUUID(), operationId: randomUUID(), actorId: "fixture-owner", input } };
}
