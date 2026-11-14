import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { GitHubSyncTransport, syncTransportGitObjectSha } from "../dist/sync-transport.js";
import { initializeSyncTransportStore, SyncTransportStore } from "../dist/sync-transport-store.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import { manifestJson, MANIFEST_PATH, GITHUB_SYNC_EXTENSION_VERSION } from "../dist/domain/sync-transport-original.js";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const file = (bytes, extra = {}) => ({
  path: "notes/source.md", type: "notes", itemId: "source", member: "", category: "",
  privacy: "public", digest: digest(bytes), contentBase64: bytes.toString("base64"), ...extra,
});
export const manifest = files => ({
  schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"] },
  files, deletions: [],
});
export const policy = () => ({
  policyId: randomUUID(), owner: "approved-owner", repository: "approved-repository", branch: "approved/branch",
  secretRef: randomUUID(), expectedLogin: "approved-login", visibility: "public", allowPrivate: false,
  extensionVersion: GITHUB_SYNC_EXTENSION_VERSION, approvalId: randomUUID(),
});

// Independent Git tree fixture, using actual Git's byte ordering and object framing.
export function treeHash(entries) {
  const directories = new Map();
  for (const entry of entries) {
    let directory = directories;
    const parts = entry.path.split("/");
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part);
    }
    directory.set(parts.at(-1), entry);
  }
  const encode = directory => {
    const children = [...directory].map(([name, value]) => ({
      name, directory: value instanceof Map, mode: value instanceof Map ? "40000" : value.mode,
      sha: value instanceof Map ? encode(value) : value.sha,
    })).sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? "/" : "")), Buffer.from(b.name + (b.directory ? "/" : ""))));
    return syncTransportGitObjectSha("tree", Buffer.concat(children.map(child => Buffer.concat([
      Buffer.from(`${child.mode} ${child.name}\0`), Buffer.from(child.sha, "hex"),
    ]))));
  };
  return encode(directories);
}

export async function fixture(options = {}) {
  const configuration = { ...policy(), ...options.policy };
  const blobs = new Map(), trees = new Map(), commits = new Map(), requests = [], receipts = [];
  const baseBytes = Buffer.from("\uFEFFfirst\r\nsecond\n");
  const baseManifest = options.manifest ?? manifest([file(baseBytes)]);
  const addBlob = bytes => {
    const sha = syncTransportGitObjectSha("blob", bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const baseEntries = baseManifest.files.map(item => ({
    path: item.path, mode: "100644", type: "blob", sha: addBlob(Buffer.from(item.contentBase64, "base64")),
  }));
  const wire = manifestJson(baseManifest.files.map(({ contentBase64, ...item }) => item), baseManifest.deletions);
  baseEntries.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: addBlob(Buffer.from(wire)) });
  baseEntries.push({ path: "README.md", mode: "100644", type: "blob", sha: addBlob(Buffer.from("unmanaged\n")) });
  const baseTree = treeHash(baseEntries);
  trees.set(baseTree, baseEntries);
  const baseCommit = "a".repeat(40);
  const identity = { name: "Personal Knowledge Manager", email: "pkm@localhost", date: "2026-11-07T00:00:00.000Z" };
  commits.set(baseCommit, { sha: baseCommit, tree: { sha: baseTree }, parents: [], message: "baseline", author: identity, committer: identity });
  let ref = baseCommit;
  const db = new DatabaseSync(":memory:");
  initializeSyncTransportStore(db);
  const store = new SyncTransportStore(db, journal => {
    receipts.push(journal.status.state);
    options.receiptHook?.(journal);
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const route = request.url.slice(`/repos/${configuration.owner}/${configuration.repository}`.length);
    requests.push({ method: request.method, route, body });
    await options.onRequest?.({ method: request.method, route, body, requests });
    if (request.method !== "GET" && options.requireFixtureReceipt !== false && !receipts.length) {
      throw new Error("No durable intent before remote mutation");
    }
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    if (await options.intercept?.({ request, response, route, body, send, requests })) return;
    if (route === "") return send(200, { full_name: `${configuration.owner}/${configuration.repository}`, private: configuration.visibility === "private" });
    if (route.startsWith("/git/ref/heads/")) return send(200, { ref: `refs/heads/${configuration.branch}`, object: { type: "commit", sha: ref } });
    if (request.method === "GET" && route.startsWith("/git/commits/")) {
      const value = commits.get(route.slice("/git/commits/".length));
      return send(value ? 200 : 404, value ?? {});
    }
    if (request.method === "GET" && route.startsWith("/git/trees/")) {
      const sha = route.slice("/git/trees/".length).split("?")[0], value = trees.get(sha);
      return send(value ? 200 : 404, { sha, truncated: false, tree: value ?? [] });
    }
    if (request.method === "GET" && route.startsWith("/git/blobs/")) {
      const sha = route.slice("/git/blobs/".length), bytes = blobs.get(sha);
      return send(bytes ? 200 : 404, bytes ? { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64").match(/.{1,60}/g)?.join("\n") ?? "" } : {});
    }
    if (route === "/git/blobs") {
      const bytes = Buffer.from(body.content, "base64"), sha = addBlob(bytes);
      if (options.drop === "blob") return response.destroy();
      return send(201, { sha });
    }
    if (route === "/git/trees") {
      const entries = new Map(trees.get(body.base_tree).map(entry => [entry.path, entry]));
      for (const entry of body.tree) {
        if (entry.sha === null) entries.delete(entry.path);
        else entries.set(entry.path, entry);
      }
      const tree = [...entries.values()], sha = treeHash(tree);
      trees.set(sha, tree);
      if (options.drop === "tree") return response.destroy();
      return send(201, { sha });
    }
    if (route === "/git/commits") {
      const sha = digest(Buffer.from(JSON.stringify(body))).slice(0, 40);
      const value = { ...body, sha, tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) };
      commits.set(sha, value);
      if (options.drop === "commit") return response.destroy();
      return send(201, value);
    }
    if (route.startsWith("/git/refs/heads/")) {
      ref = body.sha;
      if (options.drop === "ref") return response.destroy();
      return send(200, { ref: `refs/heads/${configuration.branch}`, object: { type: "commit", sha: ref } });
    }
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const host = {
    policy: configuration,
    fetch: (url, init) => {
      if (!url.startsWith(`https://api.github.com/repos/${configuration.owner}/${configuration.repository}`)) throw new Error("Unexpected native origin");
      return fetch(origin + new URL(url).pathname + new URL(url).search, init);
    },
    readSecret: async () => ({ login: configuration.expectedLogin, accessToken: "local-fixture-token" }),
    authorizeMember: () => {},
    validateDomainContent: () => {},
    verifyStagedPublication: () => {},
    approvePublication: async () => true,
    withExpectedCommitCAS: async (_policy, expected, update) => {
      options.beforeCAS?.();
      if (ref !== expected) throw new Error("native CAS denied");
      return update();
    },
    ...options.host,
  };
  const transport = new GitHubSyncTransport(host, store, options.transport);
  return {
    db, store, transport, host, requests, receipts, blobs, trees, commits, baseManifest, baseBytes, baseCommit, baseTree, configuration,
    get ref() { return ref; }, set ref(value) { ref = value; },
    async pin() { return transport.readPin(); },
    async plan(extra = {}) {
      const pin = await transport.readPin();
      const next = manifest([file(Buffer.from("\uFEFFfirst\r\nremote edit\n"))]);
      const unsigned = {
        schema: "pkm.sync-transport-publication/v1", operationId: randomUUID(), policyId: configuration.policyId,
        actorId: "native-actor", sessionId: randomUUID(), revision: 1, sessionHash: "b".repeat(64),
        sourcePins: { base: pin.manifestHash, local: syncPlanHash(next), remote: pin.manifestHash },
        expectedCommit: pin.commit, expectedTree: pin.tree, manifest: next, manifestHash: syncPlanHash(next),
        stagedReceiptId: randomUUID(), message: "PKM sync 2026-11-07T05:59:20.314Z", ...extra,
      };
      return { ...unsigned, planHash: syncPlanHash(unsigned) };
    },
    async close() {
      db.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
