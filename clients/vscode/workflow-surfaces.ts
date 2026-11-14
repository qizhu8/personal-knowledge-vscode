export const workflowSurfaceOperations = Object.freeze({
  knowledgeList: { operation: "knowledge.document.list", readOnly: true },
  knowledgeGet: { operation: "knowledge.document.get", readOnly: true },
  knowledgeUpdate: { operation: "knowledge.document.update", readOnly: false },
  metadataGet: { operation: "knowledge.metadata.get", readOnly: true },
  metadataUpdate: { operation: "knowledge.metadata.update", readOnly: false },
  assetList: { operation: "knowledge.asset.list", readOnly: true },
  uploadList: { operation: "knowledge.upload.list", readOnly: true },
  uploadBegin: { operation: "knowledge.upload.begin", readOnly: false },
  uploadAppend: { operation: "knowledge.upload.append", readOnly: false },
  uploadGet: { operation: "knowledge.upload.get", readOnly: true },
  uploadCommit: { operation: "knowledge.upload.commit", readOnly: false },
  uploadAbort: { operation: "knowledge.upload.abort", readOnly: false },
  todoBoards: { operation: "todo.board.list", readOnly: true },
  todoBoard: { operation: "todo.board.get", readOnly: true },
  todoItems: { operation: "todo.workitem.list", readOnly: true },
  todoItem: { operation: "todo.workitem.get", readOnly: true },
  todoClaim: { operation: "todo.workitem.claim", readOnly: false },
  todoAccept: { operation: "todo.workitem.accept", readOnly: false },
  workflowGet: { operation: "workflow.run.get", readOnly: true },
  workflowEvents: { operation: "workflow.run.events", readOnly: true },
  workflowCancel: { operation: "workflow.run.cancel", readOnly: false },
  actionGet: { operation: "action.runtime.get", readOnly: true },
  actionEvents: { operation: "action.runtime.events", readOnly: true },
  actionCancel: { operation: "action.runtime.cancel", readOnly: false },
} as const);

export const workflowSurfaceScope = Object.freeze({
  implemented: Object.freeze([
    "document-list-get-edit", "metadata-patch", "document-cas-conflict-diff", "durable-upload-resume",
    "todo-board-read", "todo-claim", "todo-delegated-accept-attempt", "workflow-status-events-cancel",
    "action-status-events-cancel-when-host-capability-exists",
  ]),
  notImplemented: Object.freeze([
    "full-production-ux-parity", "specialized-note-skill-research-editors", "citation-authoring-and-resolution",
    "knowledge-create-trash-restore", "asset-download-rename-delete", "todo-authoring-and-complete-lifecycle",
    "workflow-definition-authoring-or-step-execution", "action-create-or-step-execution",
    "native-human-review-or-approval", "role-override", "manager-and-chat-surfaces",
  ]),
});

export type Sha256 = string;
export type OperationId = string;
export type DocumentId = string;
export interface DocumentEdit {
  operationId: OperationId;
  id: DocumentId;
  expectedRevision: number;
  expectedSha256: Sha256;
  title: string;
  content: string;
}
export interface MetadataPatch {
  operationId: OperationId;
  id: DocumentId;
  expectedRevision: number;
  expectedSha256: Sha256;
  set: Record<string, unknown>;
  remove: string[];
}
export interface UploadBegin {
  operationId: OperationId;
  id: DocumentId;
  expectedRevision: number;
  expectedSha256: Sha256;
  name: string;
  size: number;
  digest: `sha256:${string}`;
}
export interface UploadChunk {
  operationId: OperationId;
  uploadId: string;
  offset: number;
  data: string;
}
export interface UploadMutation { operationId: OperationId; uploadId: string; }
export interface TodoIdentity { board_slug: string; id: string; }
export type TodoState = "todo" | "active" | "blocked" | "on-hold" | "completed";
export interface TodoClaim extends TodoIdentity { operationId: OperationId; expected_digest: Sha256; }
export interface TodoAccept extends TodoClaim { reason: string; }
export interface WorkflowLookup { runId: string; }
export interface WorkflowEvents extends WorkflowLookup { expectedVersion: number; after?: number; limit?: number; }
export interface WorkflowCancel extends WorkflowLookup { operationId: OperationId; expectedVersion: number; }
export interface ActionEvents extends WorkflowLookup { after?: number; limit?: number; }
export interface ActionCancel extends WorkflowCancel {}

export interface WorkflowSurfaceClient {
  available(key: keyof typeof workflowSurfaceOperations): boolean;
  knowledgeList(input?: { offset?: number; limit?: number; workspaceRevision?: Sha256; includeDeleted?: boolean; area?: "notes" | "skills" | "papers" }): Promise<unknown>;
  knowledgeGet(input: { id: DocumentId }): Promise<unknown>;
  knowledgeUpdate(input: DocumentEdit): Promise<unknown>;
  metadataGet(input: { id: DocumentId }): Promise<unknown>;
  metadataUpdate(input: MetadataPatch): Promise<unknown>;
  assetList(input: { id: DocumentId }): Promise<unknown>;
  uploadList(input: Record<string, never>): Promise<unknown>;
  uploadBegin(input: UploadBegin): Promise<unknown>;
  uploadAppend(input: UploadChunk): Promise<unknown>;
  uploadGet(input: { uploadId: string }): Promise<unknown>;
  uploadCommit(input: UploadMutation): Promise<unknown>;
  uploadAbort(input: UploadMutation): Promise<unknown>;
  todoBoards(input?: { offset?: number; limit?: number; query?: string }): Promise<unknown>;
  todoBoard(input: { board_slug: string }): Promise<unknown>;
  todoItems(input: TodoIdentity & {
    offset?: number; limit?: number; states?: TodoState[]; story_id?: string; owner_id?: string;
    unassigned?: boolean; actionable?: boolean; expected_digest?: Sha256; query?: string; include_deleted?: boolean;
  }): Promise<unknown>;
  todoItem(input: TodoIdentity & { include_deleted?: boolean }): Promise<unknown>;
  todoClaim(input: TodoClaim): Promise<unknown>;
  todoAccept(input: TodoAccept): Promise<unknown>;
  workflowGet(input: WorkflowLookup): Promise<unknown>;
  workflowEvents(input: WorkflowEvents): Promise<unknown>;
  workflowCancel(input: WorkflowCancel): Promise<unknown>;
  actionGet(input: WorkflowLookup): Promise<unknown>;
  actionEvents(input: ActionEvents): Promise<unknown>;
  actionCancel(input: ActionCancel): Promise<unknown>;
}

export interface WorkflowSurfaceBridge {
  knowledgeList(input?: Parameters<WorkflowSurfaceClient["knowledgeList"]>[0]): ReturnType<WorkflowSurfaceClient["knowledgeList"]>;
  knowledgeGet(input: Parameters<WorkflowSurfaceClient["knowledgeGet"]>[0]): ReturnType<WorkflowSurfaceClient["knowledgeGet"]>;
  knowledgeUpdate(input: Parameters<WorkflowSurfaceClient["knowledgeUpdate"]>[0]): ReturnType<WorkflowSurfaceClient["knowledgeUpdate"]>;
  metadataGet(input: Parameters<WorkflowSurfaceClient["metadataGet"]>[0]): ReturnType<WorkflowSurfaceClient["metadataGet"]>;
  metadataUpdate(input: Parameters<WorkflowSurfaceClient["metadataUpdate"]>[0]): ReturnType<WorkflowSurfaceClient["metadataUpdate"]>;
  assetList(input: Parameters<WorkflowSurfaceClient["assetList"]>[0]): ReturnType<WorkflowSurfaceClient["assetList"]>;
  uploadList(input: Parameters<WorkflowSurfaceClient["uploadList"]>[0]): ReturnType<WorkflowSurfaceClient["uploadList"]>;
  uploadBegin(input: Parameters<WorkflowSurfaceClient["uploadBegin"]>[0]): ReturnType<WorkflowSurfaceClient["uploadBegin"]>;
  uploadAppend(input: Parameters<WorkflowSurfaceClient["uploadAppend"]>[0]): ReturnType<WorkflowSurfaceClient["uploadAppend"]>;
  uploadGet(input: Parameters<WorkflowSurfaceClient["uploadGet"]>[0]): ReturnType<WorkflowSurfaceClient["uploadGet"]>;
  uploadCommit(input: Parameters<WorkflowSurfaceClient["uploadCommit"]>[0]): ReturnType<WorkflowSurfaceClient["uploadCommit"]>;
  uploadAbort(input: Parameters<WorkflowSurfaceClient["uploadAbort"]>[0]): ReturnType<WorkflowSurfaceClient["uploadAbort"]>;
  todoBoards(input?: Parameters<WorkflowSurfaceClient["todoBoards"]>[0]): ReturnType<WorkflowSurfaceClient["todoBoards"]>;
  todoBoard(input: Parameters<WorkflowSurfaceClient["todoBoard"]>[0]): ReturnType<WorkflowSurfaceClient["todoBoard"]>;
  todoItems(input: Parameters<WorkflowSurfaceClient["todoItems"]>[0]): ReturnType<WorkflowSurfaceClient["todoItems"]>;
  todoItem(input: Parameters<WorkflowSurfaceClient["todoItem"]>[0]): ReturnType<WorkflowSurfaceClient["todoItem"]>;
  todoClaim(input: Parameters<WorkflowSurfaceClient["todoClaim"]>[0]): ReturnType<WorkflowSurfaceClient["todoClaim"]>;
  todoAccept(input: Parameters<WorkflowSurfaceClient["todoAccept"]>[0]): ReturnType<WorkflowSurfaceClient["todoAccept"]>;
  workflowGet(input: Parameters<WorkflowSurfaceClient["workflowGet"]>[0]): ReturnType<WorkflowSurfaceClient["workflowGet"]>;
  workflowEvents(input: Parameters<WorkflowSurfaceClient["workflowEvents"]>[0]): ReturnType<WorkflowSurfaceClient["workflowEvents"]>;
  workflowCancel(input: Parameters<WorkflowSurfaceClient["workflowCancel"]>[0]): ReturnType<WorkflowSurfaceClient["workflowCancel"]>;
  actionGet(input: Parameters<WorkflowSurfaceClient["actionGet"]>[0]): ReturnType<WorkflowSurfaceClient["actionGet"]>;
  actionEvents(input: Parameters<WorkflowSurfaceClient["actionEvents"]>[0]): ReturnType<WorkflowSurfaceClient["actionEvents"]>;
  actionCancel(input: Parameters<WorkflowSurfaceClient["actionCancel"]>[0]): ReturnType<WorkflowSurfaceClient["actionCancel"]>;
}

/**
 * Export only the named, schema-bounded actions needed by a host bridge.
 * The bridge does not accept operation names, credentials, paths, or approval decisions.
 */
export function createWorkflowSurfaceBridge(client: WorkflowSurfaceClient): WorkflowSurfaceBridge {
  const invoke = <T>(key: keyof typeof workflowSurfaceOperations, action: () => T): T => {
    if (!client.available(key)) throw Object.assign(new Error("CAPABILITY_UNAVAILABLE"), { code: "CAPABILITY_UNAVAILABLE" });
    return action();
  };
  const bridge: WorkflowSurfaceBridge = {
    knowledgeList: input => invoke("knowledgeList", () => client.knowledgeList(input)),
    knowledgeGet: input => invoke("knowledgeGet", () => client.knowledgeGet(input)),
    knowledgeUpdate: input => invoke("knowledgeUpdate", () => client.knowledgeUpdate(input)),
    metadataGet: input => invoke("metadataGet", () => client.metadataGet(input)),
    metadataUpdate: input => invoke("metadataUpdate", () => client.metadataUpdate(input)),
    assetList: input => invoke("assetList", () => client.assetList(input)),
    uploadList: input => invoke("uploadList", () => client.uploadList(input)),
    uploadBegin: input => invoke("uploadBegin", () => client.uploadBegin(input)),
    uploadAppend: input => invoke("uploadAppend", () => client.uploadAppend(input)),
    uploadGet: input => invoke("uploadGet", () => client.uploadGet(input)),
    uploadCommit: input => invoke("uploadCommit", () => client.uploadCommit(input)),
    uploadAbort: input => invoke("uploadAbort", () => client.uploadAbort(input)),
    todoBoards: input => invoke("todoBoards", () => client.todoBoards(input)),
    todoBoard: input => invoke("todoBoard", () => client.todoBoard(input)),
    todoItems: input => invoke("todoItems", () => client.todoItems(input)),
    todoItem: input => invoke("todoItem", () => client.todoItem(input)),
    todoClaim: input => invoke("todoClaim", () => client.todoClaim(input)),
    todoAccept: input => invoke("todoAccept", () => client.todoAccept(input)),
    workflowGet: input => invoke("workflowGet", () => client.workflowGet(input)),
    workflowEvents: input => invoke("workflowEvents", () => client.workflowEvents(input)),
    workflowCancel: input => invoke("workflowCancel", () => client.workflowCancel(input)),
    actionGet: input => invoke("actionGet", () => client.actionGet(input)),
    actionEvents: input => invoke("actionEvents", () => client.actionEvents(input)),
    actionCancel: input => invoke("actionCancel", () => client.actionCancel(input)),
  };
  return Object.freeze(bridge);
}

export const managerWorkflowScope = Object.freeze({
  implemented: Object.freeze([
    "catalog-gated-native-manager-start", "runtime-and-progress-snapshot-reconciliation",
    "targeted-nonblocking-feedback", "worker-integration-verification-result-views", "cursor-gap-snapshot-refresh",
  ]),
  notImplemented: Object.freeze([
    "native-provider-or-worker-parity", "client-plan-authoring", "native-effect-recovery",
    "chat-or-webview-manager-authorization", "human-approval", "production-extension-activation",
    "automatic-polling-or-reconnect", "persistent-mutation-replay",
  ]),
});

export interface ManagerWorkflowSnapshot extends ManagerOverview {
  workers: ManagerOverview["doing"];
  integration: { freezePin: string | null; outputPin: string | null; checks: ManagerRun["checks"] };
  verification: { checks: ManagerRun["checks"] };
  acceptance: { status: "accepted" | "not-accepted"; pin: string | null };
  results: NonNullable<ManagerEvent["result"]>[];
}
export interface ManagerWorkflowProgress {
  snapshot: ManagerWorkflowSnapshot;
  events: ManagerEvent[];
  cursor: string;
  afterSeq: number;
  hasMore: boolean;
  eventsMayBeMissing: boolean;
  snapshotRefreshed: boolean;
}
type ManagerWorkflowClient = Pick<VscodeClient,
  "managerStart" | "managerGet" | "managerOverview" | "managerEvents" | "managerFeedback" | "managerCancel">;

/**
 * Trusted-host lifecycle, scoped to one immutable run. Reconciliation reads native
 * evidence; it never resumes unknown effects or supplies a native authorization token.
 */
export class ManagerWorkflow {
  private readonly client: ManagerWorkflowClient;
  readonly runId: string;
  private sequence: number | undefined = 0;
  private cursor: string | undefined;
  private gap = false;
  private reading = false;
  private snapshot: ManagerWorkflowSnapshot | undefined;
  private results = new Map<string, NonNullable<ManagerEvent["result"]>>();
  constructor(client: ManagerWorkflowClient, runId: string, resume: { afterSeq?: number; cursor?: string } = {}) {
    this.client = client;
    this.runId = runId;
    if (!operations.managerEvents.input.safeParse({ runId, ...resume }).success) throw new ClientError("INVALID_CURSOR");
    this.sequence = resume.cursor ? undefined : resume.afterSeq ?? 0;
    this.cursor = resume.cursor;
  }
  async start(input: Omit<OperationInput<"managerStart">, "runId">, signal?: AbortSignal): Promise<ManagerRun> {
    return this.client.managerStart({ ...input, runId: this.runId }, signal);
  }
  async reconcile(signal?: AbortSignal): Promise<ManagerWorkflowSnapshot> {
    // Separate read endpoints can straddle a native commit. Bound retries instead
    // of combining different versions or pretending that observation pauses workers.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [run, overview] = await Promise.all([
        this.client.managerGet({ runId: this.runId }, signal),
        this.client.managerOverview({ runId: this.runId }, signal),
      ]);
      if (run.runId !== this.runId || overview.runId !== this.runId) throw new ClientError("INVALID_MANAGER_RESPONSE");
      if (run.version !== overview.version) continue;
      if (this.snapshot && run.version < this.snapshot.version) throw new ClientError("STALE_MANAGER_SNAPSHOT");
      const integration = run.checks.filter(check => check.kind === "integration");
      const verification = run.checks.filter(check => check.kind === "e2e");
      const accepted = run.state === "succeeded" && run.freeze !== null && run.integration !== null
        && integration.some(check => check.result.ok && check.result.pin === run.integration && check.pin === run.freeze)
        && verification.some(check => check.result.ok && check.result.pin && check.pin === run.freeze);
      this.snapshot = {
        ...overview,
        workers: [...overview.doing, ...overview.completed, ...overview.remaining].filter(task => task.phase === "worker"),
        integration: { freezePin: run.freeze, outputPin: run.integration, checks: integration },
        verification: { checks: verification },
        acceptance: { status: accepted ? "accepted" : "not-accepted",
          pin: accepted ? verification.findLast(check => check.result.ok && check.pin === run.freeze)!.result.pin! : null },
        results: [...this.results.values()],
      };
      return structuredClone(this.snapshot);
    }
    throw new ClientError("MANAGER_SNAPSHOT_CHANGED");
  }
  async progress(signal?: AbortSignal): Promise<ManagerWorkflowProgress> {
    if (this.reading) throw new ClientError("MANAGER_PROGRESS_IN_FLIGHT");
    this.reading = true;
    try {
      const page = await this.client.managerEvents({ runId: this.runId,
        ...(this.cursor ? { cursor: this.cursor } : { afterSeq: this.sequence ?? 0 }), limit: 100 }, signal);
      if (page.runId !== this.runId || page.nextSeq < (this.sequence ?? 0)) throw new ClientError("INVALID_CURSOR");
      let sequence = this.sequence ?? (page.events[0] ? page.events[0].sequence - 1 : page.nextSeq);
      let gap = page.gaps.length > 0;
      for (const event of page.events) {
        if (event.sequence <= sequence || event.sequence > page.nextSeq) throw new ClientError("INVALID_CURSOR");
        if (event.sequence !== sequence + 1) gap = true;
        sequence = event.sequence;
      }
      if (page.nextSeq > sequence) gap = true;
      const previous = new Map(this.results);
      for (const event of page.events) if (event.result) this.results.set(event.result.id, event.result);
      let snapshot: ManagerWorkflowSnapshot;
      const refresh = gap || page.events.length > 0 || !this.snapshot;
      try { snapshot = refresh ? await this.reconcile(signal) : structuredClone(this.snapshot!); }
      catch (error) { this.results = previous; throw error; }
      // Advance only after successful refresh, so failed reads can safely retry.
      this.sequence = page.nextSeq; this.cursor = page.nextCursor; this.gap ||= gap;
      return { snapshot, events: page.events, cursor: page.nextCursor, afterSeq: page.nextSeq,
        hasMore: page.hasMore, eventsMayBeMissing: this.gap, snapshotRefreshed: refresh };
    } finally { this.reading = false; }
  }
  feedback(input: Omit<OperationInput<"managerFeedback">, "runId">, signal?: AbortSignal): Promise<ManagerFeedbackReceipt> {
    return this.client.managerFeedback({ ...input, runId: this.runId }, signal);
  }
  cancel(input: Omit<OperationInput<"managerCancel">, "runId">, signal?: AbortSignal): Promise<ManagerRun> {
    return this.client.managerCancel({ ...input, runId: this.runId }, signal);
  }
}
import { ClientError, type ManagerRun, type ManagerOverview, type ManagerEvent,
  type ManagerFeedbackReceipt, type VscodeClient } from "./client.ts";
import { operations, type OperationInput } from "./contracts.ts";
