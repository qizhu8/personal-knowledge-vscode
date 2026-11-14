export const legacyProjectEnvelopeOriginalSources = Object.freeze([
  {
    path: "src/workflows/project-store.ts",
    sha256: "a88568af85c6cbf714cc8c9efcfb641da12502df888b4c6dd9e4b7e24dacc010",
  },
  {
    path: "src/workflows/project-filesystem-store.ts",
    sha256: "20c0f58161b3f82181e48049e3ad95f0091ec41e1a1fba61413514c97502e0f8",
  },
  {
    path: "src/workflows/project-model.ts",
    sha256: "505f56e2351a9f173268007990eaf02f1014abe0dc4f722b12a8f6aa81c94195",
  },
  {
    path: "src/workflows/recipe-filesystem-store.ts",
    sha256: "3ecfb22753d16455ff7427993fd4d017dc00c1d2ffd65be9414157e31421b6f5",
  },
  {
    path: "src/workflows/workflow-contracts.ts",
    sha256: "35ea492ddd87ff604a581387afc6ea5b56c3e4fd3135d6d1dceb2c6af53dada8",
  },
  {
    path: "src/runtime/cross-process-lock.ts",
    sha256: "21735130fc0e0a4ecd950439bf65dc05522d9554726a0f55b5ea32ebf71f1270",
  },
] as const);

export const legacyProjectEnvelopeSupportedFormat = Object.freeze({
  path: ".pkm/state/projects.json",
  schema: 1,
  envelope: "ProjectStore { schema, storeVersion, payload: { state, receipts }, digest }",
  maximumBytes: 16 * 1024 * 1024,
  unsupported: [
    "unknown envelope schema versions",
    "canonical Project/Recipe stores or ambiguous mixed stores",
    "project or recipe migration markers and pending Project intents",
    "live or stale Project lock state",
    "non-empty Recipe trash and non-derived empty Recipe folders",
    "missing or conflicting root/default Project/General Thread identities",
    "duplicate identities, unordered receipts, or invalid payload digests",
  ],
});

export const legacyProjectEnvelopeAdoptionDdl = `
CREATE TABLE legacy_project_envelope(
  workspace_id TEXT PRIMARY KEY REFERENCES legacy_project_control(workspace_id) ON DELETE CASCADE,
  source_path TEXT NOT NULL CHECK(source_path='.pkm/state/projects.json'),
  source_schema INTEGER NOT NULL CHECK(source_schema=1),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_bytes BLOB NOT NULL CHECK(typeof(source_bytes)='blob' AND length(source_bytes)<=16777216),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  root_id TEXT NOT NULL CHECK(length(root_id) BETWEEN 1 AND 4096),
  store_version INTEGER NOT NULL CHECK(store_version>0),
  stage_id TEXT NOT NULL CHECK(length(stage_id) BETWEEN 1 AND 128),
  adoption_receipt TEXT NOT NULL
);
`;

export const legacyProjectEnvelopeAdoptionContract = Object.freeze({
  sourceInventoryPath: ".pkm/state/projects.json",
  nativeControlPath: ".pkm/state/project-store.json",
  exactBytesColumn: "legacy_project_envelope.source_bytes",
  orderedReceiptsTable: "legacy_project_receipt",
  projectHistory: "project/*.json and project/*/{threads,gantt,collaboration}/*.json",
  recipeHistory: "recipes/**/*.json",
  backup: "The workspace SQLite backup must include legacy_project_envelope and legacy_project_control/legacy_project_receipt in the same backup image.",
  commit: "Insert the opaque source envelope, native control, ordered original receipts, and global operation receipt in one SQLite transaction after staged-file verification.",
});
