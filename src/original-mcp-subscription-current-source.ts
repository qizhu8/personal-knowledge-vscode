import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import type { OriginalMcpNativeHostPolicy } from "./original-mcp-native-host.js";
import { originalMcpRequestDigest } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { originalMcpNativeIdentity } from "./original-mcp-native-identity.js";
import { originalMcpProfileBinding } from "./original-mcp-profile-binding.js";
import { originalSubscriptionProfileMethod, originalSubscriptionProfileResult, verifyCurrentSubscriptionManifest,
  currentSubscriptionManifest, type CurrentSubscriptionManifest } from "./original-mcp-subscription-profile-contracts.js";
import { captureCurrentSubscriptionManifest, readCurrentSubscriptionFile, originalCurrentSubscriptionDirectory } from "./original-mcp-subscription-profile-files.js";
import type { RefreshView } from "./legacy-subscription-refresh.js";
import { verifyOriginalCurrentSubscriptionCorpus } from "./original-mcp-subscription-current-corpus.js";

const operation = "native.subscription.original-profile.admit", actor = "native:subscription-original-profile";
const storedSchema = z.strictObject({
  schema: z.literal("pkm.original-native-subscription-profile-admission/v1"), manifest: currentSubscriptionManifest,
  files: z.array(z.strictObject({ path: z.string().max(2048), bytes: z.string().max(3 * 1024 * 1024) })).max(128),
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const denied = (): never => { throw new CoreError("ACCESS_DENIED", "Current native Subscription profile authority is unavailable or changed."); };
const invalid = (): never => { throw new CoreError("IMPORT_RECEIPT_INVALID", "Current native Subscription profile receipt is invalid; preserve it for reconciliation."); };

/** Original custody and a signed current-profile source admission compose without pretending this Root was legacy-adopted. */
export function createOriginalMcpCurrentSubscriptionSource(storage: Storage, session: AuthenticatedOriginalMcpNativeSession):
  NonNullable<OriginalMcpNativeHostPolicy["subscriptionSource"]> {
  assertStorage(storage);
  assertAuthenticatedOriginalMcpNativeSession(session);
  let last: { manifest: CurrentSubscriptionManifest; expiresAtMs: number; nativePublicKey: string } | undefined;
  const current = () => {
    storage.assertWorkspaceLease();
    assertAuthenticatedOriginalMcpNativeSession(session);
    session.assertCurrent();
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
    if (!journal || journal.plan.planSha256 !== session.binding.planSha256
      || journal.plan.profileSha256 !== session.binding.profileSha256
      || storage.workspaceRoot() !== session.binding.root) return denied();
  };
  const local = (manifest: CurrentSubscriptionManifest, nativePublicKey: string) => captureCurrentSubscriptionManifest({
    profile: manifest.profile, root: session.binding.root, workspaceId: session.binding.workspaceId,
    profileSha256: session.binding.profileSha256, identitySha256: session.identitySha256,
    nativeEpoch: session.activationId, nativePublicKey,
  });
  return Object.freeze({
    async capture(binding, signal, expectedHead) {
      current();
      if (signal.aborted || binding.root !== storage.workspaceRoot() || binding.root !== session.binding.root
        || binding.workspaceId !== await storage.workspaceId() || binding.workspaceId !== session.binding.workspaceId
        || binding.profileSha256 !== session.binding.profileSha256 || binding.epoch !== session.activationId) return denied();
      const response = originalSubscriptionProfileResult.parse(await requestOriginalMcpNative(session,
        originalSubscriptionProfileMethod, { binding, expectedHead: expectedHead ?? null }, { signal }));
      current();
      const manifest = verifyCurrentSubscriptionManifest(response.manifest);
      const publicKey = createPublicKey(manifest.state.publicKey).export({ format: "der", type: "spki" }).toString("base64");
      if (originalMcpNativeIdentity(publicKey, binding.profileSha256).sha256 !== session.identitySha256
        || manifest.root !== binding.root || manifest.workspaceId !== binding.workspaceId
        || manifest.profileSha256 !== binding.profileSha256 || manifest.identitySha256 !== session.identitySha256
        || manifest.nativeEpoch !== binding.epoch || originalMcpProfileBinding(manifest.profile).sha256 !== binding.profileSha256
        || response.decision.sourceSha256 !== manifest.head || response.decision.expiresAtMs <= Date.now()
        || response.decision.expiresAtMs > Date.now() + 300000 || expectedHead && manifest.head !== expectedHead
        || local(manifest, publicKey).head !== manifest.head || signal.aborted) return denied();
      const captured = manifest.files.map(pin => {
        const bytes = readCurrentSubscriptionFile(manifest.profile, `${originalCurrentSubscriptionDirectory}/${pin.path}`, pin.size);
        if (!bytes || bytes.length !== pin.size || hash(bytes) !== pin.sha256) return denied();
        return { ...pin, bytes };
      });
      verifyOriginalCurrentSubscriptionCorpus(manifest, captured);
      if (local(manifest, publicKey).head !== manifest.head) return denied();
      const operationId = `native-original-subscription-profile:${binding.workspaceId}:${manifest.sourceEpoch}:${manifest.revision}:${manifest.head}`;
      const body = { schema: "pkm.original-native-subscription-profile-admission/v1" as const, manifest,
        files: captured.map(file => ({ path: file.path, bytes: file.bytes.toString("base64") })) };
      const db = storage.connectNative();
      try {
        db.exec("BEGIN IMMEDIATE");
        const admitted = db.prepare(`SELECT fingerprint,length(result) AS bytes,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.schema') END AS schema,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.manifest.workspaceId') END AS workspaceId,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.manifest.profileSha256') END AS profileSha256,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.manifest.sourceEpoch') END AS sourceEpoch,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.manifest.nativeEpoch') END AS nativeEpoch,
          CASE WHEN json_valid(result) THEN json_extract(result,'$.manifest.revision') END AS revision
          FROM receipts WHERE operation=? AND actor_id=? LIMIT 4097`).all(operation, actor);
        if (admitted.length > 4096 || admitted.some(row => row.schema !== body.schema
          || Number(row.bytes) > 16 * 1024 * 1024 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
          || !z.string().uuid().safeParse(row.workspaceId).success || !z.string().uuid().safeParse(row.sourceEpoch).success
          || !z.string().uuid().safeParse(row.nativeEpoch).success
          || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(row.profileSha256).success
          || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(row.fingerprint).success)) return invalid();
        const sameSource = admitted.filter(row => row.workspaceId === binding.workspaceId
          && row.profileSha256 === binding.profileSha256 && row.sourceEpoch === manifest.sourceEpoch);
        if (sameSource.some(row => Number(row.revision) > manifest.revision))
          throw new CoreError("REVISION_CONFLICT", "Current Subscription profile revision cannot replay an older admitted source.");
        const sameRevision = sameSource.filter(row => row.revision === manifest.revision && row.nativeEpoch === manifest.nativeEpoch);
        if (sameRevision.some(row => row.fingerprint !== manifest.head))
          throw new CoreError("REVISION_CONFLICT", "Changed Subscription sources require a new native profile revision.");
        const priorReceipt = db.prepare("SELECT fingerprint,actor_id,operation,length(result) AS bytes FROM receipts WHERE operation_id=?").get(operationId);
        if (priorReceipt && (priorReceipt.fingerprint !== manifest.head || priorReceipt.actor_id !== actor
          || priorReceipt.operation !== operation || Number(priorReceipt.bytes) > 16 * 1024 * 1024)) return invalid();
        if (!priorReceipt && admitted.length >= 4096) return invalid();
        if (!priorReceipt) db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
          .run(operationId, manifest.head, JSON.stringify(body), actor, operation, new Date().toISOString());
        const row = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(operationId);
        let stored: z.infer<typeof storedSchema>;
        try { stored = storedSchema.parse(JSON.parse(String(row!.result))); } catch { return invalid(); }
        if (originalMcpRequestDigest(stored.manifest) !== originalMcpRequestDigest(manifest)
          || stored.files.length !== manifest.files.length || new Set(stored.files.map(file => file.path)).size !== stored.files.length) return invalid();
        const bytes = new Map(stored.files.map(file => [file.path, Buffer.from(file.bytes, "base64")]));
        const files = manifest.files.map(pin => {
          const data = bytes.get(pin.path);
          if (!data || data.length !== pin.size || hash(data) !== pin.sha256) return invalid();
          return { ...pin, bytes: data };
        });
        current();
        if (signal.aborted || local(manifest, publicKey).head !== manifest.head || response.decision.expiresAtMs <= Date.now()) return denied();
        db.exec("COMMIT");
        last = { manifest, expiresAtMs: response.decision.expiresAtMs, nativePublicKey: publicKey };
        return { head: manifest.head, state: manifest.state, directories: [], files } satisfies RefreshView;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        if (error instanceof CoreError) throw error;
        return invalid();
      }
      finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
    },
    assertCurrent(binding, head) {
      current();
      if (!last || binding.epoch !== session.activationId || last.expiresAtMs <= Date.now() || last.manifest.head !== head
        || local(last.manifest, last.nativePublicKey).head !== head) return denied();
    },
  });
}
