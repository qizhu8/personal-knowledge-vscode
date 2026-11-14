import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { SyncNativeGitProvider } from "./sync-native-git-provider.js";
import type { GitLeaseAuthentication } from "./legacy-github-git-lease.js";
import type { SyncTransportNativeHost } from "./sync-transport.js";
import type { SyncTransportPolicy } from "./sync-transport-contracts.js";

/** Network-isolated installed fixture only; the actual objects and CAS use native Git. */
export function privateNativeGitUiProvider(fixture: string, profile: string, policy: SyncTransportPolicy) {
  const gitDir = join(fixture, "provider", "provider.git"), home = join(fixture, "h"), bin = join(fixture, "bin");
  const bare = join(fixture, "remote.git"), countFile = join(fixture, "git-pushes"), drop = join(fixture, "git-drop");
  const syncDir = join(profile, "github-sync"), syncStat = lstatSync(syncDir);
  if (!syncStat.isDirectory() || syncStat.isSymbolicLink() || realpathSync(syncDir) !== syncDir
    || syncStat.uid !== process.getuid?.() || (syncStat.mode & 0o077) !== 0)
    throw new Error("Private Git target directory denied.");
  const configPath = join(syncDir, "targets.json"), configStat = lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1
    || configStat.uid !== process.getuid?.() || (configStat.mode & 0o077) !== 0 || configStat.size > 8 * 1024 * 1024)
    throw new Error("Private Git target denied.");
  const fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: { targets?: Array<{ id?: string; repository: string; authentication: GitLeaseAuthentication }> };
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== configStat.dev || opened.ino !== configStat.ino || opened.size !== configStat.size
      || opened.mtimeMs !== configStat.mtimeMs || opened.ctimeMs !== configStat.ctimeMs)
      throw new Error("Private Git target changed.");
    config = JSON.parse(readFileSync(fd, "utf8"));
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw new Error("Private Git target changed.");
  } finally { closeSync(fd); }
  const target = config.targets?.find((value: { id?: string }) => value.id === "fixture-target");
  const authentication = target?.authentication as GitLeaseAuthentication | undefined;
  if (!target || !authentication || authentication.expectedLogin !== "fixture" || !["ssh", "https"].includes(authentication.method))
    throw new Error("Private Git authentication denied.");
  for (const dir of [home, bin, bare]) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || (info.mode & 0o077) !== 0 || realpathSync(dir) !== dir) throw new Error("Private Git directory denied.");
  }
  if (authentication.method === "ssh" && authentication.identityFile !== join(fixture, "identity"))
    throw new Error("Private SSH identity denied.");
  const path = `${bin}:${process.env.PATH || ""}`;
  const environment = { ...process.env, PATH: path, HOME: home, GIT_TERMINAL_PROMPT: "0" };
  if (authentication.method === "https") {
    const result = spawnSync("git", ["config", "--global", "--get-all", "credential.helper"], { env: environment, encoding: "utf8" });
    const credentialHelpers = result.status === 0 ? result.stdout.trimEnd().split("\n") : [];
    if (credentialHelpers.length !== 1 || credentialHelpers[0] !== join(bin, "credential-helper"))
      throw new Error("Private credential helper denied.");
  }
  if (!existsSync(gitDir)) {
    const init = spawnSync("git", ["init", "--bare", "-q", gitDir], { env: environment });
    if (init.status !== 0) throw new Error("Private Git initialization failed.");
    chmodSync(gitDir, 0o700);
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
    chmodSync(join(gitDir, "config"), 0o600);
  }
  const localRequire = createRequire(import.meta.url);
  const moduleCandidates = [
    resolve(new URL("../legacy/dist/sync/github-sync.js", import.meta.url).pathname),
    resolve(new URL("../legacy/dist/sync/github-sync.js", import.meta.url).pathname),
  ];
  const moduleFile = moduleCandidates.find(existsSync);
  if (!moduleFile) throw new Error("Retained Git implementation unavailable.");
  const original = localRequire(moduleFile) as {
    githubSyncGitArguments: (args: string[], target: { authentication: GitLeaseAuthentication }) => string[];
    githubSyncSshCommand: (identityFile: string) => string;
  };
  const nativeGit = new SyncNativeGitProvider({ policy, repository: target.repository, gitDir, authentication,
    legacyGitArguments: original.githubSyncGitArguments, legacySshCommand: original.githubSyncSshCommand,
    inheritLegacyEnvironment: true, path, home }, async () => {
    const info = lstatSync(bare);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || (info.mode & 0o077) !== 0 || realpathSync(bare) !== bare) throw new Error("Private Git authority changed.");
  });
  const host: Omit<SyncTransportNativeHost, "readSecret"> = {
    policy, nativeGit, fetch: async () => { throw new Error("Private Git requires no GitHub REST call."); },
    authorizeMember() {}, validateDomainContent() {}, verifyStagedPublication() {},
    async approvePublication() { return true; },
    async withExpectedCommitCAS() { throw new Error("REST CAS is not used by native Git."); },
  };
  const count = () => existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter(Boolean).length : 0;
  const start = count();
  return { host, get pushes() { return count() - start; }, loseNextPushResponse() { writeFileSync(drop, "drop\n", { mode: 0o600 }); } };
}
