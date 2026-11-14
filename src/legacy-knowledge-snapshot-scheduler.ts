import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import type { WorkspaceQuiescenceLease } from "./workspace-backup.js";
import {
  assertLegacyKnowledgeSnapshotHost, legacyKnowledgeSnapshot, legacyKnowledgeSnapshotTiming,
  inspectLegacyKnowledgeSnapshotSchedulerEnrollment, verifyLegacyKnowledgeSnapshots, type LegacyKnowledgeSnapshotHost,
} from "./legacy-knowledge-snapshots.js";
import { appendSnapshotSchedule, snapshotScheduleHash, verifySnapshotSchedule } from "./legacy-knowledge-snapshot-scheduler-state.js";

export interface LegacyKnowledgeSnapshotSchedulerOptions {
  now?: () => Date;
  onError?: (error: unknown) => void;
  /** Fault injection only; normal hosts leave this unset. */
  checkpoint?: (phase: "claimed" | "created" | "completed") => void;
}
export function createAdmittedLegacyKnowledgeSnapshotScheduler(storage: Storage, actor: Actor,
  expectedAdmissionSha256: string, options: LegacyKnowledgeSnapshotSchedulerOptions = {}) {
  storage.assertWorkspaceLease();
  inspectLegacyKnowledgeSnapshotSchedulerEnrollment(storage.workspaceRoot(), expectedAdmissionSha256);
  const authority: LegacyKnowledgeSnapshotHost = {
    authorize(binding) {
      const { operation, ...admission } = binding;
      return snapshotScheduleHash(JSON.stringify(admission)) === expectedAdmissionSha256
        && binding.allowedTools.some(tool => tool === operation);
    },
  };
  const db = storage.connectNative();
  try {
    assertLegacyKnowledgeSnapshotHost(storage, db, actor, authority, "knowledge_snapshot_configure");
    assertLegacyKnowledgeSnapshotHost(storage, db, actor, authority, "knowledge_snapshot_create");
  } finally { db.close(); }
  return createLegacyKnowledgeSnapshotScheduler(storage, actor, authority, options);
}
/** Explicit native-host lifetime; never installs an OS service or grants public paths. */
export function createLegacyKnowledgeSnapshotScheduler(storage: Storage, actor: Actor,
  authority: LegacyKnowledgeSnapshotHost, options: LegacyKnowledgeSnapshotSchedulerOptions = {}) {
  const principal = Object.freeze({ ...actor }), now = options.now ?? (() => new Date());
  let started = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined, lastError: unknown;
  let requested = false;
  let quiescing = false;
  let unregister: (() => void) | undefined;
  function transaction<T>(db: DatabaseSync, work: () => T): T {
    storage.assertWorkspaceLease(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); storage.assertWorkspaceLease(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  function inspect(db: DatabaseSync, pending = false) {
    verifyLegacyKnowledgeSnapshots(db, storage.workspaceRoot(), pending);
    assertLegacyKnowledgeSnapshotHost(storage, db, principal, authority, "knowledge_snapshot_configure");
    assertLegacyKnowledgeSnapshotHost(storage, db, principal, authority, "knowledge_snapshot_create");
    return verifySnapshotSchedule(db);
  }
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function arm() {
    clearTimer();
    if (!started || closed) return;
    const db = storage.connectNative();
    try {
      const state = inspect(db, true);
      if (!state.configuration?.enabled && !state.pending) return;
      const delay = state.pending ? 0 : Math.max(0, Date.parse(state.dueUtc!) - now().getTime());
      timer = setTimeout(() => {
        timer = undefined;
        void tick().catch(error => {
          lastError = error; options.onError?.(error);
          if (started && !closed) {
            timer = setTimeout(() => { arm(); }, 1000);
            timer.unref();
          }
        });
      }, Math.min(delay, 2_147_000_000));
      timer.unref();
    } finally { db.close(); }
  }
  const host: LegacyKnowledgeSnapshotHost = {
    authorize: authority.authorize,
    async configureSchedule(request) {
      if (closed || !started && !quiescing) throw new CoreError("NOT_AVAILABLE", "An explicitly started native snapshot scheduler is required.");
      const db = storage.connectNative();
      try {
        inspect(db, true);
        const intentRow = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get();
        const intent = intentRow && JSON.parse(String(intentRow.payload));
        if (!intent || intent.operationId !== request.operationId || intent.tool !== "knowledge_snapshot_configure"
          || intent.admission.workspaceId !== request.workspaceId
          || intent.admission.workspaceRoot !== request.workspaceRoot || intent.admission.rootPin !== request.rootPin
          || intent.admission.actorId !== request.actorId || intent.admission.authorityId !== request.authorityId
          || intent.admission.privateGitRoot !== request.privateGitRoot
          || JSON.stringify(intent.admission.allowedTools) !== JSON.stringify(request.allowedTools)
          || intent.result.enabled !== request.enabled || intent.result.local_time !== request.local_time
          || intent.result.timezone !== request.timezone || intent.result.unit !== request.unit)
          throw new CoreError("ACCESS_DENIED", "Native scheduler configuration requires its exact committed snapshot intent.");
        const event = { kind: "configure" as const, operationId: request.operationId, enabled: request.enabled,
          local_time: request.local_time, timezone: request.timezone, unit: request.unit, dueUtc: String(intent.result.next_run_utc) };
        transaction(db, () => {
          const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_knowledge_snapshot_schedule_events'").get();
          const existing = exists && db.prepare("SELECT payload FROM native_knowledge_snapshot_schedule_events WHERE json_extract(payload,'$.event.operationId')=? AND json_extract(payload,'$.event.kind')='configure'")
            .get(request.operationId);
          if (existing) {
            if (JSON.stringify(JSON.parse(String(existing.payload)).event) !== JSON.stringify(event))
              throw new CoreError("CONFLICT", "Native scheduler configuration idempotency key has different content.");
          } else appendSnapshotSchedule(db, event);
        });
        arm();
      } finally { db.close(); }
    },
  };
  async function run() {
    const job = await storage.withWorkspaceExclusive(async () => {
      const db = storage.connectNative();
      try {
        const state = inspect(db);
        if (state.pending) return state.pending;
        if (!state.configuration?.enabled || Date.parse(state.dueUtc!) > now().getTime()) return;
        const claim = { kind: "claim" as const, operationId: randomUUID(),
          configurationId: state.configuration.operationId, dueUtc: state.dueUtc! };
        transaction(db, () => appendSnapshotSchedule(db, claim));
        return claim;
      } finally { db.close(); }
    });
    if (!job) return;
    options.checkpoint?.("claimed");
    const activeJob = () => {
      const db = storage.connectNative();
      try {
        const state = inspect(db, true);
        return state.configuration?.enabled === true && state.configuration.operationId === job.configurationId;
      } finally { db.close(); }
    };
    if (activeJob()) {
      await legacyKnowledgeSnapshot(storage, principal, {
        tool: "knowledge_snapshot_create", args: { reason: "scheduled-daily" }, operationId: job.operationId,
      }, { authorize: binding => authority.authorize(binding) === true && activeJob() });
      options.checkpoint?.("created");
    }
    const completed = now(), timingDb = storage.connectNative();
    let configuration;
    try { configuration = verifySnapshotSchedule(timingDb).configuration!; } finally { timingDb.close(); }
    const timing = await legacyKnowledgeSnapshotTiming(storage, configuration.local_time, configuration.timezone, completed);
    await storage.withWorkspaceExclusive(async () => {
      const db = storage.connectNative();
      try {
        const state = inspect(db);
        transaction(db, () => appendSnapshotSchedule(db,
          state.configuration?.enabled && state.configuration.operationId === job.configurationId
            ? { kind: "complete", operationId: job.operationId, configurationId: job.configurationId,
              completedUtc: completed.toISOString(), timing: timing as {
                next_run_utc: string; next_run_local: string; abbreviation: string; timezone: string; local_time: string;
              } }
            : { kind: "cancel", operationId: job.operationId, configurationId: job.configurationId }));
      } finally { db.close(); }
    });
    options.checkpoint?.("completed");
  }
  async function tick() {
    if (closed || !started) throw new CoreError("NOT_AVAILABLE", "Native snapshot scheduler is not running.");
    requested = true;
    if (inFlight) return inFlight;
    clearTimer();
    inFlight = (async () => {
      do { requested = false; await run(); } while (requested && started && !closed);
    })();
    try { await inFlight; lastError = undefined; }
    finally { inFlight = undefined; }
    arm();
  }
  const api = {
    host,
    async start() {
      if (closed) throw new CoreError("NOT_AVAILABLE", "A closed native snapshot scheduler cannot restart.");
      if (quiescing) throw new CoreError("BUSY", "Native snapshot scheduler is held quiescent.");
      const db = storage.connectNative();
      try { inspect(db, true); } finally { db.close(); }
      unregister ??= storage.registerNativeSnapshotScheduler({
        pauseForBackup: () => api.acquireQuiescence(async () => ({ assertHeld() {}, release() {} })),
        close: () => api.close(),
      });
      started = true; arm();
    },
    tick,
    async status() {
      return storage.withWorkspaceExclusive(async () => {
        const db = storage.connectNative();
        try { return { ...inspect(db, true), started, running: !!inFlight,
          lastError: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : null }; }
        finally { db.close(); }
      });
    },
    async drain() { clearTimer(); started = false; if (inFlight) await inFlight; },
    async acquireQuiescence(acquireNative: () => Promise<WorkspaceQuiescenceLease>): Promise<WorkspaceQuiescenceLease> {
      if (closed || quiescing) throw new CoreError("BUSY", "Native snapshot scheduler cannot acquire overlapping quiescence.");
      const resume = started;
      quiescing = true; clearTimer(); started = false;
      let native: WorkspaceQuiescenceLease | undefined;
      try {
        if (inFlight) await inFlight;
        const db = storage.connectNative();
        try {
          if (inspect(db).pending) throw new CoreError("RECOVERY_REQUIRED", "A claimed snapshot occurrence must be reconciled before backup.");
        } finally { db.close(); }
        native = await acquireNative();
      } catch (error) {
        quiescing = false; started = resume && !closed; arm(); throw error;
      }
      let released = false;
      return {
        assertHeld() {
          if (released || !quiescing) throw new CoreError("BUSY", "Native snapshot scheduler quiescence was released.");
          native!.assertHeld();
        },
        async release() {
          if (released) return;
          released = true;
          try { await native!.release(); }
          finally { quiescing = false; started = resume && !closed; arm(); }
        },
      };
    },
    async close() {
      closed = true; clearTimer(); started = false;
      try { if (inFlight) await inFlight; }
      finally { unregister?.(); unregister = undefined; }
    },
  };
  return api;
}
