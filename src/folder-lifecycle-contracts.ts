import { z } from "zod";
import { knowledgeArea, resourcePath } from "./document-path.js";

export const folderLifecycleLimits = Object.freeze({
  entries: Number.MAX_SAFE_INTEGER,
  documents: Number.MAX_SAFE_INTEGER,
  depth: 32,
  fileBytes: Number.MAX_SAFE_INTEGER,
  subtreeBytes: Number.MAX_SAFE_INTEGER,
  markdownBytes: Number.MAX_SAFE_INTEGER,
  scanBytes: Number.MAX_SAFE_INTEGER,
});

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const folderPath = resourcePath;

const folderReceipt = z.strictObject({
  area: knowledgeArea,
  sourcePath: folderPath,
  destinationPath: folderPath,
  sourceSha256: digest,
  scanRevision: digest,
  entries: count.max(folderLifecycleLimits.entries),
  files: count.max(folderLifecycleLimits.entries),
  bytes: count.max(folderLifecycleLimits.subtreeBytes),
  documents: count.max(folderLifecycleLimits.documents),
  rewrittenDocuments: count.max(folderLifecycleLimits.documents),
});
const promotionReceipt = folderReceipt.extend({ destinationPath: z.union([folderPath, z.literal("")]) });

export const folderLifecycleDefinitions = [
  {
    id: "knowledge.folder.lifecycle.preview",
    readOnly: true,
    description: "Preview a notes/skills/papers folder move. Pins the complete subtree, Markdown identity/revision snapshot and cross-document asset-reference scan, including the Notes folder-pin sidecar. Requires a portable absent destination. Symlinks, unknown entries, shared/outside references, path-derived identities, Todo/memory/system descriptors and legacy _assets are refused.",
    input: z.strictObject({
      area: knowledgeArea,
      path: folderPath,
      destinationPath: folderPath,
    }),
    output: folderReceipt.extend({
      destinationAbsent: z.literal(true),
      scannedDocuments: count.max(folderLifecycleLimits.documents),
      scannedBytes: count.max(folderLifecycleLimits.scanBytes),
    }),
  },
  {
    id: "knowledge.folder.move",
    readOnly: false,
    description: "Apply a strictly pinned same-area folder move with original Markdown asset-reference rebasing and exact-byte Notes folder-pin sidecar CAS. Caller must durably persist the serialized intent and hold the shared SQLite writer lock before filesystem effects; path/identity reindex, receipt and intent removal commit together. Recovery accepts only exact source/destination, sidecar and staging phases. Uses OS no-replace moves; external writers racing checks require reconciliation. Trash is not supported.",
    input: z.strictObject({
      operationId: z.string().uuid(),
      area: knowledgeArea,
      path: folderPath,
      destinationPath: folderPath,
      expectedSourceSha256: digest,
      expectedScanRevision: digest,
      expectedDestinationSha256: z.null(),
    }),
    output: z.strictObject({
      operationId: z.string().uuid(),
      action: z.literal("move"),
      folder: folderReceipt,
    }),
  },
  {
    id: "knowledge.folder.lifecycle.promote-preview",
    readOnly: true,
    description: "Preview original notes/skills/papers parent-child promotion and container deletion. Only parent mode is supported (not prompts fallback groups or Trash). All immediate child and paired asset destinations must be absent, including portable case collisions. Pins subtree, complete reference scan and Notes folder-pin sidecar. destinationAbsent refers to child destinations, not the existing parent.",
    input: z.strictObject({ area: knowledgeArea, path: folderPath, mode: z.literal("parent") }),
    output: promotionReceipt.extend({
      destinationAbsent: z.literal(true),
      scannedDocuments: count,
      scannedBytes: count,
    }),
  },
  {
    id: "knowledge.folder.promote-delete",
    readOnly: false,
    description: "Promote all immediate children and owned asset pairs into the existing parent, rebase original asset references and Notes folder pins, then remove only the verified empty source container and its optional .gitkeep marker. Requires exact preview CAS and the shared durable folder journal. Ordered no-replace moves and exact before/after bytes recover forward after interruption; unknown changes fence recovery without deleting data. Only parent mode is supported; fallback groups and Trash are explicitly unsupported.",
    input: z.strictObject({
      operationId: z.string().uuid(), area: knowledgeArea, path: folderPath, mode: z.literal("parent"),
      expectedSourceSha256: digest, expectedScanRevision: digest, expectedDestinationSha256: z.null(),
    }),
    output: z.strictObject({
      operationId: z.string().uuid(), action: z.literal("promote-delete"), folder: promotionReceipt, moved: count,
    }),
  },
] as const;

export type FolderLifecycleOperation = typeof folderLifecycleDefinitions[number]["id"];
export type FolderLifecyclePreview = z.infer<(typeof folderLifecycleDefinitions)[0]["output"]>;
export type FolderLifecycleResult = z.infer<(typeof folderLifecycleDefinitions)[1]["output"]>
  | z.infer<(typeof folderLifecycleDefinitions)[3]["output"]>;

export const folderLifecycleEntryPath = z.string().min(1).max(2048).superRefine((value, context) => {
  const parts = value.split("/");
  if (Buffer.byteLength(value, "utf8") > 2048 || parts.some((part, index) => {
    if (!part || Buffer.byteLength(part, "utf8") > 255 || /[\u0000-\u001f\u007f\\:*?"<>|]/.test(part)
      || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      || /[\uD800-\uDFFF]/.test(part) && !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(part)) return true;
    if (part.startsWith(".") && !(part === ".gitkeep" && index === parts.length - 1)) return true;
    return false;
  })) context.addIssue({ code: "custom", message: "Folder entries must use portable, non-hidden relative paths." });
});

export const folderLifecycleDocumentPin = z.strictObject({
  id: documentId,
  area: knowledgeArea,
  path: z.string().min(4).max(2048),
  revision: count.min(1),
  sha256: digest,
});
