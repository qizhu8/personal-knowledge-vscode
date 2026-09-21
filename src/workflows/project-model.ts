import { createHash, randomUUID } from "crypto";

export type ProjectSystemKind = "default-project";
export type ThreadSystemKind = "general-thread";
export type MigrationState = "pending" | "running" | "completed" | "failed";

export interface ProjectRecord {
  projectId: string;
  name: string;
  systemKind?: ProjectSystemKind;
  version: number;
}

export interface ThreadRecord {
  threadId: string;
  projectId: string;
  name: string;
  description: string;
  archived: boolean;
  systemKind?: ThreadSystemKind;
  legacyAliases: string[];
  version: number;
}

export interface LegacyRoom {
  identity: string;
  roomId?: string;
  name: string;
  description?: string;
  active?: boolean;
}

export interface MigrationEntry {
  legacyIdentity: string;
  state: MigrationState;
  threadId?: string;
  receiptId?: string;
  error?: string;
}

export interface ProjectModelState {
  schema: 1;
  rootId: string;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  migrations: MigrationEntry[];
  audit: Array<{ event: string; entityId: string }>;
}

export interface ThreadMovePlan {
  threadId: string;
  destinationProjectId: string;
  linkedActiveRunIds: string[];
  includedRunIds: string[];
  audienceChanges: boolean;
  audienceChangeConfirmed: boolean;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export class ProjectModelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function deriveSystemId(parentId: string, key: "pkm/default-project/v1" | "pkm/general-thread/v1"): string {
  const prefix = key.includes("default-project") ? "project_" : "thread_";
  return prefix + createHash("sha256").update(`${key}\0${parentId}`, "utf8").digest("hex").slice(0, 32);
}

export function initializeProjectModel(existing: Partial<ProjectModelState> | undefined, createId: () => string = randomUUID): ProjectModelState {
  if (!existing) return ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], migrations: [], audit: [] });
  if (!existing.rootId) {
    if ((existing.projects?.length || 0) + (existing.threads?.length || 0) > 0) throw new ProjectModelError("root-identity-missing", "Root identity cannot be regenerated while child records exist.");
    return ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], migrations: existing.migrations || [], audit: existing.audit || [] });
  }
  return ensureSystemEntities({
    schema: 1,
    rootId: existing.rootId,
    projects: [...(existing.projects || [])],
    threads: [...(existing.threads || [])],
    migrations: [...(existing.migrations || [])],
    audit: [...(existing.audit || [])]
  });
}

export function ensureSystemEntities(state: ProjectModelState): ProjectModelState {
  const defaultProjectId = deriveSystemId(state.rootId, "pkm/default-project/v1");
  const markedProjects = state.projects.filter(project => project.systemKind === "default-project");
  if (markedProjects.length > 1 || (markedProjects[0] && markedProjects[0].projectId !== defaultProjectId)) {
    throw new ProjectModelError("system-project-conflict", "Default Project identity is conflicting or duplicated.");
  }
  let projects = state.projects;
  let audit = state.audit;
  if (!markedProjects.length) {
    projects = [...projects, { projectId: defaultProjectId, name: "Default Project", systemKind: "default-project", version: 1 }];
    audit = [...audit, { event: "system-project-repaired", entityId: defaultProjectId }];
  }
  const generalThreadId = deriveSystemId(defaultProjectId, "pkm/general-thread/v1");
  const markedThreads = state.threads.filter(thread => thread.systemKind === "general-thread" && thread.projectId === defaultProjectId);
  if (markedThreads.length > 1 || (markedThreads[0] && markedThreads[0].threadId !== generalThreadId)) {
    throw new ProjectModelError("system-thread-conflict", "General Thread identity is conflicting or duplicated.");
  }
  let threads = state.threads;
  if (!markedThreads.length) {
    threads = [...threads, { threadId: generalThreadId, projectId: defaultProjectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }];
    audit = [...audit, { event: "system-thread-repaired", entityId: generalThreadId }];
  }
  return { ...state, projects, threads, audit };
}

export function createProject(state: ProjectModelState, name: string, createId: () => string = randomUUID): ProjectModelState {
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("project-name-required", "Project name is required.");
  const projectId = `project_${createId()}`;
  if (state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("identity-conflict", "Generated Project identity already exists.");
  const generalThreadId = deriveSystemId(projectId, "pkm/general-thread/v1");
  return {
    ...state,
    projects: [...state.projects, { projectId, name: normalized, version: 1 }],
    threads: [...state.threads, { threadId: generalThreadId, projectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "project-created", entityId: projectId }, { event: "system-thread-created", entityId: generalThreadId }]
  };
}

export function createThread(state: ProjectModelState, projectId: string, name: string, createId: () => string = randomUUID): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  const threadId = `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) throw new ProjectModelError("identity-conflict", "Generated Thread identity already exists.");
  return {
    ...state,
    threads: [...state.threads, { threadId, projectId, name: normalized, description: "", archived: false, legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "thread-created", entityId: threadId }]
  };
}

export function migrateLegacyRoom(state: ProjectModelState, room: LegacyRoom, createId: () => string = randomUUID): ProjectModelState {
  const existingEntry = state.migrations.find(entry => entry.legacyIdentity === room.identity);
  if (existingEntry?.state === "completed") return state;
  if (room.active) return setMigration(state, room.identity, { state: "pending", error: "active-room-deferred" });
  const defaultProject = state.projects.find(project => project.systemKind === "default-project")!;
  const reusableRoomId = room.roomId && ID_PATTERN.test(room.roomId) && !state.threads.some(thread => thread.threadId === room.roomId);
  const threadId = reusableRoomId ? room.roomId! : `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) return setMigration(state, room.identity, { state: "failed", error: "thread-identity-conflict" });
  if (state.threads.some(thread => thread.legacyAliases.includes(room.identity))) return setMigration(state, room.identity, { state: "failed", error: "legacy-alias-conflict" });
  const aliasRequired = threadId !== room.roomId;
  const thread: ThreadRecord = {
    threadId,
    projectId: defaultProject.projectId,
    name: room.name.trim() || "Legacy Thread",
    description: room.description || "",
    archived: false,
    legacyAliases: aliasRequired ? [room.identity] : [],
    version: 1
  };
  const receiptId = `migration_${createHash("sha256").update(`${room.identity}\0${threadId}`).digest("hex").slice(0, 24)}`;
  const migrated = { ...state, threads: [...state.threads, thread], audit: [...state.audit, { event: "legacy-room-migrated", entityId: threadId }] };
  return setMigration(migrated, room.identity, { state: "completed", threadId, receiptId });
}

export function moveThread(state: ProjectModelState, plan: ThreadMovePlan): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === plan.threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-move-forbidden", "General Thread cannot move between Projects.");
  if (!state.projects.some(project => project.projectId === plan.destinationProjectId)) throw new ProjectModelError("project-not-found", "Destination Project does not exist.");
  const omittedRuns = plan.linkedActiveRunIds.filter(runId => !plan.includedRunIds.includes(runId));
  if (omittedRuns.length) throw new ProjectModelError("active-run-move-blocked", `Active Runs must move or be resolved: ${omittedRuns.join(", ")}`);
  if (plan.audienceChanges && !plan.audienceChangeConfirmed) throw new ProjectModelError("audience-confirmation-required", "Thread movement changes its effective audience.");
  if (thread.projectId === plan.destinationProjectId) return state;
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === thread.threadId ? { ...candidate, projectId: plan.destinationProjectId, version: candidate.version + 1 } : candidate),
    audit: [...state.audit, { event: "thread-moved", entityId: thread.threadId }]
  };
}

export function resolveThreadId(state: ProjectModelState, identity: string): string | undefined {
  return state.threads.find(thread => thread.threadId === identity || thread.legacyAliases.includes(identity))?.threadId;
}

function setMigration(state: ProjectModelState, legacyIdentity: string, update: Omit<MigrationEntry, "legacyIdentity">): ProjectModelState {
  const entry = { legacyIdentity, ...update };
  const exists = state.migrations.some(candidate => candidate.legacyIdentity === legacyIdentity);
  return { ...state, migrations: exists ? state.migrations.map(candidate => candidate.legacyIdentity === legacyIdentity ? entry : candidate) : [...state.migrations, entry] };
}