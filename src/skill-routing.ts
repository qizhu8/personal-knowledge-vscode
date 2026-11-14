import { CoreError, type StorageRequest } from "./contracts.js";
import { createSkillQueries, projectSkill } from "./domain/skills.js";
import { rankSkillContext, routingSkillId, skillLinkage, skillContextHash } from "./domain/skill-routing-context.js";
import { renderProjection } from "./domain/skill-routing-projection.js";
import { knowledgeCandidatePriority, parseRetrievalSelection, retrievalJudgmentInput } from "./domain/skill-routing-prompt.js";
import { createAutomaticSkillSelection } from "./domain/skill-routing-selection.js";
import { availableSkillRouterSources, normalizeSkillRouterSourcePriority } from "./domain/skill-routing-sources.js";
import { sha256 } from "./file-write.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import type { MarkdownRecord } from "./markdown.js";
import { skillRecord } from "./skill-contracts.js";
import { skillRoutingDefinitions, SKILL_ROUTING_MAX_RESULT_BYTES, SKILL_ROUTING_MAX_SNAPSHOT_BYTES } from "./skill-routing-contracts.js";

export { skillRoutingDefinitions } from "./skill-routing-contracts.js";

const adapters = [
  { id: "agent-native", available: false as const, reason: "Native Skill discovery and activation belong to the active Agent host; no synthetic candidate or score." },
  { id: "subscriber", available: false as const, reason: "No isolated subscription/cache adapter is wired. External broker/cache paths are never read." },
  { id: "retrieval-boundary", available: false as const, reason: "Original metadata-threshold fallback only; no worker generation, semantic retrieval, frozen-serving rank or online learning is available." },
  { id: "related-recipes", available: false as const, reason: "Original related_recipes state adapter is unavailable. Empty related_recipes is not evidence of no matches; discover qualified Recipes through a host adapter before acting on next_action." },
  { id: "host-projection-install", available: false as const, reason: "Only SKILL.md text is projected. Target discovery, globalState, environment paths, inject/remove/retire and host writes are unavailable." },
];

export function readSkillRouting(root: string, documents: MarkdownRecord[], request: StorageRequest): unknown {
  const operation: string = request.operation;
  const definition = skillRoutingDefinitions.find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown Skill routing query.");
  const input = definition.input.safeParse(request.args);
  if (!input.success) throw new CoreError("INVALID_ARGUMENT", `Invalid Skill routing arguments: ${input.error.message}`);
  const sources = knowledgeSnapshot(root, documents, "skills", "Skill routing");
  const ids = new Set<string>(), paths = new Set<string>(), knowledgeIds = new Set<string>();
  const entries = sources.map(source => {
    if (ids.has(source.document.record.id) || paths.has(source.rel)) {
      throw new CoreError("CONFLICT", "Duplicate Skill stable document identity/path.");
    }
    ids.add(source.document.record.id); paths.add(source.rel);
    if (Buffer.byteLength(source.document.raw, "utf8") > 1_048_576
      || Buffer.from(source.document.raw, "utf8").toString("utf8") !== source.document.raw
      || sha256(source.document.raw) !== source.document.record.sha256) {
      throw new CoreError("INVALID_DOCUMENT", "Skill source must retain valid UTF-8 bytes under 1 MiB and a matching raw SHA.");
    }
    const parsed = skillRecord.safeParse(projectSkill(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Skill metadata violates the original read-model types: skills/${source.rel}.`);
    if (parsed.data.knowledgeId) {
      if (knowledgeIds.has(parsed.data.knowledgeId) || ids.has(parsed.data.knowledgeId) && parsed.data.knowledgeId !== source.document.record.id) {
        throw new CoreError("CONFLICT", "Duplicate/ambiguous Skill knowledge identity.");
      }
      knowledgeIds.add(parsed.data.knowledgeId);
    }
    return { source, row: parsed.data, address: {
      documentId: source.document.record.id, path: source.rel, documentSha256: source.document.record.sha256,
    } };
  });
  const owners = new Map(entries.map(entry => [entry.address.documentId, entry]));
  for (const entry of entries) {
    if (entry.row.knowledgeId && owners.has(entry.row.knowledgeId) && owners.get(entry.row.knowledgeId) !== entry) {
      throw new CoreError("CONFLICT", "Ambiguous cross-document/knowledge identity.");
    }
  }
  // Raw SHA alone misses mtime-based metadata, supplied decoded bodies and stable identities.
  const snapshot = JSON.stringify(entries.map(entry => ({
    address: entry.address, rawSha256: sha256(entry.source.document.raw), metadata: entry.source.fm,
    projected: entry.row, mtime: entry.source.mtime, document: entry.source.document.record,
  })));
  if (Buffer.byteLength(snapshot, "utf8") > SKILL_ROUTING_MAX_SNAPSHOT_BYTES) {
    throw new CoreError("BUSY", "Skill routing projected snapshot pin exceeds 32 MiB UTF-8; no partial routing was returned.");
  }
  const snapshotRevision = sha256(snapshot);
  if (input.data.snapshotRevision !== undefined && input.data.snapshotRevision !== snapshotRevision) {
    throw new CoreError("CONFLICT", "Skill routing snapshot changed; restart selection/projection/pagination.");
  }
  const common = { snapshotRevision, adapters };
  const resolve = (id: string, documentSha256?: string) => {
    const exact = entries.filter(entry => entry.address.documentId === id || entry.row.knowledgeId === id);
    const matches = exact.length ? exact : entries.filter(entry => entry.row.name === id || routingSkillId(entry.row) === id);
    if (!matches.length) throw new CoreError("NOT_FOUND", "Selected Skill is not in this isolated snapshot.");
    if (matches.length !== 1) throw new CoreError("CONFLICT", "Ambiguous Skill identity/name; select a stable documentId.");
    const entry = matches[0]!;
    if (documentSha256 !== undefined && documentSha256 !== entry.address.documentSha256) {
      throw new CoreError("CONFLICT", "Selected Skill documentSha256 changed.");
    }
    return entry;
  };
  const selectedEntries = (values: { id: string; documentSha256?: string }[]) => {
    const selected = values.map(value => resolve(value.id, value.documentSha256));
    if (new Set(selected.map(entry => entry.address.documentId)).size !== selected.length) {
      throw new CoreError("CONFLICT", "A selected Skill appeared more than once, including identity aliases.");
    }
    return selected;
  };
  let result: unknown;
  if (operation === skillRoutingDefinitions[0].id) {
    const args = skillRoutingDefinitions[0].input.parse(request.args);
    const available = availableSkillRouterSources([]);
    result = { sources: available, sourcePriority: normalizeSkillRouterSourcePriority(args.sourcePriority, available), ...common };
  } else if (operation === skillRoutingDefinitions[1].id) {
    const args = skillRoutingDefinitions[1].input.parse(request.args);
    const sourcePriority = normalizeSkillRouterSourcePriority(args.sourcePriority, availableSkillRouterSources([]));
    // Original generated MCP normalizes priority strings; legacy TS Chat projection does not.
    const contextRows = entries.map(entry => {
      const normalized = String(entry.source.fm.priority || "normal").trim().toLowerCase();
      return { ...entry.row, priority: normalized === "high" || normalized === "highest" ? normalized : "normal" } as typeof entry.row;
    });
    const selected = rankSkillContext(contextRows, args.task, args.workspace, args.files, args.diagnostics, sourcePriority).slice(0, args.limit);
    const fullItems = selected.map((candidate, index) => ({
      skill_id: routingSkillId(candidate.row), name: candidate.row.name, description: candidate.row.description,
      category: candidate.row.category, tags: JSON.parse(candidate.row.tags) as string[], source_project: candidate.row.source_project,
      source: "local", read_only: candidate.row.category.split("/")[0]?.toLowerCase() === "system",
      source_key: "pkm-personal", source_rank: candidate.sourceRank + 1, skill_priority: candidate.row.priority,
      content_hash: skillContextHash(candidate.row), score: candidate.score, task_coverage: Math.round(candidate.coverage * 1000) / 1000,
      priority: candidate.row.priority === "highest" || index === 0 && candidate.metadataCount >= 2 && candidate.coverage >= 0.5 ? "required" : "recommended",
      match_reason: candidate.reasons, linkage: skillLinkage(candidate.row),
      address: entries[contextRows.indexOf(candidate.row)]!.address,
    }));
    const items = args.detail === "full" ? fullItems : fullItems.map(item => {
      const { category: _category, tags: _tags, source_project: _sourceProject, score: _score, ...compact } = item;
      return compact;
    });
    const sourcePolicy = sourcePriority[0] === "agent-native"
      ? "Evaluate applicable Agent Native Skills before the returned PKM candidates. Agent Native is host-managed and has no synthetic PKM candidate or score."
      : "Respect source_priority when relevant Skills overlap. Agent Native is host-managed and has no synthetic PKM candidate or score.";
    result = { items, count: items.length, noMatch: !items.length, sourcePriority, sourcePolicy, ...common };
  } else if (operation === skillRoutingDefinitions[2].id) {
    const args = skillRoutingDefinitions[2].input.parse(request.args);
    const rows = entries.map(entry => entry.row);
    const list = () => createSkillQueries(rows).skillList(args.category, args.tag);
    const all = createAutomaticSkillSelection(rows, list)(args.query).map(candidate => ({
      ...candidate, address: resolve(candidate.id).address,
    }));
    const items = all.slice(args.offset, args.offset + args.limit), next = args.offset + items.length;
    result = { items, total: all.length, nextOffset: next < all.length ? next : null, ...common };
  } else if (operation === skillRoutingDefinitions[3].id) {
    const args = skillRoutingDefinitions[3].input.parse(request.args);
    const items = selectedEntries(args.selected).map(entry => ({ ...entry.row, address: entry.address, linkage: skillLinkage(entry.row) }));
    const router = args.routerId === undefined ? undefined : resolve(args.routerId);
    const projection = router ? { ...renderProjection(router.source.document.raw, { kind: args.target }, args.extensionVersion),
      address: router.address } : null;
    result = { items, projection, ...common };
  } else {
    const args = skillRoutingDefinitions[4].input.parse(request.args);
    const candidates = selectedEntries(args.selected).map(entry => ({
      id: entry.address.documentId, sourceId: `pkm://skills/${encodeURIComponent(entry.row.name)}`,
      level: "l1-source" as const, label: entry.row.name, content: entry.row.content, score: 1,
    }));
    if (new Set(candidates.map(candidate => candidate.sourceId)).size !== candidates.length) {
      throw new CoreError("CONFLICT", "Selected Skills have ambiguous original Chat source URIs; prompt projection cannot collapse duplicate names.");
    }
    const prompt = retrievalJudgmentInput(args.query, candidates);
    let selection = null;
    if (args.judgments !== undefined) {
      try { selection = parseRetrievalSelection(args.judgments, prompt.sourceIds); }
      catch (error) { throw new CoreError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid judgments."); }
    }
    result = { ...prompt, priorities: candidates.map(candidate => ({
      id: candidate.id, priority: knowledgeCandidatePriority(candidate, candidates, args.query),
    })), selection, ...common };
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > SKILL_ROUTING_MAX_RESULT_BYTES) {
    throw new CoreError("BUSY", "Skill routing result exceeds 256 KiB UTF-8; select fewer Skills or use Skill source reads. No body prefix or partial result was substituted.");
  }
  const output = definition.output.safeParse(result);
  if (!output.success) throw new CoreError("INVALID_DOCUMENT", "Skill routing projection violates its bounded result contract.");
  return output.data;
}
