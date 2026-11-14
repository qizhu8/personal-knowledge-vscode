import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const require = createRequire(import.meta.url);
const original = require("../legacy/dist/sync/github-sync.js");
const load = name => import(pathToFileURL(resolve("next-server/dist", `${name}.js`)));
const { Storage } = await load("storage");
const { SyncNativeGitProvider } = await load("sync-native-git-provider");
const { openExperimentalLegacySyncHost } = await load("legacy-github-sync-experimental-host");
const storage = await Storage.open(config.root, { deferRecovery: true });
const nativeGit = new SyncNativeGitProvider({
  policy: config.policy, repository: config.target.repository, gitDir: config.cache,
  authentication: config.target.authentication, legacyGitArguments: original.githubSyncGitArguments,
  legacySshCommand: original.githubSyncSshCommand, inheritLegacyEnvironment: true,
  path: `${config.bin}:${process.env.PATH}`, home: config.home,
}, async () => {});
const host = await openExperimentalLegacySyncHost({
  mode: "isolated-experiment", storage, globalStorage: config.profile, targetId: config.target.id,
  actorId: "fixture-actor", experimentalNativeTrash: true,
  experimentalFaultInjector(point) {
    if (point === config.fault) process.kill(process.pid, "SIGKILL");
  },
  transport: {
    policy: config.policy, nativeGit, fetch: async () => { throw new Error("No external network"); },
    authorizeMember() {}, validateDomainContent() {}, verifyStagedPublication() {},
    async approvePublication() { return true; }, async withExpectedCommitCAS() { throw new Error("REST CAS not used"); },
  },
  publisherPolicy: { policyId: config.policy.policyId, enforcement: "atomic-git-lease" },
  readSecret: async () => { throw new Error("Unexpected secret request"); },
});
try {
  await host.sync();
  throw new Error("Requested crash boundary was not reached.");
} finally {
  await host.close();
  await storage.close();
}
