import type { DatabaseSync } from "node:sqlite";

export type FreshKnowledgeArea = "notes" | "skills" | "papers";
export interface KnowledgeReadRestriction {
  privateTopLevels(area: string): ReadonlySet<string>;
}
const knowledgeReadRestrictions = new Map<string, KnowledgeReadRestriction>();
/** Admission-only deny policies are immutable for this process; they never grant private access. */
export function bindKnowledgeReadRestriction(root: string, restriction: KnowledgeReadRestriction): void {
  const prior = knowledgeReadRestrictions.get(root);
  if (prior && prior !== restriction) throw new Error("Knowledge read restrictions cannot be replaced in a live process.");
  knowledgeReadRestrictions.set(root, restriction);
}
export function knowledgeReadPrivateTopLevels(root: string, area: string): ReadonlySet<string> {
  return knowledgeReadRestrictions.get(root)?.privateTopLevels(area) ?? new Set<string>();
}
export interface FreshNoteSource {
  readonly area: FreshKnowledgeArea;
  readonly path: string;
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly deleted: boolean;
  readonly knowledgeId: string | null;
  readonly raw: string;
  readonly sha256: string;
  readonly statPin: string;
  readonly mtimeNs: string;
  readonly boardPresent: boolean;
  readonly dependencyPin: string;
}
export interface FreshRootScan {
  readonly rootPin: string;
  readonly guardDigest: string;
  readonly sources: ReadonlyMap<string, FreshNoteSource>;
  readonly directories: ReadonlySet<string>;
}
const qualifiedScans = new WeakSet<object>();
/** Internal scanner boundary; never called on a serialized/public request. */
export function qualifyFreshRootScan(scan: FreshRootScan): FreshRootScan {
  const map = scan.sources, set = scan.directories;
  const sources: ReadonlyMap<string, FreshNoteSource> = Object.freeze({
    size: map.size, get: map.get.bind(map), has: map.has.bind(map),
    entries: map.entries.bind(map), keys: map.keys.bind(map), values: map.values.bind(map),
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
    forEach(callback: (value: FreshNoteSource, key: string, owner: ReadonlyMap<string, FreshNoteSource>) => void, thisArg?: unknown) {
      map.forEach((value, key) => callback.call(thisArg, value, key, sources));
    },
  });
  const directories: ReadonlySet<string> = Object.freeze({
    size: set.size, has: set.has.bind(set), entries: set.entries.bind(set), keys: set.keys.bind(set),
    values: set.values.bind(set), [Symbol.iterator]: set[Symbol.iterator].bind(set),
    forEach(callback: (value: string, key: string, owner: ReadonlySet<string>) => void, thisArg?: unknown) {
      set.forEach(value => callback.call(thisArg, value, value, directories));
    },
  });
  const qualified = Object.freeze({ ...scan, sources, directories });
  qualifiedScans.add(qualified);
  return qualified;
}
export function isQualifiedFreshRootScan(scan: FreshRootScan): boolean {
  return qualifiedScans.has(scan);
}
export interface FreshRootScanner {
  readonly rootPin: string;
  scan(): FreshRootScan;
  statistics(): Readonly<{ scans: number; reads: number; parses: number; identityUpdates: number }>;
}
export interface LegacyNoteListArguments {
  type?: string | null;
  directory?: string | null;
  recursive?: boolean;
  offset?: number;
  limit?: number;
  inventory_revision?: string | null;
}
export interface LegacyNoteSearchArguments {
  query: string;
  limit?: number | null;
}
export type FreshNoteQuery =
  | { kind: "list"; arguments: LegacyNoteListArguments }
  | { kind: "legacy-lexical"; arguments: LegacyNoteSearchArguments };
export type FreshNoteGuardPhase = "initialize" | "before" | "after-query" | "after-scan" | "before-commit";
export interface FreshNoteQueryScope {
  readonly workspaceId: string;
  readonly rootPin: string;
}
export interface FreshNoteTrustedGuard {
  /** Must assert live root/private binding/actor/privacy/journal/lease authority at every phase. */
  assert(phase: FreshNoteGuardPhase): FreshNoteQueryScope;
}
export interface FreshNoteQueryOptions {
  database: DatabaseSync;
  scanner: FreshRootScanner;
  guard: FreshNoteTrustedGuard;
  /** Optional documents-index owner; synchronous, inside its already-held guarded SQL transaction. */
  reconcileRootIndex?: (scan: FreshRootScan, delta: {
    readonly rebuild: boolean;
    readonly changed: readonly FreshNoteSource[];
    readonly removed: readonly FreshNoteSource[];
  }) => undefined;
  /** Foreign commits in a separately transacted documents projection also require reconciliation. */
  externalDatabaseVersion?: () => number;
}
export interface FreshNoteQueryReply {
  readonly text: string;
  readonly generation: number;
  readonly guardDigest: string;
}
export interface FreshNoteQueryModel {
  executeFresh(query: FreshNoteQuery): FreshNoteQueryReply;
  statistics(): Readonly<{ reconciliations: number; ftsUpdates: number; generations: number }>;
  close(): void;
}
