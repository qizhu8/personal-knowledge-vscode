import { createHash, randomUUID } from "node:crypto";
import { CoreError } from "./contracts.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { compileRecipeMethodologyV1 } from "./domain/project-recipes-methodology-model.js";
import { normalizeRecipeCategory, validateRecipeRecord } from "./domain/project-recipes-storage-rules.js";
import type { ProjectRecipeRecord } from "./project-recipes.js";
import { recipeLibraryEditable } from "./recipe-library-fields.js";
export { recipeLibraryEditable } from "./recipe-library-fields.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export type LibraryRecord = ProjectRecipeRecord & {
  editorLayout?: z.infer<typeof recipeLibraryEditable>["editorLayout"];
};
const nativeRecord = recipeLibraryEditable.extend({
  schema: z.literal("pkm.knowledge/v1"), knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/),
  aliases: z.array(z.string().min(1)).min(1),
  recipeId: z.string().regex(/^recipe_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  scope: z.literal("global"), revision: z.number().int().safe().positive(),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  methodologyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  origin: z.strictObject({ kind: z.string(), sourceRecipeId: z.string().optional(), sourceKey: z.string().optional(),
    sourceRevision: z.number().int().safe().positive().optional(), sourceScope: z.enum(["global", "project"]).optional(),
    brokerName: z.string().optional(), publisherUser: z.string().optional(), publisherHost: z.string().optional() }).optional(),
});
type Snapshot = { snapshotRevision: string; recipes: ProjectRecipeRecord[] };

/** Native-owned definitions and receipts only. Original filesystem/ProjectStore authorities are never written. */
export class NativeRecipeLibrary {
  private closed = false;
  constructor(private readonly options: {
    database: DatabaseSync; workspaceId: string; assertLease(): void;
    original(): Snapshot;
    fault?(point: "before-commit" | "after-commit", operationId: string): void;
  }) {
    options.assertLease();
    options.database.exec(`
      CREATE TABLE IF NOT EXISTS native_recipe_library_records(
        workspace_id TEXT NOT NULL, recipe_id TEXT NOT NULL, original_digest TEXT NOT NULL,
        record TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(workspace_id,recipe_id));
      CREATE TABLE IF NOT EXISTS native_recipe_library_receipts(
        operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    `);
  }
  private assert() {
    if (this.closed) throw new Error("Recipe library closed.");
    this.options.assertLease();
  }
  snapshot() {
    this.assert();
    const original = this.options.original(), records = new Map(original.recipes.map(row => [row.recipeId, row]));
    const rows = this.options.database.prepare(
      "SELECT * FROM native_recipe_library_records WHERE workspace_id=? ORDER BY recipe_id").all(this.options.workspaceId);
    for (const row of rows) {
      const base = records.get(String(row.recipe_id));
      if (row.original_digest !== hash(base ?? null)) throw new Error("Original Recipe authority changed; explicit reconciliation required.");
      const record = nativeRecord.parse(JSON.parse(String(row.record)));
      if (hash(record) !== row.digest || record.recipeId !== row.recipe_id) throw new Error("Damaged native Recipe record.");
      if (base && record.revision <= base.revision) throw new Error("Native Recipe revision predates its original source.");
      validateRecipeRecord(record);
      recipeLibraryEditable.parse(this.editable(record));
      records.set(record.recipeId, record);
    }
    this.assert();
    return { ...original, recipes: [...records.values()],
      snapshotRevision: hash({ original: original.snapshotRevision, native: rows.map(row => [row.recipe_id, row.digest]) }) };
  }
  editable(record: LibraryRecord) {
    return Object.fromEntries(Object.keys(recipeLibraryEditable.shape).filter(key => key in record)
      .map(key => [key, record[key as keyof LibraryRecord]]));
  }
  draft(templateId: string) {
    const template = this.snapshot().recipes.find(row => row.recipeId === templateId);
    if (!template) throw new Error("Recipe template no longer exists.");
    const recipeId = `recipe_${randomUUID()}`;
    return { ...this.editable(template), recipeId, revision: 0, name: "Untitled Recipe", scope: "global",
      schema: "pkm.knowledge/v1", knowledgeId: `knowledge_${hash(recipeId).slice(0, 24)}`,
      aliases: [`recipe:${recipeId}`], origin: { kind: "native" }, executableDigest: template.executableDigest };
  }
  validate(value: unknown) {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > 262144) throw new CoreError("INVALID_ARGUMENT", "Recipe definition exceeds compiler budget.");
    const compiled = compileWorkflowDefinitionV1(value);
    if (!compiled.ok) throw new CoreError("INVALID_ARGUMENT", "Recipe workflow definition is invalid.");
    return { definition: compiled.model, executableDigest: compiled.executableDigest };
  }
  save(input: {
    actorId: string; operationId: string; recipeId: string; expectedRevision: number;
    expectedSnapshot: string; fields: unknown;
  }): LibraryRecord {
    this.assert();
    if (!z.string().uuid().safeParse(input.operationId).success
      || !/^recipe_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.recipeId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new CoreError("INVALID_ARGUMENT", "Invalid native Recipe operation identity.");
    const fields = recipeLibraryEditable.parse(input.fields);
    if (canonicalJson(fields).length > 1048576) throw new CoreError("INVALID_ARGUMENT", "Recipe exceeds authoring budget.");
    const compiled = this.validate(fields.definition);
    const nodeIds = new Set(compiled.definition.spec.nodes.map(node => node.nodeId)), seen = new Set<string>();
    for (const entry of fields.nodeBindings ?? []) {
      if (!nodeIds.has(entry.nodeId) || seen.has(entry.nodeId)) throw new CoreError("INVALID_ARGUMENT", "Invalid Recipe node reference.");
      seen.add(entry.nodeId);
      const bindings = new Set<string>();
      for (const binding of entry.bindings) {
        if (bindings.has(binding.bindingId)) throw new CoreError("INVALID_ARGUMENT", "Duplicate Recipe knowledge binding.");
        bindings.add(binding.bindingId);
      }
    }
    if (fields.editorLayout && Object.keys(fields.editorLayout.nodePositions).some(id => !nodeIds.has(id)))
      throw new CoreError("INVALID_ARGUMENT", "Layout references a missing Recipe node.");
    let methodologyDigest: string | undefined;
    if (fields.methodology !== undefined) {
      const methodology = compileRecipeMethodologyV1(fields.methodology);
      if (!methodology.ok) throw new CoreError("INVALID_ARGUMENT", "Invalid Methodology Manifest.");
      methodologyDigest = methodology.methodologyDigest;
    }
    const fingerprint = hash({ ...input, fields }), db = this.options.database;
    db.exec("BEGIN IMMEDIATE");
    let result: LibraryRecord;
    try {
      const receipt = db.prepare("SELECT * FROM native_recipe_library_receipts WHERE operation_id=?").get(input.operationId);
      if (receipt) {
        if (receipt.workspace_id !== this.options.workspaceId || receipt.actor_id !== input.actorId
          || receipt.fingerprint !== fingerprint) throw new Error("Recipe operation ID reused with different input.");
        result = JSON.parse(String(receipt.result));
      } else {
        const snapshot = this.snapshot(), current = snapshot.recipes.find(row => row.recipeId === input.recipeId);
        if (snapshot.snapshotRevision !== input.expectedSnapshot || (current?.revision ?? 0) !== input.expectedRevision)
          throw new Error("Recipe revision/source conflict; reload before saving.");
        if (current?.systemKind || current && current.scope !== "global")
          throw new Error("Built-in or non-global Recipe is read-only; create a distinct copy.");
        const identity = current ? Object.fromEntries(
          ["schema", "knowledgeId", "aliases", "origin"].filter(key => key in current)
            .map(key => [key, current[key as keyof ProjectRecipeRecord]])) : {
          schema: "pkm.knowledge/v1", knowledgeId: `knowledge_${hash(input.recipeId).slice(0, 24)}`,
          aliases: [`recipe:${input.recipeId}`], origin: { kind: "native" },
        };
        result = JSON.parse(canonicalJson({ ...identity, ...fields, scope: "global", recipeId: input.recipeId,
          category: normalizeRecipeCategory(fields.category), revision: input.expectedRevision + 1,
          definition: compiled.definition, executableDigest: compiled.executableDigest,
          ...(methodologyDigest ? { methodologyDigest } : {}) }));
        validateRecipeRecord(result);
        nativeRecord.parse(result);
        const original = this.options.original().recipes.find(row => row.recipeId === input.recipeId);
        db.prepare("INSERT INTO native_recipe_library_records VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,recipe_id) DO UPDATE SET record=excluded.record,digest=excluded.digest")
          .run(this.options.workspaceId, input.recipeId, hash(original ?? null), canonicalJson(result), hash(result));
        db.prepare("INSERT INTO native_recipe_library_receipts VALUES(?,?,?,?,?)")
          .run(input.operationId, this.options.workspaceId, input.actorId, fingerprint, canonicalJson(result));
        this.options.fault?.("before-commit", input.operationId);
      }
      this.assert(); db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    try { this.options.fault?.("after-commit", input.operationId); }
    catch { throw new CoreError("RECIPE_OPERATION_UNCERTAIN", "Native Recipe committed; inspect its durable operation receipt before any retry.", "unknown"); }
    return result;
  }
  close() { if (!this.closed) { this.closed = true; this.options.database.close(); } }
}
