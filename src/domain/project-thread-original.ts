export const capturedSources = Object.freeze({
  model: {
    path: "src/workflows/project-model.ts",
    sha256: "505f56e2351a9f173268007990eaf02f1014abe0dc4f722b12a8f6aa81c94195",
  },
  store: {
    path: "src/workflows/project-store.ts",
    sha256: "a88568af85c6cbf714cc8c9efcfb641da12502df888b4c6dd9e4b7e24dacc010",
  },
  filesystem: {
    path: "src/workflows/project-filesystem-store.ts",
    sha256: "20c0f58161b3f82181e48049e3ad95f0091ec41e1a1fba61413514c97502e0f8",
  },
  canonicalJson: {
    path: "src/workflows/workflow-contracts.ts",
    sha256: "35ea492ddd87ff604a581387afc6ea5b56c3e4fd3135d6d1dceb2c6af53dada8",
  },
});

export const capturedDeclarations = Object.freeze({
  threadMovePlan: `export interface ThreadMovePlan {
  threadId: string;
  destinationProjectId: string;
  linkedActiveRunIds: string[];
  includedRunIds: string[];
  audienceChanges: boolean;
  audienceChangeConfirmed: boolean;
}`,
  createThread: `export function createThread(state: ProjectModelState, projectId: string, name: string, createId: () => string = randomUUID): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  const threadId = \`thread_\${createId()}\`;
  if (state.threads.some(thread => thread.threadId === threadId)) throw new ProjectModelError("identity-conflict", "Generated Thread identity already exists.");
  return {
    ...state,
    threads: [...state.threads, { threadId, projectId, name: normalized, description: "", archived: false, legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "thread-created", entityId: threadId }]
  };
}`,
  renameThread: `export function renameThread(state: ProjectModelState, threadId: string, name: string): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-rename-forbidden", "General Thread cannot be renamed.");
  const normalized = String(name || "").trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  if (normalized === thread.name) return state;
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === threadId
      ? { ...candidate, name: normalized, version: candidate.version + 1 }
      : candidate),
    audit: [...state.audit, { event: "thread-renamed", entityId: threadId }]
  };
}`,
  moveThread: `export function moveThread(state: ProjectModelState, plan: ThreadMovePlan): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === plan.threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-move-forbidden", "General Thread cannot move between Projects.");
  if (!state.projects.some(project => project.projectId === plan.destinationProjectId)) throw new ProjectModelError("project-not-found", "Destination Project does not exist.");
  const omittedRuns = plan.linkedActiveRunIds.filter(runId => !plan.includedRunIds.includes(runId));
  if (omittedRuns.length) throw new ProjectModelError("active-run-move-blocked", \`Active Runs must move or be resolved: \${omittedRuns.join(", ")}\`);
  if (plan.audienceChanges && !plan.audienceChangeConfirmed) throw new ProjectModelError("audience-confirmation-required", "Thread movement changes its effective audience.");
  if (thread.projectId === plan.destinationProjectId) return state;
  const scheduled = (state.ganttTasks || []).filter(task => task.threadId === thread.threadId);
  if (scheduled.length) {
    throw new ProjectModelError("gantt-thread-move-blocked", "Move or remove Thread-associated Gantt tasks before moving this Thread.", {
      taskIds: scheduled.map(task => task.taskId)
    });
  }
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === thread.threadId ? { ...candidate, projectId: plan.destinationProjectId, version: candidate.version + 1 } : candidate),
    audit: [...state.audit, { event: "thread-moved", entityId: thread.threadId }]
  };
}`,
  validateThreadChatrooms: `function validateThreadChatrooms(state: ProjectModelState): void {
  const roomIds = new Set<string>();
  for (const thread of state.threads) {
    if (!thread.chatroom) continue;
    if (!ID_PATTERN.test(String(thread.chatroom.roomId || "")) || !String(thread.chatroom.roomName || "").trim()) {
      throw new ProjectModelError("chatroom-association-invalid", "Thread Chatroom association is invalid.");
    }
    normalizeTimestamp(thread.chatroom.linkedAt, "chatroom-linked-at-invalid");
    if (roomIds.has(thread.chatroom.roomId)) throw new ProjectModelError("chatroom-already-linked", "Chatroom is linked to more than one Thread.");
    roomIds.add(thread.chatroom.roomId);
  }
}`,
  validateGanttTasks: `function validateGanttTasks(state: ProjectModelState): void {
  const tasks = state.ganttTasks || [];
  const ids = new Set<string>();
  for (const candidate of tasks) {
    if (ids.has(candidate.taskId)) throw new ProjectModelError("gantt-task-id-duplicate", "Gantt task identity is duplicated.");
    ids.add(candidate.taskId);
    normalizeGanttTask(candidate, state);
  }
  for (const task of tasks) {
    const missing = task.dependencyIds.find(dependencyId => !ids.has(dependencyId));
    if (missing) throw new ProjectModelError("gantt-dependency-not-found", \`Gantt dependency \${missing} does not exist.\`);
    const crossProject = task.dependencyIds.find(dependencyId => tasks.find(candidate => candidate.taskId === dependencyId)?.projectId !== task.projectId);
    if (crossProject) throw new ProjectModelError("gantt-dependency-cross-project", "Gantt dependencies must belong to the same Project.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId);
      throw new ProjectModelError("gantt-dependency-cycle", \`Gantt dependency cycle: \${[...path.slice(start), taskId].join(" → ")}\`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependencyIds || []) visit(dependencyId, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId, []);
}`,
  storeCreateThread: `  createThread(command: ProjectStoreCommand, projectId: string, name: string): ProjectStoreResult {
    return this.mutate(command, "thread-create", state => {
      const next = createThread(state, projectId, name, this.createId);
      return { state: next, entityId: next.threads[next.threads.length - 1].threadId };
    });
  }`,
  storeRenameThread: `  renameThread(command: ProjectStoreCommand, threadId: string, name: string): ProjectStoreResult {
    return this.mutate(command, "thread-rename", state => ({ state: renameThread(state, threadId, name), entityId: threadId }));
  }`,
  storeMoveThread: `  moveThread(command: ProjectStoreCommand, plan: ThreadMovePlan): ProjectStoreResult {
    return this.mutate(command, "thread-move", state => ({ state: moveThread(state, plan), entityId: plan.threadId }));
  }`,
  filesystemCheckCommand: `  checkCommand(command: ProjectFilesystemCommand): ProjectFilesystemMutationResult | undefined {
    this.recoverPendingCommit();
    const control = this.readControl()!;
    const replay = control.receipts.find(receipt => receipt.commandId === command.commandId);
    if (replay) {
      if (replay.fingerprint !== command.fingerprint) {
        fail("command-conflict", "Command ID was already used with a different fingerprint.");
      }
      return { snapshot: this.list(), entityId: replay.entityId, replayed: true };
    }
    if (command.expectedStoreVersion !== control.storeVersion) {
      fail("store-version-conflict", "Expected Project store version does not match the current version.");
    }
    return undefined;
  }`,
  filesystemMutation: `  mutate(
    command: ProjectFilesystemCommand,
    operation: string,
    state: ProjectModelState,
    entityId: string,
  ): ProjectFilesystemMutationResult {
    const replay = this.checkCommand(command);
    if (replay) return replay;
    const control = this.readControl()!;
    const domain = projectDomain(state);
    const storeVersion = control.storeVersion + 1;
    const receipts = compactReceipts(control.receipts.concat({
      commandId: command.commandId,
      fingerprint: command.fingerprint,
      operation,
      storeVersion,
      entityId,
    }));
    this.commitProjectTree(domain, {
      ...makeControl(domain, storeVersion, receipts),
      ...(control.migration ? { migration: control.migration } : {}),
    });
    return { snapshot: { ...clone(domain), storeVersion }, entityId, replayed: false };
  }`,
  canonicalSerialization: `      const text = canonicalJson(value);
      let current: string | undefined;
      try {
        current = fs.readFileSync(filePath, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== text) atomicWriteJson(filePath, value);`,
});
