import { z } from "zod";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { decodeMarkdown } from "./markdown.js";
import type { Storage } from "./storage.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy, originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import {
  prepareOriginalPublicDocumentTrash, prepareOriginalPublicDocumentRestore, inspectTrashLifecycleRecovery,
  inspectTrashLifecycleEntry, deserializeTrashLifecyclePlan, serializeTrashLifecyclePlan, trashLifecycleMetadata,
  type TrashLifecyclePlan,
} from "./trash-lifecycle.js";
import { assertNativeTrashRow } from "./migration-runtime.js";
import {
  originalNativeTrashDigest as digest, originalNativeTrashListInputSchema, originalNativeTrashMetadataSchema,
  originalNativeTrashSelectionSchema, validateOriginalNativeTrashSubject,
  type OriginalNativeTrashSubject, type OriginalNativeTrashSelection,
} from "./original-native-trash-contracts.js";
import {
  originalTrashControls, originalTrashHistoryImage, originalTrashHistoryAfter, originalTrashIdentity,
  originalTrashTree, originalTrashRead, originalTrashPredecessor, originalTrashTransitionBodySchema,
  validateOriginalTrashTransition, inspectOriginalTrashHistoryPhase,
  type OriginalTrashTransitionBody,
} from "./original-native-trash-custody.js";
import { assertOriginalTrashRecovery, type OriginalTrashRecovery,
  type OriginalTrashCanonicalRequest, type OriginalTrashPublicRequest } from "./original-native-trash-native.js";
import { opaqueTrashArea, trashCustodyArea, type TrashCustodyArea } from "./opaque-trash-contracts.js";

interface Prepared {
  subject: OriginalNativeTrashSubject; transition?: OriginalTrashTransitionBody; plan?: TrashLifecyclePlan;
  sourceRows: OriginalNativeTrashSelection["inventory"];
}
export async function hasOriginalTrashReplay(storage: Storage, request: OriginalTrashCanonicalRequest): Promise<boolean> {
  if (request.operation === "knowledge.trash.list") return false;
  return storage.withWorkspaceExclusive(() => {
    const database = storage.connectNative();
    try {
      const row = database.prepare("SELECT actor_id,operation,fingerprint FROM receipts WHERE operation_id=?")
        .get(String(request.args.operationId));
      if (!row) return false;
      if (row.actor_id !== request.actorId || row.operation !== request.operation
        || row.fingerprint !== sha256(JSON.stringify({ operation: request.operation, actorId: request.actorId, args: request.args })))
        fail("CONFLICT", "The global operation UUID belongs to another immutable request or actor.");
      return true;
    } finally { database.close(); }
  });
}
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function publicPath(root: string, area: TrashCustodyArea, path: string) {
  if (originalMcpPrivateTopLevels(root, area).has(path.split("/")[0]!)
    || path.split("/").some(part => ["system", "_assets", ".trash"].includes(part.toLowerCase())))
    fail("ACCESS_DENIED", "Private, System and legacy-resource Trash targets remain closed.");
}
function selectionForPlan(root: string, plan: TrashLifecyclePlan): OriginalNativeTrashSelection {
  if (plan.targetKind === "opaque") {
    const inventory = plan.moves.flatMap(move => originalTrashTree(root, plan.action === "trash"
      ? `${plan.area}/${move.originalPath}` : `${plan.area}/.trash/${plan.entryId}/${move.slot}`));
    return originalNativeTrashSelectionSchema.parse({
      area: plan.area, path: plan.path, file: plan.opaqueFile,
      entryId: plan.entryId, metadata: JSON.parse(trashLifecycleMetadata(plan).toString("utf8")),
      metadataSha256: sha256(trashLifecycleMetadata(plan)), inventory, treeSha256: digest(inventory),
      scanRevision: plan.expectedScanRevision, readOnlyOriginalBucket: false,
    });
  }
  const document = plan.documentPins[0]!;
  const rawPath = plan.action === "trash" ? `${plan.area}/${plan.path}` : `${plan.area}/.trash/${plan.entryId}/payload`;
  const raw = originalTrashRead(root, rawPath), decoded = decodeMarkdown(document.id, raw.toString("utf8"), plan.path, z.enum(["notes", "skills", "papers"]).parse(plan.area));
  const knowledgeId = decoded.metadata.get("knowledgeId");
  if (typeof knowledgeId !== "string" || raw.toString("utf8").includes("\uFFFD")
    || decoded.record.sha256 !== document.sha256 || decoded.record.revision !== document.revision)
    fail("NOT_AVAILABLE", "Original public Note Trash requires its exact original UTF-8 knowledge identity and revision.");
  const inventory = plan.moves.flatMap(move => originalTrashTree(root, plan.action === "trash"
    ? `${plan.area}/${move.originalPath}` : `${plan.area}/.trash/${plan.entryId}/${move.slot}`));
  return originalNativeTrashSelectionSchema.parse({
    area: plan.area, path: plan.path, document: { id: document.id, revision: document.revision, sha256: document.sha256, knowledgeId },
    entryId: plan.entryId, metadata: JSON.parse(trashLifecycleMetadata(plan).toString("utf8")),
    metadataSha256: sha256(trashLifecycleMetadata(plan)), inventory, treeSha256: digest(inventory),
    scanRevision: plan.expectedScanRevision, readOnlyOriginalBucket: false,
  });
}
function listSelection(root: string, area: TrashCustodyArea, entryId: string, native: TrashLifecyclePlan | undefined): OriginalNativeTrashSelection {
  if (native && native.area !== area || area !== "notes" && (!native || !native.originalTrash))
    fail("NOT_FOUND", "New-area list selects only exact receipt-owned buckets in that area.");
  if (opaqueTrashArea.safeParse(area).success) {
    inspectTrashLifecycleEntry(root, native!);
    publicPath(root, area, native!.path);
    return selectionForPlan(root, { ...native!, action: "restore" });
  }
  const base = `${area}/.trash/${entryId}`, metadataBytes = originalTrashRead(root, `${base}/metadata.json`, 8192);
  const metadata = (area === "skills" ? originalNativeTrashMetadataSchema.extend({ kind: z.literal("skill") })
    : originalNativeTrashMetadataSchema).parse(JSON.parse(metadataBytes.toString("utf8")));
  publicPath(root, area, metadata.originalPath);
  const inventory = originalTrashTree(root, base);
  if (inventory.some(row => row.path !== base && row.path !== `${base}/metadata.json` && row.path !== `${base}/payload`
    && row.path !== `${base}/assets` && !row.path.startsWith(`${base}/assets/`))
    || metadata.id !== entryId || !!metadata.assetsPath !== inventory.some(row => row.path === `${base}/assets`)
    || inventory.find(row => row.path === `${base}/payload`)?.kind !== "file")
    fail("NOT_AVAILABLE", "The selected original bucket is not an exact public Note/owned-pair bucket.");
  if (native) inspectTrashLifecycleEntry(root, native);
  const raw = originalTrashRead(root, `${base}/payload`);
  if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail("NOT_AVAILABLE", "Original Trash list requires exact UTF-8 Note metadata.");
  const markdownArea = z.enum(["notes", "skills", "papers"]).parse(area);
  const initial = decodeMarkdown("scan", raw.toString("utf8"), metadata.originalPath, markdownArea);
  const knowledgeId = initial.metadata.get("knowledgeId");
  if (typeof knowledgeId !== "string" || initial.metadata.has("documentId") || initial.metadata.has("memory")
    || initial.metadata.get("documentKind") === "todo-board")
    fail("NOT_AVAILABLE", "Unknown or private-domain original bucket descriptors remain closed.");
  const id = native?.documentPins[0]?.id ?? knowledgeId;
  const decoded = decodeMarkdown(id, raw.toString("utf8"), metadata.originalPath, markdownArea);
  return originalNativeTrashSelectionSchema.parse({
    area, path: metadata.originalPath, document: { id, knowledgeId, revision: decoded.record.revision, sha256: sha256(raw) },
    entryId, metadata, metadataSha256: sha256(metadataBytes), inventory, treeSha256: digest(inventory),
    scanRevision: native?.expectedScanRevision ?? digest([]), readOnlyOriginalBucket: !native,
  });
}
export async function prepareOriginalTrashOperation(storage: Storage, host: OriginalMcpNativeHost,
  request: OriginalTrashCanonicalRequest, publicRequest?: OriginalTrashPublicRequest): Promise<Prepared> {
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root);
    if (!journal || request.actorId !== "mcp:external") fail("NATIVE_AUTHORITY_REQUIRED", "Original Trash requires the actual original-root native actor.");
    const list = request.operation === "knowledge.trash.list" ? originalNativeTrashListInputSchema.safeParse(request.args) : undefined;
    if (list && !list.success)
      fail("INVALID_ARGUMENT", "Original Trash list requires one explicit public area, entryIds and operationId; unscoped/private listing remains closed.");
    const { validateOriginalMcpWorkspace } = await import("./original-mcp-root.js");
    await validateOriginalMcpWorkspace(root);
    const database = storage.connectNative();
    try {
      if (database.prepare("SELECT 1 FROM migration_runtime_intents LIMIT 1").get())
        fail("RECOVERY_REQUIRED", "Pending mutations must be separately approved and recovered before a new Trash operation.");
      const predecessor = originalTrashPredecessor(database, journal.plan.planSha256), before = originalTrashHistoryImage(root);
      const base = {
        root, workspaceId: journal.workspaceId, custodyPlanSha256: journal.plan.planSha256,
        catalogSha256: host.receipt.sourceCatalogSha256, profileSha256: journal.plan.profileSha256,
        actorId: "mcp:external" as const, operationId: list?.success ? list.data.operationId : z.string().uuid().parse(request.args.operationId),
        canonicalArgumentsDigest: digest(request.args), privacySha256: journal.plan.privacySha256,
        sourceOriginalSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27" as const,
        custodyPredecessorSha256: predecessor, historyBeforeSha256: before ? sha256(before) : null,
      };
      if (request.operation === "knowledge.trash.list") {
        if (!list?.success) fail("INVALID_ARGUMENT", "Original Trash list requires its exact scoped query.");
        const args = list.data;
        const selection = args.entryIds.map(entryId => {
          const row = database.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(entryId);
          return listSelection(root, args.area, entryId, row ? assertNativeTrashRow(database, journal.workspaceId, root, row) : undefined);
        });
        const subject = validateOriginalNativeTrashSubject({ ...base, action: "list", operation: "knowledge.trash.list",
          ...(args.area !== "notes" ? { area: args.area } : {}),
          selection, historyAfterSha256: base.historyBeforeSha256, transitionSha256: digest(selection) });
        return { subject, sourceRows: selection.flatMap(item => item.inventory) };
      }
      let plan: TrashLifecyclePlan;
      if (request.operation === "knowledge.trash.move") {
        const area = trashCustodyArea.parse(request.args.area);
        if (area === "prompts" && journal.plan.schema !== "pkm.original-mcp-custody/v3"
          || area === "scripts" && journal.plan.schema === "pkm.original-mcp-custody/v1")
          fail("NATIVE_AUTHORITY_REQUIRED", "Opaque Trash requires a fresh versioned source custody capture.");
        publicPath(root, area, String(request.args.path));
        if (request.args.entryIdFormat !== "original") fail("INVALID_ARGUMENT", "Original-root Trash requires original-format buckets.");
        plan = prepareOriginalPublicDocumentTrash(root, request.actorId, request.args);
      } else if (request.operation === "knowledge.trash.restore") {
        const row = database.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(String(request.args.entryId));
        if (!row) fail("NOT_FOUND", "Only a committed receipt-owned native public Note bucket can be restored.");
        const original = assertNativeTrashRow(database, journal.workspaceId, root, row);
        if (!original.originalTrash) fail("NATIVE_AUTHORITY_REQUIRED", "Old original buckets are read-only; history is not a restore grant.");
        plan = prepareOriginalPublicDocumentRestore(root, request.actorId, original, request.args);
      } else fail("NOT_AVAILABLE", "This original Trash operation is outside the bounded lifecycle.");
      const selection = selectionForPlan(root, plan);
      const paths = [...plan.moves].sort((a, b) => a.slot === b.slot ? 0 : a.slot === "payload" ? -1 : 1)
        .flatMap(move => move.entries.filter(row => row.kind === "file" && !row.path.split("/").some(part => part.startsWith(".")))
          .map(row => `${plan.area}/${move.originalPath}${row.path ? `/${row.path}` : ""}`));
      const action = plan.action === "trash" ? "move" as const : "restore" as const;
      const after = originalTrashHistoryAfter(before, paths, plan.deletedAt, action);
      const transition = originalTrashTransitionBodySchema.parse({
        schema: plan.area === "notes" ? "pkm.original-native-trash-transition/v1" : opaqueTrashArea.safeParse(plan.area).success
          ? "pkm.original-native-trash-transition/v3" : "pkm.original-native-trash-transition/v2",
        operationId: plan.operationId, action,
        planSha256: sha256(serializeTrashLifecyclePlan(plan)), predecessorSha256: predecessor, selection,
        historyBefore: before?.toString("base64") ?? null, historyAfter: after.toString("base64"),
        controlBefore: originalTrashControls(root, plan.entryId, plan.area, plan.path),
      });
      const subject = { ...base, action, operation: request.operation, selection: [selection],
        ...(plan.area !== "notes" ? { area: plan.area } : {}),
        historyAfterSha256: sha256(after), transitionSha256: digest(transition),
        ...(action === "move" && publicRequest ? { publicRequest: {
          tool: publicRequest.tool, version: 1, argumentsDigest: digest(publicRequest.arguments),
        } } : {}) };
      return { subject: validateOriginalNativeTrashSubject(subject), plan, transition, sourceRows: selection.inventory };
    } finally { database.close(); }
  });
}
export async function assertOriginalTrashPreparation(storage: Storage, prepared: Prepared) {
  await storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const { validateOriginalMcpWorkspace } = await import("./original-mcp-root.js");
    await validateOriginalMcpWorkspace(storage.workspaceRoot());
    const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root), database = storage.connectNative();
    try {
      const currentHistory = originalTrashHistoryImage(root);
      if (!journal || journal.plan.privacySha256 !== prepared.subject.privacySha256
        || originalTrashPredecessor(database, journal.plan.planSha256) !== prepared.subject.custodyPredecessorSha256
        || prepared.sourceRows.some(row => digest(originalTrashIdentity(root, row.path)) !== digest(row))
        || (currentHistory ? sha256(currentHistory) : null) !== prepared.subject.historyBeforeSha256)
        fail("CONFLICT", "Original Trash source, pair, history or custody predecessor changed during native review.");
      if (prepared.transition && digest(originalTrashControls(root, prepared.transition.selection.entryId, prepared.transition.selection.area, prepared.transition.selection.path)) !== digest(prepared.transition.controlBefore))
        fail("CONFLICT", "Original Trash custody control rows changed during native review.");
      if (prepared.plan) {
        const current = prepared.plan.action === "trash"
          ? prepareOriginalPublicDocumentTrash(root, prepared.plan.actorId, {
            operationId: prepared.plan.operationId, area: prepared.plan.area, path: prepared.plan.path, kind: prepared.plan.targetKind,
            expectedTreeSha256: prepared.plan.expectedTreeSha256, expectedScanRevision: prepared.plan.expectedScanRevision, entryIdFormat: "original",
          })
          : prepared.plan.area === "notes" ? undefined : (() => {
            const plan = prepared.plan!, row = database.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(plan.entryId);
            if (!row || !journal) fail("CONFLICT", "The exact committed Skill/Paper bucket changed during review.");
            return prepareOriginalPublicDocumentRestore(root, plan.actorId,
              assertNativeTrashRow(database, journal.workspaceId, root, row), {
                operationId: plan.operationId, entryId: plan.entryId, expectedScanRevision: plan.expectedScanRevision,
              });
          })();
        if (current && (digest(current.moves) !== digest(prepared.plan.moves) || current.expectedScanRevision !== prepared.plan.expectedScanRevision))
          fail("CONFLICT", "Original Trash reference scan changed during native review.");
      }
    } finally { database.close(); }
  });
}
export async function readPendingOriginalTrash(storage: Storage) {
  return storage.withWorkspaceExclusive(() => {
    const database = storage.connectNative();
    try {
      const rows = database.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all();
      const candidates = rows.filter(row => String(row.operation).startsWith("knowledge.trash."));
      if (!candidates.length) return undefined;
      if (rows.length !== 1) fail("RECOVERY_REQUIRED", "Original Trash recovery requires its sole exact fenced intent.");
      const row = candidates[0]!, plan = deserializeTrashLifecyclePlan(String(row.plan_json));
      if (!plan.originalTrash) fail("RECOVERY_REQUIRED", "Old Trash intents lack the new native original transition protocol.");
      const transition = validateOriginalTrashTransition(plan.originalTrash), request = JSON.parse(String(row.request_json)) as OriginalTrashCanonicalRequest;
      const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
      const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
        row.fingerprint, row.request_json, row.plan_json];
      if (!journal || row.workspace_id !== journal.workspaceId || row.root_path !== storage.workspaceRoot()
        || row.digest !== sha256(JSON.stringify(binding)) || row.fingerprint !== sha256(JSON.stringify(request))
        || request.actorId !== plan.actorId || request.operation !== transition.provenance.request.subject.operation
        || digest(request.args) !== transition.provenance.request.subject.canonicalArgumentsDigest
        || database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(plan.operationId))
        fail("RECOVERY_REQUIRED", "Original Trash recovery intent/request/actor bindings changed.");
      inspectTrashLifecycleRecovery(storage.workspaceRoot(), plan);
      inspectOriginalTrashHistoryPhase(storage.workspaceRoot(), transition);
      return { row, plan, request, transition };
    } finally { database.close(); }
  });
}
export async function refreshOriginalTrashRecovery(storage: Storage,
  pending: NonNullable<Awaited<ReturnType<typeof readPendingOriginalTrash>>>, plan: TrashLifecyclePlan, recovery: OriginalTrashRecovery) {
  await storage.withWorkspaceExclusive(() => {
    assertOriginalTrashRecovery(storage, recovery, plan);
    storage.assertWorkspaceLease(); inspectTrashLifecycleRecovery(storage.workspaceRoot(), plan);
    inspectOriginalTrashHistoryPhase(storage.workspaceRoot(), plan.originalTrash!);
    const database = storage.connectNative();
    try {
      const json = serializeTrashLifecyclePlan(plan), row = pending.row;
      const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
        row.fingerprint, row.request_json, json];
      assertOriginalTrashRecovery(storage, recovery, plan);
      database.exec("BEGIN IMMEDIATE");
      const result = database.prepare("UPDATE migration_runtime_intents SET plan_json=?,digest=? WHERE operation_id=? AND digest=?")
        .run(json, sha256(JSON.stringify(binding)), row.operation_id!, row.digest!);
      if (result.changes !== 1) fail("CONFLICT", "Original Trash intent changed while refreshing native recovery approval.");
      database.exec("COMMIT");
    } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  });
}
