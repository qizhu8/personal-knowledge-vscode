import { z } from "zod";
import { knowledgeArea, resourcePath } from "./document-path.js";

export const trashLifecycleLayout = Object.freeze({
  version: "pkm.trash-lifecycle/v1",
  directories: Object.freeze(["notes/.trash", "skills/.trash", "papers/.trash"]),
  qualification: "Host must explicitly allowlist and provision these real directories; this module never provisions storage roots.",
});
export const trashLifecycleLimits = Object.freeze({
  entries: Number.MAX_SAFE_INTEGER, depth: 32, fileBytes: Number.MAX_SAFE_INTEGER, subtreeBytes: Number.MAX_SAFE_INTEGER,
  documents: Number.MAX_SAFE_INTEGER, markdownBytes: Number.MAX_SAFE_INTEGER, scanBytes: Number.MAX_SAFE_INTEGER,
  journalBytes: Number.MAX_SAFE_INTEGER,
});
export const trashLifecyclePin = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  area: knowledgeArea, path: resourcePath, revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const trashEntryId = z.union([z.string().uuid(), z.string().regex(/^[0-9]+-[a-f0-9]{10}$/)]);
const receipt = z.strictObject({
  operationId: z.string().uuid(), action: z.enum(["trash", "restore"]),
  entryId: trashEntryId, area: knowledgeArea, path: resourcePath,
});
const input = z.strictObject({
  operationId: z.string().uuid(), area: knowledgeArea, path: resourcePath,
  kind: z.enum(["document", "folder"]), expectedTreeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedScanRevision: z.string().regex(/^[a-f0-9]{64}$/),
  entryIdFormat: z.literal("original").optional(),
});
export const trashLifecycleDefinitions = [
  {
    id: "knowledge.trash.lifecycle.preview", readOnly: true,
    description: "Preview recoverable byte-preserving document/paired-assets or folder trash. Path-derived IDs remain pinned to their exact original paths for restore; no identity metadata is manufactured. Refuses shared resources, legacy assets, conflicting explicit identities, Board/memory/System descriptors and unsafe trees.",
    input: input.omit({ operationId: true, expectedTreeSha256: true, expectedScanRevision: true, entryIdFormat: true }),
    output: z.strictObject({
      treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
      scanRevision: z.string().regex(/^[a-f0-9]{64}$/),
      documents: z.array(trashLifecyclePin).max(trashLifecycleLimits.documents),
    }),
  },
  { id: "knowledge.trash.move", readOnly: false, description: "Recoverably trash with a host-locked intent-before-effects journal; no permanent deletion.", input, output: receipt },
  {
    id: "knowledge.trash.restore", readOnly: false,
    description: "Restore an authoritative committed trash entry, its exact subtree and paired bytes to an absent original location. Recreate missing real parent directories inside the existing area only after durable intent; recovery retains them. No replacement or rollback.",
    input: z.strictObject({ operationId: z.string().uuid(), entryId: trashEntryId, expectedScanRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: receipt,
  },
] as const;
export type TrashLifecycleResult = z.infer<typeof receipt>;
