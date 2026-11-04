import { relativeToolPath } from "./tool-paths";

export interface WorkerScope { writeScope?: string[]; resources?: string[]; }
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
  const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const overlaps = (a: string, b: string) => {
    a = canonical(a); b = canonical(b);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  for (let index = 0; index < scopes.length; index++) {
    const candidate = scopes[index];
    for (const prior of [...existing, ...scopes.slice(0, index)]) {
      if (candidate.writeScope?.some(file => prior.writeScope?.some(other => overlaps(file, other)))
        || candidate.resources?.some(resource => prior.resources?.includes(resource))) {
        throw new Error("Worker write scopes or exclusive resources overlap. Wait for the original handoff; do not dispatch competing work.");
      }
    }
  }
}
