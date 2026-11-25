import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { assertRootOwner, assertRootReadScope, type RootOwner, type RootReadScope } from "./root-owner.js";
import { capturePlainWorkspaceControls, type PlainWorkspaceControls } from "./workspace-validation.js";
import { classifyStorageStartup } from "./storage-startup-classification.js";
import { createFreshRootScanner } from "./markdown-read.js";
import { createFreshNoteQueryModel, initializeFreshNoteQuerySchema } from "./fresh-note-query-model.js";
import { openFreshNoteIndex } from "./fresh-note-index-storage.js";
import type { FreshNoteGuardPhase, FreshNoteQuery, FreshNoteQueryModel, FreshNoteQueryReply } from "./fresh-note-query-contracts.js";

export interface RootOwnerBasicNoteRead {
  read(scope: RootReadScope, query: FreshNoteQuery): Promise<FreshNoteQueryReply | undefined>;
  close(): Promise<void>;
}

/** A disposable Note projection, not a Storage attachment or a recovery authority. */
export function createRootOwnerBasicNoteRead(owner: RootOwner, database: DatabaseSync,
  failedAttachment: (error: unknown) => void): RootOwnerBasicNoteRead {
  assertRootOwner(owner);
  let model: FreshNoteQueryModel | undefined, initialFailure: unknown;
  let index: ReturnType<typeof openFreshNoteIndex> | undefined;
  let active: { scope: RootReadScope; controls: PlainWorkspaceControls; initializing: boolean } | undefined;
  let accepting = true, tail: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined;

  function assertPhase(phase: FreshNoteGuardPhase) {
    const context = active;
    if (initialFailure !== undefined) throw initialFailure;
    if (!context || phase === "initialize" && !context.initializing)
      throw new CoreError("ACCESS_DENIED", "Basic Note queries require their active canonical root scope.");
    if (context.scope.full || !owner.supportsFreshLegacyReads(context.scope))
      throw new CoreError("STORAGE_UNAVAILABLE", "Basic Note reads cannot impersonate a full Storage attachment.", "unknown");
    index?.assertHeld();
    const controls = capturePlainWorkspaceControls(context.scope.root);
    if (!controls || controls.workspaceId !== context.scope.workspaceId || controls.digest !== context.controls.digest)
      throw new CoreError("CONFLICT", "Workspace controls changed during the basic Note query.");
    if (classifyStorageStartup(context.scope.root, database).kind !== "plain")
      throw new CoreError("RECOVERY_REQUIRED", "Native workspace state blocks the basic Note query.", "unknown");
    // The owner checks its separate lifetime lease connection, never this query's SQL snapshot.
    assertRootReadScope(context.scope, owner);
    return { workspaceId: controls.workspaceId, rootPin: controls.rootPin };
  }

  return {
    read(scope, query) {
      assertRootReadScope(scope, owner);
      if (!accepting)
        return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Basic Note admission is closed.", "unknown"));
      const read = tail.then(async () => {
        if (initialFailure !== undefined) throw initialFailure;
        assertRootReadScope(scope, owner);
        if (scope.full || (await owner.qualifyFreshLegacyReadScope(scope)).kind !== "plain") return undefined;
        const controls = capturePlainWorkspaceControls(scope.root);
        if (!controls) return undefined;
        active = { scope, controls, initializing: true };
        try {
          if (!model) {
            const guard = { assert: assertPhase };
            index = openFreshNoteIndex(scope.root, database);
            // Opening a new runtime directory changes the control inventory before this query begins.
            active.controls = capturePlainWorkspaceControls(scope.root)!;
            initializeFreshNoteQuerySchema(index.database, guard);
            const scanner = createFreshRootScanner(scope.root);
            let initialScan = true;
            model = createFreshNoteQueryModel({ database: index.database, scanner: {
              rootPin: scanner.rootPin, statistics: scanner.statistics,
              scan() {
                try {
                  const result = scanner.scan();
                  initialScan = false;
                  return result;
                } catch (error) {
                  // Canonical initial source-validation failure must not reopen thin path admission.
                  if (initialScan) { initialFailure = error; failedAttachment(error); }
                  throw error;
                }
              },
            }, guard });
          }
          active.initializing = false;
          const reply = model.executeFresh(query);
          assertPhase("after-query");
          const eligibility = await owner.qualifyFreshLegacyReadScope(scope);
          const after = capturePlainWorkspaceControls(scope.root);
          if (!after || after.digest !== active.controls.digest)
            throw new CoreError("CONFLICT", "Workspace controls changed after the basic Note query.");
          if (eligibility.kind !== "plain")
            throw new CoreError("RECOVERY_REQUIRED", "Workspace state changed during the basic Note query.", "unknown");
          scope.assertHeld();
          return reply;
        } finally { active = undefined; }
      });
      tail = read.then(() => undefined, () => undefined);
      return read;
    },
    close() {
      accepting = false;
      return closing ??= (async () => {
        await tail;
        model?.close();
        index?.close();
        database.close();
        model = undefined;
      })();
    },
  };
}
