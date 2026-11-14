import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionApplyHost } from "../dist/subscription-apply.js";
import { SubscriptionTransportHost } from "../dist/subscription-transport.js";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const originalMarkdown = "---\r\ndocumentId: source-original\r\naliases: [note:historic/path]\r\n---\r\n# Source\r\n\r\n![asset](A.assets/image.bin)\r\n";
function durable(path, value) {
  const fd = openSync(`${path}.pending`, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.pending`, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
export async function subscriptionTransportFixture(t, settings = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), `subscription-transport-work-${randomUUID()}`);
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "subscriptions"));
  mkdirSync(join(root, "transport-staging"));
  mkdirSync(join(root, "fixture-global-journal"));
  writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2" }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const nodeId = hash(publicKey);
  const asset = Buffer.from([0, 255, 13, 10]);
  const snapshot = JSON.stringify(settings.bundle ?? {
    notes: [{ slug: "Team/A", content: originalMarkdown }],
    assets: [{ type: "notes", path: "Team/A.assets/image.bin", data: asset.toString("base64"), digest: `sha256:${hash(asset)}` }],
  });
  const source = { subscriptionId: "fixture-sub", nodeId, shareId: "fixture-share", capabilityId: "fixture-local-copy",
    brokerName: "Fixture broker", publisherUser: "fixture-user", publisherHost: "fixture-host", revision: 1, collectionHash: `sha256:${hash(snapshot)}` };
  const native = structuredClone(subscriptionReadSourceFiles);
  Object.assign(native["subscriptions.json"].subscriptions[0], source, { id: "fixture-sub", publicKey });
  for (const [name, value] of Object.entries(native)) writeFileSync(join(root, "subscriptions", name), JSON.stringify(value));
  const counts = { summary: 0, ticket: 0, bundle: 0, requests: [] };
  let allowed = true, nativeRevision = "fixture-native-revision", mode = settings.mode ?? "normal";
  const proofs = [];
  const proof = "fixture_signed_subscriber_proof";
  const data = createServer((req, res) => {
    counts.bundle++;
    counts.requests.push({ method: req.method, path: req.url, range: req.headers.range });
    assertRequest(req.method === "GET" && req.url === "/sync/bundle" && req.headers.authorization === "Bearer fixture_ticket_0123456789");
    if (mode === "data-403") { res.writeHead(403); res.end(JSON.stringify({ error: "Access denied by Broker ACL." })); return; }
    const body = mode === "digest-bad" ? snapshot.replace("Source", "Mutate") : snapshot;
    res.writeHead(200, { "Content-Type": mode === "archive" ? "application/zip" : "application/json", "Content-Length": Buffer.byteLength(body) });
    if (mode === "partial") {
      res.write(body.slice(0, 24));
      setImmediate(() => res.destroy());
    } else {
      res.write(body.slice(0, 24));
      setImmediate(() => {
        if (mode === "revoke") allowed = false;
        if (mode === "native-change") nativeRevision = "changed";
        if (mode === "abort") settings.controller.abort();
        if (mode === "expire") settings.clock.value += 120_000;
        res.end(body.slice(24));
      });
    }
  });
  const dataPort = await listen(data);
  const control = createServer((req, res) => {
    counts.requests.push({ method: req.method, path: req.url, conditional: req.headers["if-none-match"] });
    proofs.push(req.headers["x-pkm-subscriber-proof"]);
    assertRequest(req.headers["x-pkm-subscriber-proof"] === proof);
    if (mode === "redirect") { res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }); res.end(); return; }
    if (mode === "summary-403") { res.writeHead(403); res.end(JSON.stringify({ error: "Access denied by Broker ACL." })); return; }
    if (mode === "remote-revoke" && counts.bundle > 0) { res.writeHead(403); res.end(JSON.stringify({ error: "Access denied by Broker ACL." })); return; }
    if (mode === "summary-304") { res.writeHead(304); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/v1/shares/fixture-share/summary") {
      counts.summary++;
      const unsigned = { shareId: source.shareId, name: source.brokerName, revision: mode === "version-change" ? 2 : 1,
        collectionHash: source.collectionHash, updatedAt: "2026-11-07T00:00:00.000Z", counts: { notes: 1 },
        topics: [], tags: [], itemCount: 1, metadataOnly: true, secretProtected: mode === "protected", snapshotBytes: Buffer.byteLength(snapshot) };
      res.end(JSON.stringify({ ...unsigned, signature: mode === "signature-bad" ? "AAAA" : sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64url") }));
    } else if (req.method === "POST" && req.url === "/v1/shares/fixture-share/sync-ticket") {
      counts.ticket++;
      res.end(JSON.stringify({
        brokerUrl: mode === "grant-ssrf" ? "http://169.254.169.254:80" : `http://127.0.0.1:${dataPort}`,
        ticket: "fixture_ticket_0123456789", expiresAt: new Date(Date.now() + (mode === "ticket-expired" ? -1 : 60_000)).toISOString(),
        revision: mode === "ticket-change" ? 2 : 1, collectionHash: source.collectionHash,
      }));
    } else { res.writeHead(404); res.end(); }
  });
  const controlPort = await listen(control);
  t.after(async () => {
    data.closeAllConnections(); control.closeAllConnections();
    await Promise.all([data, control].map(server => new Promise(resolve => server.close(resolve))));
  });
  const journalDir = join(root, "fixture-global-journal");
  const applyJournal = {
    async runExclusive(work) {
      return work({
        async load(id) {
          const path = join(journalDir, `${id}.apply-intent`);
          return existsSync(path) ? { intent: readFileSync(path, "utf8"),
            receipt: existsSync(`${path}.receipt`) ? JSON.parse(readFileSync(`${path}.receipt`, "utf8")) : null } : undefined;
        },
        async persistIntent(id, intent) { const path = join(journalDir, `${id}.apply-intent`); assertRequest(!existsSync(path)); durable(path, intent); },
        async commit(id, receipt) { durable(join(journalDir, `${id}.apply-intent.receipt`), JSON.stringify(receipt)); },
      });
    },
  };
  const store = {
    async runExclusive(id, work) {
      return work({
        async load() { const path = join(journalDir, `${id}.transport`); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; },
        async create(state) { const path = join(journalDir, `${id}.transport`); assertRequest(!existsSync(path)); durable(path, JSON.stringify(state)); },
        async compareAndSwap(revision, state) {
          const path = join(journalDir, `${id}.transport`);
          if (JSON.parse(readFileSync(path, "utf8")).revision !== revision) return false;
          durable(path, JSON.stringify(state)); return true;
        },
      });
    },
  };
  const authority = { actorId: "fixture:reader", sourceIp: "192.0.2.10", subscriptionId: source.subscriptionId, capabilityId: source.capabilityId };
  const makeApplyHost = () => new SubscriptionApplyHost(root, applyJournal, authority, async () => allowed);
  const endpoint = { bindingId: "fixture-host-endpoint", controlUrl: `http://127.0.0.1:${controlPort}`,
    connectAddress: "127.0.0.1", transferPorts: [dataPort], secretRef: "fixture:secret-reference", publisherPublicKey: publicKey };
  const makeHost = (overrides = {}) => new SubscriptionTransportHost({
    endpoint, stagingRoot: join(root, "transport-staging"), store, applyHost: makeApplyHost(),
    secrets: { async resolve(ref, share) { assertRequest(ref === endpoint.secretRef && share === source.shareId); return { subscriberProof: proof }; } },
    async authorize(s) {
      if (!allowed || JSON.stringify(s) !== JSON.stringify(source)) throw Object.assign(new Error("Native source ACL denied"), { code: "ACCESS_DENIED" });
      return nativeRevision;
    }, ...overrides,
  });
  const request = { operationId: randomUUID(), source, area: "notes", paths: ["Team/A.md"], mode: "fork", expiresAt: new Date(Date.now() + 110_000).toISOString() };
  return { root, source, snapshot, asset, request, endpoint, store, counts, proofs, makeHost, makeApplyHost,
    setMode(value) { mode = value; }, revoke() { allowed = false; },
    state() { return JSON.parse(readFileSync(join(journalDir, `${request.operationId}.transport`), "utf8")); } };
}
function assertRequest(condition) { if (!condition) throw new Error("Fixture protocol assertion failed."); }
