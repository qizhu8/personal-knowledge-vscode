import { extname } from "node:path";
import { CoreError } from "./contracts.js";
import { documentPath, type KnowledgeArea } from "./document-path.js";
import { sha256 } from "./file-write.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { knowledgeReadPrivateTopLevels } from "./fresh-note-query-contracts.js";
import { scanMarkdown } from "./markdown.js";
import { legacyAssetReferenceSources, privateLegacyAssetProof } from "./document-legacy-assets.js";
import {
  knowledgeMutationDefinitions, deserializeKnowledgeMutationPlan, serializeKnowledgeMutationPlan, assertKnowledgeMutationRequestPlan,
  type KnowledgeMutationRequest,
} from "./knowledge-mutations.js";
import { deserializeDocumentLifecyclePlan, serializeDocumentLifecyclePlan, documentLifecyclePrivatePublicationRequirements } from "./document-lifecycle.js";
import {
  privateResourcePublicationDigest as digest, validatePrivateResourcePublicationSubject,
  validatePrivateResourcePublicationProvenance, type PrivateResourcePublicationSubject,
} from "./private-resource-publication-contracts.js";
import {
  privatePublicationRecoveryProvenances, type PrivatePublicationMutation, type PrivateResourcePublicationRecovery,
} from "./private-resource-publication-native.js";

type OriginalRequest = { tool: string; arguments: Record<string, unknown> };
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function checkedCanonical(value: PrivatePublicationMutation): KnowledgeMutationRequest {
  const definition = knowledgeMutationDefinitions.find(item => item.id === value.operation);
  if (!definition || !value.operation.endsWith(".update")) fail("ACCESS_DENIED", "Private publication requires an existing canonical public owner update.");
  const args = definition.input.parse(value.args);
  return { operation: value.operation as KnowledgeMutationRequest["operation"], actorId: value.actorId, args };
}
function owner(storage: Storage, canonical: KnowledgeMutationRequest) {
  assertStorage(storage); storage.assertWorkspaceLease();
  const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root);
  if (!journal) fail("ACCESS_DENIED", "Private publication requires actual original-root custody.");
  const area: KnowledgeArea = canonical.operation === "knowledge.note.update" ? "notes" : canonical.operation === "knowledge.skill.update" ? "skills" : "papers";
  const records = scanMarkdown(root), record = records.find(value => value.record.area === area && value.record.id === canonical.args.id);
  if (!record || record.record.sha256 !== canonical.args.expectedSha256 || record.record.revision !== canonical.args.expectedRevision)
    fail("CONFLICT", "The stored public owner changed before private resource review.");
  const afterPath = typeof canonical.args.moveTo === "string" ? canonical.args.moveTo : record.record.path;
  if (!documentPath.safeParse(afterPath).success || afterPath.split("/").some(part => ["system", "_assets"].includes(part.toLowerCase()))
    || knowledgeReadPrivateTopLevels(root, area).has(afterPath.split("/")[0]!))
    fail("ACCESS_DENIED", "Private publication targets require an ordinary public owner destination.");
  const sources = legacyAssetReferenceSources(root, area, record.record.path, record.raw);
  if (typeof canonical.args.content === "string") {
    const submitted = legacyAssetReferenceSources(root, area, record.record.path, canonical.args.content);
    if (submitted.some(path => !sources.includes(path)))
      fail("UNSUPPORTED_OPERATION", "New submitted private paths cannot establish publication authority.");
  }
  return { root, journal, area, record, afterPath, sources };
}
export function privatePublicationRequirements(storage: Storage, original: OriginalRequest, canonical: PrivatePublicationMutation,
  hashes: false): Promise<string[]>;
export function privatePublicationRequirements(storage: Storage, original: OriginalRequest, canonical: PrivatePublicationMutation,
  hashes: true, host: OriginalMcpNativeHost): Promise<PrivateResourcePublicationSubject[]>;
export async function privatePublicationRequirements(storage: Storage, original: OriginalRequest, value: PrivatePublicationMutation,
  hashes: boolean, host?: OriginalMcpNativeHost): Promise<string[] | PrivateResourcePublicationSubject[]> {
  if (!value.operation.endsWith(".update") || typeof value.args.moveTo !== "string") return [];
  if (!assertOriginalMcpPrivacy(storage.workspaceRoot())) return [];
  const canonical = checkedCanonical(value);
  return storage.withWorkspaceExclusive(() => {
    const current = owner(storage, canonical), privateSources = current.sources.filter(path =>
      knowledgeReadPrivateTopLevels(current.root, current.area).has(path.split("/")[0]!));
    if (!hashes || !privateSources.length) return privateSources;
    assertOriginalMcpNativeHost(host!, storage);
    if (canonical.actorId !== "mcp:external") fail("ACCESS_DENIED", "Private publication is bound to its exact native actor.");
    const subjects = privateSources.map(sourcePath => {
      const proof = privateLegacyAssetProof(current.root, current.area, sourcePath);
      return validatePrivateResourcePublicationSubject({
        root: current.root, workspaceId: current.journal.workspaceId, custodyPlanSha256: current.journal.plan.planSha256,
        catalogSha256: host!.receipt.sourceCatalogSha256, profileSha256: host!.receipt.profileSha256,
        actorId: canonical.actorId, operationId: canonical.args.operationId, operation: canonical.operation,
        publicRequest: { tool: original.tool, version: 1, argumentsDigest: digest(original.arguments) },
        canonicalArgumentsDigest: digest(canonical.args),
        owner: { area: current.area, id: current.record.record.id, beforePath: current.record.record.path,
          afterPath: current.afterPath, revision: current.record.record.revision, sha256: current.record.record.sha256 },
        resource: { sourcePath, ...proof, targetPath: `${current.afterPath.replace(/\.md$/i, ".assets")}/${proof.sha256.slice(0, 16)}${extname(sourcePath).toLowerCase()}` },
        privacySha256: current.journal.plan.privacySha256, preservePrivateSource: true, oneResourceOneOperation: true,
      });
    });
    if (subjects.length > 2048 || subjects.reduce((sum, subject) => sum + subject.resource.size, 0) > 67_108_864)
      fail("INVALID_WORKSPACE", "Private resource review exceeds the existing bounded source profile.");
    return subjects;
  });
}
export async function assertPrivatePublicationSourcePins(storage: Storage, subjects: readonly PrivateResourcePublicationSubject[]) {
  await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    for (const subject of subjects) {
      const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
      if (!journal || subject.root !== storage.workspaceRoot() || subject.workspaceId !== journal.workspaceId
        || subject.custodyPlanSha256 !== journal.plan.planSha256 || subject.privacySha256 !== journal.plan.privacySha256)
        fail("ACCESS_DENIED", "Private publication custody changed after resource review.");
      const selected = scanMarkdown(subject.root).find(value => value.record.area === subject.owner.area && value.record.id === subject.owner.id);
      if (!selected || selected.record.path !== subject.owner.beforePath || selected.record.sha256 !== subject.owner.sha256
        || selected.record.revision !== subject.owner.revision) fail("CONFLICT", "The public owner changed after resource review.");
      const proof = privateLegacyAssetProof(subject.root, subject.owner.area, subject.resource.sourcePath);
      if (proof.sha256 !== subject.resource.sha256 || proof.sourceIdentity !== subject.resource.sourceIdentity || proof.size !== subject.resource.size)
        fail("CONFLICT", "Private source changed after its exact native resource review.");
    }
  });
}

interface Pending {
  operationId: string; actorId: string; canonicalArgumentsDigest: string;
  subjects: PrivateResourcePublicationSubject[]; incomplete: PrivateResourcePublicationSubject[];
  row: Record<string, unknown>; request: KnowledgeMutationRequest;
}
function pendingRequest(storage: Storage, row: Record<string, unknown>): KnowledgeMutationRequest {
  const journal = assertOriginalMcpPrivacy(storage.workspaceRoot()), parsed = JSON.parse(String(row.request_json));
  const request = checkedCanonical(parsed);
  const fingerprint = sha256(JSON.stringify({ operation: request.operation, actorId: request.actorId, args: request.args }));
  const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
    row.fingerprint, row.request_json, row.plan_json];
  if (!journal || row.workspace_id !== journal.workspaceId || row.root_path !== storage.workspaceRoot()
    || row.actor_id !== request.actorId || row.operation !== request.operation || row.operation_id !== request.args.operationId
    || row.request_json !== JSON.stringify(request) || row.fingerprint !== fingerprint || row.digest !== sha256(JSON.stringify(binding)))
    fail("RECOVERY_CONFLICT", "Private publication intent lost its immutable root/request/actor binding.");
  return request;
}
export async function readPendingPrivatePublicationRequirements(storage: Storage): Promise<Pending[]> {
  assertStorage(storage);
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease(); const database = storage.connectNative();
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_runtime_intents'").get()) return [];
      const result: Pending[] = [];
      for (const raw of database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all()) {
        const row = { ...raw };
        if (!String(row.operation).match(/^knowledge\.(note|skill|research)\.update$/)) continue;
        const plan = deserializeKnowledgeMutationPlan(String(row.plan_json));
        if (!plan.relocation) continue;
        const relocation = deserializeDocumentLifecyclePlan(plan.relocation);
        const copies = relocation.legacyAssets?.copies.filter(copy => copy.visibility === "private") ?? [];
        if (!copies.length) continue;
        const request = pendingRequest(storage, row);
        if (database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(plan.operationId))
          fail("RECOVERY_CONFLICT", "A committed private publication cannot become a new pending grant.");
        assertKnowledgeMutationRequestPlan(storage.workspaceRoot(), plan, request);
        const requirements = documentLifecyclePrivatePublicationRequirements(storage.workspaceRoot(), relocation, plan.change.after);
        result.push({ operationId: plan.operationId, actorId: plan.actorId, canonicalArgumentsDigest: digest(request.args),
          subjects: copies.map(copy => validatePrivateResourcePublicationProvenance(copy.publication).subject),
          incomplete: requirements.map(provenance => provenance.subject), row, request });
      }
      return result;
    } finally { database.close(); }
  });
}
export async function refreshPrivatePublicationRecoveryProvenance(storage: Storage, pending: Pending[],
  recovery: PrivateResourcePublicationRecovery) {
  const provenance = privatePublicationRecoveryProvenances(storage, recovery), bySubject = new Map(provenance.map(value => [digest(value.subject), value]));
  await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease(); const database = storage.connectNative();
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const item of pending) {
        const live = database.prepare("SELECT * FROM migration_runtime_intents WHERE operation_id=?").get(item.operationId);
        if (!live || live.digest !== item.row.digest) fail("RECOVERY_CONFLICT", "Private publication intent changed while native review was pending.");
        const plan = deserializeKnowledgeMutationPlan(String(live.plan_json)), relocation = deserializeDocumentLifecyclePlan(plan.relocation!);
        for (const copy of relocation.legacyAssets!.copies) {
          if (copy.visibility !== "private") continue;
          const renewed = bySubject.get(digest(copy.publication!.subject));
          if (renewed) copy.publication = renewed;
        }
        plan.relocation = serializeDocumentLifecyclePlan(relocation);
        assertKnowledgeMutationRequestPlan(storage.workspaceRoot(), plan, item.request);
        const json = serializeKnowledgeMutationPlan(plan), binding = [live.operation_id, live.workspace_id, live.root_path,
          live.actor_id, live.operation, live.fingerprint, live.request_json, json];
        database.prepare("UPDATE migration_runtime_intents SET plan_json=?,digest=? WHERE operation_id=? AND digest=?")
          .run(json, sha256(JSON.stringify(binding)), item.operationId, live.digest);
      }
      privatePublicationRecoveryProvenances(storage, recovery);
      storage.assertWorkspaceLease(); database.exec("COMMIT");
    } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  });
}
