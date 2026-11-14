import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stripTypeScriptTypes } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { capturedDeclarations as threadOriginal } from "./domain/project-thread-original.js";
import { capturedDeclarations as projectModelOriginal } from "./domain/project-mutations-original-project-model.js";
import { readProjectRecipes } from "./project-recipes.js";
import {
  legacyProjectDomainDigest, readCurrentLegacyProjectSnapshot, readLegacyProjectControl,
} from "./legacy-control-import.js";
import { projectMutationInputs } from "./project-mutations-contracts.js";
import { checkLegacyExtensionCommand, legacyExtensionEnvelopeSchema, LegacyExtensionJournalError,
  type LegacyExtensionEnvelope } from "./legacy-command-extension-journal.js";
import { compileLegacyExtensionEffectPlan, stageLegacyExtensionEffect, recoverLegacyExtensionEffects,
  commitLegacyExtensionEffects, assertLegacyExtensionRoot, compileLegacyProjectThreadExtensionEffect,
  stageLegacyProjectThreadExtensionEffect } from "./legacy-command-extension-recovery.js";
import {
  planLegacyProjectThreadEffect, type LegacyProjectThreadDomain, type LegacyProjectThreadEffect,
  type LegacyProjectThreadRequest,
} from "./legacy-project-thread-parity.js";

export const LEGACY_EXTENSION_OPERATIONS = [
  "project-archive", "recipe-create", "recipe-update", "project-create",
  "thread-create", "thread-rename", "thread-move",
] as const;
const { operationId: _operationId, ...recipeCreateShape } = projectMutationInputs["project.recipe.create"].shape;
export const legacyExtensionInputs = {
  "project-archive": projectMutationInputs["project.archive"].omit({ operationId: true }),
  "recipe-create": z.strictObject(recipeCreateShape).refine(value => value.scope === "project"
    ? value.projectId !== undefined : value.projectId === undefined, "projectId is required only for Project-scoped Recipes."),
  "recipe-update": projectMutationInputs["project.recipe.update"].omit({ operationId: true }),
  "project-create": z.strictObject({ name: z.string().max(4096) }),
  "thread-create": z.strictObject({ projectId: z.string().min(1).max(128), name: z.string().max(4096) }),
  "thread-rename": z.strictObject({ threadId: z.string().min(1).max(128), name: z.string().max(4096) }),
  "thread-move": z.strictObject({
    threadId: z.string().min(1).max(128), destinationProjectId: z.string().min(1).max(128),
    linkedActiveRunIds: z.array(z.string().min(1).max(4096)),
    includedRunIds: z.array(z.string().min(1).max(4096)),
    audienceChanges: z.boolean(), audienceChangeConfirmed: z.boolean(),
  }),
} as const;
export const legacyExtensionInvocationSchema = z.strictObject({
  envelope: legacyExtensionEnvelopeSchema,
  args: z.record(z.string(), z.json()).optional(),
});

export interface LegacyExtensionHost {
  /** A synchronous, trusted ownership/fence check, not a filesystem action. */
  assertExclusive(): void;
}
function transaction<T>(db: DatabaseSync, host: LegacyExtensionHost, action: () => T): T {
  if (db.isTransaction) throw new LegacyExtensionJournalError("TRANSACTION_ALREADY_OPEN", "Extension runtime requires its own short SQL phases.");
  host.assertExclusive();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    host.assertExclusive();
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Current original snapshot includes canonical Recipes, never a saved command result. */
export function readLegacyExtensionSnapshot(db: DatabaseSync, root: string, workspaceId: string) {
  if (db.isTransaction) throw new LegacyExtensionJournalError("FILESYSTEM_TRANSACTION_FORBIDDEN", "Read the snapshot outside SQL.");
  assertLegacyExtensionRoot(db, root, workspaceId);
  const domain = readCurrentLegacyProjectSnapshot(db, workspaceId);
  const recipes: Array<Record<string, unknown>> = [];
  let offset: number | null = 0, snapshotRevision: string | undefined;
  while (offset !== null) {
    const page = readProjectRecipes(root, { operation: "project.recipe.list", actorId: "legacy-extension-snapshot",
      args: { offset, limit: 100, ...(snapshotRevision ? { snapshotRevision } : {}) } }) as {
        items: Array<{ recipeId: string }>; nextOffset: number | null; snapshotRevision: string;
      };
    snapshotRevision = page.snapshotRevision;
    for (const item of page.items) {
      recipes.push((readProjectRecipes(root, { operation: "project.recipe.get", actorId: "legacy-extension-snapshot",
        args: { id: item.recipeId, snapshotRevision } }) as { item: Record<string, unknown> }).item);
    }
    offset = page.nextOffset;
  }
  const folders = new Set<string>();
  for (const recipe of recipes) {
    const parts = String(recipe.category ?? "").split("/").filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
  }
  return { schema: 1 as const, ...domain, recipes, recipeFolders: [...folders].sort((a, b) => a.localeCompare(b)),
    recipeTrash: [] };
}

function globalAdmission(db: DatabaseSync, envelope: LegacyExtensionEnvelope) {
  const prior = db.prepare("SELECT fingerprint,actor_id,operation FROM receipts WHERE operation_id=?")
    .get(envelope.operationId) as Record<string, unknown> | undefined;
  if (prior && (prior.fingerprint !== envelope.globalFingerprint || prior.actor_id !== envelope.actorId
    || prior.operation !== "project.legacy.command")) {
    throw new LegacyExtensionJournalError("GLOBAL_OPERATION_CONFLICT", "Global operation ID belongs to another request.");
  }
  return prior;
}

/**
 * Explicit native composition seam, not a registered public capability.
 * The host owns the workspace across admission, preflight, effects and commit;
 * shared startup's existing fail-closed gate is intentionally unchanged.
 */
export function executeLegacyExtensionCommand(db: DatabaseSync, root: string, value: z.infer<typeof legacyExtensionInvocationSchema>,
  host: LegacyExtensionHost, now: string) {
  const { envelope, args } = legacyExtensionInvocationSchema.parse(value);
  z.string().datetime({ offset: true }).parse(now);
  if (["project-create", "thread-create", "thread-rename", "thread-move"].includes(envelope.command.operation)) {
    const admission = transaction(db, host, () => {
      const decision = checkLegacyExtensionCommand(db, envelope.workspaceId, envelope.command);
      globalAdmission(db, envelope);
      if (db.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()
        || db.prepare("SELECT 1 FROM legacy_command_extension_intent LIMIT 1").get()) {
        throw new LegacyExtensionJournalError("BUSY", "Pending extension intent requires explicit recovery.");
      }
      for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource",
        "pending_document_lifecycle", "data_runtime_intents", "migration_runtime_intents"]) {
        if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new LegacyExtensionJournalError("BUSY", "Another workspace journal is pending.");
      }
      return decision;
    });
    host.assertExclusive();
    if (admission.status === "replay") {
      const snapshot = readLegacyExtensionSnapshot(db, root, envelope.workspaceId);
      const result = { snapshot, entityId: admission.entityId, replayed: true, storeVersion: snapshot.storeVersion };
      transaction(db, host, () => {
        const current = checkLegacyExtensionCommand(db, envelope.workspaceId, envelope.command);
        if (current.status !== "replay" || current.storeVersion !== snapshot.storeVersion) {
          throw new LegacyExtensionJournalError("STORE_VERSION_CONFLICT", "Workspace changed during replay snapshot inspection.");
        }
        if (!globalAdmission(db, envelope)) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
          .run(envelope.operationId, envelope.globalFingerprint, JSON.stringify(result), envelope.actorId, "project.legacy.command", now);
      });
      return result;
    }
    const operation = envelope.command.operation as keyof typeof legacyExtensionInputs;
    const parsedArgs = legacyExtensionInputs[operation]?.parse(args);
    if (!parsedArgs) throw new LegacyExtensionJournalError("LEGACY_COMMAND_UNSUPPORTED", "Unsupported Project/Thread extension operation.");
    assertLegacyExtensionRoot(db, root, envelope.workspaceId);
    const control = readLegacyProjectControl(db, envelope.workspaceId);
    if (!control) throw new LegacyExtensionJournalError("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
    const first = readProjectRecipes(root, {
      operation: "project.list", args: { offset: 0, limit: 100 }, actorId: "legacy-project-thread",
    }) as { snapshotRevision: string };
    const current = readLegacyExtensionSnapshot(db, root, envelope.workspaceId);
    const before: LegacyProjectThreadDomain = {
      rootId: control.rootId, projects: current.projects as LegacyProjectThreadDomain["projects"],
      threads: current.threads as LegacyProjectThreadDomain["threads"],
      ganttTasks: current.ganttTasks as LegacyProjectThreadDomain["ganttTasks"],
      collaborationTasks: current.collaborationTasks as LegacyProjectThreadDomain["collaborationTasks"],
    };
    const authenticated = readCurrentLegacyProjectSnapshot(db, envelope.workspaceId);
    if (legacyProjectDomainDigest(authenticated) !== control.canonicalDigest
      || legacyProjectDomainDigest({ ...before, storeVersion: control.storeVersion }) !== control.canonicalDigest) {
      throw new LegacyExtensionJournalError("CONTROL_RECOVERY_CONFLICT", "Original Project control differs from the native before-state.");
    }
    const state = { ...before, audit: [] as Array<{ event: string; entityId: string }> };
    const { createProject, createThread, renameThread, moveThread } = originalProjectThreadModel();
    let updated: typeof state;
    switch (envelope.command.operation) {
      case "project-create":
        updated = createProject(state, (parsedArgs as { name: string }).name, randomUUID);
        break;
      case "thread-create": {
        const input = parsedArgs as { projectId: string; name: string };
        updated = createThread(state, input.projectId, input.name, randomUUID);
        break;
      }
      case "thread-rename": {
        const input = parsedArgs as { threadId: string; name: string };
        updated = renameThread(state, input.threadId, input.name);
        break;
      }
      default:
        updated = moveThread(state, parsedArgs as Parameters<typeof moveThread>[1]);
        break;
    }
    const after: LegacyProjectThreadDomain = {
      rootId: control.rootId, projects: updated.projects, threads: updated.threads,
      ganttTasks: updated.ganttTasks, collaborationTasks: updated.collaborationTasks,
    };
    const effect = planLegacyProjectThreadEffect(root, {
      workspaceId: envelope.workspaceId, rootId: control.rootId, actorId: envelope.actorId,
      operationId: envelope.operationId, expectedSnapshotRevision: first.snapshotRevision,
      command: envelope.command, operation: envelope.command.operation as LegacyProjectThreadEffect["operation"],
      args: parsedArgs as LegacyProjectThreadRequest["args"],
    }, { before, after }, control);
    const prepared = compileLegacyProjectThreadExtensionEffect(db, root, envelope, effect);
    transaction(db, host, () => stageLegacyProjectThreadExtensionEffect(db, envelope, prepared));
    return resumeLegacyExtensionCommand(db, root, envelope, host, now);
  }
  const admission = transaction(db, host, () => {
    const decision = checkLegacyExtensionCommand(db, envelope.workspaceId, envelope.command);
    globalAdmission(db, envelope);
    if (db.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()
      || db.prepare("SELECT 1 FROM legacy_command_extension_intent LIMIT 1").get()) {
      throw new LegacyExtensionJournalError("BUSY", "Pending extension intent requires explicit recovery.");
    }
    for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource",
      "pending_document_lifecycle", "data_runtime_intents", "migration_runtime_intents"]) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new LegacyExtensionJournalError("BUSY", "Another workspace journal is pending.");
    }
    return decision;
  });
  host.assertExclusive();
  if (admission.status === "replay") {
    const snapshot = readLegacyExtensionSnapshot(db, root, envelope.workspaceId);
    const result = { snapshot, entityId: admission.entityId, replayed: true, storeVersion: snapshot.storeVersion };
    transaction(db, host, () => {
      const current = checkLegacyExtensionCommand(db, envelope.workspaceId, envelope.command);
      if (current.status !== "replay" || current.storeVersion !== snapshot.storeVersion) {
        throw new LegacyExtensionJournalError("STORE_VERSION_CONFLICT", "Workspace changed during replay snapshot inspection.");
      }
      if (!globalAdmission(db, envelope)) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(envelope.operationId, envelope.globalFingerprint, JSON.stringify(result), envelope.actorId, "project.legacy.command", now);
    });
    return result;
  }
  const input = legacyExtensionInputs[envelope.command.operation as keyof typeof legacyExtensionInputs];
  if (!input) throw new LegacyExtensionJournalError("LEGACY_COMMAND_UNSUPPORTED", "Unsupported new extension operation.");
  const parsedArgs = input.parse(args);
  const effect = compileLegacyExtensionEffectPlan(db, root, envelope, parsedArgs);
  transaction(db, host, () => stageLegacyExtensionEffect(db, envelope, effect));
  return resumeLegacyExtensionCommand(db, root, envelope, host, now);
}

export function resumeLegacyExtensionCommand(db: DatabaseSync, root: string, envelope: LegacyExtensionEnvelope,
  host: LegacyExtensionHost, now: string) {
  host.assertExclusive();
  const verified = recoverLegacyExtensionEffects(db, root, envelope);
  const snapshot = readLegacyExtensionSnapshot(db, root, envelope.workspaceId);
  host.assertExclusive();
  transaction(db, host, () => commitLegacyExtensionEffects(db, envelope, { ...verified, snapshot }, now));
  const version = readLegacyProjectControl(db, envelope.workspaceId)!.storeVersion;
  const entityId = verified.effect.schema === "pkm.legacy-project-thread-extension/v1"
    ? verified.effect.effect.entityId : verified.effect.plan.result.entityId;
  return { snapshot: { ...snapshot, storeVersion: version }, entityId,
    replayed: false, storeVersion: version };
}

function originalProjectThreadModel() {
  const derive = projectModelOriginal.find(value => value.startsWith("export function deriveSystemId"))!.replace(/^export /, "");
  const createProject = projectModelOriginal.find(value => value.startsWith("export function createProject"))!.replace(/^export /, "");
  const createThread = threadOriginal.createThread.replace(/^export /, "");
  const renameThread = threadOriginal.renameThread.replace(/^export /, "");
  const moveThread = threadOriginal.moveThread.replace(/^export /, "");
  class ProjectModelError extends Error {
    constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
  }
  const factory = new Function("createHash", "randomUUID", "ProjectModelError",
    `${stripTypeScriptTypes(`${derive}\n${createProject}\n${createThread}\n${renameThread}\n${moveThread}`, { mode: "strip" })}\nreturn {deriveSystemId,createProject,createThread,renameThread,moveThread};`);
  return factory(createHash, randomUUID, ProjectModelError) as {
    deriveSystemId(parentId: string, key: "pkm/default-project/v1" | "pkm/general-thread/v1"): string;
    createProject(state: Record<string, any>, name: string, createId: () => string): any;
    createThread(state: Record<string, any>, projectId: string, name: string, createId: () => string): any;
    renameThread(state: Record<string, any>, threadId: string, name: string): any;
    moveThread(state: Record<string, any>, plan: Record<string, any>): any;
  };
}
