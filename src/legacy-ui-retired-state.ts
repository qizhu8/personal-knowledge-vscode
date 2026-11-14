import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LegacyApiChatEntity } from "./legacy-api-chat-archive.js";
import { validateLegacyRecipeReceiptEvolution } from "./legacy-ui-recipe-receipts.js";
import { legacyPathHasNoSymlinks, legacyPrivateRootGuard, sameLegacyPrivateRoot, type LegacyPrivateRootGuard } from "./legacy-effective-private-root.js";

type Json = Record<string, any>;
export interface LegacyUiRetiredStateArchive {
  schema: "pkm.legacy-ui-retired-state/v1";
  root: string; sourceFingerprint: string; metadataAuthority: "archive_only";
  privateRootGuard?: LegacyPrivateRootGuard;
  paths: string[]; files: LegacyApiChatEntity[];
  components: { projectStore: "bootstrap-cutover-only" | "recipe-library-history-only"; actions: "blocked-no-workers";
    telemetry: "completed-lifecycle-only" | "completed-lifecycle-and-recipe-metadata-only"
      | "completed-lifecycle-and-note-read-only" | "completed-lifecycle-recipe-metadata-and-note-read-only"
      | "completed-lifecycle-and-note-create" | "completed-lifecycle-and-note-read-and-create"
      | "completed-lifecycle-recipe-metadata-and-note-create" | "completed-lifecycle-recipe-metadata-and-note-read-and-create" };
  recipeEvolution?: ReturnType<typeof validateLegacyRecipeReceiptEvolution>;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const roots = ["actions", "diagnostics", "mcp-usage", "project-store-migration", "project-store.json", "projects.json"];
const lifecycleTools = new Set(["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"]);
const recipeMetadataLeaves = new Set(["recipe_search", "recipe_capabilities"]);
const noteReadLeaves = new Set(["get_note"]);
const noteCreateLeaves = new Set(["add_note"]);
const readLeaves = new Set([...recipeMetadataLeaves, ...noteReadLeaves]);
const recipeMetadataTools = new Set(["capabilities_describe", "capability_read", ...recipeMetadataLeaves]);
const archivedReadTools = new Set([...recipeMetadataTools, ...noteReadLeaves]);
const archivedCreateTools = new Set(["capability_call", ...noteCreateLeaves]);
const archivedTools = new Set([...lifecycleTools, ...archivedReadTools, ...archivedCreateTools]);
function fail(message: string): never {
  throw Object.assign(new Error(`LEGACY_UI_RETIRED_STATE_BLOCKED: ${message}`), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a bounded JSON record.");
  return value as Json;
}
function keys(value: Json, names: string): void {
  const expected = names.split(" ").sort(), actual = Object.keys(value).sort();
  if (actual.join(" ") !== expected.join(" "))
    fail(`Unknown or incomplete retired state fields: extra=${actual.filter(key => !expected.includes(key)).slice(0, 10).join(",").slice(0, 200)}; missing=${expected.filter(key => !actual.includes(key)).join(",")}.`);
}
function empty(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }
function emptyRecord(value: unknown): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length; }
function parse(bytes: Buffer): Json {
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { fail("Malformed retired UTF-8 JSON."); }
}

/**
 * Archives only observed bootstrap/cutover and paired completed control, read and Note-create footprints.
 * This is neither Project/Actions parity, executable authority, nor proof of writer exclusion.
 */
export function inspectLegacyUiRetiredState(root: string): LegacyUiRetiredStateArchive | undefined {
  if (resolve(root) !== root || realpathSync(root) !== root) fail("An exact canonical absolute root is required.");
  const state = ".pkm/state";
  if (!lstatSync(join(root, state), { throwIfNoEntry: false })) return undefined;
  if (!roots.filter(name => name !== "actions").some(name => lstatSync(join(root, state, name), { throwIfNoEntry: false }))) return undefined;
  const files = new Map<string, LegacyApiChatEntity>();
  const contents = new Map<string, Buffer>();
  const rootGuard = legacyPrivateRootGuard(root);
  let usesPrivateRootGuard = false;
  let total = 0;
  function read(relative: string, directory = false): Buffer {
    const file = join(root, relative), before = lstatSync(file, { bigint: true });
    const sharedLegacy = directory
      ? /^\.pkm(?:\/state(?:\/(?:project-store-migration(?:\/(?:backup|backups|stage))?|actions(?:\/preparations)?|mcp-usage(?:\/events)?|diagnostics))?)?$/.test(relative)
      : /^\.pkm\/state\/(?:actions\/(?:mutation-lease|validation-queue\.json|preparations\/[^/]+\.json)|mcp-usage\/events\/[^/]+\.json)$/.test(relative);
    const needsGuard = (Number(before.mode) & 0o077) !== 0;
    if (needsGuard && rootGuard && sharedLegacy && (Number(before.mode) & 0o7002) === 0)
      usesPrivateRootGuard = true;
    if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)
      || (Number(before.mode) & 0o7000) !== 0
      || needsGuard && !(rootGuard && sharedLegacy && (Number(before.mode) & 0o002) === 0)
      || process.platform !== "linux" || before.uid !== BigInt(process.getuid!())
      || !legacyPathHasNoSymlinks(root, relative))
      fail(`Retired state must be owned, private, non-special and unlinked: ${relative}.`);
    if (before.size > 1_048_576n || files.size >= 512) fail("Retired state exceeds its bounded inspection limits.");
    const metadata: LegacyApiChatEntity = { path: relative, kind: directory ? "directory" : "file", size: Number(before.size),
      mode: Number(before.mode & 0o777n), device: String(before.dev), inode: String(before.ino),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
    let bytes = Buffer.alloc(0);
    if (!directory) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino) fail("Retired file identity changed.");
        bytes = readFileSync(fd);
        const after = fstatSync(fd, { bigint: true });
        if (after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || after.size !== before.size
          || BigInt(bytes.length) !== before.size) fail("Retired file changed during inspection.");
      } finally { closeSync(fd); }
      total += bytes.length;
      if (total > 8_388_608) fail("Retired state exceeds 8 MiB.");
      metadata.sha256 = hash(bytes); contents.set(relative, bytes);
    }
    files.set(relative, metadata);
    return bytes;
  }
  function record(relative: string): Json { return parse(read(`${state}/${relative}`)); }
  function directory(relative: string, expected?: string[]): string[] {
    const full = `${state}/${relative}`; read(full, true);
    const names = readdirSync(join(root, full)).sort();
    if (expected && names.join("\n") !== [...expected].sort().join("\n")) fail(`Unknown or pending state under ${relative}.`);
    return names;
  }
  const containers: NonNullable<LegacyPrivateRootGuard["containers"]> = [];
  for (const relative of [".pkm", state] as const) {
    read(relative, true); files.delete(relative);
    const stat = lstatSync(join(root, relative), { bigint: true });
    containers.push({ path: relative, device: String(stat.dev), inode: String(stat.ino),
      mode: Number(stat.mode & 0o777n), ctimeNs: String(stat.ctimeNs) });
  }

  const currentProjects = record("projects.json");
  if (!lstatSync(join(root, state, "project-store.json"), { throwIfNoEntry: false }))
    fail("Original ProjectStore has no complete canonical target.");
  const target = record("project-store.json");
  let recipeEvolution: LegacyUiRetiredStateArchive["recipeEvolution"];
  let projects = currentProjects;
  if (currentProjects.storeVersion !== 1) {
    if (!digest.test(target.migration?.sourceDigest)) fail("Recipe evolution has no bounded original cutover digest.");
    projects = parse(read(`${state}/project-store-migration/backups/${target.migration.sourceDigest}.projects.json`));
    try { recipeEvolution = validateLegacyRecipeReceiptEvolution(currentProjects, target, projects); }
    catch (error) { fail(error instanceof Error ? error.message : "Invalid Recipe receipt evolution."); }
  }
  keys(projects, "schema storeVersion digest payload");
  const payload = object(projects.payload); keys(payload, "receipts state");
  const original = object(payload.state);
  keys(original, "schema rootId audit collaborationTasks ganttTasks migrations projects recipeFolders recipeTrash recipes threads");
  if (projects.schema !== 1 || projects.storeVersion !== 1 || !digest.test(projects.digest)
    || projects.digest !== hash(JSON.stringify(payload)) || !empty(payload.receipts)
    || original.schema !== 1 || typeof original.rootId !== "string" || !original.rootId.startsWith("root_") || !uuid.test(original.rootId.slice(5))
    || !["collaborationTasks", "ganttTasks", "migrations", "recipeFolders", "recipeTrash"].every(key => empty(original[key]))
    || !Array.isArray(original.projects) || original.projects.length !== 1 || !Array.isArray(original.threads) || original.threads.length !== 1
    || !Array.isArray(original.recipes) || !original.recipes.length || original.recipes.length > 64)
    fail("Only untouched bootstrap ProjectStore state with no tasks, receipts or pending migrations is archived.");
  const project = object(original.projects[0]), thread = object(original.threads[0]);
  keys(project, "name projectId systemKind version"); keys(thread, "archived description legacyAliases name projectId systemKind threadId version");
  if (project.name !== "Default Project" || project.systemKind !== "default-project" || project.version !== 1
    || !/^project_[a-f0-9]{32}$/.test(project.projectId) || thread.name !== "General" || thread.systemKind !== "general-thread"
    || thread.projectId !== project.projectId || !/^thread_[a-f0-9]{32}$/.test(thread.threadId) || thread.version !== 1
    || thread.archived !== false || thread.description !== "" || !empty(thread.legacyAliases))
    fail("User project/thread workflows require their own migration implementation.");
  if (!Array.isArray(original.audit) || original.audit.length !== 2 || new Set(original.audit.map((row: Json) => row?.event)).size !== 2
    || original.audit.some((row: Json) => {
      keys(object(row), "entityId event");
      return row.entityId !== (row.event === "system-project-repaired" ? project.projectId
        : row.event === "system-thread-repaired" ? thread.threadId : undefined);
    })) fail("Unrecognized bootstrap audit.");
  const recipeIds = new Set<string>();
  for (const raw of original.recipes) {
    const recipe = object(raw);
    const methodology = "methodology" in recipe || "methodologyDigest" in recipe;
    keys(recipe, `category definition description executableDigest metadata name recipeId revision scope systemKind${methodology ? " methodology methodologyDigest" : ""}`);
    if (recipe.systemKind !== "built-in" || recipe.scope !== "global" || recipe.revision !== 1
      || !/^recipe_[a-f0-9]{32}$/.test(recipe.recipeId) || recipeIds.has(recipe.recipeId)
      || !digest.test(recipe.executableDigest) || recipe.executableDigest !== hash(JSON.stringify(recipe.definition))
      || methodology && (!digest.test(recipe.methodologyDigest) || recipe.methodologyDigest !== hash(JSON.stringify(recipe.methodology))
        || recipe.methodology?.schema !== "pkm.recipe.methodology/v1")
      || recipe.definition?.schema !== "pkm.workflow.definition/v1")
      fail("Custom or unrecognized recipe authority is not adopted.");
    recipeIds.add(recipe.recipeId);
  }
  keys(target, "canonicalDigest migration receipts rootId schema storeVersion");
  if (target.schema !== 1 || target.storeVersion !== (recipeEvolution?.storeVersion ?? 1) || target.rootId !== original.rootId
    || !recipeEvolution && !empty(target.receipts)
    || !digest.test(target.canonicalDigest)) fail("Unrecognized canonical ProjectStore marker.");
  const migration = object(target.migration); keys(migration, "canonicalDigest collaborationTasks ganttTasks phase projects sourceDigest threads");
  if (migration.phase !== "cutover" || migration.canonicalDigest !== target.canonicalDigest || migration.sourceDigest !== projects.digest
    || migration.projects !== 1 || migration.threads !== 1 || migration.collaborationTasks !== 0 || migration.ganttTasks !== 0)
    fail("ProjectStore migration is incomplete or inconsistent.");
  directory("project-store-migration", ["backup", "backups", "migration.json", "stage"]);
  directory("project-store-migration/backup", []); directory("project-store-migration/stage", []);
  const saved = record("project-store-migration/migration.json");
  keys(saved, "canonicalDigest collaborationTasks ganttTasks hadTarget phase projects sourceDigest threads");
  const { hadTarget, ...savedMigration } = saved;
  if (hadTarget !== false || Object.keys(migration).some(key => migration[key] !== savedMigration[key]))
    fail("The preserved cutover journal is inconsistent.");
  const backup = `${projects.digest}.projects.json`;
  directory("project-store-migration/backups", [backup]);
  const backupBytes = read(`${state}/project-store-migration/backups/${backup}`);
  if (!recipeEvolution && !backupBytes.equals(contents.get(`${state}/projects.json`)!))
    fail("ProjectStore backup does not match the retained source.");

  directory("actions", ["mutation-lease", "preparations", "settings.json", "validation-queue.json"]);
  if (read(`${state}/actions/mutation-lease`).length) fail("A nonempty action lease is not retired.");
  const settings = record("actions/settings.json"); keys(settings, "toolchains workspace_roots");
  if (!emptyRecord(settings.toolchains) || !emptyRecord(settings.workspace_roots)) fail("Configured Action workspace/toolchain authority is not adopted.");
  const queue = record("actions/validation-queue.json"); keys(queue, "jobs schema worker_pid");
  if (queue.schema !== "pkm.action.validation-queue/v1" || queue.worker_pid !== null || !emptyRecord(queue.jobs))
    fail("Pending Action jobs or workers are not retired.");
  const preparationNames = new Set(["core.artifact.copy", "core.artifact.write", "core.ask-user", "core.cast.integer-to-string",
    "core.cast.string-to-float", "core.cast.string-to-integer", "core.chatroom-alias", "core.date.parse", "core.delay"]);
  for (const name of directory("actions/preparations")) {
    if (!name.endsWith(".json") || !preparationNames.has(name.slice(0, -5))) fail("Unknown Action preparation.");
    const item = record(`actions/preparations/${name}`); keys(item, "content_hash reason state");
    if (item.state !== "blocked" || !digest.test(item.content_hash)
      || item.reason !== "needs_workspace: configure personalKnowledge.actions.workspaceRoots for this OS.")
      fail("Only explicitly blocked, non-executable Action preparations are archived.");
  }

  directory("mcp-usage", ["events"]);
  const usageCounts = new Map<string, number>();
  const createUsage = new Map<string, { sessionId: string; counts: Map<string, number> }>();
  for (const name of directory("mcp-usage/events")) {
    if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) fail("Unknown MCP usage artifact.");
    const event = record(`mcp-usage/events/${name}`);
    keys(event, "domain durationMs estimatedTokenEquivalent eventId inputBytes occurredAt outputBytes reportedTokens resultCount schema sessionId success toolName"
      + (event.toolName === "capability_read" || event.toolName === "capability_call" ? " capabilityVersion" : ""));
    keys(object(event.reportedTokens), "input output");
    if (event.schema !== 1 || event.eventId !== name.slice(0, -5)
      || event.domain !== (recipeMetadataLeaves.has(event.toolName) ? "automation" : "knowledge") || event.success !== true
      || !archivedTools.has(event.toolName)
      || (event.toolName === "capability_read" || event.toolName === "capability_call") && event.capabilityVersion !== 1
      || event.resultCount !== 0 || !Number.isFinite(Date.parse(event.occurredAt))
      || !["durationMs", "estimatedTokenEquivalent", "inputBytes", "outputBytes"].every(key => Number.isFinite(event[key]) && event[key] >= 0)
      || event.reportedTokens.input !== 0 || event.reportedTokens.output !== 0 || typeof event.sessionId !== "string")
      fail("Unknown, failed or non-control MCP usage requires its own migration.");
    usageCounts.set(event.toolName, (usageCounts.get(event.toolName) ?? 0) + 1);
    if (archivedCreateTools.has(event.toolName)) {
      const session = /^.+-([1-9][0-9]*)-([a-f0-9]{8})$/.exec(event.sessionId);
      if (!session) fail("Note-create telemetry has no original process session identity.");
      const prior = createUsage.get(session[1]);
      if (prior && prior.sessionId !== event.sessionId) fail("Note-create process session identity is ambiguous.");
      const entry = prior ?? { sessionId: event.sessionId, counts: new Map<string, number>() };
      entry.counts.set(event.toolName, (entry.counts.get(event.toolName) ?? 0) + 1);
      createUsage.set(session[1], entry);
    }
  }
  directory("diagnostics", ["mcp"]);
  const completed = new Map<string, number>();
  const createCompleted = new Map<string, { writerId: string; counts: Map<string, number> }>();
  const diagnosticWriters = new Map<string, Set<string>>();
  for (const name of directory("diagnostics/mcp")) {
    if (!/^[1-9][0-9]*-[a-f0-9]{32}\.0000000000\.jsonl$/.test(name)) fail("Rotated or unknown MCP diagnostic streams are not complete evidence.");
    const rows = new TextDecoder("utf-8", { fatal: true }).decode(read(`${state}/diagnostics/mcp/${name}`)).split("\n");
    if (rows.pop() !== "" || !rows.length || rows.length > 4096) fail("Truncated or excessive diagnostic stream.");
    const pending = new Map<string, Json>(), writerId = name.split(".")[0]!;
    const wrapperChildren = new Map<string, { callId: string; completed: boolean }>();
    const childWrappers = new Map<string, string>();
    let started = false, quiesced = false;
    for (const line of rows) {
      const event = parse(Buffer.from(line));
      if (event.schema !== "pkm.diagnostic/v1" || event.writerId !== writerId || event.pid !== Number(writerId.split("-")[0])
        || event.dropped !== 0 || !Number.isFinite(Date.parse(event.at))) fail("Incomplete or inconsistent diagnostic identity.");
      if (event.event === "runtime.started" && !started) {
        keys(event, "schema at pid writerId event component parentPid dropped");
        if (event.component !== "unified-mcp" || !Number.isSafeInteger(event.parentPid) || event.parentPid < 1) fail("Unknown runtime diagnostic.");
        const pid = String(event.pid), writers = diagnosticWriters.get(pid) ?? new Set<string>();
        writers.add(writerId); diagnosticWriters.set(pid, writers);
        started = true; continue;
      }
      if (!started || !archivedTools.has(event.tool) || quiesced && (archivedReadTools.has(event.tool)
        || archivedCreateTools.has(event.tool) && event.event === "mcp.call.started"))
        fail("Unknown diagnostic event or executable MCP call.");
      if (event.event === "mcp.call.started") {
        keys(event, "schema at pid writerId event callId tool transportId requestId dropped");
        if (!/^[a-f0-9]{32}$/.test(event.callId) || pending.has(event.callId)
          || !/^[a-f0-9]{24}$/.test(event.transportId) || !/^[a-f0-9]{24}$/.test(event.requestId)) fail("Invalid diagnostic call identity.");
        if (readLeaves.has(event.tool) || noteCreateLeaves.has(event.tool)) {
          const wrapperTool = noteCreateLeaves.has(event.tool) ? "capability_call" : "capability_read";
          const allWrappers = [...pending.values()].filter(item => (item.tool === "capability_read" || item.tool === "capability_call")
            && item.transportId === event.transportId && item.requestId === event.requestId);
          if (allWrappers.some(item => item.tool !== wrapperTool)) fail("Facade dispatched an unsupported leaf.");
          const wrappers = allWrappers.filter(item => item.tool === wrapperTool);
          if (wrappers.length > 1 || wrappers.some(item => wrapperChildren.has(item.callId)))
            fail("Ambiguous facade dispatch.");
          if (noteCreateLeaves.has(event.tool) && wrappers.length !== 1)
            fail("Note creation requires its exact capability facade.");
          if (wrappers[0]) {
            wrapperChildren.set(wrappers[0].callId, { callId: event.callId, completed: false });
            childWrappers.set(event.callId, wrappers[0].callId);
          }
        }
        pending.set(event.callId, event);
      } else if (event.event === "mcp.call.returned") {
        keys(event, "schema at pid writerId event callId tool transportId requestId durationMs dropped");
        const first = pending.get(event.callId);
        if (!first || ["tool", "transportId", "requestId"].some(key => first[key] !== event[key])
          || !Number.isFinite(event.durationMs) || event.durationMs < 0) fail("Unpaired diagnostic call completion.");
        if (event.tool === "capability_read" || event.tool === "capability_call") {
          const child = wrapperChildren.get(event.callId);
          if (!child?.completed) fail("Facade calls require one completed, exact approved leaf.");
          wrapperChildren.delete(event.callId);
        }
        const wrapper = childWrappers.get(event.callId);
        if (wrapper) {
          const child = wrapperChildren.get(wrapper);
          if (!child || child.callId !== event.callId) fail("Unpaired read-only facade child.");
          child.completed = true; childWrappers.delete(event.callId);
        }
        pending.delete(event.callId);
        completed.set(event.tool, (completed.get(event.tool) ?? 0) + 1);
        if (archivedCreateTools.has(event.tool)) {
          const pid = String(event.pid), prior = createCompleted.get(pid);
          if (prior && prior.writerId !== writerId) fail("Note-create diagnostic process identity is ambiguous.");
          const entry = prior ?? { writerId, counts: new Map<string, number>() };
          entry.counts.set(event.tool, (entry.counts.get(event.tool) ?? 0) + 1);
          createCompleted.set(pid, entry);
        }
        if (event.tool === "mcp_lifecycle_quiesce") quiesced = true;
      } else fail("Unknown diagnostic lifecycle state.");
    }
    if (!started || !quiesced || pending.size || wrapperChildren.size || childWrappers.size)
      fail("MCP calls or lifecycle handoff are incomplete.");
  }
  if (!completed.size || [...archivedTools].some(tool => (completed.get(tool) ?? 0) !== (usageCounts.get(tool) ?? 0)))
    fail("MCP telemetry and diagnostic completed-call counts disagree.");
  if (createUsage.size !== createCompleted.size || [...createUsage].some(([pid, usage]) => {
    const diagnostics = createCompleted.get(pid);
    return !diagnostics || diagnosticWriters.get(pid)?.size !== 1 || [...archivedCreateTools].some(tool =>
      (usage.counts.get(tool) ?? 0) !== (diagnostics.counts.get(tool) ?? 0));
  })) fail("Note-create telemetry does not match the diagnostic process identity.");
  for (const entry of files.values()) {
    const after = lstatSync(join(root, entry.path), { bigint: true });
    if (String(after.dev) !== entry.device || String(after.ino) !== entry.inode || String(after.mtimeNs) !== entry.mtimeNs
      || String(after.ctimeNs) !== entry.ctimeNs || Number(after.size) !== entry.size) fail("Retired component changed during inspection.");
  }
  if (usesPrivateRootGuard && (!rootGuard || !sameLegacyPrivateRoot(root, rootGuard)))
    fail("The private legacy root changed during inspection.");
  if (usesPrivateRootGuard) for (const entry of containers) {
    const stat = lstatSync(join(root, entry.path), { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || String(stat.dev) !== entry.device
      || String(stat.ino) !== entry.inode || Number(stat.mode & 0o777n) !== entry.mode
      || String(stat.ctimeNs) !== entry.ctimeNs) fail("A legacy state container changed during inspection.");
  }
  const privateRootGuard = usesPrivateRootGuard ? { ...rootGuard!, containers } : undefined;
  const entries = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hasRecipe = [...usageCounts.keys()].some(tool => recipeMetadataLeaves.has(tool) || tool === "capabilities_describe");
  const hasNoteRead = usageCounts.has("get_note");
  const hasNoteCreate = usageCounts.has("add_note");
  return { schema: "pkm.legacy-ui-retired-state/v1", root, metadataAuthority: "archive_only",
    ...(privateRootGuard ? { privateRootGuard } : {}),
    ...(recipeEvolution ? { recipeEvolution } : {}),
    sourceFingerprint: hash(JSON.stringify(privateRootGuard ? { entries, privateRootGuard } : entries)),
    paths: entries.map(entry => entry.path), files: entries,
    components: { projectStore: recipeEvolution ? "recipe-library-history-only" : "bootstrap-cutover-only",
      actions: "blocked-no-workers", telemetry: hasNoteCreate
        ? hasNoteRead
          ? hasRecipe ? "completed-lifecycle-recipe-metadata-and-note-read-and-create" : "completed-lifecycle-and-note-read-and-create"
          : hasRecipe ? "completed-lifecycle-recipe-metadata-and-note-create" : "completed-lifecycle-and-note-create"
        : hasNoteRead
        ? hasRecipe ? "completed-lifecycle-recipe-metadata-and-note-read-only" : "completed-lifecycle-and-note-read-only"
        : hasRecipe ? "completed-lifecycle-and-recipe-metadata-only" : "completed-lifecycle-only" } };
}
