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
