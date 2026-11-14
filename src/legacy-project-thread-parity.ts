import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { atomicFileWrite } from "./file-write.js";
import { readProjectRecipes } from "./project-recipes.js";
import {
  projectCollaborationTaskSchema, projectGanttTaskSchema, projectRecordSchema, projectThreadSchema,
} from "./project-recipes-contracts.js";
import { deriveSystemId, safeProjectDirectoryName } from "./domain/project-recipes-project-rules.js";
import { projectSystemEntityIssue } from "./domain/project-recipes.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { capturedSources } from "./domain/project-thread-original.js";

export { capturedSources as LEGACY_PROJECT_THREAD_SOURCES } from "./domain/project-thread-original.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const commandSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  expectedStoreVersion: z.number().int().safe().min(0),
});
const domainSchema = z.strictObject({
  rootId: z.string().min(1).max(4096),
  projects: z.array(projectRecordSchema).max(4096),
  threads: z.array(projectThreadSchema).max(8192),
  ganttTasks: z.array(projectGanttTaskSchema).max(8192),
  collaborationTasks: z.array(projectCollaborationTaskSchema).max(8192),
});
const fileSchema = z.strictObject({
  relativePath: z.string().min(1).max(2048),
  beforeSha256: digestSchema.nullable(),
  beforeBase64: z.string().max(2_796_204).nullable(),
  afterSha256: digestSchema.nullable(),
  afterBase64: z.string().max(2_796_204).nullable(),
});
const operationSchema = z.enum(["project-create", "thread-create", "thread-rename", "thread-move"]);
const effectSchema = z.strictObject({
  schema: z.literal("pkm.legacy-project-thread-effect/v1"),
  source: z.strictObject({
    model: z.strictObject({ path: z.string(), sha256: digestSchema }),
    store: z.strictObject({ path: z.string(), sha256: digestSchema }),
    filesystem: z.strictObject({ path: z.string(), sha256: digestSchema }),
    canonicalJson: z.strictObject({ path: z.string(), sha256: digestSchema }),
  }),
  workspaceId: z.string().uuid(),
  rootId: z.string().min(1).max(4096),
  actorId: z.string().min(1).max(500),
  operationId: z.string().uuid(),
  operation: operationSchema,
  command: commandSchema,
  expectedStoreVersion: z.number().int().safe().min(0),
  nextStoreVersion: z.number().int().safe().min(1),
  snapshotRevision: digestSchema,
  entityId: identitySchema,
  beforeDomain: domainSchema,
  afterDomain: domainSchema,
  files: z.array(fileSchema).max(3),
  createDirectories: z.array(z.string().min(1).max(2048)).max(4),
});

export type LegacyProjectThreadOperation = z.infer<typeof operationSchema>;
export type LegacyProjectThreadDomain = z.infer<typeof domainSchema>;
export type LegacyProjectThreadCommand = z.infer<typeof commandSchema>;
export type LegacyProjectThreadEffect = z.infer<typeof effectSchema>;

export interface LegacyProjectThreadControl {
  storeVersion: number;
  receipts: Array<{
    commandId: string;
    fingerprint: string;
    operation: string;
    storeVersion: number;
    entityId: string;
  }>;
}

export type LegacyProjectThreadCommandCheck =
  | { status: "replay"; entityId: string; receipt: LegacyProjectThreadControl["receipts"][number] }
  | { status: "new"; expectedStoreVersion: number; nextStoreVersion: number };

export interface LegacyProjectThreadOracle {
  before: LegacyProjectThreadDomain;
  after: LegacyProjectThreadDomain;
}

export interface LegacyProjectThreadRequest {
  workspaceId: string;
  rootId: string;
  actorId: string;
  operationId: string;
  expectedSnapshotRevision: string;
  command: LegacyProjectThreadCommand;
  operation: LegacyProjectThreadOperation;
  args:
    | { projectId: string; name: string }
    | { threadId: string; name: string }
    | {
        threadId: string;
        destinationProjectId: string;
        linkedActiveRunIds: string[];
        includedRunIds: string[];
        audienceChanges: boolean;
        audienceChangeConfirmed: boolean;
      };
}

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedDomain(value: LegacyProjectThreadDomain): LegacyProjectThreadDomain {
  return {
    rootId: value.rootId,
    projects: [...value.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    threads: [...value.threads].sort((a, b) => a.threadId.localeCompare(b.threadId)),
    ganttTasks: [...value.ganttTasks].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    collaborationTasks: [...value.collaborationTasks].sort((a, b) => a.collaborationId.localeCompare(b.collaborationId)),
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function threadPath(domain: LegacyProjectThreadDomain, thread: { projectId: string; threadId: string }): string {
  const project = domain.projects.find(item => item.projectId === thread.projectId);
  if (!project) fail("INVALID_DOCUMENT", `Thread owner Project does not exist: ${thread.threadId}`);
  return `project/${safeProjectDirectoryName(project.name, project.projectId)}/threads/${thread.threadId}.json`;
}

function projectPath(project: { projectId: string; name: string }): string {
  return `project/${safeProjectDirectoryName(project.name, project.projectId)}/project.json`;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return same(Object.keys(value).sort(), [...expected].sort());
}

function validateSourcePins(): void {
  for (const source of Object.values(capturedSources)) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.path.startsWith("src/workflows/")) {
      fail("LEGACY_ORIGINAL_SOURCE_MISMATCH", "Captured Project/Thread oracle source pin is invalid.");
    }
  }
}

function workspaceMarker(root: string, expectedId: string): void {
  const marker = join(resolve(root), ".pkm-next-workspace");
  assertSafePath(marker);
  let value: unknown;
  try { value = JSON.parse(readFileSync(marker, "utf8")); }
  catch { fail("INVALID_WORKSPACE", "Isolated workspace marker is missing or malformed."); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).schema !== "pkm.next-workspace/v2"
    || (value as Record<string, unknown>).id !== expectedId) {
    fail("INVALID_WORKSPACE", "Workspace marker does not match the captured command.");
  }
}

function readDomain(root: string, rootId: string, expectedSnapshotRevision?: string): {
  domain: LegacyProjectThreadDomain;
  snapshotRevision: string;
  workspaceId: string;
} {
  const markerPath = join(resolve(root), ".pkm-next-workspace");
  assertSafePath(markerPath);
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>; }
  catch { fail("INVALID_WORKSPACE", "Isolated workspace marker is missing or malformed."); }
  if (marker.schema !== "pkm.next-workspace/v2" || typeof marker.id !== "string") {
    fail("INVALID_WORKSPACE", "Isolated workspace marker is invalid.");
  }
  const first = readProjectRecipes(root, {
    operation: "project.list", args: { offset: 0, limit: 100 }, actorId: "legacy-project-thread",
  }) as { items: Array<Record<string, any>>; nextOffset: number | null; snapshotRevision: string };
  if (expectedSnapshotRevision && first.snapshotRevision !== expectedSnapshotRevision) {
    fail("CONFLICT", "Project snapshot changed; rediscover before mutating.");
  }
  const projects = [...first.items];
  for (let offset = first.nextOffset; offset !== null;) {
    const page = readProjectRecipes(root, {
      operation: "project.list",
      args: { offset, limit: 100, snapshotRevision: first.snapshotRevision },
      actorId: "legacy-project-thread",
    }) as typeof first;
    projects.push(...page.items);
    offset = page.nextOffset;
  }
  const threads: Array<Record<string, any>> = [];
  const ganttTasks: Array<Record<string, any>> = [];
  const collaborationTasks: Array<Record<string, any>> = [];
  for (const project of projects) {
    const detail = readProjectRecipes(root, {
      operation: "project.get",
      args: { id: project.projectId, snapshotRevision: first.snapshotRevision },
      actorId: "legacy-project-thread",
    }) as {
      threads: Array<Record<string, any>>;
      ganttTasks: Array<Record<string, any>>;
      collaborationTasks: Array<Record<string, any>>;
    };
    threads.push(...detail.threads);
    ganttTasks.push(...detail.ganttTasks);
    collaborationTasks.push(...detail.collaborationTasks);
  }
  const domain = domainSchema.parse({
    rootId,
    projects, threads, ganttTasks, collaborationTasks,
  });
  return { domain, snapshotRevision: first.snapshotRevision, workspaceId: marker.id };
}

export function checkLegacyProjectThreadCommand(
  control: LegacyProjectThreadControl,
  input: LegacyProjectThreadCommand,
): LegacyProjectThreadCommandCheck {
  const command = commandSchema.parse(input);
  if (!Number.isSafeInteger(control.storeVersion) || control.storeVersion < 0) {
    fail("STORE_VERSION_CONFLICT", "Original Project control version is invalid.");
  }
  const prior = control.receipts.find(receipt => receipt.commandId === command.commandId);
  if (prior) {
    if (prior.fingerprint !== command.fingerprint) {
      fail("COMMAND_CONFLICT", "Command ID was already used with a different fingerprint.");
    }
    return { status: "replay", entityId: prior.entityId, receipt: prior };
  }
  if (command.expectedStoreVersion !== control.storeVersion) {
    fail("STORE_VERSION_CONFLICT", "Expected Project store version does not match the current version.");
  }
  if (control.storeVersion === Number.MAX_SAFE_INTEGER) {
    fail("STORE_VERSION_CONFLICT", "Project store version is exhausted.");
  }
  return { status: "new", expectedStoreVersion: control.storeVersion, nextStoreVersion: control.storeVersion + 1 };
}

function validateRequest(request: LegacyProjectThreadRequest): LegacyProjectThreadRequest {
  z.strictObject({
    workspaceId: z.string().uuid(),
    rootId: z.string().min(1).max(4096),
    actorId: z.string().min(1).max(500),
    operationId: z.string().uuid(),
    expectedSnapshotRevision: digestSchema,
    command: commandSchema,
    operation: operationSchema,
    args: z.unknown(),
  }).parse(request);
  validateSourcePins();
  z.string().uuid().parse(request.workspaceId);
  z.string().uuid().parse(request.operationId);
  z.string().min(1).max(500).parse(request.actorId);
  z.string().min(1).max(4096).parse(request.rootId);
  digestSchema.parse(request.expectedSnapshotRevision);
  commandSchema.parse(request.command);
  operationSchema.parse(request.operation);
  if (request.command.expectedStoreVersion === Number.MAX_SAFE_INTEGER) {
    fail("STORE_VERSION_CONFLICT", "Project store version is exhausted.");
  }
  const expectedCommandOperation: Record<LegacyProjectThreadOperation, string> = {
    "project-create": "project-create",
    "thread-create": "thread-create",
    "thread-rename": "thread-rename",
    "thread-move": "thread-move",
  };
  if (request.command.operation !== expectedCommandOperation[request.operation]) {
    fail("INVALID_ARGUMENT", "Opaque original command operation does not match the requested mutation.");
  }
  const parsedArgs = request.operation === "thread-move"
    ? z.strictObject({
      threadId: identitySchema,
      destinationProjectId: identitySchema,
      linkedActiveRunIds: z.array(z.string().min(1).max(4096)),
      includedRunIds: z.array(z.string().min(1).max(4096)),
      audienceChanges: z.boolean(),
      audienceChangeConfirmed: z.boolean(),
    }).parse(request.args)
    : request.operation === "thread-create"
    ? z.strictObject({
      projectId: identitySchema, name: z.string().max(8000),
    }).parse(request.args)
    : z.strictObject({
      ...(request.operation === "project-create" ? {} : { threadId: identitySchema }),
      name: z.string().max(8000),
    }).parse(request.args);
  return { ...request, args: parsedArgs } as LegacyProjectThreadRequest;
}

function currentDomainMatches(root: string, expected: LegacyProjectThreadDomain, snapshotRevision?: string): string {
  const current = readDomain(root, expected.rootId, snapshotRevision);
  if (current.workspaceId.length === 0) fail("INVALID_WORKSPACE", "Workspace identity is missing.");
  const expectedDomain = sortedDomain(expected);
  const observedDomain = sortedDomain({ ...current.domain, rootId: expected.rootId });
  if (!same(observedDomain, expectedDomain)) {
    fail("CONFLICT", "Original oracle before-snapshot differs from the native Project tree.");
  }
  const issue = projectSystemEntityIssue(expectedDomain.projects.map(project => ({
    project,
    threads: expectedDomain.threads.filter(thread => thread.projectId === project.projectId),
  })), expected.rootId);
  if (issue) fail("INVALID_DOCUMENT", issue);
  return current.snapshotRevision;
}

function validateCreateProjectDelta(
  before: LegacyProjectThreadDomain,
  after: LegacyProjectThreadDomain,
  name: string,
): string {
  const addedProjects = after.projects.filter(project => !before.projects.some(item => item.projectId === project.projectId));
  const addedThreads = after.threads.filter(thread => !before.threads.some(item => item.threadId === thread.threadId));
  if (addedProjects.length !== 1 || addedThreads.length !== 1
    || !same(before.projects, after.projects.filter(item => item.projectId !== addedProjects[0]!.projectId))
    || !same(before.threads, after.threads.filter(item => item.threadId !== addedThreads[0]!.threadId))
    || !same(before.ganttTasks, after.ganttTasks)
    || !same(before.collaborationTasks, after.collaborationTasks)) {
    fail("INVALID_DOCUMENT", "Captured ProjectStore createProject changed unrelated domain records.");
  }
  const project = addedProjects[0]!;
  const thread = addedThreads[0]!;
  if (project.name !== name.trim() || project.version !== 1 || project.systemKind !== undefined
    || !exactKeys(project as unknown as Record<string, unknown>, ["projectId", "name", "version"])
    || thread.threadId !== deriveSystemId(project.projectId, "pkm/general-thread/v1")
    || thread.projectId !== project.projectId || thread.name !== "General" || thread.description !== ""
    || thread.archived || thread.systemKind !== "general-thread" || thread.version !== 1
    || thread.legacyAliases.length !== 0 || thread.chatroom !== undefined
    || !exactKeys(thread as unknown as Record<string, unknown>, [
      "threadId", "projectId", "name", "description", "archived", "systemKind", "legacyAliases", "version",
    ])) {
    fail("INVALID_DOCUMENT", "Original ProjectStore createProject result differs from the captured default behavior.");
  }
  return project.projectId;
}

function validateThreadCreateDelta(
  before: LegacyProjectThreadDomain,
  after: LegacyProjectThreadDomain,
  projectId: string,
  name: string,
): string {
  const additions = after.threads.filter(thread => !before.threads.some(item => item.threadId === thread.threadId));
  if (additions.length !== 1 || !same(before.projects, after.projects)
    || !same(before.threads, after.threads.filter(item => item.threadId !== additions[0]!.threadId))
    || !same(before.ganttTasks, after.ganttTasks) || !same(before.collaborationTasks, after.collaborationTasks)) {
    fail("INVALID_DOCUMENT", "Captured ProjectStore createThread changed unrelated domain records.");
  }
  const thread = additions[0]!;
  if (!before.projects.some(project => project.projectId === projectId)) fail("NOT_FOUND", "Original ProjectStore Thread owner does not exist.");
  if (thread.projectId !== projectId || thread.name !== name.trim() || thread.version !== 1
    || thread.description !== "" || thread.archived || thread.systemKind !== undefined
    || thread.legacyAliases.length !== 0 || thread.chatroom !== undefined
    || !thread.threadId.startsWith("thread_")
    || !exactKeys(thread as unknown as Record<string, unknown>, [
      "threadId", "projectId", "name", "description", "archived", "legacyAliases", "version",
    ])) {
    fail("INVALID_DOCUMENT", "Original ProjectStore createThread result differs from the captured model.");
  }
  return thread.threadId;
}

function validateThreadRenameDelta(
  before: LegacyProjectThreadDomain,
  after: LegacyProjectThreadDomain,
  threadId: string,
  name: string,
): { entityId: string; changed: boolean } {
  const current = before.threads.find(thread => thread.threadId === threadId);
  const saved = after.threads.find(thread => thread.threadId === threadId);
  if (!current || !saved) fail("NOT_FOUND", "Original ProjectStore Thread does not exist.");
  if (current.systemKind === "general-thread") fail("CONFLICT", "The protected General Thread cannot be renamed.");
  const normalized = String(name || "").trim();
  if (!normalized) fail("INVALID_ARGUMENT", "Original ProjectStore Thread name is required.");
  const changed = normalized !== current.name;
  const expected = changed ? { ...current, name: normalized, version: current.version + 1 } : current;
  const oldOtherThreads = before.threads.filter(thread => thread.threadId !== threadId);
  const newOtherThreads = after.threads.filter(thread => thread.threadId !== threadId);
  if (!same(saved, expected) || !same(oldOtherThreads, newOtherThreads)
    || !same(before.projects, after.projects) || !same(before.ganttTasks, after.ganttTasks)
    || !same(before.collaborationTasks, after.collaborationTasks)) {
    fail("INVALID_DOCUMENT", "Captured ProjectStore renameThread changed unrelated records or fields.");
  }
  return { entityId: threadId, changed };
}

function validateThreadMoveDelta(
  before: LegacyProjectThreadDomain,
  after: LegacyProjectThreadDomain,
  args: Extract<LegacyProjectThreadRequest["args"], { destinationProjectId: string }>,
): { entityId: string; changed: boolean } {
  const thread = before.threads.find(item => item.threadId === args.threadId);
  if (!thread) fail("NOT_FOUND", "Original ProjectStore Thread does not exist.");
  if (thread.systemKind === "general-thread") fail("CONFLICT", "The protected General Thread cannot move between Projects.");
  if (!before.projects.some(project => project.projectId === args.destinationProjectId)) {
    fail("NOT_FOUND", "Original ProjectStore Thread destination Project does not exist.");
  }
  const omittedRuns = args.linkedActiveRunIds.filter(runId => !args.includedRunIds.includes(runId));
  if (omittedRuns.length) fail("CONFLICT", `Active Runs must move or be resolved: ${omittedRuns.join(", ")}`);
  if (args.audienceChanges && !args.audienceChangeConfirmed) {
    fail("CONFLICT", "Thread movement changes its effective audience.");
  }
  const changed = thread.projectId !== args.destinationProjectId;
  if (changed && before.ganttTasks.some(task => task.threadId === thread.threadId)) {
    fail("CONFLICT", "Move or remove Thread-associated Gantt tasks before moving this Thread.");
  }
  const expected = changed ? {
    ...thread, projectId: args.destinationProjectId, version: thread.version + 1,
  } : thread;
  const sameThread = after.threads.find(item => item.threadId === args.threadId);
  if (!same(sameThread, expected)
    || !same(before.threads.filter(item => item.threadId !== args.threadId),
      after.threads.filter(item => item.threadId !== args.threadId))
    || !same(before.projects, after.projects) || !same(before.ganttTasks, after.ganttTasks)
    || !same(before.collaborationTasks, after.collaborationTasks)) {
    fail("INVALID_DOCUMENT", "Captured ProjectStore moveThread changed unrelated records or fields.");
  }
  return { entityId: thread.threadId, changed };
}

function validateChangedPathSet(
  operation: LegacyProjectThreadOperation,
  before: LegacyProjectThreadDomain,
  after: LegacyProjectThreadDomain,
  entityId: string,
  changed: boolean,
): { path: string; before: unknown | null; after: unknown | null }[] {
  if (!changed && operation !== "project-create") return [];
  if (operation === "project-create") {
    const project = after.projects.find(item => item.projectId === entityId)!;
    const thread = after.threads.find(item => item.projectId === entityId && item.threadId === deriveSystemId(entityId, "pkm/general-thread/v1"))!;
    return [
      { path: projectPath(project), before: null, after: project },
      { path: threadPath(after, thread), before: null, after: thread },
    ];
  }
  if (operation === "thread-create") {
    const thread = after.threads.find(item => item.threadId === entityId)!;
    return [{ path: threadPath(after, thread), before: null, after: thread }];
  }
  const oldThread = before.threads.find(item => item.threadId === entityId)!;
  const newThread = after.threads.find(item => item.threadId === entityId)!;
  if (operation === "thread-move" && oldThread.projectId !== newThread.projectId) {
    return [
      { path: threadPath(before, oldThread), before: oldThread, after: null },
      { path: threadPath(after, newThread), before: null, after: newThread },
    ];
  }
  return [{ path: threadPath(before, oldThread), before: oldThread, after: newThread }];
}

function readFileState(root: string, relativePath: string): Buffer | undefined {
  const absolute = safeAbsolute(root, relativePath);
  assertSafePath(absolute);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
      fail("INVALID_DOCUMENT", "Thread effect path is not a bounded regular file.");
    }
    return readFileSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function safeAbsolute(root: string, relativePath: string): string {
  if (!relativePath.startsWith("project/") || relativePath.includes("\\")
    || relativePath.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) {
    fail("INVALID_DOCUMENT", "Thread effect contains a non-portable target path.");
  }
  const base = resolve(root);
  const absolute = resolve(base, ...relativePath.split("/"));
  const local = relative(base, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(base, local) !== absolute) {
    fail("INVALID_DOCUMENT", "Thread effect target escapes the isolated workspace.");
  }
  return absolute;
}

function assertSafePath(path: string): void {
  for (let current = resolve(path);;) {
    try {
      if (lstatSync(current).isSymbolicLink()) fail("INVALID_DOCUMENT", "Thread effect paths cannot contain symlinks.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
}

function encoded(bytesValue: unknown | null) {
  if (bytesValue === null) return { sha256: null, base64: null };
  const content = bytes(bytesValue);
  if (content.length > 2 * 1024 * 1024) fail("RESOURCE_LIMIT", "Original Project entity exceeds the 2 MiB file limit.");
  return { sha256: sha256(content), base64: content.toString("base64") };
}

function compileFileEffects(
  root: string,
  values: Array<{ path: string; before: unknown | null; after: unknown | null }>,
): LegacyProjectThreadEffect["files"] {
  return values.map(value => {
    const priorBytes = readFileState(root, value.path);
    const priorDigest = priorBytes ? sha256(priorBytes) : null;
    const expectedBefore = encoded(value.before);
    if (priorDigest !== expectedBefore.sha256
      || (priorBytes?.toString("base64") ?? null) !== expectedBefore.base64) {
      fail("CONFLICT", "Original Project entity bytes differ from the oracle snapshot.");
    }
    const next = encoded(value.after);
    if (value.before === null && priorBytes !== undefined) fail("CONFLICT", "Generated Project/Thread target already exists.");
    return {
      relativePath: value.path,
      beforeSha256: expectedBefore.sha256,
      beforeBase64: expectedBefore.base64,
      afterSha256: next.sha256,
      afterBase64: next.base64,
    };
  });
}

export function planLegacyProjectThreadEffect(
  root: string,
  requestValue: LegacyProjectThreadRequest,
  oracleValue: LegacyProjectThreadOracle,
  control: LegacyProjectThreadControl,
): LegacyProjectThreadEffect {
  const request = validateRequest(requestValue);
  const commandCheck = checkLegacyProjectThreadCommand(control, request.command);
  if (commandCheck.status !== "new") fail("COMMAND_ALREADY_RECORDED", "Original command was already applied; return the current snapshot instead.");
  const before = domainSchema.parse(oracleValue.before);
  const after = domainSchema.parse(oracleValue.after);
  if (before.rootId !== request.rootId || after.rootId !== request.rootId) {
    fail("INVALID_DOCUMENT", "Original oracle root identity differs from command admission.");
  }
  if (!before.projects.length) fail("INVALID_DOCUMENT", "Original ProjectStore mutations require the initialized Default Project.");
  const systemIssue = projectSystemEntityIssue(before.projects.map(project => ({
    project,
    threads: before.threads.filter(thread => thread.projectId === project.projectId),
  })), request.rootId);
  if (systemIssue) fail("INVALID_DOCUMENT", systemIssue);
  const snapshotRevision = currentDomainMatches(root, before, request.expectedSnapshotRevision);

  let entityId: string;
  let changed = true;
  if (request.operation === "project-create") {
    if (!("name" in request.args)) fail("INVALID_ARGUMENT", "Project create requires a name.");
    entityId = validateCreateProjectDelta(before, after, request.args.name);
  } else if (request.operation === "thread-create") {
    if (!("projectId" in request.args)) fail("INVALID_ARGUMENT", "Thread create requires its owning Project.");
    entityId = validateThreadCreateDelta(before, after, request.args.projectId, request.args.name);
  } else if (request.operation === "thread-rename") {
    if (!("threadId" in request.args) || "destinationProjectId" in request.args) {
      fail("INVALID_ARGUMENT", "Thread rename requires its Thread identity and name.");
    }
    const result = validateThreadRenameDelta(before, after, request.args.threadId, request.args.name);
    entityId = result.entityId;
    changed = result.changed;
  } else {
    if (!("destinationProjectId" in request.args)) fail("INVALID_ARGUMENT", "Thread move requires its destination Project.");
    const result = validateThreadMoveDelta(before, after, request.args);
    entityId = result.entityId;
    changed = result.changed;
  }

  const changedPaths = validateChangedPathSet(request.operation, before, after, entityId, changed);
  const files = compileFileEffects(root, changedPaths);
  const workspaceId = readDomain(root, request.rootId, snapshotRevision).workspaceId;
  if (workspaceId !== request.workspaceId) fail("INVALID_WORKSPACE", "Workspace identity changed during Project planning.");
  workspaceMarker(root, request.workspaceId);
  const directories = request.operation === "project-create"
    ? (() => {
        const project = after.projects.find(item => item.projectId === entityId)!;
        const directory = `project/${safeProjectDirectoryName(project.name, project.projectId)}`;
        return [directory, ...["threads", "gantt", "collaboration"].map(child => `${directory}/${child}`)];
      })()
    : [];
  for (const directory of directories) {
    const absolute = safeAbsolute(root, `${directory}/placeholder`);
    assertSafePath(dirname(absolute));
    try {
      lstatSync(dirname(absolute));
      fail("CONFLICT", "Original Project creation target directory already exists.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const effect = effectSchema.parse({
    schema: "pkm.legacy-project-thread-effect/v1",
    source: capturedSources,
    workspaceId: request.workspaceId,
    rootId: request.rootId,
    actorId: request.actorId,
    operationId: request.operationId,
    operation: request.operation,
    command: request.command,
    expectedStoreVersion: commandCheck.expectedStoreVersion,
    nextStoreVersion: commandCheck.nextStoreVersion,
    snapshotRevision,
    entityId,
    beforeDomain: sortedDomain(before),
    afterDomain: sortedDomain(after),
    files,
    createDirectories: directories,
  });
  if (!same(effect.source, capturedSources)) {
    fail("LEGACY_ORIGINAL_SOURCE_MISMATCH", "Effect provenance differs from the checked source captures.");
  }
  return effect;
}

function classify(root: string, file: LegacyProjectThreadEffect["files"][number]): "before" | "after" | "unknown" {
  const current = readFileState(root, file.relativePath);
  const digest = current ? sha256(current) : null;
  if (digest === file.beforeSha256 && (current?.toString("base64") ?? null) === file.beforeBase64) return "before";
  if (digest === file.afterSha256 && (current?.toString("base64") ?? null) === file.afterBase64) return "after";
  return "unknown";
}

function ensureDirectories(root: string, directories: string[]): void {
  for (const directory of directories) {
    const absolute = safeAbsolute(root, `${directory}/placeholder`);
    const target = dirname(absolute);
    assertSafePath(target);
    mkdirSync(target, { recursive: true });
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("RECOVERY_CONFLICT", "Project entity directory is not a regular directory.");
  }
}

function writeEffectFile(root: string, file: LegacyProjectThreadEffect["files"][number], direction: "before" | "after", operationId: string): void {
  const expected = direction === "after" ? file.beforeSha256 : file.afterSha256;
  const content = direction === "after" ? file.afterBase64 : file.beforeBase64;
  const targetDigest = direction === "after" ? file.afterSha256 : file.beforeSha256;
  const path = safeAbsolute(root, file.relativePath);
  assertSafePath(path);
  const current = readFileState(root, file.relativePath);
  if ((current ? sha256(current) : null) !== expected
    || (current?.toString("base64") ?? null) !== (direction === "after" ? file.beforeBase64 : file.afterBase64)) {
    fail("RECOVERY_CONFLICT", "Project entity changed outside its recognized before/after state.");
  }
  if (targetDigest === null) {
    if (current) {
      unlinkSync(path);
      const directoryDescriptor = openSync(dirname(path), "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    }
  } else {
    if (content === null) fail("INVALID_DOCUMENT", "Effect target bytes are missing.");
    mkdirSync(dirname(path), { recursive: true });
    atomicFileWrite(path, Buffer.from(content, "base64"), expected, operationId);
  }
}

function verifyFinalDomain(root: string, effect: LegacyProjectThreadEffect, state: "before" | "after"): void {
  const expected = state === "after" ? effect.afterDomain : effect.beforeDomain;
  const current = readDomain(root, effect.rootId);
  if (current.workspaceId !== effect.workspaceId) fail("INVALID_WORKSPACE", "Workspace identity changed during recovery.");
  if (!same(sortedDomain({ ...current.domain, rootId: effect.rootId }), expected)) {
    fail("RECOVERY_CONFLICT", `Recovered Project tree does not match the original ${state} snapshot.`);
  }
}

export function inspectLegacyProjectThreadEffect(
  root: string,
  input: LegacyProjectThreadEffect,
): { state: "before" | "after" | "mixed" | "unknown"; effect: LegacyProjectThreadEffect } {
  const effect = effectSchema.parse(input);
  validateSourcePins();
  if (!same(effect.source, capturedSources)) {
    fail("LEGACY_ORIGINAL_SOURCE_MISMATCH", "Effect provenance differs from the checked source captures.");
  }
  workspaceMarker(root, effect.workspaceId);
  const states = effect.files.map(file => classify(root, file));
  if (states.includes("unknown")) return { state: "unknown", effect };
  if (states.every(value => value === "before")) return { state: "before", effect };
  if (states.every(value => value === "after")) return { state: "after", effect };
  return { state: "mixed", effect };
}

export function recoverLegacyProjectThreadEffect(root: string, input: LegacyProjectThreadEffect) {
  const inspected = inspectLegacyProjectThreadEffect(root, input);
  const { effect } = inspected;
  if (inspected.state === "unknown") {
    return { state: "unknown" as const, operationId: effect.operationId, entityId: effect.entityId };
  }
  if (inspected.state === "after") {
    verifyFinalDomain(root, effect, "after");
    return { state: "complete" as const, operationId: effect.operationId, entityId: effect.entityId };
  }
  if (inspected.state === "before") {
    const current = readDomain(root, effect.rootId, effect.snapshotRevision);
    if (current.workspaceId !== effect.workspaceId
      || !same(sortedDomain({ ...current.domain, rootId: effect.rootId }), effect.beforeDomain)) {
      fail("CONFLICT", "Pinned original before snapshot changed before effect application.");
    }
  }
  ensureDirectories(root, effect.createDirectories);
  for (const file of [...effect.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (classify(root, file) === "after") continue;
    writeEffectFile(root, file, "after", effect.operationId);
  }
  verifyFinalDomain(root, effect, "after");
  return { state: "complete" as const, operationId: effect.operationId, entityId: effect.entityId };
}

export function rollbackLegacyProjectThreadEffect(root: string, input: LegacyProjectThreadEffect) {
  const inspected = inspectLegacyProjectThreadEffect(root, input);
  const { effect } = inspected;
  if (inspected.state === "unknown") {
    return { state: "unknown" as const, operationId: effect.operationId, entityId: effect.entityId };
  }
  if (inspected.state === "before") {
    verifyFinalDomain(root, effect, "before");
    return { state: "rolled-back" as const, operationId: effect.operationId, entityId: effect.entityId };
  }
  for (const file of [...effect.files].sort((a, b) => b.relativePath.localeCompare(a.relativePath))) {
    if (classify(root, file) === "before") continue;
    writeEffectFile(root, file, "before", effect.operationId);
  }
  for (const directory of [...effect.createDirectories].reverse()) {
    const path = safeAbsolute(root, `${directory}/placeholder`);
    try { rmdirSync(dirname(path)); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code)))) throw error;
    }
  }
  verifyFinalDomain(root, effect, "before");
  return { state: "rolled-back" as const, operationId: effect.operationId, entityId: effect.entityId };
}

export function serializeLegacyProjectThreadEffect(input: LegacyProjectThreadEffect): string {
  const effect = effectSchema.parse(input);
  return canonicalJson(effect);
}
