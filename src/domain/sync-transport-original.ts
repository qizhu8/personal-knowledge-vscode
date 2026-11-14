// Captured publication wire serialization; REST transport is a new, disabled adapter.
type GitHubSyncManagedFile = {
  path: string; type: string; itemId: string; member: string; category: string; privacy: "public" | "private"; digest: string;
  content?: unknown; sourceDigest?: unknown; rawSnapshot?: unknown; sourceLocator?: unknown; baseIntegrityEvidence?: unknown;
};
type GitHubSyncDeletionEvidence = { type: string; itemId: string; deletedAt: string; category?: string; privacy?: "public" | "private" };
const GITHUB_SYNC_MANIFEST_SCHEMA = 3;
export const GITHUB_SYNC_EXTENSION_VERSION = "4.0.22";
const GITHUB_SYNC_REQUIRED_CAPABILITIES = ["explicit-deletions", "stable-entity-identity"] as const;
const GITHUB_SYNC_SUPPORTED_CAPABILITIES = new Set<string>([...GITHUB_SYNC_REQUIRED_CAPABILITIES, "entity-partial-progress", "action-library-assets", "profile-cards"]);
export const MANIFEST_PATH = ".pkm-github-sync.json";

export function manifestJson(files: GitHubSyncManagedFile[], deletions: GitHubSyncDeletionEvidence[] = []): string {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const members = new Set<string>();
  for (const file of ordered) {
    const portable = file.path.toLocaleLowerCase("en-US");
    if (paths.has(portable)) throw new Error(`Managed destinations differ only by case: ${file.path}.`);
    paths.add(portable);
    const member = `${file.type}\0${file.itemId}\0${file.member}`;
    if (members.has(member)) throw new Error(`Managed content repeats stable member identity for ${file.itemId}.`);
    members.add(member);
  }
  return JSON.stringify({
    schema: GITHUB_SYNC_MANIFEST_SCHEMA,
    minimumExtensionVersion: GITHUB_SYNC_EXTENSION_VERSION,
    capabilities: {
      required: [...GITHUB_SYNC_SUPPORTED_CAPABILITIES].filter(capability =>
        (capability !== "action-library-assets" || [...ordered, ...deletions].some(file => file.type === "actions" || file.type === "action-module-sets"))
        && (capability !== "profile-cards" || [...ordered, ...deletions].some(file => file.type === "profiles"))),
      storage: "pkm.github.publication/v1",
    },
    // Review-only evidence is machine-local, never publication metadata.
    files: ordered.map(({ content, sourceDigest, rawSnapshot, sourceLocator, baseIntegrityEvidence, ...file }) => file),
    deletions: [...deletions].sort((left, right) =>
      `${left.type}\0${left.itemId}`.localeCompare(`${right.type}\0${right.itemId}`))
      .map(({ type, itemId, deletedAt, category, privacy }) => ({ type, itemId, deletedAt, category, privacy })),
  }, null, 2) + "\n";
}

export interface PersonaProfile {
  schema: "pkm.profile/v1";
  id: string;
  revision: number;
  updatedAt: string;
  kind: "user" | "agent";
  name: string;
  role: string;
  focus: string;
  preferences: string;
  boundaries: string;
  responseStyle?: PersonaResponseStyle;
  deleted?: true;
}

export interface PersonaResponseStyle {
  verbosity: "default" | "concise" | "detailed";
  terminology: "default" | "explain" | "domain";
  ordering: "default" | "conclusion-first" | "evidence-first";
}

const idValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

const fields = ["name", "role", "focus", "preferences", "boundaries"] as const;

const responseStyleKeys = ["verbosity", "terminology", "ordering"] as const;

const recordKeys = new Set(["schema", "id", "revision", "updatedAt", "kind", ...fields, "responseStyle", "deleted"]);

function validResponseStyle(value: unknown): value is PersonaResponseStyle {
  if (!value || typeof value !== "object" || Object.keys(value).length !== responseStyleKeys.length
    || responseStyleKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  const style = value as PersonaResponseStyle;
  return ["default", "concise", "detailed"].includes(style.verbosity)
    && ["default", "explain", "domain"].includes(style.terminology)
    && ["default", "conclusion-first", "evidence-first"].includes(style.ordering);
}

export function validatePersona(value: unknown): asserts value is PersonaProfile {
  const p = value as PersonaProfile;
  if (!p || typeof p !== "object" || Object.keys(p).some(key => !recordKeys.has(key)) || p.schema !== "pkm.profile/v1"
    || !idValid(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1
    || typeof p.updatedAt !== "string" || !Number.isFinite(Date.parse(p.updatedAt))
    || !["user", "agent"].includes(p.kind) || fields.some(key => typeof p[key] !== "string")
    || p.responseStyle !== undefined && !validResponseStyle(p.responseStyle)
    || p.deleted !== undefined && p.deleted !== true) throw new Error("Invalid private Profile record.");
  const size = fields.reduce((count, key) => count + p[key].length, 0);
  if (p.name.length > 120 || p.role.length > 120 || size > (p.kind === "user" ? 2000 : 4000)) {
    throw new Error(`Profile exceeds its ${p.kind === "user" ? 2000 : 4000}-character limit (including all card fields); nothing was saved.`);
  }
  if (!p.deleted && !p.name.trim()) throw new Error("Profile name is required.");
  if (p.deleted && size !== 0) throw new Error("Deleted Profile must not retain current card content.");
}

export function portablePersonaPath(record: PersonaProfile): string {
  return `profiles/${record.kind}/${record.id}.json`;
}
