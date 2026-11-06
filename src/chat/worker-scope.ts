import { relativeToolPath } from "./tool-paths";

export interface WorkerScope { writeScope?: string[]; resources?: string[]; }
const canonicalPath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const containsPath = (parent: string, child: string) => {
  parent = canonicalPath(parent); child = canonicalPath(child);
  return parent === child || child.startsWith(`${parent}/`);
};
export function validWorkerScope(value: unknown): value is WorkerScope {
  try { workerScope(value); return true; } catch { return false; }
}
export function workerScope(value: unknown): WorkerScope {
  if (!value || typeof value !== "object") throw new Error("Provide a worker scope object.");
  const record = value as Record<string, unknown>, result: WorkerScope = {};
  for (const key of ["writeScope", "resources"] as const) {
    const items = record[key];
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length > 16 || items.some(item => typeof item !== "string" || !item.trim() || item.length > 256)
      || new Set(items).size !== items.length) throw new Error("Worker scopes require up to 16 distinct bounded paths/resource names.");
    result[key] = items.map(item => key === "writeScope" ? relativeToolPath(item).replace(/\\/g, "/").replace(/\/$/, "") : item);
  }
  return result;
}

export function assertIndependentWorkerScopes(tasks: WorkerScope[], active: WorkerScope[] = []): void {
  const scopes = tasks.map(workerScope), existing = active.map(workerScope);
  for (let index = 0; index < scopes.length; index++) {
    const candidate = scopes[index];
    for (const prior of [...existing, ...scopes.slice(0, index)]) {
      if (candidate.writeScope?.some(file => prior.writeScope?.some(other => containsPath(file, other) || containsPath(other, file)))
        || candidate.resources?.some(resource => prior.resources?.includes(resource))) {
        throw new Error("Worker write scopes or exclusive resources overlap. Wait for the original handoff; do not dispatch competing work.");
      }
    }
  }
}

export function assertWorkerScopeWithin(task: WorkerScope, ancestor: WorkerScope): void {
  const child = workerScope(task), parent = workerScope(ancestor);
  const { writeScope, resources } = parent;
  if (writeScope && child.writeScope?.some(file => !writeScope.some(owner => containsPath(owner, file)))
    || resources && child.resources?.some(resource => !resources.includes(resource))) {
    throw new Error("A recursive worker cannot expand its ancestor's declared write scope or exclusive resources.");
  }
}
