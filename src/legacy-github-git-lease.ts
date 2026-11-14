import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, fstatSync, openSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { syncPlanHash } from "./sync-plan.js";
import { syncTransportPolicySchema, syncTransportShaSchema, type SyncTransportPolicy, type SyncTransportPublication } from "./sync-transport-contracts.js";
import { SyncTransportStore, type SyncTransportJournal } from "./sync-transport-store.js";

export type GitLeaseAuthentication = { method: "ssh"; expectedLogin: string; identityFile: string }
  | { method: "https"; expectedLogin: string };
type LegacyGitArguments = (args: string[], target: { authentication: GitLeaseAuthentication }) => string[];
function isBoundGitHubRepository(repository: string, method: GitLeaseAuthentication["method"],
  owner: string, name: string): boolean {
  const match = method === "ssh"
    ? /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/i.exec(repository)
    : /^https:\/\/github\.com(?::443)?\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/i.exec(repository);
  if (!match) return false;
  const actual = match[2].toLowerCase(), expected = name.toLowerCase();
  return match[1].toLowerCase() === owner.toLowerCase()
    && (actual === expected || actual === `${expected}.git`);
}
export type LegacyGitLeaseOptions = {
  policy: SyncTransportPolicy; repository: string; gitDir: string; authentication: GitLeaseAuthentication;
  legacyGitArguments: LegacyGitArguments; legacySshCommand(identityFile: string): string;
  credentialHelpers?: readonly string[];
  /** The isolated native host explicitly elects the same trusted environment used by legacy Git. */
  inheritLegacyEnvironment?: true;
  path: string; home: string;
};

/** Experimental primitive only; not registered with any runtime or UI. */
export class LegacyGitLease {
  private readonly policy: SyncTransportPolicy;
  private readonly env: NodeJS.ProcessEnv;
  private readonly target: { authentication: GitLeaseAuthentication };
  private readonly gitDir: string;
  private readonly repository: string;
  private readonly argumentsForGit: LegacyGitArguments;
  private readonly sshArguments?: string[];
  private readonly verifyPublication: (publication: SyncTransportPublication, tree: string) => void;
  private readonly storeIdentity: string;
  private readonly configIdentity: string;
  private readonly identityPin?: { path: string; identity: string };

  constructor(options: LegacyGitLeaseOptions & {
    /** Must verify the staged native receipt and exact planned tree before any push. */
    verifyPublication(publication: SyncTransportPublication, tree: string): void;
    assertPublicationAuthority?(): void;
  }, private readonly store: SyncTransportStore) {
    this.policy = syncTransportPolicySchema.parse(options.policy);
    this.target = { authentication: Object.freeze({ ...options.authentication }) };
    if (options.authentication.expectedLogin.toLowerCase() !== this.policy.expectedLogin.toLowerCase()
      || !/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(options.authentication.expectedLogin)
      || this.policy.allowPrivate && this.policy.visibility !== "private") throw new Error("Git lease binding denied.");
    if (!isBoundGitHubRepository(options.repository, options.authentication.method, this.policy.owner, this.policy.repository))
      throw new Error("Git lease endpoint denied.");
    this.repository = options.repository;
    if (resolve(options.gitDir) !== options.gitDir || realpathSync(options.gitDir) !== options.gitDir
      || resolve(options.home) !== options.home || realpathSync(options.home) !== options.home)
      throw new Error("Git lease paths denied.");
    const directory = lstatSync(options.gitDir), config = join(options.gitDir, "config"), configStat = lstatSync(config);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
      || (directory.mode & 0o077) !== 0 || !configStat.isFile() || configStat.isSymbolicLink()
      || configStat.nlink !== 1 || configStat.uid !== process.getuid?.() || (configStat.mode & 0o077) !== 0)
      throw new Error("Git lease object store denied.");
    const fd = openSync(config, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try { bytes = readFileSync(fd); } finally { closeSync(fd); }
    if (bytes.toString("utf8") !== "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n")
      throw new Error("Git lease object store configuration denied.");
    this.gitDir = options.gitDir;
    this.storeIdentity = `${directory.dev}:${directory.ino}`;
    this.configIdentity = `${configStat.dev}:${configStat.ino}`;
    this.assertObjectStore();
    this.argumentsForGit = options.legacyGitArguments;
    if (typeof options.verifyPublication !== "function") throw new Error("Git lease publication verifier required.");
    this.verifyPublication = options.verifyPublication;
    this.assertPublicationAuthority = options.assertPublicationAuthority;
    this.env = { ...(options.inheritLegacyEnvironment ? process.env : {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    }), PATH: options.path, HOME: options.home, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
    const helpers = options.credentialHelpers ?? [];
    if (helpers.length > 16 || helpers.some(value => value.length > 4096 || !/^[A-Za-z0-9._/-]+$/.test(value))
      || options.authentication.method === "ssh" && helpers.length
      || options.inheritLegacyEnvironment && options.credentialHelpers) throw new Error("Git credential helper binding denied.");
    if (!options.inheritLegacyEnvironment) {
      this.env.GIT_CONFIG_COUNT = String(helpers.length);
      helpers.forEach((value, i) => { this.env[`GIT_CONFIG_KEY_${i}`] = "credential.helper"; this.env[`GIT_CONFIG_VALUE_${i}`] = value; });
    }
    if (options.authentication.method === "ssh") {
      const identity = options.authentication.identityFile;
      if (resolve(identity) !== identity || realpathSync(identity) !== identity) throw new Error("SSH identity denied.");
      const stat = lstatSync(identity);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new Error("SSH identity denied.");
      this.identityPin = { path: identity, identity: `${stat.dev}:${stat.ino}` };
      this.sshArguments = ["-T", ...options.inheritLegacyEnvironment ? [] : ["-F", "/dev/null", "-o", "StrictHostKeyChecking=yes"],
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "-i", identity, "git@github.com"];
      this.env.GIT_SSH_COMMAND = options.legacySshCommand(identity)
        + (options.inheritLegacyEnvironment ? "" : " -F /dev/null -o StrictHostKeyChecking=yes");
      this.env.GIT_SSH_VARIANT = "ssh";
    }
  }

  private readonly assertPublicationAuthority?: () => void;

  assertObjectStore(): void {
    const directory = lstatSync(this.gitDir), config = join(this.gitDir, "config"), stat = lstatSync(config);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
      || (directory.mode & 0o077) !== 0 || `${directory.dev}:${directory.ino}` !== this.storeIdentity
      || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o077) !== 0 || `${stat.dev}:${stat.ino}` !== this.configIdentity)
      throw new Error("Git lease object store changed.");
    const fd = openSync(config, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (`${current.dev}:${current.ino}` !== this.configIdentity
        || readFileSync(fd, "utf8") !== "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n")
        throw new Error("Git lease object store changed.");
    } finally { closeSync(fd); }
    for (const relative of ["objects/info/alternates", "objects/info/http-alternates", "info/grafts", "shallow"]) {
      try { lstatSync(join(this.gitDir, relative)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new Error("Git lease object store has unsupported indirection.");
    }
  }

  private execute(program: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
    return new Promise((done, reject) => {
      if (signal?.aborted) return reject(new Error("Git lease operation canceled; outcome may require review."));
      const child = execFile(program, args, { env: this.env, encoding: "utf8", timeout: 30000,
        maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true }, (error, stdout) => {
        if (error) return reject(new Error("Git lease operation failed; outcome may require review."));
        done(stdout);
      });
      child.stdin?.on("error", () => {});
      if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
    });
  }

  private git(args: string[], signal?: AbortSignal, input?: string): Promise<string> {
    this.assertObjectStore();
    return this.execute("git", ["--git-dir", this.gitDir, "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false", "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
      "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "protocol.https.allow=always",
      ...this.argumentsForGit(args, this.target)], signal, input);
  }

  /** Verifies SSH account identity without interpreting any remote output as executable code. */
  async verifySshAccount(signal?: AbortSignal): Promise<void> {
    this.assertObjectStore();
    if (!this.sshArguments) throw new Error("SSH authentication is not configured.");
    const pin = this.identityPin!, identity = lstatSync(pin.path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== process.getuid?.()
      || identity.nlink !== 1 || (identity.mode & 0o077) !== 0 || `${identity.dev}:${identity.ino}` !== pin.identity
      || realpathSync(pin.path) !== pin.path) throw new Error("SSH identity changed.");
    // GitHub normally exits nonzero after its successful authentication greeting.
    const output = await new Promise<string>((done, reject) => {
      if (signal?.aborted) return reject(new Error("SSH authentication canceled."));
      execFile("ssh", this.sshArguments!, { env: this.env, encoding: "utf8", timeout: 15000, signal,
        maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => {
        if (signal?.aborted || error && !("code" in error && typeof error.code === "number"))
          return reject(new Error("SSH authentication failed."));
        done(`${stdout}\n${stderr}`);
      });
    });
    const match = /Hi\s+([^!\s]+)!\s+You've successfully authenticated/i.exec(output);
    if (!match || match[1].toLowerCase() !== this.policy.expectedLogin.toLowerCase())
      throw new Error("SSH account identity differs.");
  }

  /** Retrieves only the existing helper's credential for the exact trusted GitHub host. */
  async verifyHttpsHelper(signal?: AbortSignal): Promise<void> {
    if (this.target.authentication.method !== "https") throw new Error("HTTPS helper is not configured.");
    const output = await this.git(["credential", "fill"], signal,
      `protocol=https\nhost=github.com\nusername=${this.policy.expectedLogin}\n\n`);
    const fields = new Map(output.split(/\r?\n/).filter(Boolean).map(line => {
      const position = line.indexOf("=");
      return position < 0 ? ["", ""] : [line.slice(0, position), line.slice(position + 1)];
    }));
    if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com"
      || fields.get("username")?.toLowerCase() !== this.policy.expectedLogin.toLowerCase()
      || !fields.get("password")) throw new Error("Git credential helper account differs.");
  }

  private async verifyEffectiveEndpoint(signal?: AbortSignal): Promise<void> {
    const effective = (await this.git(["ls-remote", "--get-url", this.repository], signal)).trim();
    if (effective !== this.repository) throw new Error("Git lease effective endpoint differs.");
  }

  /** Reads the configured branch through Git; callers must retain the returned immutable commit. */
  async fetch(signal?: AbortSignal): Promise<string> {
    await this.verifyEffectiveEndpoint(signal);
    if (this.sshArguments) await this.verifySshAccount(signal);
    const ref = `refs/pkm-fetch/${randomUUID()}`;
    try {
      await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", this.repository,
        `+refs/heads/${this.policy.branch}:${ref}`], signal);
      return syncTransportShaSchema.parse((await this.git(["rev-parse", ref], signal)).trim());
    } finally {
      await this.git(["update-ref", "-d", ref]).catch(() => {});
    }
  }

  private async verifyCommit(journal: SyncTransportJournal, signal?: AbortSignal): Promise<string> {
    const commit = syncTransportShaSchema.parse(journal.status.commit), tree = syncTransportShaSchema.parse(journal.status.tree);
    const { planHash, ...unsigned } = journal.publication;
    if (syncPlanHash(unsigned) !== planHash || syncPlanHash(journal.publication.manifest) !== journal.publication.manifestHash
      || (await this.git(["rev-parse", `${journal.publication.expectedCommit}^{tree}`], signal)).trim() !== journal.publication.expectedTree)
      throw new Error("Git lease publication does not match the durable intent.");
    const raw = (await this.git(["show", "-s", "--format=%T%x00%P%x00%B%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct", commit], signal)).trimEnd().split("\0");
    const date = Math.floor(Date.parse(journal.publication.message.slice("PKM sync ".length)) / 1000);
    if (raw.length !== 9 || raw[0] !== tree || raw[1] !== journal.publication.expectedCommit
      || raw[2] !== `${journal.publication.message}\n`
      || raw[3] !== "Personal Knowledge Manager" || raw[4] !== "pkm@localhost" || Number(raw[5]) !== date
      || raw[6] !== "Personal Knowledge Manager" || raw[7] !== "pkm@localhost" || Number(raw[8]) !== date)
      throw new Error("Git lease commit does not match the durable publication.");
    try { this.verifyPublication(journal.publication, tree); }
    catch { throw new Error("Git lease publication verification denied."); }
    return commit;
  }

  /** Called once for a durably prepared commit; unknown push outcomes are never replayed. */
  async push(operationId: string, actorId: string, signal?: AbortSignal) {
    let journal = this.store.read(operationId, actorId);
    if (!journal || journal.publication.policyId !== this.policy.policyId) throw new Error("Git lease intent denied.");
    if (journal.status.state !== "commit-created") return journal.status;
    const commit = await this.verifyCommit(journal, signal);
    await this.verifyEffectiveEndpoint(signal);
    journal = this.store.transition(journal, "ref-pending", { pending: {
      method: "PATCH", path: `/git/refs/heads/${this.policy.branch}`, body: { sha: commit, force: false }, expectedSha: commit,
    } });
    if (this.sshArguments) await this.verifySshAccount(signal);
    this.assertPublicationAuthority?.();
    await this.git(["push", "--quiet", `--force-with-lease=refs/heads/${this.policy.branch}:${journal.publication.expectedCommit}`,
      this.repository, `${commit}:refs/heads/${this.policy.branch}`], signal);
    if (await this.fetch(signal) !== commit) throw new Error("Git lease outcome requires review.");
    return this.store.transition(journal, "published", { pending: undefined }).status;
  }

  /** Reconciliation only reads the remote ref; it never repeats the push. */
  async reconcile(operationId: string, actorId: string, signal?: AbortSignal) {
    const journal = this.store.read(operationId, actorId);
    if (!journal || journal.publication.policyId !== this.policy.policyId) throw new Error("Git lease intent denied.");
    if (journal.status.state !== "ref-pending") return journal.status;
    const commit = await this.verifyCommit(journal, signal);
    const remote = await this.fetch(signal);
    return this.store.transition(journal, remote === commit ? "published" : "needs-review",
      { pending: undefined }).status;
  }
}
