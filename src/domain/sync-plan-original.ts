export function githubSyncSafeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!normalized || /^[A-Za-z]:/.test(normalized) || segments.some(segment =>
    !segment || segment === ".." || segment === "." || /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || windowsReserved.test(segment)
  ) || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Managed destination is invalid: ${value}`);
  }
  return normalized;
}

export function githubSyncIgnoredPath(relative: string): boolean {
  const parts = relative.replace(/\\/g, "/").split("/");
  const directories = new Set([".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".ipynb_checkpoints", ".tox", ".nox", ".venv", "node_modules"]);
  const name = parts[parts.length - 1];
  return parts.some(part => directories.has(part)) || /(?:\.py[co]|\.DS_Store|Thumbs\.db)$/i.test(name)
    || /^(?:\.#|~\$)/.test(name) || /^#.*#$/.test(name)
    || /^\..+\.(?:[a-f0-9-]{32,36}|[0-9]{8,})\.tmp$/i.test(name)
    || /\.[0-9]+\.[a-f0-9]{10}\.tmp$/i.test(name)
    || /^\..+\.sw[pon]$/.test(name);
}

export function githubSyncUnrecordedAbsenceNeedsReview(
  base: boolean, local: boolean, remote: boolean, localDeletion: boolean, remoteDeletion: boolean,
): boolean {
  return base && ((!local && remote && !localDeletion) || (local && !remote && !remoteDeletion));
}

export interface PublicationMember {
  path: string;
}

/** Pure admission: blocked entities and their required dependencies stay remote. */
export function planGitHubSyncPublication<T extends PublicationMember>(
  candidates: ReadonlyMap<string, readonly T[]>,
  remote: ReadonlyMap<string, readonly T[]>,
  blocked: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): { files: T[]; blocked: Set<string>; collisions: Set<string> } {
  const isolated = new Set(blocked);
  const collisions = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const isolate = (key: string): void => {
      if (!isolated.has(key)) { isolated.add(key); changed = true; }
    };
    for (const [key, required] of dependencies) {
      if (isolated.has(key) || [...required].some(dependency => isolated.has(dependency))) {
        isolate(key);
        for (const dependency of required) isolate(dependency);
      }
    }
    const owners = new Map<string, string>();
    for (const key of new Set([...candidates.keys(), ...remote.keys()])) {
      for (const file of (isolated.has(key) ? remote : candidates).get(key) || []) {
        const portable = file.path.toLocaleLowerCase("en-US");
        const previous = owners.get(portable);
        if (previous !== undefined && previous !== key) {
          collisions.add(previous); collisions.add(key);
          isolate(previous); isolate(key);
        } else owners.set(portable, key);
      }
    }
  }
  return {
    files: [...new Set([...candidates.keys(), ...remote.keys()])]
      .flatMap(key => [...((isolated.has(key) ? remote : candidates).get(key) || [])]),
    blocked: isolated, collisions,
  };
}
