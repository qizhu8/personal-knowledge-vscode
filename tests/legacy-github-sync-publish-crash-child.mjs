import assert from "node:assert/strict";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";

const [root, directory, bare, policyJson, actor, operationId, sessionId, stagedReceiptId] = process.argv.slice(2);
const provider = localGitSyncProvider(directory, bare, JSON.parse(policyJson));
const storage = await Storage.open(root);
const runtime = await createNativeRuntime({ storage, remote: {
  authorize: async id => id === actor,
  sync: provider.host,
  publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
} });
provider.loseNextPushResponse();
await assert.rejects(runtime.services.remote.publish(actor, { operationId, sessionId, stagedReceiptId }), /transport network/);
assert.equal((await runtime.services.remote.status(actor, operationId)).result.state, "ref-pending");
assert.equal(provider.pushes, 1);
process.exit(77);
