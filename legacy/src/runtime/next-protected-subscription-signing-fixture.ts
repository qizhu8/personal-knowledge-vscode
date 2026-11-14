import { createHash, createHmac, createPrivateKey, createPublicKey, scryptSync, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SharedMarketManager, parseShareMagicLink, verifyShareSummary } from "../subscriptions/subscriptions";

type StatePlan = {
  schema: string; sourceRoot: string; subscriptionRoot?: string; planSha256: string;
  protectedSubscriptions?: { snapshots: Array<{ name: string; sha256: string; status: string }> };
  entries: Array<{ source: string; destination: string; sourceSha256?: string; sha256: string; projection?: string }>;
};

function deny(): never { throw new Error("Private Subscription signing denied."); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function bytes(file: string, limit: number): Buffer {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)
    || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o7077) !== 0) deny();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const data = fs.readFileSync(fd), opened = fs.fstatSync(fd, { bigint: true }), after = fs.lstatSync(file, { bigint: true });
    const same = (s: typeof before) => s.dev === before.dev && s.ino === before.ino && s.size === before.size
      && s.mode === before.mode && s.uid === before.uid && s.nlink === 1n && s.mtimeNs === before.mtimeNs && s.ctimeNs === before.ctimeNs;
    if (!same(opened) || !same(after) || BigInt(data.length) !== before.size) { data.fill(0); deny(); }
    return data;
  } finally { fs.closeSync(fd); }
}

/** Fixture-only use of the original host's fixed-format signing operations; never returns a key. */
export function signProtectedSubscriptionFixture(fixture: string, nonce: string, shareId: string, secret: string, plan: StatePlan,
  options: { mutableSubscriberState?: boolean; expectedSubscriptions?: any[];
    pending?: { action: "add" | "remove"; publisherNodeId: string; shareId: string; subscriptionId: string | null } } = {}) {
  const profile = path.join(fixture, "profile"), root = path.join(fixture, "original");
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== fixture
    || process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING !== "1" || path.resolve(fixture) !== fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(path.basename(fixture))
    || !/^[a-f0-9-]{36}$/.test(nonce) || !/^[A-Za-z0-9_-]{1,128}$/.test(shareId)) deny();
  for (const dir of [fixture, root, profile, path.join(fixture, "imported")]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir
      || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) deny();
  }
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(bytes(path.join(fixture, "subscription-state-fixture.json"), 4096).toString("utf8")); }
  catch { return deny(); }
  const rootStat = fs.lstatSync(root, { bigint: true }), profileStat = fs.lstatSync(profile, { bigint: true });
  if (!marker || typeof marker !== "object" || Array.isArray(marker)
    || Object.keys(marker).sort().join(",") !== "nonce,profilePin,rootPin,schema"
    || marker.schema !== "pkm.protected-subscription-state-fixture/v1" || marker.nonce !== nonce
    || marker.rootPin !== `${rootStat.dev}:${rootStat.ino}` || marker.profilePin !== `${profileStat.dev}:${profileStat.ino}`) deny();
  if (!plan || plan.schema !== "pkm.legacy-state-import/v1" || plan.sourceRoot !== root || plan.subscriptionRoot !== profile
    || !plan.protectedSubscriptions || !Array.isArray(plan.entries)) deny();
  const { planSha256, ...body } = plan;
  if (hash(JSON.stringify(body)) !== planSha256) deny();
  const matches = plan.entries.filter(e => e.projection === "protected-subscription");
  if (matches.length !== 1 || matches[0].source !== path.join(profile, "subscriptions.json")
    || matches[0].destination !== "subscriptions/subscriptions.json") deny();
  const original = bytes(matches[0].source, 2 * 1024 * 1024);
  let base: Buffer | undefined, verifier: Buffer | undefined;
  try {
    if (!options.mutableSubscriberState && hash(original) !== matches[0].sourceSha256) deny();
    const projected = bytes(path.join(fixture, "imported", matches[0].destination), 2 * 1024 * 1024);
    if (hash(projected) !== matches[0].sha256) deny();
    const state = JSON.parse(original.toString("utf8"));
    const publicState = JSON.parse(projected.toString("utf8"));
    if (state.schema !== 1 || state.enabled !== false || state.gatewayPid !== undefined
      || typeof state.privateKey !== "string" || typeof state.publicKey !== "string"
      || hash(state.publicKey) !== state.nodeId || publicState.nodeId !== state.nodeId || publicState.publicKey !== state.publicKey
      || createPrivateKey(state.privateKey).asymmetricKeyType !== "ed25519"
      || createPublicKey(state.privateKey).export({ type: "spki", format: "pem" }).toString() !== state.publicKey
      || !Array.isArray(state.shares) || !Array.isArray(publicState.shares)) deny();
    if (options.mutableSubscriberState) {
      const expectedSubscriptions = options.expectedSubscriptions ?? publicState.subscriptions;
      if (process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1" || !Array.isArray(state.subscriptions)
        || !Array.isArray(expectedSubscriptions)) deny();
      const fields = ["id", "nodeId", "shareId", "publicKey", "magicLink", "endpoint", "secretProtected", "secretSalt", "publisherUser", "publisherHost"];
      const pending = options.pending;
      const target = (record: { nodeId?: string; shareId?: string }) =>
        pending && record.nodeId === pending.publisherNodeId && record.shareId === pending.shareId;
      for (const originalRecord of expectedSubscriptions) {
        const found = state.subscriptions.filter((record: { id?: string }) => record.id === originalRecord.id);
        if (pending?.action === "remove" && target(originalRecord) && found.length === 0) continue;
        if (found.length !== 1 || !["new", "current", "offline", "error"].includes(found[0].status)
          || fields.some(field => found[0][field] !== originalRecord[field])) deny();
      }
      const extras = state.subscriptions.filter((record: { id?: string }) =>
        !expectedSubscriptions.some((item: { id?: string }) => item.id === record.id));
      if (extras.length && (!pending || pending.action !== "add" || extras.length !== 1 || !target(extras[0]))) deny();
      if (pending?.action === "remove" && expectedSubscriptions.filter((record: { id?: string; nodeId?: string; shareId?: string }) =>
        target(record) && record.id === pending.subscriptionId).length !== 1) deny();
      for (const record of state.subscriptions) {
        if (!["new", "current", "offline", "error"].includes(record.status)) deny();
        const link = parseShareMagicLink(record.magicLink);
        if (link.nodeId !== record.nodeId || link.shareId !== record.shareId || link.publicKey !== record.publicKey
          || link.publisherUser !== record.publisherUser || link.publisherHost !== record.publisherHost
          || !!link.secretProtected !== !!record.secretProtected) deny();
        const endpoint = new URL(record.endpoint);
        const owner = publicState.shares.filter((share: { shareId?: string }) => share.shareId === record.shareId);
        const remote = record.nodeId !== state.nodeId && process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE === "1";
        if ((!remote && (owner.length !== 1 || ![23001, 23002].includes(owner[0].controlPort)
          || endpoint.origin !== `http://127.0.0.1:${owner[0].controlPort}`))
          || (remote && !["http://127.0.0.1:23001", "http://127.0.0.1:23002"].includes(endpoint.origin))
          || endpoint.username || endpoint.password
          || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) deny();
      }
    }
    const shares = state.shares.filter((s: { shareId?: string }) => s.shareId === shareId);
    const published = publicState.shares.filter((s: { shareId?: string }) => s.shareId === shareId);
    if (shares.length !== 1 || published.length !== 1) deny();
    const share = shares[0], { authVerifier, snapshotPath, ...publicShare } = share;
    if (share.protection !== "secret-protected" || JSON.stringify(publicShare) !== JSON.stringify(published[0])
      || typeof share.secretSalt !== "string" || typeof authVerifier !== "string" || !Number.isSafeInteger(share.revision)) deny();
    const name = `${shareId}-${share.revision}.json`;
    const snapshot = plan.protectedSubscriptions.snapshots.filter(s => s.name === name && s.status === "authenticated-current");
    if (snapshot.length !== 1 || snapshotPath !== path.join(profile, "snapshots", name)) deny();
    const wire = bytes(path.join(fixture, "imported/subscriptions/snapshots", name), 16 * 1024 * 1024);
    if (hash(wire) !== snapshot[0].sha256) deny();
    base = scryptSync(secret, Buffer.from(share.secretSalt, "base64url"), 32);
    verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
    const expected = Buffer.from(authVerifier, "base64url");
    if (expected.length !== verifier.length || !timingSafeEqual(expected, verifier)) deny();
    verifyShareSummary(share.summary, state.publicKey, state.nodeId, shareId);
    const manager = Object.create(SharedMarketManager.prototype) as SharedMarketManager;
    Object.assign(manager, { state, publisherUser: "fixture", publisherHost: "fixture" });
    const magicLink = manager.magicLink(shareId);
    const parsed = parseShareMagicLink(magicLink);
    if (parsed.nodeId !== state.nodeId || parsed.shareId !== shareId) deny();
    const proof = (manager as unknown as { subscriberProof(id: string): string }).subscriberProof(shareId);
    return { magicLink, proof, nodeId: state.nodeId };
  } catch { return deny(); }
  finally { original.fill(0); base?.fill(0); verifier?.fill(0); }
}
