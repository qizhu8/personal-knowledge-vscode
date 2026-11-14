// Exact original native Manager scope/budget guards and root acceptance; regenerate with capture-manager-plan.mjs.
export function relativeToolPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\0:]/.test(value)) throw new Error("Use a workspace-relative path.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some(part => !part || part.startsWith(".") || part === "node_modules")) throw new Error("Hidden, excluded or outside-workspace paths are not allowed.");
  if (/\.(pem|key)$/i.test(normalized) || /(^|\/)(credentials|id_rsa|id_ed25519)(\.|$)/i.test(normalized)) throw new Error("Attach sensitive files explicitly instead of using tools.");
  return normalized;
}

export interface WorkerScope { writeScope?: string[]; resources?: string[]; }

const canonicalPath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

const containsPath = (parent: string, child: string) => {
  parent = canonicalPath(parent); child = canonicalPath(child);
  return parent === child || child.startsWith(`${parent}/`);
};

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

export interface WorkerLimits { automatic: number; maximum: number; }

export function workerLimits(automatic: number, maximum: number): WorkerLimits {
  if (!Number.isSafeInteger(automatic) || !Number.isSafeInteger(maximum) || automatic < 0 || maximum < 1 || maximum > 1000 || automatic > maximum) {
    throw new Error("Worker limits require 0 <= automatic <= maximum <= 1000.");
  }
  return { automatic, maximum };
}

export const rootWorkCriterion = "The original user objective and all subsequent requirements are satisfied.";
