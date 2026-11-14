import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, Module } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import ts from "typescript";

export const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = resolve(serverRoot, "legacy");
const require = createRequire(import.meta.url);

/** In-memory ESM transpilation: no shared dist output, builds or source-tree loader hooks. */
export async function loadCollaborationModules(order = "contracts-first") {
  const cache = new Map();
  function url(relativePath) {
    const path = resolve(serverRoot, relativePath);
    if (cache.has(path)) return cache.get(path);
    let output = ts.transpileModule(readFileSync(path, "utf8"), {
      fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText;
    output = output.replace(/(from\s+|import\s*)["']([^"']+)["']/g, (match, prefix, specifier) => {
      if (specifier.startsWith("node:")) return match;
      const target = specifier.startsWith(".")
        ? url(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")))
        : pathToFileURL(require.resolve(specifier)).href;
      return `${prefix}${JSON.stringify(target)}`;
    });
    const result = `data:text/javascript;base64,${Buffer.from(output + `\n// ${order}`).toString("base64")}`;
    cache.set(path, result);
    return result;
  }
  const names = order === "store-first"
    ? ["src/collaboration-state.ts", "src/collaboration-state-contracts.ts"]
    : ["src/collaboration-state-contracts.ts", "src/collaboration-state.ts"];
  for (const name of names) await import(url(name));
  return {
    store: await import(url("src/collaboration-state.ts")),
    contracts: await import(url("src/collaboration-state-contracts.ts")),
    model: await import(url("src/domain/collaboration-state-model.ts")),
    permissions: await import(url("src/domain/collaboration-state-permissions.ts")),
    connections: await import(url("src/domain/collaboration-state-connections.ts")),
    routing: await import(url("src/domain/collaboration-state-routing.ts")),
  };
}

/** Evaluate original pure modules independently, without extension activation or network. */
export function loadOriginalPure(relativePath) {
  const path = resolve(repositoryRoot, relativePath);
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const mod = new Module(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(dirname(path));
  mod.require = specifier => specifier.startsWith(".")
    ? loadOriginalPure(resolve(dirname(path), specifier + ".ts")) : require(specifier);
  mod._compile(output, path);
  return mod.exports;
}

export const actors = Object.freeze({
  host: Object.freeze({ actorId: "fixture-host", kind: "human" }),
  worker: Object.freeze({ actorId: "fixture-worker", kind: "human" }),
  reviewer: Object.freeze({ actorId: "fixture-reviewer", kind: "human" }),
  outsider: Object.freeze({ actorId: "fixture-outsider", kind: "human" }),
});
export function mutation(roomId, expectedRevision, extra = {}) {
  return { operationId: randomUUID(), roomId, expectedRevision, ...extra };
}
export function taskInput(lead = "lead", worker = "worker", reviewer = "reviewer", extra = {}) {
  return {
    collaborationId: "fixture-task", title: "Bounded original reducer fixture", projectId: "fixture-project", threadId: "fixture-thread",
    lead, owners: [worker], reviewers: [reviewer], expectedResponders: [worker],
    objective: "Verify state", context: "Synthetic only", expectedOutput: "Fixture result", artifactType: "test",
    acceptanceCriteria: ["Transitions match the original"], at: "2026-01-01T00:00:00.000Z", ...extra,
  };
}
export async function createCollaborationFixture({ durable = false, authorizeHuman = () => true } = {}) {
  const { store: module } = await loadCollaborationModules();
  const path = durable ? resolve(serverRoot, "tests", `collaboration-state-${randomUUID()}.sqlite`) : ":memory:";
  let db = new DatabaseSync(path), clock = { now: Date.parse("2026-01-01T00:00:00Z") };
  const open = () => new module.CollaborationStateStore(db, { authorizeHuman, now: () => clock.now });
  let store = open();
  return {
    path, clock, module, get db() { return db; }, get store() { return store; },
    reopen() { if (!durable) throw new Error("Durable fixture required"); db.close(); db = new DatabaseSync(path); store = open(); return store; },
    cleanup() { db.close(); if (durable) for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true }); },
    seedRoom(roomId = "fixture-room") {
      store.create(actors.host, { roomId, operationId: randomUUID(), name: "Synthetic room", alias: "Host" });
      store.join(actors.worker, mutation(roomId, 1, { alias: "Worker" }));
      store.join(actors.reviewer, mutation(roomId, 2, { alias: "Reviewer" }));
      return store.read(actors.host, roomId);
    },
  };
}
