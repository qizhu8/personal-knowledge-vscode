import { z } from "zod";
import { recipeTrashDefinitions } from "./host-composition-legacy-recipe-trash.js";
import { todoDefinitions } from "./todo-definitions.js";
import { documentPath, knowledgeArea, resourcePath } from "./document-path.js";
import { researchDefinitions } from "./research-contracts.js";
import { memoryDefinitions } from "./memory-contracts.js";
import { skillDefinitions } from "./skill-contracts.js";
import { libraryDefinitions } from "./library-contracts.js";
import { mutationScanDefinition } from "./mutation-scan.js";
import { noteDefinitions } from "./note-contracts.js";
import { searchDefinitions } from "./search-contracts.js";
import { linksDefinitions } from "./links-contracts.js";
import { skillRoutingDefinitions } from "./skill-routing-contracts.js";
import { projectRecipeDefinitions } from "./project-recipes-contracts.js";
import { resourceLifecycleDefinitions } from "./resource-lifecycle-contracts.js";
import { workflowCompilerDefinitions } from "./workflow-compiler-contracts.js";
import { recipePublicDefinitions } from "./recipe-public-contracts.js";
import { documentLifecycleDefinitions } from "./document-lifecycle-contracts.js";
import { subscriptionReadDefinitions } from "./subscription-reads-contracts.js";
import { subscriptionBrokerDefinitions } from "./subscription-broker-contracts.js";
import { agentSnapshotReadDefinitions } from "./agent-snapshot-reads-contracts.js";
import { projectMutationDefinitions, projectMutationReadDefinitions } from "./project-mutations-contracts.js";
import { chatSessionDefinitions } from "./chat-session-contracts.js";
import { workflowRuntimeDefinitions } from "./workflow-runtime-contracts.js";
import { syncPlanDefinitions } from "./sync-plan-contracts.js";
import { collaborationStateDefinitions } from "./collaboration-state-contracts.js";
import { actionCompilerDefinitions } from "./action-compiler-contracts.js";
import { pluginRuntimeDefinitions, pluginRuntimeControlDefinitions } from "./plugin-runtime-contracts.js";
import { modelConfigDefinitions } from "./model-config-contracts.js";
import { createChatTurnDefinitions } from "./chat-turn-contracts.js";
import { workflowExecutorDefinitions } from "./workflow-executor-contracts.js";
import { agentRuntimeDefinitions } from "./agent-runtime-contracts.js";
import { folderLifecycleDefinitions } from "./folder-lifecycle-contracts.js";
import { dataRuntimeDefinitions } from "./data-runtime-contracts.js";
import { managerRuntimeDefinitions } from "./manager-runtime-contracts.js";
import { managerProgressDefinitions } from "./manager-progress.js";
import { knowledgeMutationDefinitions } from "./knowledge-mutations-contracts.js";
import { trashLifecycleDefinitions, trashEntryId } from "./trash-lifecycle-contracts.js";
import { managerArtifactDefinitions } from "./host-composition-manager.js";
import { actionRuntimeDefinitions } from "./action-runtime-contracts.js";
import { channelRuntimeDefinitions } from "./channel-runtime-contracts.js";
import { remoteRuntimeDefinitions } from "./remote-runtime.js";
import { remoteSubscriptionDefinitions } from "./remote-runtime-subscription.js";
import { remoteSubscriptionBundleDefinitions } from "./remote-runtime-subscription-bundle-contracts.js";
import { legacyProjectCommandDefinitions } from "./host-composition-legacy-project-contracts.js";
import { portalLifecycleDefinitions } from "./portal-lifecycle-contracts.js";
import {
  legacyTrashDeletionSchema, legacyTrashImportAreas, adoptedTrashMetadataSchema, legacyTrashPurgeDefinitions,
} from "./domain/legacy-trash-import-contracts.js";
import { legacyNoteWorkItemsDefinitions } from "./legacy-note-workitems-contracts.js";
import { legacyInlineNoteDefinitions } from "./legacy-inline-note-contracts.js";
import { legacySnapshotRestoreDefinitions } from "./legacy-snapshot-restore-contracts.js";
import { batch15Definitions } from "./host-composition-legacy-batch15-contracts.js";
import { batch16Definitions } from "./host-composition-legacy-batch16-contracts.js";

import { CoreError } from "./host-composition-legacy-batch15-errors.js";
export { CoreError };

export const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mutation = {
  operationId: z.string().uuid(),
  id: documentId,
};
export const documentSchema = z.strictObject({
  id: documentId,
  // Historical receipts retain their original response shape.
  path: documentPath.optional(),
  area: knowledgeArea.optional(),
  title: z.string().min(1).max(500),
  content: z.string(),
  revision: revision.min(1),
  deleted: z.boolean(),
  sha256: digest,
});
export type DocumentRecord = z.infer<typeof documentSchema>;
export const metadataSchema = z.record(z.string(), z.json());
const diagnosticSchema = z.strictObject({ code: z.string(), pointer: z.string(), message: z.string() });
const assetDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const assetSchema = z.strictObject({ area: knowledgeArea, path: resourcePath, digest: assetDigest, size: revision });
const resourceName = resourcePath.max(200).regex(/^[^/]+$/);
export const uploadStatus = z.strictObject({
  uploadId: z.string().uuid(), documentId, area: knowledgeArea, path: documentPath,
  name: resourceName, size: revision.min(1).max(16_777_216), digest: assetDigest,
  receivedBytes: revision.max(16_777_216), status: z.enum(["active", "committed", "aborted"]),
  resource: assetSchema.extend({ uri: z.string() }).optional(),
}).refine(value => value.receivedBytes <= value.size && (value.status === "committed"
  ? value.receivedBytes === value.size && value.resource !== undefined && value.resource.area === value.area
    && value.resource.digest === value.digest && value.resource.size === value.size
    && value.resource.path === `${value.path.replace(/\.md$/i, ".assets")}/${value.name}`
  : value.resource === undefined), "Upload lifecycle/result fields are inconsistent.");
const uploadMutation = { operationId: z.string().uuid(), uploadId: z.string().uuid() };
export const definitions = [
  ...batch16Definitions,
  ...batch15Definitions,
  ...managerRuntimeDefinitions, ...managerProgressDefinitions, ...managerArtifactDefinitions, ...actionRuntimeDefinitions,
  ...channelRuntimeDefinitions,
  ...portalLifecycleDefinitions,
  ...remoteRuntimeDefinitions, ...remoteSubscriptionDefinitions, ...remoteSubscriptionBundleDefinitions,
  ...legacyProjectCommandDefinitions,
  ...legacyNoteWorkItemsDefinitions.map(definition => {
    const inline = legacyInlineNoteDefinitions.find(item => item.id === definition.id);
    return inline ? { ...definition, input: inline.input, output: inline.output } : definition;
  }),
  ...legacySnapshotRestoreDefinitions.map(definition => ({
    ...definition, description: "Explicit native-approved imported encrypted Snapshot intent; paused durable state only, never automatic runtime replay.",
  })),
  ...recipeTrashDefinitions,
  ...knowledgeMutationDefinitions, ...trashLifecycleDefinitions,
  ...legacyTrashPurgeDefinitions,
  {
    id: "knowledge.trash.list", readOnly: true,
    description: "List current adopted Trash entries. Restored and permanently deleted entries are excluded.",
    input: z.strictObject({}),
    output: z.strictObject({ items: z.array(adoptedTrashMetadataSchema.extend({
      area: z.enum(legacyTrashImportAreas), runtimeEntryId: trashEntryId,
    })).max(2048) }),
  },
  {
    id: "knowledge.trash.get", readOnly: true,
    description: "Read original deletion metadata, ordered history and exact adopted payload/asset bytes.",
    input: z.strictObject({ area: z.enum(legacyTrashImportAreas), originalId: trashEntryId }),
    output: z.strictObject({
      entry: adoptedTrashMetadataSchema.extend({ area: z.enum(legacyTrashImportAreas), runtimeEntryId: trashEntryId }),
      metadataBytes: z.string(),
      deletionHistory: z.strictObject({
        originalBytes: z.string().nullable(),
        current: legacyTrashDeletionSchema,
      }),
      files: z.array(z.strictObject({ path: z.string(), bytes: z.string() })).max(8192),
    }),
  },
  {
    id: "knowledge.trash.restore.original", readOnly: false,
    description: "Restore one exact imported original deletion by area and original ID. Uses a durable native restore operation ID; no replacement or permanent deletion.",
    input: z.strictObject({
      operationId: z.string().uuid(), area: z.enum(legacyTrashImportAreas),
      originalId: trashEntryId,
    }),
    output: trashLifecycleDefinitions[2].output,
  },
  {
    id: "knowledge.document.list", readOnly: true,
    description: "List this isolated workspace's documents. Pin workspaceRevision on later pages. Does not read the legacy Knowledge Root.",
    input: z.strictObject({
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      workspaceRevision: digest.optional(),
      includeDeleted: z.boolean().default(false),
      area: knowledgeArea.optional(),
    }),
    output: z.strictObject({ items: z.array(documentSchema.omit({ content: true })), total: revision, nextOffset: revision.nullable(), workspaceRevision: digest }),
  },
  {
    id: "knowledge.document.get", readOnly: true, description: "Read a document, including its recorded deletion state.",
    input: z.strictObject({ id: documentId }), output: documentSchema,
  },
  {
    id: "knowledge.document.create", readOnly: false, description: "Create a new document with a durable operation receipt. An existing ID is a conflict.",
    input: z.strictObject({ ...mutation, area: knowledgeArea.optional(), path: documentPath.optional(), title: z.string().trim().min(1).max(500), content: z.string() }),
    output: documentSchema,
  },
  {
    id: "knowledge.document.update", readOnly: false, description: "Replace title/content using the exact current revision. Never writes legacy Notes.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1), expectedSha256: digest, title: z.string().trim().min(1).max(500), content: z.string() }),
    output: documentSchema,
  },
  {
    id: "knowledge.document.trash", readOnly: false, description: "Soft-delete by revision. Content and audit remain; no permanent deletion.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1), expectedSha256: digest }), output: documentSchema,
  },
  {
    id: "knowledge.document.restore", readOnly: false, description: "Restore a soft-deleted document using its exact revision.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1), expectedSha256: digest }), output: documentSchema,
  },
  {
    id: "knowledge.metadata.get", readOnly: true,
    description: "Read original YAML metadata and original Knowledge identity/link diagnostics without rewriting a legacy document.",
    input: z.strictObject({ id: documentId }),
    output: documentSchema.omit({ content: true }).extend({ metadata: metadataSchema, diagnostics: z.array(diagnosticSchema) }),
  },
  {
    id: "knowledge.metadata.update", readOnly: false,
    description: "Patch/remove metadata fields using revision and full-file digest CAS. Preserves body/comments and other fields; identity/history and Todo authority fields are protected. Links use the original pinned/floating contracts.",
    input: z.strictObject({
      ...mutation, expectedRevision: revision.min(1), expectedSha256: digest,
      set: metadataSchema.default({}), remove: z.array(z.string().min(1).max(200)).max(100).default([]),
    }).refine(value => Object.keys(value.set).length > 0 || value.remove.length > 0, "Provide at least one metadata field to set or remove."),
    output: documentSchema,
  },
  {
    id: "knowledge.asset.list", readOnly: true,
    description: "Page original owned/referenced Markdown resources, including unreferenced owned diagrams and legacy shared assets. Reports missing/unsafe references; never follows links or exposes Todo authority files.",
    input: z.strictObject({
      id: documentId, offset: z.number().int().min(0).max(2048).default(0),
      limit: z.number().int().min(1).max(100).default(20), revision: digest.optional(),
    }),
    output: z.strictObject({
      id: documentId, area: knowledgeArea, documentSha256: digest, revision: digest,
      items: z.array(assetSchema), total: revision, nextOffset: revision.nullable(), diagnostics: z.array(diagnosticSchema),
    }),
  },
  {
    id: "knowledge.asset.get", readOnly: true,
    description: "Read a bounded base64 resource chunk from the document's owned/referenced catalog. Pin both document SHA256 and asset digest across chunks; changed content is a conflict.",
    input: z.strictObject({
      id: documentId, path: resourcePath, expectedDocumentSha256: digest, expectedDigest: assetDigest,
      offset: z.number().int().min(0).max(16_777_216).default(0),
      length: z.number().int().min(1).max(65_536).default(65_536),
    }),
    output: assetSchema.extend({
      id: documentId, documentSha256: digest, offset: revision, data: z.string().max(87_384), nextOffset: revision.nullable(),
    }),
  },
  {
    id: "knowledge.upload.begin", readOnly: false,
    description: "Begin an actor-owned durable resource upload, pinning document identity/path/revision/digest and final byte size/SHA256. At most 4 active uploads per actor, 8 globally and 64 MiB reserved.",
    input: z.strictObject({
      ...mutation, expectedRevision: revision.min(1), expectedSha256: digest,
      name: resourceName, size: revision.min(1).max(16_777_216), digest: assetDigest,
    }), output: uploadStatus,
  },
  {
    id: "knowledge.upload.append", readOnly: false,
    description: "Append a canonical base64 chunk of 1..65536 bytes at the exact next offset. Each chunk has a durable operationId receipt; retry the identical request after reconnect.",
    input: z.strictObject({
      ...uploadMutation, offset: revision.max(16_777_216), data: z.string().min(4).max(87_384),
    }), output: uploadStatus,
  },
  {
    id: "knowledge.upload.get", readOnly: true, description: "Read this actor's durable upload progress after reconnect; never returns another actor's data or upload chunks.",
    input: z.strictObject({ uploadId: z.string().uuid() }), output: uploadStatus,
  },
  {
    id: "knowledge.upload.list", readOnly: true, description: "Recover this actor's active upload IDs after losing client state. At most four owned active sessions; no chunk content or other actor's sessions.",
    input: z.strictObject({}), output: z.strictObject({ items: z.array(uploadStatus).max(4), total: z.number().int().min(0).max(4) }),
  },
  {
    id: "knowledge.upload.abort", readOnly: false, description: "Abort an active owned upload and release its buffered bytes without writing or deleting a knowledge resource.",
    input: z.strictObject(uploadMutation), output: uploadStatus,
  },
  {
    id: "knowledge.upload.commit", readOnly: false,
    description: "Verify complete bytes, SHA256 and original document pins, then durably journal an atomic resource creation. Never overwrites different bytes or edits Markdown. Returns the encoded Markdown URI.",
    input: z.strictObject(uploadMutation), output: uploadStatus,
  },
  ...researchDefinitions,
  ...skillDefinitions,
  ...libraryDefinitions,
  mutationScanDefinition,
  ...noteDefinitions,
  ...searchDefinitions,
  ...linksDefinitions,
  ...skillRoutingDefinitions,
  ...projectRecipeDefinitions,
  ...resourceLifecycleDefinitions,
  ...workflowCompilerDefinitions,
  ...recipePublicDefinitions,
  ...documentLifecycleDefinitions,
  ...subscriptionReadDefinitions,
  ...subscriptionBrokerDefinitions,
  ...agentSnapshotReadDefinitions,
  ...projectMutationDefinitions,
  ...projectMutationReadDefinitions,
  ...chatSessionDefinitions,
  ...workflowRuntimeDefinitions,
  ...syncPlanDefinitions,
  ...collaborationStateDefinitions,
  ...actionCompilerDefinitions,
  ...pluginRuntimeDefinitions,
  ...pluginRuntimeControlDefinitions,
  ...modelConfigDefinitions,
  ...createChatTurnDefinitions(true),
  ...workflowExecutorDefinitions,
  ...agentRuntimeDefinitions,
  ...folderLifecycleDefinitions,
  ...dataRuntimeDefinitions,
  ...memoryDefinitions,
  ...todoDefinitions,
] as const;
export const invocation = z.strictObject({
  operation: z.string().max(100),
  version: z.literal(1),
  arguments: z.record(z.string(), z.unknown()),
});
export const discovery = z.strictObject({
  query: z.string().max(200).default(""),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const description = z.strictObject({ operation: z.string().max(100) });
export const resultEnvelope = z.strictObject({
  schema: z.literal("pkm.next-result/v1"),
  requestId: z.string().uuid(),
  operation: z.string().optional(),
  version: z.literal(1).optional(),
  catalogRevision: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.strictObject({ code: z.string(), message: z.string(), effect: z.enum(["not-committed", "unknown"]) }).optional(),
}).refine(value => (value.result === undefined) !== (value.error === undefined), "Exactly one result or error is required.");
export interface BoardWorkerAuthority { boardSlug: string; digest: string }
export interface Actor {
  id: string; canWrite: boolean; collaborationKind?: "human" | "agent" | "browser";
  recipeProtocol?: true;
  boardWorker?: BoardWorkerAuthority;
}
export interface StorageRequest {
  operation: typeof definitions[number]["id"]; args: Record<string, unknown>; actorId: string;
  boardWorker?: BoardWorkerAuthority;
  collaborationKind?: "human" | "agent" | "browser";
  receiptOnly?: boolean;
  memoryDecision?: { decisionId: string; actorId: string; documentSha256: string };
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", z.prettifyError(parsed.error));
  return parsed.data;
}
