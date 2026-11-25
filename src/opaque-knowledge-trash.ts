import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Core } from "./core.js";
import type { Storage } from "./storage.js";
import { opaqueTrashArea, opaqueTrashPath } from "./opaque-trash-contracts.js";
import { originalMcpPrivateTopLevels, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalTrashIdentity, originalTrashRead } from "./original-native-trash-custody.js";
import { sha256 } from "./file-write.js";

export async function opaqueKnowledgeTrash(core: Core, storage: Storage, actor: Actor, input: Record<string, unknown>) {
  const area = opaqueTrashArea.parse(input.area), path = opaqueTrashPath.parse(input.path);
  const expected = z.string().regex(/^[a-f0-9]{64}$/).nullable().optional().parse(input.expected_sha256);
  const root = storage.workspaceRoot();
  const source = await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const journal = readOriginalMcpJournal(root);
    if (!actor.canWrite || actor.id !== "mcp:external" || !journal
      || area === "prompts" && journal.plan.schema !== "pkm.original-mcp-custody/v3"
      || area === "scripts" && journal.plan.schema === "pkm.original-mcp-custody/v1"
      || originalMcpPrivateTopLevels(root, area).has(path.split("/")[0]!))
      throw new CoreError("ACCESS_DENIED", "Opaque Trash requires the current public original-root writer.");
    return originalTrashIdentity(root, `${area}/${path}`);
  });
  if (!source) {
    if (expected) throw new CoreError("CONFLICT", "Knowledge changed after preview.");
    return { text: JSON.stringify({ ok: true, absent: true }), value: { ok: true, absent: true } };
  }
  if (source.kind !== "file") throw new CoreError("INVALID_ARGUMENT", "Opaque Trash requires a regular source file.");
  if (expected && source.sha256 !== expected) throw new CoreError("CONFLICT", "Knowledge changed after preview.");
  async function dispatch(operation: string, args: Record<string, unknown>, readOnly: boolean) {
    const response = await core.dispatch(readOnly ? "capability_read" : "capability_call",
      { operation, version: 1, arguments: args }, actor);
    if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
    return response.result;
  }
  const address = { area, path, kind: "opaque" };
  const preview = await dispatch("knowledge.trash.lifecycle.preview", address, true) as {
    treeSha256: string; scanRevision: string;
  };
  await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    if (JSON.stringify(originalTrashIdentity(root, `${area}/${path}`)) !== JSON.stringify(source))
      throw new CoreError("CONFLICT", "Opaque source changed after exact byte selection.");
  });
  const receipt = await dispatch("knowledge.trash.move", { ...address, operationId: randomUUID(),
    expectedTreeSha256: preview.treeSha256, expectedScanRevision: preview.scanRevision,
    entryIdFormat: "original" }, false) as { entryId: string; area: string; path: string };
  const metadata = await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const base = `${area}/.trash/${receipt.entryId}`;
    const payload = originalTrashRead(root, `${base}/payload`);
    if (receipt.area !== area || receipt.path !== path || sha256(payload) !== source!.sha256)
      throw new CoreError("RECOVERY_CONFLICT", "Opaque Trash receipt no longer matches its exact reviewed bytes.", "unknown");
    const result = JSON.parse(originalTrashRead(root, `${base}/metadata.json`, 8192).toString("utf8"));
    if (result.id !== receipt.entryId || result.originalPath !== path)
      throw new CoreError("RECOVERY_CONFLICT", "Opaque Trash metadata no longer matches its durable receipt.", "unknown");
    return result;
  });
  const value = { ok: true, trash: metadata };
  return { text: JSON.stringify(value), value };
}
