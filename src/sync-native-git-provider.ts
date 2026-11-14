import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { LegacyGitLease, type LegacyGitLeaseOptions } from "./legacy-github-git-lease.js";
import { syncTransportPolicySchema, type SyncTransportPolicy, type SyncTransportPublication } from "./sync-transport-contracts.js";
import type { SyncTransportStore } from "./sync-transport-store.js";
import { syncPlanHash } from "./sync-plan.js";

/** Git object operations for the existing verified Sync planner; never exposes a remote URL to callers. */
export class SyncNativeGitProvider {
  private lease?: LegacyGitLease;
  readonly options: LegacyGitLeaseOptions;

  constructor(options: LegacyGitLeaseOptions,
    private readonly repositoryAuthority: (policy: SyncTransportPolicy) => Promise<void>) {
    this.options = Object.freeze({ ...options, policy: Object.freeze(syncTransportPolicySchema.parse(options.policy)),
      authentication: Object.freeze({ ...options.authentication }),
      ...(options.credentialHelpers ? { credentialHelpers: Object.freeze([...options.credentialHelpers]) } : {}) });
  }

  bind(store: SyncTransportStore, verifyPublication: (publication: SyncTransportPublication, tree: string) => void,
    assertPublicationAuthority?: () => void): LegacyGitLease {
    if (this.lease) throw new Error("Git provider already bound.");
    this.lease = new LegacyGitLease({ ...this.options, verifyPublication, assertPublicationAuthority }, store);
    return this.lease;
  }

  async verifyRepository(policy: SyncTransportPolicy): Promise<void> {
    if (syncPlanHash(policy) !== syncPlanHash(this.options.policy)) throw new Error("Git policy changed.");
    await this.repositoryAuthority(policy);
  }

  private git(args: string[], input?: string | Buffer, extra: Record<string, string> = {}): Buffer {
    if (!this.lease) throw new Error("Git provider unavailable.");
    this.lease.assertObjectStore();
    const result = spawnSync("git", ["--git-dir", this.options.gitDir, "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", ...args], {
      env: { PATH: this.options.path, HOME: this.options.home, GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1", ...extra }, input, encoding: null, maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    });
    if (result.status !== 0 || !result.stdout) throw new Error("Git object operation failed.");
    return result.stdout;
  }

  private text(args: string[], input?: string | Buffer, extra?: Record<string, string>): string {
    return this.git(args, input, extra).toString("utf8").trim();
  }

  private commit(sha: string) {
    const [tree, parents, name, email, date, committer, committerEmail, committerDate, ...message] =
      this.git(["show", "-s", "--format=%T%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B", sha]).toString("utf8").split("\n");
    return { sha, tree: { sha: tree }, parents: parents ? parents.split(" ").map(value => ({ sha: value })) : [],
      message: message.join("\n").trimEnd(), author: { name, email, date },
      committer: { name: committer, email: committerEmail, date: committerDate } };
  }

  async request(method: "GET" | "POST" | "PATCH", route: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.lease || signal?.aborted) throw new Error("Git provider unavailable.");
    const branch = this.options.policy.branch.split("/").map(encodeURIComponent).join("/");
    if (method === "GET" && route === `/git/ref/heads/${branch}`)
      return { ref: `refs/heads/${this.options.policy.branch}`, object: { type: "commit", sha: await this.lease.fetch(signal) } };
    if (method === "GET" && /^\/git\/commits\/[a-f0-9]{40}$/.test(route)) return this.commit(route.slice(13));
    if (method === "GET" && /^\/git\/blobs\/[a-f0-9]{40}$/.test(route)) {
      const sha = route.slice(11), bytes = this.git(["cat-file", "blob", sha]);
      return { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
    }
    if (method === "GET" && /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(route)) {
      const sha = route.slice(11, 51);
      const tree = this.git(["ls-tree", "-r", "-t", "-z", sha]).toString("utf8").split("\0").filter(Boolean).map(line => {
        const match = /^(\d+) (blob|tree) ([a-f0-9]{40})\t(.+)$/.exec(line);
        if (!match) throw new Error("Git tree unsupported.");
        return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
      });
      return { sha, truncated: false, tree };
    }
    if (method === "POST" && route === "/git/blobs") {
      const value = body as { content: string; encoding: string };
      if (value.encoding !== "base64") throw new Error("Git blob encoding denied.");
      return { sha: this.text(["hash-object", "-w", "--stdin"], Buffer.from(value.content, "base64")) };
    }
    if (method === "POST" && route === "/git/trees") {
      const value = body as { base_tree: string; tree: Array<{ path: string; mode: string; sha: string | null }> };
      const index = join(this.options.gitDir, `pkm-index-${randomUUID()}`);
      try {
        const env = { GIT_INDEX_FILE: index };
        this.git(["read-tree", value.base_tree], undefined, env);
        for (const entry of value.tree) {
          if (entry.sha === null) this.git(["update-index", "-z", "--index-info"],
            `0 0000000000000000000000000000000000000000\t${entry.path}\0`, env);
          else this.git(["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, entry.path], undefined, env);
        }
        return { sha: this.text(["write-tree"], undefined, env) };
      } finally { rmSync(index, { force: true }); }
    }
    if (method === "POST" && route === "/git/commits") {
      const value = body as { tree: string; parents: string[]; message: string;
        author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } };
      const env = { GIT_AUTHOR_NAME: value.author.name, GIT_AUTHOR_EMAIL: value.author.email, GIT_AUTHOR_DATE: value.author.date,
        GIT_COMMITTER_NAME: value.committer.name, GIT_COMMITTER_EMAIL: value.committer.email, GIT_COMMITTER_DATE: value.committer.date };
      return this.commit(this.text(["commit-tree", value.tree, "-p", value.parents[0]], `${value.message}\n`, env));
    }
    throw new Error("Git object operation denied.");
  }
}
