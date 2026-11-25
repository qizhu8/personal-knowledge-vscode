import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Core } from "./core.js";
import type { Storage } from "./storage.js";
import { documentPath, knowledgeArea } from "./document-path.js";
import { sha256 } from "./file-write.js";
import { legacyKnowledgeTree } from "./legacy-knowledge-snapshot.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { opaqueKnowledgeTrash } from "./opaque-knowledge-trash.js";

const script = fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url));
export const legacyKnowledgeTrashRequest = z.strictObject({
  tool: z.enum(["delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"]),
  arguments: z.record(z.string(), z.unknown()),
});
const mutationSchema = z.strictObject({
  area: knowledgeArea, path: documentPath, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
const projectionSchema = z.object({
  text: z.string(), value: z.unknown(), mutations: z.array(mutationSchema).max(1),
});

export async function legacyKnowledgeTrash(core: Core, storage: Storage, actor: Actor,
  request: z.infer<typeof legacyKnowledgeTrashRequest>) {
  if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "The isolated MCP process is read-only.");
  if (request.tool === "knowledge_file_trash" && ["scripts", "prompts"].includes(String(request.arguments.area)))
    return opaqueKnowledgeTrash(core, storage, actor, request.arguments);
  const root = storage.workspaceRoot();
  const area = request.tool === "delete_note" ? "notes" : request.tool === "delete_skill" ? "skills"
    : request.tool === "delete_paper" ? "papers" : knowledgeArea.parse(request.arguments.area);
  const pinned = await storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const files = legacyKnowledgeTree(root, area);
    const input = { ...request, files };
    const projection = projectionSchema.parse(await runLegacyMcpPython(script, [], input));
    storage.assertWorkspaceLease();
    if (JSON.stringify(files) !== JSON.stringify(legacyKnowledgeTree(root, area)))
      throw new CoreError("CONFLICT", "Original Trash selection changed during source planning.");
    const mutation = projection.mutations[0];
    if (!mutation) return { input, projection, files };
    const file = files.find(file => file.path === mutation.path && !file.directory);
    if (file && file.raw === undefined)
      throw new CoreError("NOT_AVAILABLE", "The original Trash adapter currently requires native UTF-8 Markdown.");
    if (mutation.expectedSha256 && (!file || sha256(file.raw!) !== mutation.expectedSha256))
      throw new CoreError("CONFLICT", "Knowledge changed after preview.");
    return { input, projection, files, mutation, file };
  });
  if (!pinned.mutation) return { text: pinned.projection.text, value: pinned.projection.value };
  async function dispatch(operation: string, args: Record<string, unknown>, readOnly: boolean) {
    const result = await core.dispatch(readOnly ? "capability_read" : "capability_call",
      { operation, version: 1, arguments: args }, actor);
    if (result.error) throw new CoreError(result.error.code, result.error.message, result.error.effect);
    return result.result;
  }
  const { mutation } = pinned;
  let trashResult: Record<string, unknown>;
  if (!pinned.file) trashResult = { ok: true, absent: true };
  else {
    const address = { area: mutation.area, path: mutation.path, kind: "document" };
    const preview = await dispatch("knowledge.trash.lifecycle.preview", address, true) as {
      treeSha256: string; scanRevision: string; documents: { path: string; sha256: string }[];
    };
    if (preview.documents.length !== 1 || preview.documents[0]?.path !== mutation.path
      || preview.documents[0]?.sha256 !== sha256(pinned.file.raw!))
      throw new CoreError("CONFLICT", "Original Trash target changed after source planning.");
    await storage.withWorkspaceExclusive(() => {
      storage.assertWorkspaceLease();
      if (JSON.stringify(pinned.files) !== JSON.stringify(legacyKnowledgeTree(root, area)))
        throw new CoreError("CONFLICT", "Original Trash selection or paired resources changed after preview.");
    });
    const receipt = await dispatch("knowledge.trash.move", { ...address, operationId: randomUUID(),
      expectedTreeSha256: preview.treeSha256, expectedScanRevision: preview.scanRevision, entryIdFormat: "original" }, false) as {
      entryId: string; area: string; path: string;
    };
    const metadata = await storage.withWorkspaceExclusive(() => {
      storage.assertWorkspaceLease();
      const entries = legacyKnowledgeTree(root, mutation.area, `.trash/${receipt.entryId}/metadata.json`);
      const raw = entries[0]?.raw;
      if (typeof raw !== "string" || receipt.area !== mutation.area || receipt.path !== mutation.path)
        throw new CoreError("RECOVERY_CONFLICT", "Committed Trash result requires its exact persisted metadata.", "unknown");
      const value = JSON.parse(raw);
      if (value.id !== receipt.entryId || value.originalPath !== mutation.path)
        throw new CoreError("RECOVERY_CONFLICT", "Committed Trash metadata no longer matches its receipt.", "unknown");
      return value;
    });
    trashResult = { ok: true, trash: metadata };
  }
  const result = projectionSchema.parse(await runLegacyMcpPython(script, [], { ...pinned.input, trashResult }));
  if (JSON.stringify(result.mutations) !== JSON.stringify(pinned.projection.mutations))
    throw new CoreError("RECOVERY_CONFLICT", "Original Trash result projection changed.", "unknown");
  return { text: result.text, value: result.value };
}
