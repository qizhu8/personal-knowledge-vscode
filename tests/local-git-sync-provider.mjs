import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { legacyVscodeSyncCredentialReader } from "../dist/legacy-github-sync-credentials.js";

/** Test-only GitHub protocol adapter backed by real private local Git repositories. */
export function localGitSyncProvider(directory, bare, savedPolicy) {
  const gitDir = join(directory, "provider.git");
  const index = join(directory, "provider-index");
  const environment = {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  };
  const git = (args, input, extra = {}) => {
    const result = spawnSync("git", ["--git-dir", gitDir, "-c", "core.hooksPath=/dev/null", ...args], {
      env: { ...environment, ...extra }, input, encoding: null, maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Private Git fixture command failed: ${args[0]}`);
    return result.stdout;
  };
  if (!existsSync(gitDir)) {
    const init = spawnSync("git", ["init", "--bare", "-q", gitDir], { env: environment });
    assert.equal(init.status, 0);
    git(["remote", "add", "origin", bare]);
  }
  const configuration = savedPolicy ?? {
    policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
    extensionVersion: "4.0.22", approvalId: randomUUID(),
  };
  let expectedCommit;
  let dropNextPushResponse = false;
  let pushCount = 0;
  const readSecret = legacyVscodeSyncCredentialReader({
    targetId: "fixture-target", expectedLogin: "fixture", secretRef: configuration.secretRef,
    async readSecret(key) {
      assert.equal(key, "personalKnowledge.githubSync.vscode.fixture-target");
      return JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" });
    },
  });
  const text = (args, input, extra) => git(args, input, extra).toString("utf8").trim();
  const fetchRef = () => {
    git(["fetch", "--no-tags", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    return text(["rev-parse", "refs/remotes/origin/main"]);
  };
  const response = (status, data) => new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
  const commit = sha => {
    const [tree, parents, name, email, date, committer, committerEmail, committerDate, ...message] =
      git(["show", "-s", "--format=%T%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B", sha]).toString("utf8").split("\n");
    return { sha, tree: { sha: tree }, parents: parents ? parents.split(" ").map(sha => ({ sha })) : [],
      message: message.join("\n").trimEnd(),
      author: { name, email, date }, committer: { name: committer, email: committerEmail, date: committerDate } };
  };
  const host = {
    policy: configuration, readSecret,
    authorizeMember() {}, validateDomainContent() {}, verifyStagedPublication() {},
    async approvePublication() { return true; },
    async withExpectedCommitCAS(_policy, expected, update) {
      if (expectedCommit !== undefined) throw new Error("Overlapping fixture CAS.");
      expectedCommit = expected;
      try { return await update(); } finally { expectedCommit = undefined; }
    },
    async fetch(url, init) {
      if (new Headers(init.headers).get("authorization") !== "Bearer fixture-token")
        throw new Error("Synthetic fixture credential was not supplied.");
      const parsed = new URL(url);
      if (parsed.origin !== "https://api.github.com" || !parsed.pathname.startsWith("/repos/fixture/fixture"))
        throw new Error("Unexpected fixture URL.");
      const route = parsed.pathname.slice("/repos/fixture/fixture".length);
      const method = init.method;
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (route === "") return response(200, { full_name: "fixture/fixture", private: false });
      if (route === "/git/ref/heads/main") return response(200, { ref: "refs/heads/main", object: { type: "commit", sha: fetchRef() } });
      if (method === "GET" && route.startsWith("/git/commits/")) return response(200, commit(route.slice(13)));
      if (method === "GET" && route.startsWith("/git/blobs/")) {
        const sha = route.slice(11), bytes = git(["cat-file", "blob", sha]);
        return response(200, { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
      }
      if (method === "GET" && route.startsWith("/git/trees/")) {
        const sha = route.slice(11);
        const entries = git(["ls-tree", "-r", "-t", "-z", sha]).toString("utf8").split("\0").filter(Boolean).map(line => {
          const match = /^(\d+) (blob|tree) ([a-f0-9]{40})\t(.+)$/.exec(line);
          if (!match) throw new Error("Invalid private Git tree.");
          return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
        });
        return response(200, { sha, truncated: false, tree: entries });
      }
      if (method === "POST" && route === "/git/blobs") {
        return response(201, { sha: text(["hash-object", "-w", "--stdin"], Buffer.from(body.content, "base64")) });
      }
      if (method === "POST" && route === "/git/trees") {
        try {
          git(["read-tree", body.base_tree], undefined, { GIT_INDEX_FILE: index });
          for (const entry of body.tree) {
            if (entry.sha === null) git(["update-index", "--force-remove", "--", entry.path], undefined, { GIT_INDEX_FILE: index });
            else git(["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, entry.path], undefined, { GIT_INDEX_FILE: index });
          }
          return response(201, { sha: text(["write-tree"], undefined, { GIT_INDEX_FILE: index }) });
        } finally { rmSync(index, { force: true }); }
      }
      if (method === "POST" && route === "/git/commits") {
        const environment = {
          GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: body.author.date,
          GIT_COMMITTER_NAME: body.committer.name, GIT_COMMITTER_EMAIL: body.committer.email, GIT_COMMITTER_DATE: body.committer.date,
        };
        const sha = text(["commit-tree", body.tree, "-p", body.parents[0]], `${body.message}\n`, environment);
        return response(201, commit(sha));
      }
      if (method === "PATCH" && route === "/git/refs/heads/main") {
        if (!expectedCommit || body.force !== false) throw new Error("Fixture CAS missing.");
        git(["merge-base", "--is-ancestor", expectedCommit, body.sha]);
        try {
          git(["push", "--quiet", `--force-with-lease=refs/heads/main:${expectedCommit}`, "origin", `${body.sha}:refs/heads/main`]);
        } catch { return response(409, {}); }
        pushCount++;
        if (dropNextPushResponse) { dropNextPushResponse = false; throw new Error("Fixture response lost after push."); }
        return response(200, { ref: "refs/heads/main", object: { type: "commit", sha: body.sha } });
      }
      throw new Error(`Unsupported private Git fixture request: ${method} ${route}`);
    },
  };
  return {
    host,
    get pushes() { return pushCount; },
    loseNextPushResponse() { dropNextPushResponse = true; },
  };
}
