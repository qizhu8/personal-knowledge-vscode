/**
 * Compare independently captured expectations with observed migration results.
 * These rows describe only caller-supplied cases, not coverage or approval.
 */
export const importParityScopes = [
  "bytes", "frontmatter", "identity", "aliases", "linked-assets", "board-history",
  "source-version", "reads", "mutations", "backup-restore", "rollback",
] as const;
export type ImportParityScope = typeof importParityScopes[number];
export type ParityValue = null | boolean | number | string | ParityValue[] | { [key: string]: ParityValue };
export interface ImportParityCase {
  scope: ImportParityScope;
  key: string;
  value: ParityValue;
}
export interface ImportParityRow {
  scope: ImportParityScope;
  key: string;
  result: "match" | "mismatch" | "missing" | "unexpected";
}

function canonical(value: ParityValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError("Sparse arrays are not JSON values.");
      items.push(canonical(value[index]!));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  throw new TypeError("Parity values must contain only finite JSON values.");
}

export function compareImportParity(expected: readonly ImportParityCase[], actual: readonly ImportParityCase[]): ImportParityRow[] {
  if (!expected.length) throw new TypeError("Parity comparison requires explicit expected cases.");
  const index = (cases: readonly ImportParityCase[]) => {
    const map = new Map<string, { item: ImportParityCase; value: string }>();
    for (const item of cases) {
      if (!importParityScopes.includes(item.scope) || typeof item.key !== "string" || !item.key || item.key.length > 2048) {
        throw new TypeError("Invalid parity scope or case key.");
      }
      const id = JSON.stringify([item.scope, item.key]);
      if (map.has(id)) throw new TypeError("Duplicate parity case.");
      let value: string;
      try { value = canonical(item.value); }
      catch { throw new TypeError(`Invalid JSON parity value for ${item.scope}/${item.key}.`); }
      map.set(id, { item, value });
    }
    return map;
  };
  const left = index(expected), right = index(actual);
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(id => {
    const want = left.get(id), got = right.get(id);
    const item = (want ?? got)!.item;
    return {
      scope: item.scope, key: item.key,
      result: !want ? "unexpected" : !got ? "missing" : want.value === got.value ? "match" : "mismatch",
    };
  });
}
