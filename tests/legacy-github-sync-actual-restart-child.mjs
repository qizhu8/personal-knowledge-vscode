import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, profile, policyJson] = process.argv.slice(2);
const policy = JSON.parse(policyJson);
const dist = process.env.PKM_NEXT_TEST_DIST
  ? pathToFileURL(resolve(process.env.PKM_NEXT_TEST_DIST) + "/").href : new URL("../dist/", import.meta.url).href;
const { Storage } = await import(new URL("storage.js", dist));
const { openExperimentalLegacySyncHost } = await import(new URL("legacy-github-sync-experimental-host.js", dist));
const denied = () => { throw new Error("Restart inspection must not request credentials or network."); };
const storage = await Storage.open(root);
let host;
try {
  host = await openExperimentalLegacySyncHost({
    mode: "isolated-experiment", storage, globalStorage: profile, targetId: "fixture-target",
    actorId: "legacy-recovery-fixture", publisherPolicy: { policyId: policy.policyId, enforcement: "all-repository-ref-writers" },
    transport: { policy, fetch: denied, authorizeMember: denied, validateDomainContent: denied,
      verifyStagedPublication: denied, approvePublication: denied, withExpectedCommitCAS: denied },
    readSecret: denied,
  });
  console.log(JSON.stringify(await host.resume()));
} finally {
  await host?.close();
  await storage.close();
}
