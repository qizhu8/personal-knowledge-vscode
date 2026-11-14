import assert from "node:assert/strict";
import { Storage } from "../dist/storage.js";
import { openExperimentalLegacySyncHost } from "../dist/legacy-github-sync-experimental-host.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";

const [root, globalStorage, directory, bare, policyJson] = process.argv.slice(2);
const provider = localGitSyncProvider(directory, bare, JSON.parse(policyJson));
const storage = await Storage.open(root);
const host = await openExperimentalLegacySyncHost({
  mode: "isolated-experiment", storage, globalStorage, targetId: "fixture-target", actorId: "fixture-actor",
  transport: provider.host, publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
  readSecret: async () => JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }),
});
provider.loseNextPushResponse();
await assert.rejects(host.sync(), /transport network/);
assert.equal(host.status().phase, "publishing");
assert.equal(provider.pushes, 1);
process.exit(77);
