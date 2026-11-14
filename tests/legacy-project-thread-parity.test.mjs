import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import ts from "typescript";
import {
  checkLegacyProjectThreadCommand, inspectLegacyProjectThreadEffect, planLegacyProjectThreadEffect,
  recoverLegacyProjectThreadEffect, rollbackLegacyProjectThreadEffect, serializeLegacyProjectThreadEffect,
} from "../dist/legacy-project-thread-parity.js";
import { capturedDeclarations, capturedSources } from "../dist/domain/project-thread-original.js";
import { deriveSystemId, safeProjectDirectoryName } from "../dist/domain/project-recipes-project-rules.js";
import { projectSystemEntityIssue } from "../dist/domain/project-recipes.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import { capturedDeclarations as modelDeclarations } from "../dist/domain/project-mutations-original-project-model.js";

const ROOT = join(import.meta.dirname, ".legacy-project-thread-parity");
const rootId = "root_project_thread_parity";
const workspaceId = "12345678-1234-4234-8234-123456789012";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const sourceRoot = join(import.meta.dirname, "../legacy/src/workflows");
let fixtureCounter = 0;
const sha256 = value => createHash("sha256").update(value).digest("hex");
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, canonical(value), "utf8");
}

function projectDirectory(root, project) {
  return join(root, "project", safeProjectDirectoryName(project.name, project.projectId));
}

function addProject(root, project, threads = []) {
  const directory = projectDirectory(root, project);
  mkdirSync(directory, { recursive: true });
  for (const child of ["threads", "gantt", "collaboration"]) mkdirSync(join(directory, child), { recursive: true });
  writeJson(join(directory, "project.json"), project);
  for (const thread of threads) writeJson(join(directory, "threads", `${thread.threadId}.json`), thread);
  return directory;
}

function makeWorkspace() {
  const root = join(ROOT, `workspace-${process.pid}-${++fixtureCounter}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeJson(join(root, ".pkm-next-workspace"), { schema: "pkm.next-workspace/v2", id: workspaceId });
  const defaultProject = {
    projectId: deriveSystemId(rootId, "pkm/default-project/v1"),
    name: "Default Project", systemKind: "default-project", version: 1,
  };
  const defaultThread = {
    threadId: deriveSystemId(defaultProject.projectId, "pkm/general-thread/v1"),
    projectId: defaultProject.projectId, name: "General", description: "", archived: false,
    systemKind: "general-thread", legacyAliases: [], version: 1,
  };
  const alpha = { projectId: "project_alpha", name: "Alpha", version: 1 };
  const alphaGeneral = {
    threadId: deriveSystemId(alpha.projectId, "pkm/general-thread/v1"),
    projectId: alpha.projectId, name: "General", description: "", archived: false,
    legacyAliases: [], version: 1,
  };
  const alphaThread = {
    threadId: "thread_work", projectId: alpha.projectId, name: "Work", description: "", archived: false,
    legacyAliases: [], version: 1,
  };
  const beta = { projectId: "project_beta", name: "Beta", version: 1 };
  const betaThread = {
    threadId: "thread_beta", projectId: beta.projectId, name: "Beta topic", description: "", archived: false,
    legacyAliases: [], version: 1,
  };
  addProject(root, defaultProject, [defaultThread]);
  addProject(root, alpha, [alphaGeneral, alphaThread]);
  addProject(root, beta, [betaThread]);
  return { root, defaultProject, defaultThread, alpha, alphaGeneral, alphaThread, beta, betaThread };
}

function nativeDomain(root) {
  const page = readProjectRecipes(root, {
    operation: "project.list", args: { offset: 0, limit: 100 }, actorId: "test-project-thread-parity",
  });
  const projects = page.items;
  const threads = [], ganttTasks = [], collaborationTasks = [];
  for (const project of projects) {
    const detail = readProjectRecipes(root, {
      operation: "project.get",
      args: { id: project.projectId, snapshotRevision: page.snapshotRevision },
      actorId: "test-project-thread-parity",
    });
    threads.push(...detail.threads);
    ganttTasks.push(...detail.ganttTasks);
    collaborationTasks.push(...detail.collaborationTasks);
  }
  return {
    rootId, projects, threads, ganttTasks, collaborationTasks,
    snapshotRevision: page.snapshotRevision,
  };
}

function originalFunction(source) {
  const compiled = ts.transpileModule(source.replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const declarations = modelDeclarations;
  const deriveDeclaration = ts.transpileModule(
    declarations.find(item => item.startsWith("export function deriveSystemId(")).replace(/^export\s+/, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const derive = new Function("createHash", `${deriveDeclaration}\nreturn deriveSystemId;`)(
    createHash,
  );
  return new Function("ProjectModelError", "randomUUID", "deriveSystemId", `${compiled}\nreturn ${source.match(/function\s+(\w+)/)[1]};`)(
    class ProjectModelError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    () => "unused",
    derive,
  );
}

function originalCreateProject() {
  const declaration = modelDeclarations.find(item => item.startsWith("export function createProject("));
  assert.ok(declaration);
  return originalFunction(declaration);
}

function originalThreadFunction(name) {
  return originalFunction(capturedDeclarations[name]);
}

function oracleState(domain) {
  return {
    schema: 1, rootId: domain.rootId, projects: structuredClone(domain.projects),
    threads: structuredClone(domain.threads), ganttTasks: structuredClone(domain.ganttTasks),
    collaborationTasks: structuredClone(domain.collaborationTasks), migrations: [], audit: [],
  };
}

function command(operation, expectedStoreVersion = 4) {
  return {
    commandId: `command-${operation}`,
    fingerprint: `fingerprint-${operation}`,
    operation,
    expectedStoreVersion,
  };
}

function control(expectedStoreVersion = 4, receipts = []) {
  return { storeVersion: expectedStoreVersion, receipts };
}

function request(root, domain, operation, args, commandValue = command(operation)) {
  return {
    workspaceId, rootId, actorId: "test-original-project-store", operationId,
    expectedSnapshotRevision: domain.snapshotRevision, command: commandValue, operation, args,
  };
}

function plan(root, operation, args, runOracle, controlValue = control()) {
  const before = nativeDomain(root);
  const beforeState = oracleState(before);
  const afterState = runOracle(beforeState);
  const oracle = {
    before: {
      rootId, projects: beforeState.projects, threads: beforeState.threads,
      ganttTasks: beforeState.ganttTasks, collaborationTasks: beforeState.collaborationTasks,
    },
    after: {
      rootId, projects: afterState.projects, threads: afterState.threads,
      ganttTasks: afterState.ganttTasks, collaborationTasks: afterState.collaborationTasks,
    },
  };
  return planLegacyProjectThreadEffect(root, request(root, before, operation, args), oracle, controlValue);
}

test("captured Project/Thread declarations and source pins match authoritative source files", () => {
  for (const source of Object.values(capturedSources)) {
    const file = readFileSync(join(sourceRoot, source.path.split("/").at(-1)));
    assert.equal(sha256(file), source.sha256, `${source.path} source hash`);
  }
  const modelSource = readFileSync(join(sourceRoot, "project-model.ts"), "utf8");
  const storeSource = readFileSync(join(sourceRoot, "project-store.ts"), "utf8");
  const filesystemSource = readFileSync(join(sourceRoot, "project-filesystem-store.ts"), "utf8");
  const workflowSource = readFileSync(join(sourceRoot, "workflow-contracts.ts"), "utf8");
  for (const key of [
    "threadMovePlan", "createThread", "renameThread", "moveThread",
    "validateThreadChatrooms", "validateGanttTasks",
  ]) {
    assert.ok(modelSource.includes(capturedDeclarations[key]), `model capture ${key}`);
  }
  for (const key of ["storeCreateThread", "storeRenameThread", "storeMoveThread"]) {
    assert.ok(storeSource.includes(capturedDeclarations[key]), `store capture ${key}`);
  }
  for (const key of ["filesystemCheckCommand", "filesystemMutation"]) {
    assert.ok(filesystemSource.includes(capturedDeclarations[key]), `filesystem capture ${key}`);
  }
  assert.ok(filesystemSource.includes(capturedDeclarations.canonicalSerialization));
  assert.ok(workflowSource.includes("export function canonicalJson(value: unknown): string"));
});

test("original ProjectStore createProject records exact IDs, compact bytes, store version, and recovers after restart", () => {
  const fixture = makeWorkspace();
  try {
    const before = nativeDomain(fixture.root);
    const createId = () => "original-random-project-id";
    const original = originalCreateProject()(oracleState(before), " Native Project ", createId);
    const project = original.projects.at(-1);
    const thread = original.threads.at(-1);
    const effect = planLegacyProjectThreadEffect(fixture.root, request(fixture.root, before, "project-create", { name: "Native Project" }), {
      before: {
        rootId, projects: before.projects, threads: before.threads,
        ganttTasks: before.ganttTasks, collaborationTasks: before.collaborationTasks,
      },
      after: {
        rootId, projects: original.projects, threads: original.threads,
        ganttTasks: original.ganttTasks, collaborationTasks: original.collaborationTasks,
      },
    }, control());
    assert.equal(effect.entityId, project.projectId);
    assert.equal(effect.files[0].afterBase64, Buffer.from(canonical(project)).toString("base64"));
    assert.equal(effect.expectedStoreVersion, 4);
    assert.equal(effect.nextStoreVersion, 5);
    assert.equal(effect.command.commandId, "command-project-create");
    assert.equal(inspectLegacyProjectThreadEffect(fixture.root, effect).state, "before");
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, effect).state, "complete");
    assert.equal(inspectLegacyProjectThreadEffect(fixture.root, effect).state, "after");
    assert.equal(nativeDomain(fixture.root).projects.find(item => item.projectId === project.projectId).projectId, project.projectId);
    assert.equal(nativeDomain(fixture.root).threads.find(item => item.threadId === thread.threadId).systemKind, "general-thread");
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, JSON.parse(serializeLegacyProjectThreadEffect(effect))).state, "complete");
    assert.equal(rollbackLegacyProjectThreadEffect(fixture.root, effect).state, "rolled-back");
    assert.equal(nativeDomain(fixture.root).projects.some(item => item.projectId === project.projectId), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("per-Project system General Threads and ordinary unmarked Generals preserve original protections", () => {
  const fixture = makeWorkspace();
  try {
    const before = nativeDomain(fixture.root);
    const createThread = originalThreadFunction("createThread");
    const created = createThread(oracleState(before), fixture.defaultProject.projectId, "General", () => "ordinary-general");
    const createEffect = planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, before, "thread-create", { projectId: fixture.defaultProject.projectId, name: "General" }), {
        before: { rootId, projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId, projects: created.projects, threads: created.threads, ganttTasks: [], collaborationTasks: [] },
      }, control());
    assert.equal(createEffect.entityId, "thread_ordinary-general");
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, createEffect).state, "complete");

    const afterCreate = nativeDomain(fixture.root);
    const ordinary = afterCreate.threads.find(item => item.threadId === createEffect.entityId);
    const renameThread = originalThreadFunction("renameThread");
    const renamed = renameThread(oracleState(afterCreate), ordinary.threadId, "Renamed General");
    const renameEffect = planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, afterCreate, "thread-rename", { threadId: ordinary.threadId, name: "Renamed General" }), {
        before: { rootId, projects: afterCreate.projects, threads: afterCreate.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId, projects: renamed.projects, threads: renamed.threads, ganttTasks: [], collaborationTasks: [] },
      }, control());
    assert.equal(renameEffect.files.length, 1);
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, renameEffect).state, "complete");

    const protectedGeneral = afterCreate.threads.find(item => item.projectId === fixture.defaultProject.projectId
      && item.systemKind === "general-thread");
    assert.throws(() => renameThread(oracleState(afterCreate), protectedGeneral.threadId, "No"), error =>
      error?.code === "system-thread-rename-forbidden");
    assert.throws(() => originalThreadFunction("moveThread")(oracleState(afterCreate), {
      threadId: protectedGeneral.threadId, destinationProjectId: fixture.beta.projectId,
      linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
    }), error => error?.code === "system-thread-move-forbidden");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("native reads preserve separately-derived system General Threads in multiple Projects", () => {
  const fixture = makeWorkspace();
  try {
    const alphaGeneralPath = join(projectDirectory(fixture.root, fixture.alpha), "threads", `${fixture.alphaGeneral.threadId}.json`);
    writeJson(alphaGeneralPath, { ...fixture.alphaGeneral, systemKind: "general-thread" });
    const betaGeneral = {
      threadId: deriveSystemId(fixture.beta.projectId, "pkm/general-thread/v1"),
      projectId: fixture.beta.projectId, name: "General", description: "", archived: false,
      systemKind: "general-thread", legacyAliases: [], version: 1,
    };
    addProject(fixture.root, fixture.beta, [betaGeneral, fixture.betaThread]);
    const domain = nativeDomain(fixture.root);
    assert.equal(domain.threads.filter(thread => thread.systemKind === "general-thread").length, 3);

    const renameThread = originalThreadFunction("renameThread");
    const moveThread = originalThreadFunction("moveThread");
    for (const thread of domain.threads.filter(item => item.systemKind === "general-thread")) {
      assert.throws(() => renameThread(oracleState(domain), thread.threadId, "No"), error =>
        error?.code === "system-thread-rename-forbidden");
      assert.throws(() => moveThread(oracleState(domain), {
        threadId: thread.threadId, destinationProjectId: fixture.beta.projectId,
        linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
      }), error => error?.code === "system-thread-move-forbidden");
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("thread rename preserves fields and recognizes no-op, partial, recovery, rollback, and conflicts", () => {
  const fixture = makeWorkspace();
  try {
    const before = nativeDomain(fixture.root);
    const renameThread = originalThreadFunction("renameThread");
    const noOp = renameThread(oracleState(before), fixture.alphaThread.threadId, " Work ");
    const noOpEffect = planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, before, "thread-rename", { threadId: fixture.alphaThread.threadId, name: " Work " }), {
        before: { rootId, projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId, projects: noOp.projects, threads: noOp.threads, ganttTasks: [], collaborationTasks: [] },
      }, control());
    assert.equal(noOpEffect.files.length, 0);
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, noOpEffect).state, "complete");

    const renamed = renameThread(oracleState(before), fixture.alphaThread.threadId, " Work Plan ");
    const effect = planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, before, "thread-rename", { threadId: fixture.alphaThread.threadId, name: " Work Plan " }), {
        before: { rootId, projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId, projects: renamed.projects, threads: renamed.threads, ganttTasks: [], collaborationTasks: [] },
      }, control());
    const sourceFile = join(fixture.root, ...effect.files[0].relativePath.split("/"));
    writeFileSync(sourceFile, Buffer.from(effect.files[0].afterBase64, "base64"));
    assert.equal(inspectLegacyProjectThreadEffect(fixture.root, effect).state, "after");
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, effect).state, "complete");
    assert.equal(rollbackLegacyProjectThreadEffect(fixture.root, effect).state, "rolled-back");
    writeFileSync(sourceFile, "unknown");
    assert.equal(inspectLegacyProjectThreadEffect(fixture.root, effect).state, "unknown");
    assert.equal(rollbackLegacyProjectThreadEffect(fixture.root, effect).state, "unknown");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Thread moves enforce original active-run, audience, Gantt, cross-Project, and protected-General rules", () => {
  const fixture = makeWorkspace();
  try {
    const before = nativeDomain(fixture.root);
    const moveThread = originalThreadFunction("moveThread");
    const sameProjectPlan = {
      threadId: fixture.alphaThread.threadId, destinationProjectId: fixture.alpha.projectId,
      linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
    };
    const unchanged = moveThread(oracleState(before), sameProjectPlan);
    const noOpEffect = planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, before, "thread-move", sameProjectPlan), {
        before: { rootId, projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId, projects: unchanged.projects, threads: unchanged.threads, ganttTasks: [], collaborationTasks: [] },
      }, control());
    assert.equal(noOpEffect.files.length, 0);
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, noOpEffect).state, "complete");

    const basePlan = {
      threadId: fixture.alphaThread.threadId, destinationProjectId: fixture.beta.projectId,
      linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
    };
    const moved = moveThread(oracleState(before), basePlan);
    const effect = planLegacyProjectThreadEffect(fixture.root, request(fixture.root, before, "thread-move", basePlan), {
      before: { rootId, projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
      after: { rootId, projects: moved.projects, threads: moved.threads, ganttTasks: [], collaborationTasks: [] },
    }, control());
    assert.equal(effect.files.length, 2);
    const sourcePath = join(fixture.root, ...effect.files.find(file => file.beforeSha256 !== null && file.afterSha256 === null)
      .relativePath.split("/"));
    unlinkSync(sourcePath);
    assert.equal(inspectLegacyProjectThreadEffect(fixture.root, effect).state, "mixed");
    assert.equal(recoverLegacyProjectThreadEffect(fixture.root, effect).state, "complete");
    const movedThread = nativeDomain(fixture.root).threads.find(item => item.threadId === fixture.alphaThread.threadId);
    assert.equal(movedThread.projectId, fixture.beta.projectId);
    assert.equal(movedThread.version, fixture.alphaThread.version + 1);
    assert.equal(rollbackLegacyProjectThreadEffect(fixture.root, effect).state, "rolled-back");

    assert.throws(() => moveThread(oracleState(before), {
      ...basePlan, linkedActiveRunIds: ["run-one"], includedRunIds: [],
    }), error => error?.code === "active-run-move-blocked");
    assert.throws(() => moveThread(oracleState(before), {
      ...basePlan, audienceChanges: true, audienceChangeConfirmed: false,
    }), error => error?.code === "audience-confirmation-required");
    assert.throws(() => moveThread(oracleState(before), {
      ...basePlan, destinationProjectId: "project_missing",
    }), error => error?.code === "project-not-found");
    assert.throws(() => moveThread(oracleState(before), {
      ...basePlan, threadId: fixture.defaultThread.threadId,
    }), error => error?.code === "system-thread-move-forbidden");

    const gantt = {
      taskId: "task_work", projectId: fixture.alpha.projectId, threadId: fixture.alphaThread.threadId,
      title: "Work", startDate: "2026-01-01", endDate: "2026-01-01", progress: 0,
      status: "not-started", owners: [], dependencyIds: [], version: 1,
    };
    writeJson(join(projectDirectory(fixture.root, fixture.alpha), "gantt", `${gantt.taskId}.json`), gantt);
    const withGantt = nativeDomain(fixture.root);
    assert.throws(() => moveThread(oracleState(withGantt), basePlan), error =>
      error?.code === "gantt-thread-move-blocked");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("opaque original command replay precedes version admission and conflicts on fingerprint", () => {
  const saved = { commandId: "opaque", fingerprint: "opaque-fingerprint", operation: "thread-create", storeVersion: 5, entityId: "thread_x" };
  assert.equal(checkLegacyProjectThreadCommand(control(99, [saved]), {
    commandId: "opaque", fingerprint: "opaque-fingerprint", operation: "other", expectedStoreVersion: 0,
  }).status, "replay");
  assert.throws(() => checkLegacyProjectThreadCommand(control(99, [saved]), {
    commandId: "opaque", fingerprint: "different", operation: "thread-create", expectedStoreVersion: 0,
  }), error => error?.code === "COMMAND_CONFLICT");
  assert.throws(() => checkLegacyProjectThreadCommand(control(5), {
    commandId: "new", fingerprint: "fp", operation: "thread-create", expectedStoreVersion: 4,
  }), error => error?.code === "STORE_VERSION_CONFLICT");
});

test("System validation rejects duplicate, missing, cross-Project, mistyped, and wrong-root identities", () => {
  const fixture = makeWorkspace();
  try {
    const before = nativeDomain(fixture.root);
    const malformed = structuredClone(before);
    malformed.threads.push({ ...fixture.defaultThread, threadId: "thread_duplicate" });
    assert.throws(() => planLegacyProjectThreadEffect(fixture.root,
      request(fixture.root, before, "thread-create", { projectId: fixture.alpha.projectId, name: "New" }), {
        before: {
          rootId, projects: malformed.projects, threads: malformed.threads,
          ganttTasks: malformed.ganttTasks, collaborationTasks: malformed.collaborationTasks,
        },
        after: {
          rootId, projects: malformed.projects, threads: malformed.threads,
          ganttTasks: malformed.ganttTasks, collaborationTasks: malformed.collaborationTasks,
        },
      }, control()), error => error?.code === "INVALID_DOCUMENT");

    assert.throws(() => planLegacyProjectThreadEffect(fixture.root,
      { ...request(fixture.root, before, "thread-create", { projectId: fixture.alpha.projectId, name: "New" }), rootId: "wrong-root" }, {
        before: { rootId: "wrong-root", projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
        after: { rootId: "wrong-root", projects: before.projects, threads: before.threads, ganttTasks: [], collaborationTasks: [] },
      }, control()), error => error?.code === "INVALID_DOCUMENT");
    const defaultGroup = {
      project: fixture.defaultProject,
      threads: [fixture.defaultThread],
    };
    assert.equal(projectSystemEntityIssue([], rootId), undefined);
    assert.ok(projectSystemEntityIssue([{
      project: fixture.alpha, threads: [fixture.alphaGeneral],
    }], rootId));
    assert.ok(projectSystemEntityIssue([{
      project: fixture.defaultProject, threads: [],
    }], rootId));
    assert.ok(projectSystemEntityIssue([
      defaultGroup,
      { project: { ...fixture.defaultProject, projectId: "project_second_default" }, threads: [] },
    ], rootId));
    assert.ok(projectSystemEntityIssue([{
      project: fixture.defaultProject,
      threads: [fixture.defaultThread, { ...fixture.defaultThread }],
    }], rootId));
    assert.ok(projectSystemEntityIssue([{
      project: fixture.defaultProject,
      threads: [{ ...fixture.defaultThread, projectId: fixture.alpha.projectId }],
    }], rootId));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }

  const invalidWorkspace = change => {
    const fixture = makeWorkspace();
    try {
      change(fixture);
      assert.throws(() => nativeDomain(fixture.root), error => error?.code === "INVALID_DOCUMENT");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  };
  invalidWorkspace(fixture => {
    writeJson(join(projectDirectory(fixture.root, fixture.defaultProject), "project.json"),
      { projectId: fixture.defaultProject.projectId, name: fixture.defaultProject.name, version: 1 });
  });
  invalidWorkspace(fixture => {
    const thread = { ...fixture.defaultThread };
    delete thread.systemKind;
    writeJson(join(projectDirectory(fixture.root, fixture.defaultProject), "threads", `${thread.threadId}.json`), thread);
  });
  invalidWorkspace(fixture => {
    writeJson(join(projectDirectory(fixture.root, fixture.defaultProject), "threads", "thread_cross.json"), {
      ...fixture.defaultThread,
      threadId: deriveSystemId(fixture.alpha.projectId, "pkm/general-thread/v1"),
      projectId: fixture.alpha.projectId,
    });
  });
  invalidWorkspace(fixture => {
    writeJson(join(projectDirectory(fixture.root, fixture.defaultProject), "threads", `${fixture.defaultThread.threadId}.json`),
      { ...fixture.defaultThread, systemKind: "default-project" });
  });
});
