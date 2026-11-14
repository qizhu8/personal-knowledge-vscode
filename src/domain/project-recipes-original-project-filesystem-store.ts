export const originalProjectFilesystemStoreExcerpts = [
  {
    "name": "PROJECT_FILESYSTEM_STORE_SCHEMA",
    "source": "export const PROJECT_FILESYSTEM_STORE_SCHEMA = 1;"
  },
  {
    "name": "PROJECT_RECEIPT_LIMIT",
    "source": "export const PROJECT_RECEIPT_LIMIT = 256;"
  },
  {
    "name": "ProjectDomainState",
    "source": "export interface ProjectDomainState {\n  rootId: string;\n  projects: ProjectRecord[];\n  threads: ThreadRecord[];\n  ganttTasks: GanttTaskRecord[];\n  collaborationTasks: CollaborationTaskRecord[];\n}"
  },
  {
    "name": "ProjectFilesystemReceipt",
    "source": "export interface ProjectFilesystemReceipt {\n  commandId: string;\n  fingerprint: string;\n  operation: string;\n  storeVersion: number;\n  entityId: string;\n}"
  },
  {
    "name": "ProjectMigrationPhase",
    "source": "export type ProjectMigrationPhase = \"previewed\" | \"staged\" | \"verified\" | \"cutover\" | \"rolled-back\";"
  },
  {
    "name": "ProjectMigrationReceipt",
    "source": "export interface ProjectMigrationReceipt {\n  phase: ProjectMigrationPhase;\n  sourceDigest: string;\n  canonicalDigest: string;\n  projects: number;\n  threads: number;\n  ganttTasks: number;\n  collaborationTasks: number;\n}"
  },
  {
    "name": "ProjectStoreControl",
    "source": "interface ProjectStoreControl {\n  schema: 1;\n  rootId: string;\n  storeVersion: number;\n  receipts: ProjectFilesystemReceipt[];\n  canonicalDigest: string;\n  migration?: ProjectMigrationReceipt;\n}"
  },
  {
    "name": "MigrationMarker",
    "source": "interface MigrationMarker extends ProjectMigrationReceipt {\n  hadTarget: boolean;\n}"
  },
  {
    "name": "ProjectFilesystemSnapshot",
    "source": "export interface ProjectFilesystemSnapshot extends ProjectDomainState {\n  storeVersion: number;\n}"
  },
  {
    "name": "ProjectFilesystemMutationResult",
    "source": "export interface ProjectFilesystemMutationResult {\n  snapshot: ProjectFilesystemSnapshot;\n  entityId: string;\n  replayed: boolean;\n}"
  },
  {
    "name": "ProjectFilesystemCommand",
    "source": "export interface ProjectFilesystemCommand {\n  commandId: string;\n  fingerprint: string;\n  expectedStoreVersion: number;\n}"
  },
  {
    "name": "LegacyProjectMigrationSource",
    "source": "export interface LegacyProjectMigrationSource {\n  sourceDigest: string;\n  state: ProjectModelState;\n  storeVersion: number;\n  receipts?: ProjectFilesystemReceipt[];\n}"
  },
  {
    "name": "ProjectFilesystemStoreError",
    "source": "export class ProjectFilesystemStoreError extends Error {\n  constructor(public readonly code: string, message: string) {\n    super(message);\n  }\n}"
  },
  {
    "name": "ProjectFilesystemStore",
    "source": "export class ProjectFilesystemStore {\n  readonly knowledgeRoot: string;\n  readonly projectRoot: string;\n  readonly controlPath: string;\n  readonly lockPath: string;\n  private readonly migrationRoot: string;\n  private readonly markerPath: string;\n\n  constructor(readonly stateDirectory: string) {\n    this.knowledgeRoot = path.basename(stateDirectory) === \"state\" && path.basename(path.dirname(stateDirectory)) === \".pkm\"\n      ? path.dirname(path.dirname(stateDirectory))\n      : stateDirectory;\n    this.projectRoot = path.join(this.knowledgeRoot, \"project\");\n    this.controlPath = path.join(stateDirectory, \"project-store.json\");\n    this.lockPath = path.join(stateDirectory, \"projects.lock\");\n    this.migrationRoot = path.join(stateDirectory, \"project-store-migration\");\n    this.markerPath = path.join(this.migrationRoot, \"migration.json\");\n  }\n\n  hasCanonicalStore(): boolean {\n    return fs.existsSync(this.controlPath) && fs.existsSync(this.projectRoot);\n  }\n\n  initialize(state: ProjectModelState, storeVersion = 1): ProjectFilesystemSnapshot {\n    if (this.hasCanonicalStore()) return this.list();\n    const domain = projectDomain(state);\n    fs.mkdirSync(this.stateDirectory, { recursive: true });\n    this.commitProjectTree(domain, makeControl(domain, storeVersion, []));\n    return { ...clone(domain), storeVersion };\n  }\n\n  list(): ProjectFilesystemSnapshot {\n    this.recoverPendingCommit();\n    const control = this.readControl()!;\n    const domain = this.readProjectTree(control.rootId);\n    if (domainDigest(domain) !== control.canonicalDigest) {\n      fail(\"store-corrupt\", \"Project filesystem digest does not match its control state.\");\n    }\n    return { ...clone(domain), storeVersion: control.storeVersion };\n  }\n\n  checkCommand(command: ProjectFilesystemCommand): ProjectFilesystemMutationResult | undefined {\n    this.recoverPendingCommit();\n    const control = this.readControl()!;\n    const replay = control.receipts.find(receipt => receipt.commandId === command.commandId);\n    if (replay) {\n      if (replay.fingerprint !== command.fingerprint) {\n        fail(\"command-conflict\", \"Command ID was already used with a different fingerprint.\");\n      }\n      return { snapshot: this.list(), entityId: replay.entityId, replayed: true };\n    }\n    if (command.expectedStoreVersion !== control.storeVersion) {\n      fail(\"store-version-conflict\", \"Expected Project store version does not match the current version.\");\n    }\n    return undefined;\n  }\n\n  mutate(\n    command: ProjectFilesystemCommand,\n    operation: string,\n    state: ProjectModelState,\n    entityId: string,\n  ): ProjectFilesystemMutationResult {\n    const replay = this.checkCommand(command);\n    if (replay) return replay;\n    const control = this.readControl()!;\n    const domain = projectDomain(state);\n    const storeVersion = control.storeVersion + 1;\n    const receipts = compactReceipts(control.receipts.concat({\n      commandId: command.commandId,\n      fingerprint: command.fingerprint,\n      operation,\n      storeVersion,\n      entityId,\n    }));\n    this.commitProjectTree(domain, {\n      ...makeControl(domain, storeVersion, receipts),\n      ...(control.migration ? { migration: control.migration } : {}),\n    });\n    return { snapshot: { ...clone(domain), storeVersion }, entityId, replayed: false };\n  }\n\n  recordCompatibilityMutation(\n    command: ProjectFilesystemCommand,\n    operation: string,\n    entityId: string,\n  ): ProjectFilesystemMutationResult {\n    const current = this.list();\n    return this.mutate(command, operation, toModelState(current), entityId);\n  }\n\n  previewMigration(source: LegacyProjectMigrationSource): ProjectMigrationReceipt {\n    const domain = projectDomain(source.state);\n    return migrationReceipt(\"previewed\", source.sourceDigest, domain);\n  }\n\n  stageMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {\n    fenceSource(source, expectedSourceDigest);\n    const domain = projectDomain(source.state);\n    const receipt = migrationReceipt(\"staged\", source.sourceDigest, domain);\n    const marker = this.readMarker(false);\n    if (marker && marker.sourceDigest === receipt.sourceDigest && marker.canonicalDigest === receipt.canonicalDigest\n      && [\"staged\", \"verified\"].includes(marker.phase)\n      && (fs.existsSync(this.stagingProjectRoot()) || this.targetMatches(marker, source.state.rootId))) {\n      return { ...marker, phase: marker.phase as \"staged\" | \"verified\" };\n    }\n    if (marker && marker.sourceDigest !== source.sourceDigest) {\n      fail(\"migration-source-changed\", \"Legacy Project source changed after migration staging began.\");\n    }\n    fs.rmSync(path.join(this.migrationRoot, \"stage\"), { recursive: true, force: true });\n    fs.rmSync(path.join(this.migrationRoot, \"backup\"), { recursive: true, force: true });\n    fs.rmSync(this.markerPath, { force: true });\n    fs.mkdirSync(this.migrationRoot, { recursive: true });\n    writeProjectTree(this.stagingProjectRoot(), domain);\n    this.writeMarker({ ...receipt, hadTarget: fs.existsSync(this.projectRoot) });\n    this.writeControl({\n      ...makeControl(domain, source.storeVersion, source.receipts || []),\n      migration: receipt,\n    });\n    return receipt;\n  }\n\n  verifyMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {\n    fenceSource(source, expectedSourceDigest);\n    const marker = this.requireMarker(source.sourceDigest);\n    const verificationRoot = fs.existsSync(this.stagingProjectRoot())\n      ? this.stagingProjectRoot()\n      : this.targetMatches(marker, source.state.rootId) ? this.projectRoot : \"\";\n    if (!verificationRoot) fail(\"migration-not-staged\", \"Project migration staging is missing.\");\n    const domain = readProjectTreeAt(verificationRoot, source.state.rootId);\n    const canonicalDigest = domainDigest(domain);\n    if (canonicalDigest !== marker.canonicalDigest) fail(\"migration-verification-failed\", \"Staged Project data failed digest verification.\");\n    const verified = { ...marker, phase: \"verified\" as const };\n    this.writeMarker(verified);\n    this.writeControl({\n      ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),\n      migration: withoutInternalMarker(verified),\n    });\n    return withoutInternalMarker(verified);\n  }\n\n  cutoverMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {\n    fenceSource(source, expectedSourceDigest);\n    const existingControl = this.readControl(false);\n    if (existingControl?.migration?.phase === \"cutover\"\n      && existingControl.migration.sourceDigest === source.sourceDigest) {\n      return existingControl.migration;\n    }\n    const marker = this.requireMarker(source.sourceDigest);\n    if (marker.phase !== \"verified\") this.verifyMigration(source, expectedSourceDigest);\n    if (fs.existsSync(this.projectRoot)) {\n      if (this.targetMatches(marker, source.state.rootId)\n        && (!existingControl || existingControl.migration?.sourceDigest === source.sourceDigest)) {\n        const receipt = { ...withoutInternalMarker(marker), phase: \"cutover\" as const };\n        this.writeControl({\n          ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),\n          migration: receipt,\n        });\n        this.writeMarker({ ...marker, phase: \"cutover\" });\n        return receipt;\n      }\n      if (!existingControl || existingControl.canonicalDigest !== marker.canonicalDigest) {\n        fail(\"migration-target-conflict\", \"Canonical Project target exists with different or unverified content.\");\n      }\n      fail(\"migration-target-conflict\", \"Canonical Project target is already owned by another store.\");\n    }\n    const backupRoot = this.backupProjectRoot();\n    fs.rmSync(path.dirname(backupRoot), { recursive: true, force: true });\n    fs.mkdirSync(path.dirname(backupRoot), { recursive: true });\n    withFsRetry(() => fs.renameSync(this.stagingProjectRoot(), this.projectRoot));\n    const receipt = { ...withoutInternalMarker(marker), phase: \"cutover\" as const };\n    this.writeControl({\n      ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),\n      migration: receipt,\n    });\n    this.writeMarker({ ...marker, phase: \"cutover\" });\n    return receipt;\n  }\n\n  rollbackMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {\n    fenceSource(source, expectedSourceDigest);\n    const marker = this.requireMarker(source.sourceDigest);\n    if (marker.phase === \"rolled-back\") return withoutInternalMarker(marker);\n    if (marker.phase !== \"cutover\") {\n      fs.rmSync(this.migrationRoot, { recursive: true, force: true });\n      const rolledBack = { ...marker, phase: \"rolled-back\" as const };\n      fs.mkdirSync(this.migrationRoot, { recursive: true });\n      this.writeMarker(rolledBack);\n      return withoutInternalMarker(rolledBack);\n    }\n    fs.rmSync(this.projectRoot, { recursive: true, force: true });\n    if (marker.hadTarget && fs.existsSync(this.backupProjectRoot())) {\n      withFsRetry(() => fs.renameSync(this.backupProjectRoot(), this.projectRoot));\n    }\n    const receipt = { ...withoutInternalMarker(marker), phase: \"rolled-back\" as const };\n    this.writeControl({\n      schema: PROJECT_FILESYSTEM_STORE_SCHEMA,\n      rootId: source.state.rootId,\n      storeVersion: source.storeVersion,\n      receipts: [],\n      canonicalDigest: marker.canonicalDigest,\n      migration: receipt,\n    });\n    this.writeMarker({ ...marker, phase: \"rolled-back\" });\n    return receipt;\n  }\n\n  legacySourceMatchesCutover(state: ProjectModelState): boolean {\n    const migration = this.readControl(false)?.migration;\n    if (!migration || migration.phase !== \"cutover\") return true;\n    return domainDigest(projectDomain(state)) === migration.canonicalDigest;\n  }\n\n  private readControl(required = true): ProjectStoreControl | undefined {\n    if (!fs.existsSync(this.controlPath)) {\n      if (required) fail(\"store-missing\", \"Project filesystem control state is missing.\");\n      return undefined;\n    }\n    let value: unknown;\n    try { value = JSON.parse(fs.readFileSync(this.controlPath, \"utf8\")); }\n    catch { fail(\"store-corrupt\", \"Project filesystem control state is corrupt.\"); }\n    if (!isRecord(value) || value.schema !== PROJECT_FILESYSTEM_STORE_SCHEMA\n      || typeof value.rootId !== \"string\" || !Number.isSafeInteger(value.storeVersion) || Number(value.storeVersion) < 1\n      || !Array.isArray(value.receipts) || value.receipts.length > PROJECT_RECEIPT_LIMIT\n      || typeof value.canonicalDigest !== \"string\") {\n      fail(\"store-corrupt\", \"Project filesystem control state is invalid.\");\n    }\n    for (const receipt of value.receipts) validateReceipt(receipt);\n    return clone(value as unknown as ProjectStoreControl);\n  }\n\n  private readProjectTree(rootId: string): ProjectDomainState {\n    return readProjectTreeAt(this.projectRoot, rootId);\n  }\n\n  // Windows cannot rename a directory while another process (file watcher, indexer,\n  // antivirus) holds a handle inside it, so the tree is reconciled in place behind a\n  // roll-forward intent instead of swapping the whole directory.\n  private commitProjectTree(domain: ProjectDomainState, control: ProjectStoreControl): void {\n    atomicWriteJson(this.intentPath(), { schema: 1, domain, control });\n    this.applyIntent(domain, control);\n  }\n\n  private applyIntent(domain: ProjectDomainState, control: ProjectStoreControl): void {\n    syncProjectTree(this.projectRoot, domain);\n    const verified = readProjectTreeAt(this.projectRoot, domain.rootId);\n    if (domainDigest(verified) !== control.canonicalDigest) {\n      fail(\"store-write-verification-failed\", \"Project write verification failed.\");\n    }\n    fsyncDirectory(this.knowledgeRoot);\n    this.writeControl(control);\n    withFsRetry(() => fs.rmSync(this.intentPath(), { force: true }));\n    this.removeLegacyWriteStaging();\n  }\n\n  private recoverPendingCommit(): void {\n    if (!fs.existsSync(this.intentPath())) return;\n    let intent: any;\n    try {\n      intent = JSON.parse(fs.readFileSync(this.intentPath(), \"utf8\"));\n    } catch {\n      fail(\"store-corrupt\", \"Pending Project write intent is corrupt.\");\n    }\n    if (!isRecord(intent) || !isRecord(intent.domain) || !isRecord(intent.control)\n      || domainDigest(intent.domain as ProjectDomainState) !== intent.control.canonicalDigest) {\n      fail(\"store-corrupt\", \"Pending Project write intent is invalid.\");\n    }\n    this.applyIntent(intent.domain as ProjectDomainState, intent.control as ProjectStoreControl);\n  }\n\n  private removeLegacyWriteStaging(): void {\n    let entries: string[] = [];\n    try {\n      entries = fs.readdirSync(this.stateDirectory);\n    } catch {\n      return;\n    }\n    for (const entry of entries) {\n      if (!entry.startsWith(\".project-store-write-\")) continue;\n      try {\n        fs.rmSync(path.join(this.stateDirectory, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });\n      } catch {\n        // Best effort: a leftover staging directory is never read as canonical data.\n      }\n    }\n  }\n\n  private intentPath(): string {\n    return path.join(this.stateDirectory, \"project-store-intent.json\");\n  }\n\n  private writeControl(control: ProjectStoreControl): void {\n    atomicWriteJson(this.controlPath, control);\n  }\n\n  private stagingProjectRoot(): string {\n    return path.join(this.migrationRoot, \"stage\", \"project\");\n  }\n\n  private backupProjectRoot(): string {\n    return path.join(this.migrationRoot, \"backup\", \"project\");\n  }\n\n  private readMarker(required: boolean): MigrationMarker | undefined {\n    if (!fs.existsSync(this.markerPath)) {\n      if (required) fail(\"migration-not-staged\", \"Project migration state is missing.\");\n      return undefined;\n    }\n    try {\n      const marker = JSON.parse(fs.readFileSync(this.markerPath, \"utf8\"));\n      if (!isRecord(marker) || typeof marker.sourceDigest !== \"string\" || typeof marker.canonicalDigest !== \"string\"\n        || typeof marker.hadTarget !== \"boolean\") throw new Error(\"invalid\");\n      return marker as MigrationMarker;\n    } catch {\n      fail(\"migration-state-corrupt\", \"Project migration state is corrupt.\");\n    }\n  }\n\n  private requireMarker(sourceDigest: string): MigrationMarker {\n    const marker = this.readMarker(true)!;\n    if (marker.sourceDigest !== sourceDigest) fail(\"migration-source-changed\", \"Legacy Project source changed after staging.\");\n    return marker;\n  }\n\n  private writeMarker(marker: MigrationMarker): void {\n    atomicWriteJson(this.markerPath, marker);\n  }\n\n  private targetMatches(marker: MigrationMarker, rootId: string): boolean {\n    if (!fs.existsSync(this.projectRoot)) return false;\n    try {\n      return domainDigest(readProjectTreeAt(this.projectRoot, rootId)) === marker.canonicalDigest;\n    } catch {\n      return false;\n    }\n  }\n}"
  },
  {
    "name": "safeProjectDirectoryName",
    "source": "export function safeProjectDirectoryName(name: string, projectId: string): string {\n  const normalized = String(name || \"\").normalize(\"NFKC\").trim();\n  let segment = normalized\n    .replace(/[\\u0000-\\u001f\\u007f<>:\"/\\\\|?*]+/g, \"-\")\n    .replace(/\\s+/g, \"-\")\n    .replace(/-+/g, \"-\")\n    .replace(/[ .-]+$/g, \"\")\n    .replace(/^[ .-]+/g, \"\");\n  if (!segment) segment = \"project\";\n  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) segment += \"-project\";\n  segment = segment.slice(0, 80).replace(/[ .-]+$/g, \"\") || \"project\";\n  const safeId = String(projectId).replace(/[^A-Za-z0-9._-]/g, \"-\").slice(0, 128);\n  if (!safeId) fail(\"project-id-path-invalid\", \"Project identity cannot be represented as a portable path.\");\n  return `${segment}.${safeId}`;\n}"
  },
  {
    "name": "projectDomain",
    "source": "function projectDomain(state: ProjectModelState): ProjectDomainState {\n  return clone({\n    rootId: state.rootId,\n    projects: state.projects,\n    threads: state.threads,\n    ganttTasks: state.ganttTasks || [],\n    collaborationTasks: state.collaborationTasks || [],\n  });\n}"
  },
  {
    "name": "toModelState",
    "source": "function toModelState(domain: ProjectDomainState): ProjectModelState {\n  return {\n    schema: 1,\n    ...clone(domain),\n    recipes: [],\n    recipeFolders: [],\n    recipeTrash: [],\n    migrations: [],\n    audit: [],\n  };\n}"
  },
  {
    "name": "makeControl",
    "source": "function makeControl(\n  domain: ProjectDomainState,\n  storeVersion: number,\n  receipts: ProjectFilesystemReceipt[],\n): ProjectStoreControl {\n  return {\n    schema: PROJECT_FILESYSTEM_STORE_SCHEMA,\n    rootId: domain.rootId,\n    storeVersion,\n    receipts: compactReceipts(receipts),\n    canonicalDigest: domainDigest(domain),\n  };\n}"
  },
  {
    "name": "compactReceipts",
    "source": "function compactReceipts(receipts: ProjectFilesystemReceipt[]): ProjectFilesystemReceipt[] {\n  return receipts.slice(-PROJECT_RECEIPT_LIMIT);\n}"
  },
  {
    "name": "migrationReceipt",
    "source": "function migrationReceipt(\n  phase: ProjectMigrationPhase,\n  sourceDigest: string,\n  domain: ProjectDomainState,\n): ProjectMigrationReceipt {\n  return {\n    phase,\n    sourceDigest,\n    canonicalDigest: domainDigest(domain),\n    projects: domain.projects.length,\n    threads: domain.threads.length,\n    ganttTasks: domain.ganttTasks.length,\n    collaborationTasks: domain.collaborationTasks.length,\n  };\n}"
  },
  {
    "name": "withoutInternalMarker",
    "source": "function withoutInternalMarker(marker: MigrationMarker): ProjectMigrationReceipt {\n  const { hadTarget: _hadTarget, ...receipt } = marker;\n  return receipt;\n}"
  },
  {
    "name": "fenceSource",
    "source": "function fenceSource(source: LegacyProjectMigrationSource, expected?: string): void {\n  if (expected && expected !== source.sourceDigest) {\n    fail(\"migration-source-changed\", \"Legacy Project source changed since preview.\");\n  }\n}"
  },
  {
    "name": "domainDigest",
    "source": "function domainDigest(domain: ProjectDomainState): string {\n  return createHash(\"sha256\").update(canonicalJson(sortDomain(domain)), \"utf8\").digest(\"hex\");\n}"
  },
  {
    "name": "sortDomain",
    "source": "function sortDomain(domain: ProjectDomainState): ProjectDomainState {\n  const by = <T>(key: keyof T) => (left: T, right: T) => String(left[key]).localeCompare(String(right[key]));\n  return {\n    rootId: domain.rootId,\n    projects: clone(domain.projects).sort(by<ProjectRecord>(\"projectId\")),\n    threads: clone(domain.threads).sort(by<ThreadRecord>(\"threadId\")),\n    ganttTasks: clone(domain.ganttTasks).sort(by<GanttTaskRecord>(\"taskId\")),\n    collaborationTasks: clone(domain.collaborationTasks).sort(by<CollaborationTaskRecord>(\"collaborationId\")),\n  };\n}"
  },
  {
    "name": "PROJECT_ENTITY_DIRECTORIES",
    "source": "const PROJECT_ENTITY_DIRECTORIES = [\"threads\", \"gantt\", \"collaboration\"] as const;"
  },
  {
    "name": "projectTreeFiles",
    "source": "function projectTreeFiles(domain: ProjectDomainState): Map<string, Map<string, unknown>> {\n  const directories = new Map<string, Map<string, unknown>>();\n  for (const project of domain.projects) {\n    const files = new Map<string, unknown>();\n    files.set(\"project.json\", project);\n    for (const thread of domain.threads.filter(candidate => candidate.projectId === project.projectId)) {\n      files.set(`threads/${safeEntityFileName(thread.threadId)}.json`, thread);\n    }\n    for (const task of domain.ganttTasks.filter(candidate => candidate.projectId === project.projectId)) {\n      files.set(`gantt/${safeEntityFileName(task.taskId)}.json`, task);\n    }\n    for (const task of domain.collaborationTasks.filter(candidate => candidate.projectId === project.projectId)) {\n      files.set(`collaboration/${safeEntityFileName(task.collaborationId)}.json`, task);\n    }\n    directories.set(safeProjectDirectoryName(project.name, project.projectId), files);\n  }\n  return directories;\n}"
  },
  {
    "name": "syncProjectTree",
    "source": "function syncProjectTree(projectRoot: string, domain: ProjectDomainState): void {\n  const desired = projectTreeFiles(domain);\n  withFsRetry(() => fs.mkdirSync(projectRoot, { recursive: true }));\n  for (const [directoryName, files] of desired) {\n    const directory = path.join(projectRoot, directoryName);\n    for (const child of PROJECT_ENTITY_DIRECTORIES) {\n      withFsRetry(() => fs.mkdirSync(path.join(directory, child), { recursive: true }));\n    }\n    for (const [relative, value] of files) {\n      const filePath = path.join(directory, ...relative.split(\"/\"));\n      const text = canonicalJson(value);\n      let current: string | undefined;\n      try {\n        current = fs.readFileSync(filePath, \"utf8\");\n      } catch {\n        current = undefined;\n      }\n      if (current !== text) atomicWriteJson(filePath, value);\n    }\n    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {\n      if (entry.isDirectory() && (PROJECT_ENTITY_DIRECTORIES as readonly string[]).includes(entry.name)) {\n        for (const file of fs.readdirSync(path.join(directory, entry.name))) {\n          if (!files.has(`${entry.name}/${file}`)) removeWithRetry(path.join(directory, entry.name, file));\n        }\n      } else if (!(entry.isFile() && entry.name === \"project.json\")) {\n        removeWithRetry(path.join(directory, entry.name));\n      }\n    }\n  }\n  for (const entry of fs.readdirSync(projectRoot)) {\n    if (!desired.has(entry)) removeWithRetry(path.join(projectRoot, entry));\n  }\n  fsyncDirectory(projectRoot);\n}"
  },
  {
    "name": "writeProjectTree",
    "source": "function writeProjectTree(projectRoot: string, domain: ProjectDomainState): void {\n  syncProjectTree(projectRoot, domain);\n}"
  },
  {
    "name": "readProjectTreeAt",
    "source": "function readProjectTreeAt(projectRoot: string, rootId: string): ProjectDomainState {\n  if (!fs.existsSync(projectRoot)) fail(\"store-missing\", \"Canonical Project directory is missing.\");\n  const domain: ProjectDomainState = { rootId, projects: [], threads: [], ganttTasks: [], collaborationTasks: [] };\n  const projectIds = new Set<string>();\n  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {\n    if (!entry.isDirectory()) continue;\n    const directory = path.join(projectRoot, entry.name);\n    const project = readEntity<ProjectRecord>(path.join(directory, \"project.json\"));\n    if (projectIds.has(project.projectId)) fail(\"entity-conflict\", \"Project identity is duplicated.\");\n    if (!entry.name.endsWith(`.${project.projectId}`)) fail(\"entity-corrupt\", \"Project directory identity does not match project.json.\");\n    projectIds.add(project.projectId);\n    domain.projects.push(project);\n    domain.threads.push(...readEntityDirectory<ThreadRecord>(path.join(directory, \"threads\")));\n    domain.ganttTasks.push(...readEntityDirectory<GanttTaskRecord>(path.join(directory, \"gantt\")));\n    domain.collaborationTasks.push(...readEntityDirectory<CollaborationTaskRecord>(path.join(directory, \"collaboration\")));\n  }\n  const initialized = initializeProjectModel(toModelState(domain));\n  const verified = projectDomain(initialized);\n  if (canonicalJson(sortDomain(verified)) !== canonicalJson(sortDomain(domain))) {\n    fail(\"entity-corrupt\", \"Project entities require repair and cannot be loaded automatically.\");\n  }\n  return sortDomain(domain);\n}"
  },
  {
    "name": "readEntityDirectory",
    "source": "function readEntityDirectory<T>(directory: string): T[] {\n  if (!fs.existsSync(directory)) return [];\n  return fs.readdirSync(directory, { withFileTypes: true })\n    .filter(entry => entry.isFile() && entry.name.endsWith(\".json\"))\n    .map(entry => readEntity<T>(path.join(directory, entry.name)));\n}"
  },
  {
    "name": "readEntity",
    "source": "function readEntity<T>(filePath: string): T {\n  try {\n    const parsed = JSON.parse(fs.readFileSync(filePath, \"utf8\"));\n    if (!isRecord(parsed)) throw new Error(\"invalid\");\n    return parsed as T;\n  } catch {\n    fail(\"entity-corrupt\", `Project entity is corrupt: ${path.basename(filePath)}`);\n  }\n}"
  },
  {
    "name": "safeEntityFileName",
    "source": "function safeEntityFileName(id: string): string {\n  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id) || id === \".\" || id === \"..\") {\n    fail(\"entity-id-path-invalid\", \"Project entity identity is not portable.\");\n  }\n  return id;\n}"
  },
  {
    "name": "atomicWriteJson",
    "source": "function atomicWriteJson(filePath: string, value: unknown): void {\n  fs.mkdirSync(path.dirname(filePath), { recursive: true });\n  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;\n  const descriptor = fs.openSync(temporary, \"wx\", 0o600);\n  try {\n    fs.writeFileSync(descriptor, canonicalJson(value), \"utf8\");\n    fs.fsyncSync(descriptor);\n  } finally {\n    fs.closeSync(descriptor);\n  }\n  try {\n    withFsRetry(() => fs.renameSync(temporary, filePath));\n  } catch (error) {\n    try { fs.rmSync(temporary, { force: true }); } catch { /* keep original error */ }\n    throw error;\n  }\n  fs.chmodSync(filePath, 0o600);\n  fsyncDirectory(path.dirname(filePath));\n}"
  },
  {
    "name": "validateReceipt",
    "source": "function validateReceipt(value: unknown): void {\n  if (!isRecord(value) || typeof value.commandId !== \"string\" || typeof value.fingerprint !== \"string\"\n    || typeof value.operation !== \"string\" || !Number.isSafeInteger(value.storeVersion)\n    || typeof value.entityId !== \"string\") {\n    fail(\"store-corrupt\", \"Project command receipt is invalid.\");\n  }\n}"
  },
  {
    "name": "fsyncDirectory",
    "source": "function fsyncDirectory(directory: string): void {\n  let descriptor: number | undefined;\n  try {\n    descriptor = fs.openSync(directory, \"r\");\n    fs.fsyncSync(descriptor);\n  } catch (error: any) {\n    if (!error || ![\"EINVAL\", \"ENOTSUP\", \"EISDIR\", \"EPERM\"].includes(error.code)) throw error;\n  } finally {\n    if (descriptor !== undefined) fs.closeSync(descriptor);\n  }\n}"
  },
  {
    "name": "TRANSIENT_FS_CODES",
    "source": "const TRANSIENT_FS_CODES = new Set([\"EPERM\", \"EBUSY\", \"EACCES\", \"ENOTEMPTY\", \"EMFILE\", \"ENFILE\"]);"
  },
  {
    "name": "fsRetryPolicy",
    "source": "let fsRetryPolicy = { attempts: process.platform === \"win32\" ? 8 : 1, initialDelayMs: 25, maxDelayMs: 500 };"
  },
  {
    "name": "setProjectStoreFsRetryPolicyForTests",
    "source": "export function setProjectStoreFsRetryPolicyForTests(policy: Partial<typeof fsRetryPolicy>): () => void {\n  const previous = fsRetryPolicy;\n  fsRetryPolicy = { ...previous, ...policy };\n  return () => { fsRetryPolicy = previous; };\n}"
  },
  {
    "name": "withFsRetry",
    "source": "export function withFsRetry<T>(operation: () => T): T {\n  let delay = fsRetryPolicy.initialDelayMs;\n  for (let attempt = 1; ; attempt += 1) {\n    try {\n      return operation();\n    } catch (error: any) {\n      if (attempt >= fsRetryPolicy.attempts || !TRANSIENT_FS_CODES.has(error?.code)) throw error;\n      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);\n      delay = Math.min(delay * 2, fsRetryPolicy.maxDelayMs);\n    }\n  }\n}"
  },
  {
    "name": "removeWithRetry",
    "source": "function removeWithRetry(target: string): void {\n  withFsRetry(() => fs.rmSync(target, { recursive: true, force: true }));\n}"
  },
  {
    "name": "clone",
    "source": "function clone<T>(value: T): T {\n  return JSON.parse(canonicalJson(value)) as T;\n}"
  },
  {
    "name": "isRecord",
    "source": "function isRecord(value: unknown): value is Record<string, any> {\n  return typeof value === \"object\" && value !== null && !Array.isArray(value);\n}"
  },
  {
    "name": "fail",
    "source": "function fail(code: string, message: string): never {\n  throw new ProjectFilesystemStoreError(code, message);\n}"
  }
] as const;
