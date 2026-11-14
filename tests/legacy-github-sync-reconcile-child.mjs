import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";

const [root, directory, bare, policyJson, actor, operationId] = process.argv.slice(2);
const provider = localGitSyncProvider(directory, bare, JSON.parse(policyJson));
const storage = await Storage.open(root, { deferRecovery: true });
let runtime;
try {
  runtime = await createNativeRuntime({ storage, remote: {
    authorize: async id => id === actor,
    sync: provider.host,
    publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
  } });
  const result = await runtime.services.remote.reconcile(actor, operationId);
  console.log(JSON.stringify({ result, pushes: provider.pushes }));
} finally {
  await runtime?.close();
  await storage.close();
}
