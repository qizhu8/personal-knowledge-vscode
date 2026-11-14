import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { scanMarkdown } from "./markdown.js";
import { scanBoards } from "./boards.js";
import { readProjectRecipeSnapshot } from "./project-recipes.js";
import { legacyKnowledgeTree, type LegacySnapshotFile } from "./legacy-knowledge-snapshot.js";
import { legacyScriptIdentitySchema } from "./legacy-library.js";
import { verifyLegacyNoteWorkItemsWorkspace } from "./host-composition-legacy-note-workitems.js";
import { createRetrievalSnapshot, indexedRetrievalDocument } from "./legacy-retrieval-snapshot-captured.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { asArray, normalizeCites, skillPriority, toYear } from "./legacy-retrieval-projection-captured.js";
import { legacyRetrievalSubscriptions } from "./legacy-retrieval-subscriptions.js";
import { parseLegacyRouterConfig } from "./legacy-router-config.js";
import { readLegacyStateReceipt, verifyBoundLegacyStateBytes } from "./host-composition-legacy-state.js";
import { verifyLegacyRetrievalModels } from "./legacy-retrieval-model.js";
import { authorizeLegacyRetrievalFeedback, legacyLearningStateSchema, publishLegacyRetrievalLearning,
  readLegacyRetrievalLearning } from "./legacy-retrieval-learning.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const LEGACY_RETRIEVAL_ENGINE_SHA256 = "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89";
export const legacyIndexedKnowledgeRequest = z.strictObject({
  tool: z.enum(["get_knowledge", "get_script", "search_knowledge", "search_scripts",
    "get_note", "get_skill", "get_paper", "get_research",
    "search_notes", "search_skills", "search_research", "search_papers", "skill_context", "retrieval_status", "retrieval_feedback"]),
  arguments: z.record(z.string(), z.unknown()),
});
const rowSchema = z.strictObject({
  generation: z.number().int().positive().safe(), corpus_revision: z.string().regex(/^[a-f0-9]{64}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/), engine_sha256: z.literal(LEGACY_RETRIEVAL_ENGINE_SHA256),
  document_count: z.number().int().nonnegative().safe(),
});
const ddl = `CREATE TABLE IF NOT EXISTS legacy_retrieval_corpus (
  generation INTEGER PRIMARY KEY, corpus_revision TEXT NOT NULL, source_sha256 TEXT NOT NULL,
  engine_sha256 TEXT NOT NULL, document_count INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_retrieval_corpus_no_update BEFORE UPDATE ON legacy_retrieval_corpus
BEGIN SELECT RAISE(ABORT,'retrieval generation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_retrieval_corpus_no_delete BEFORE DELETE ON legacy_retrieval_corpus
BEGIN SELECT RAISE(ABORT,'retrieval generation is immutable'); END;`;

function inspect(database: DatabaseSync) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_corpus'").get();
  if (!exists) database.exec(ddl);
  const columns = database.prepare("PRAGMA table_info(legacy_retrieval_corpus)").all().map(row => row.name);
  if (JSON.stringify(columns) !== JSON.stringify(Object.keys(rowSchema.shape)))
    throw new CoreError("INVALID_WORKSPACE", "Original retrieval generation schema changed.");
  for (const suffix of ["update", "delete"]) {
    const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(`legacy_retrieval_corpus_no_${suffix}`);
    if (!String(trigger?.sql).toLowerCase().includes("raise(abort"))
      throw new CoreError("INVALID_WORKSPACE", "Original retrieval generation immutability is missing.");
  }
  const rows = database.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all();
  rows.forEach((value, index) => {
    const row = rowSchema.parse(value);
    if (row.generation !== index + 1) throw new CoreError("INVALID_WORKSPACE", "Original retrieval generation chain is incomplete.");
  });
  return rows.length ? rowSchema.parse(rows.at(-1)) : undefined;
}

function languages(path: string, raw: string): string {
  const extension = extname(path).toLowerCase();
  const known: Record<string, string> = { ".cs": "C#", ".py": "Python", ".ps1": "PowerShell",
    ".usql": "U-SQL", ".sql": "SQL", ".sh": "Shell" };
  if (known[extension]) return known[extension];
  if (extension !== ".script") return extension ? extension.slice(1).toUpperCase() : "text";
  const sample = raw.slice(0, 20000), values = ["Scope"];
  if (/#CS\b|#ENDCS\b|\bpublic\s+(class|static|struct)\b|\busing\s+System\b/.test(sample)) values.push("C#");
  if (/\bPython(Reducer|Processor|Combiner|Mapper)?\b|#PY\b|\.py"|\bimport\s+\w+/.test(sample)) values.push("Python");
  return values.join(" + ");
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function legacyRetrievalSources(storage: Storage, database: DatabaseSync,
  subscription?: Awaited<ReturnType<typeof legacyRetrievalSubscriptions>>) {
  storage.assertWorkspaceLease();
  const root = storage.workspaceRoot();
  const rootStat = lstatSync(root, { bigint: true });
  const providerFiles = legacyKnowledgeTree(root, "knowledge-read-config", "retrieval");
  if (providerFiles.some(file => !file.directory && file.path !== "retrieval/router-config.json"))
    throw new CoreError("NOT_AVAILABLE", "Configured retrieval providers need their original native model/learning authority.");
  for (const file of providerFiles.filter(file => !file.directory)) {
    if (file.raw === undefined) throw new CoreError("INVALID_DATA", "Retrieval router policy must be valid UTF-8.");
    parseLegacyRouterConfig(file.raw);
  }
  const subscriptions = subscription?.cache ?? legacyKnowledgeTree(root, "subscriptions", "cache", true);
  if (!subscription && subscriptions.some(file => !file.directory))
    throw new CoreError("NOT_AVAILABLE", "Unified subscribed retrieval needs the complete native subscription corpus adapter.");
  const admissions = database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_note_workitems_admission'").get();
  if (admissions) verifyLegacyNoteWorkItemsWorkspace(database, root);
  const admitted = new Set(admissions ? database.prepare("SELECT slug FROM legacy_note_workitems_admission").all().map(row => row.slug) : []);
  const boards = scanBoards(root);
  const records = scanMarkdown(root).filter(document =>
    !document.record.deleted && !document.metadata.has("memory")
    && !document.record.path.split("/").some(part => part.toLowerCase() === "system")
    && ["notes", "skills", "papers"].includes(document.record.area));
  const files: LegacySnapshotFile[] = records.map(document => {
    const stat = lstatSync(join(root, document.record.area, document.record.path), { bigint: true });
    return { area: document.record.area, path: document.record.path, raw: document.raw, size: Number(stat.size),
      mtimeNs: String(stat.mtimeNs), pin: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  });
  const skills: any[] = [], notes: any[] = [], papers: any[] = [];
  for (const document of records) {
    const fm = document.metadata.toJS({ maxAliasCount: 0 }) as Record<string, any>;
    const key = document.record.path.replace(/\.md$/i, ""), category = dirname(key) === "." ? "" : dirname(key);
    const mtime = lstatSync(join(root, document.record.area, document.record.path)).mtime.toISOString();
    const common = { ...fm, content: document.record.content, category, links: array(fm.links),
      knowledgeId: /^knowledge_[a-f0-9]{24}$/.test(String(fm.knowledgeId || "")) ? fm.knowledgeId : undefined,
      revision: Number.isSafeInteger(Number(fm.revision)) && Number(fm.revision) > 0 ? Number(fm.revision) : undefined,
      tags: JSON.stringify(asArray(fm.tags)), created_at: fm.created || mtime };
    if (document.record.area === "skills") {
      skills.push({ ...common, _key: key, name: fm.name || basename(key), description: fm.description ?? "",
        source_project: fm.source_project ?? null, recipe_required: fm.recipe_required === true,
        recipe_hint: String(fm.recipe_hint || ""), related_skills: asArray(fm.related_skills),
        priority: skillPriority(fm.priority) });
    } else if (document.record.area === "notes") {
      const backing = legacyKnowledgeTree(root, "notes", `${key}.assets/pkm-todo-board.json`);
      const native = admitted.has(key) ? boards.get(key) : undefined;
      const rawBoard = native?.raw ?? backing.find(file => !file.directory)?.raw;
      files.push(...backing.filter(file => !file.directory).map(file => ({ ...file, raw: file.raw ?? "", pin: file.pin })));
      notes.push({ ...common, slug: key, title: fm.title || basename(key), description: fm.description || "",
        type: fm.type || "general", documentKind: fm.documentKind === "todo-board" || rawBoard !== undefined ? "todo-board" : "markdown",
        ...(rawBoard !== undefined ? { boardDigest: hash(rawBoard) } : {}) });
    } else {
      papers.push({ ...common, slug: key, title: fm.title || basename(key), description: fm.description || "",
        kind: fm.kind === "idea" ? "idea" : "paper", year: toYear(fm.year), conclusions: asArray(fm.conclusions),
        implementation: asArray(fm.implementation), assumptions: asArray(fm.assumptions), cites: normalizeCites(fm.cites) });
    }
  }
  const scriptFiles = legacyKnowledgeTree(root, "scripts");
  const identities = new Map<string, z.infer<typeof legacyScriptIdentitySchema>>();
  for (const file of scriptFiles.filter(file => !file.directory && basename(file.path).startsWith(".") && file.path.endsWith(".pkm.json"))) {
    if (file.raw === undefined) throw new CoreError("INVALID_DATA", "Script identity must be valid UTF-8.");
    const identity = legacyScriptIdentitySchema.parse(JSON.parse(file.raw));
    const target = join(dirname(file.path), basename(file.path).slice(1, -".pkm.json".length)).replaceAll("\\", "/");
    identities.set(target, identity);
  }
  const scripts: any[] = [], owners = new Map<string, string>();
  const claim = (reference: string, path: string) => {
    if (owners.has(reference) && owners.get(reference) !== path) throw new CoreError("CONFLICT", "Script index identity or alias is ambiguous.");
    owners.set(reference, path);
  };
  for (const [path, identity] of identities) {
    claim(`pkm://script/${identity.knowledgeId}`, path);
    for (const alias of identity.aliases) claim(alias, path);
  }
  for (const file of scriptFiles) {
    if (file.directory || file.path.split("/").some(part => part.startsWith("."))) continue;
    if (file.raw === undefined) throw new CoreError("NOT_AVAILABLE", "Indexed Script content must be valid UTF-8.");
    const legacyId = `script_${hash(file.path).slice(0, 24)}`, uri = `pkm://scripts/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const identity = identities.get(file.path);
    if (!identity && [uri, `pkm://script/${legacyId}`].some(reference => owners.has(reference)))
      throw new CoreError("NOT_AVAILABLE", "A reused Script path requires an explicit identity migration.");
    claim(`pkm://script/${identity?.knowledgeId ?? legacyId}`, file.path);
    scripts.push({ path: file.path, file: basename(file.path), category: dirname(file.path) === "." ? "(root)" : dirname(file.path),
      content: file.raw, lang: languages(file.path, file.raw), extension: extname(file.path), knowledgeId: identity?.knowledgeId ?? legacyId });
  }
  const recipes = readProjectRecipeSnapshot(root);
  const sources = { skills, notes, papers, scripts, recipes: recipes.recipes, subscriptionGroups: subscription?.groups ?? [],
    readSubscription(key: string) {
      if (subscription) return subscription.read(key);
      throw new CoreError("NOT_AVAILABLE", "Subscribed corpus is not admitted.");
    } };
  const original = createRetrievalSnapshot(sources);
  const snapshot = { ...original, documents: original.documents.map(indexedRetrievalDocument) };
  if (new Set(snapshot.documents.map(document => document.source_id)).size !== snapshot.documents.length)
    throw new CoreError("CONFLICT", "Indexed source identities are ambiguous.");
  const boardPins = [...boards].filter(([slug]) => admitted.has(slug)).map(([slug, value]) => [slug, value.raw]);
  return { snapshot, files: [...files, ...providerFiles], recipes: recipes.recipes,
    sourceDigest: hash(JSON.stringify({ rootIdentity: `${rootStat.dev}:${rootStat.ino}`, documents: snapshot.documents, boardPins, scriptFiles, providerFiles,
      recipes: recipes.snapshotRevision, subscriptions, subscriptionRevision: subscription?.revision })) };
}

export async function legacyIndexedKnowledgeRead(storage: Storage, args: z.infer<typeof legacyIndexedKnowledgeRequest>,
  authorizeSubscriptions?: () => Promise<unknown>, execute?: (input: unknown) => Promise<unknown>,
  actor: Actor = { id: "mcp:external", canWrite: false }) {
  const authorization = authorizeSubscriptions ? await authorizeSubscriptions() : undefined;
  const result = await storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const database = storage.connectNative();
    try {
      const workspaceId = await storage.workspaceId();
      const binding = readLegacyStateReceipt(database, workspaceId);
      if (binding?.plan.statePlan?.subscriptionIdentity && !authorizeSubscriptions)
        throw new CoreError("ACCESS_DENIED", "Imported subscriber identity requires its native fixed-actor read authority.");
      await verifyBoundLegacyStateBytes(database, storage.workspaceRoot(), workspaceId);
      const models = verifyLegacyRetrievalModels(database, storage.workspaceRoot()), model = models.active;
      const learning = readLegacyRetrievalLearning(database, { workspaceId, actorId: actor.id });
      const latest = inspect(database), before = legacyRetrievalSources(storage, database, await legacyRetrievalSubscriptions(storage.workspaceRoot()));
      const authority = model ? { actorId: actor.id, workspaceId, packageId: model.packageId, selectionRevision: model.revision,
        corpusRevision: before.snapshot.corpus_revision, pinsDigest: hash(JSON.stringify(before.snapshot.documents)) } : undefined;
      if (args.tool === "retrieval_feedback") {
        if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "Read-only MCP cannot submit retrieval relevance judgments.");
        if (!model || !authority) throw new CoreError("NOT_AVAILABLE", "Retrieval feedback requires a current admitted native model selection.");
        if (args.arguments.provenance === "user" && !model.userFeedback)
          throw new CoreError("ACCESS_DENIED", "User relevance provenance requires explicit native user-judgment authority.");
        authorizeLegacyRetrievalFeedback(database, authority, String(args.arguments.retrieval_id ?? ""));
      }
      const same = latest?.corpus_revision === before.snapshot.corpus_revision && latest?.source_sha256 === before.sourceDigest;
      const generation = same ? latest.generation : (latest?.generation ?? 0) + 1;
      const input = {
          ...args, ...before, retrievalSnapshot: { ...before.snapshot, generation }, retrievalModel: model,
          learningState: learning.state,
        };
      const staged = z.strictObject({ value: z.json(), text: z.string(), learningState: legacyLearningStateSchema.optional() })
        .parse(await (execute ? execute(input) : runLegacyMcpPython(
        fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url)), [], input)));
      const result = { value: staged.value, text: staged.text };
      storage.assertWorkspaceLease();
      const after = legacyRetrievalSources(storage, database, await legacyRetrievalSubscriptions(storage.workspaceRoot()));
      await verifyBoundLegacyStateBytes(database, storage.workspaceRoot(), workspaceId);
      if (JSON.stringify(verifyLegacyRetrievalModels(database, storage.workspaceRoot()).selection) !== JSON.stringify(models.selection))
        throw new CoreError("CONFLICT", "Native local-model selection changed during retrieval.");
      if (before.sourceDigest !== after.sourceDigest || JSON.stringify(before.files) !== JSON.stringify(after.files))
        throw new CoreError("CONFLICT", "Indexed sources changed during retrieval; no generation was published.");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = inspect(database);
        if (JSON.stringify(current) !== JSON.stringify(latest)) throw new CoreError("CONFLICT", "Indexed generation changed before publication.");
        if (!same) database.prepare("INSERT INTO legacy_retrieval_corpus VALUES(?,?,?,?,?)").run(
          generation, before.snapshot.corpus_revision, before.sourceDigest, LEGACY_RETRIEVAL_ENGINE_SHA256, before.snapshot.documents.length);
        if (staged.learningState) {
          if (!authority) throw new CoreError("INVALID_WORKSPACE", "Unconfigured lexical result cannot publish model learning receipts.");
          const value = z.record(z.string(), z.unknown()).parse(staged.value);
          publishLegacyRetrievalLearning(database, authority, learning.revision, staged.learningState,
            args.tool === "retrieval_feedback" ? undefined : z.string().regex(/^[a-f0-9]{48}$/).parse(value.retrieval_id));
        }
        storage.assertWorkspaceLease();
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return result;
    } finally { database.close(); }
  });
  if (authorizeSubscriptions && JSON.stringify(authorization) !== JSON.stringify(await authorizeSubscriptions()))
    throw new CoreError("CONFLICT", "Native subscriber read authority or membership changed during indexed retrieval.");
  return result;
}
