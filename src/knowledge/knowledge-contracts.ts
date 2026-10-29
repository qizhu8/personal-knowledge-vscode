import { randomBytes } from "crypto";

export const KNOWLEDGE_SCHEMA_V1 = "pkm.knowledge/v1" as const;
export type KnowledgeKind = "note" | "skill" | "research" | "recipe";

export interface KnowledgeIdentityMetadata {
  schema: typeof KNOWLEDGE_SCHEMA_V1;
  knowledgeId: string;
  revision: number;
  aliases: string[];
}

export interface KnowledgeDiagnostic {
  code: string;
  pointer: string;
  message: string;
}

export interface KnowledgeLinkV1 {
  relation: string;
  target: string;
  mode: "floating" | "pinned";
  required: boolean;
  targetRevision?: string;
}

export type KnowledgeIdentityCompileResult =
  | { ok: true; model: KnowledgeIdentityMetadata; diagnostics: [] }
  | { ok: false; diagnostics: KnowledgeDiagnostic[] };

const KNOWLEDGE_ID = /^knowledge_[a-f0-9]{24}$/;
const ALIAS_SCHEME = /^(note|skill|research|recipe):[^\u0000-\u001f]+$/;

export function createKnowledgeId(bytes: () => Buffer = () => randomBytes(12)): string {
  const value = bytes();
  if (!Buffer.isBuffer(value) || value.length !== 12) throw new Error("Knowledge ID generator must return exactly 12 bytes.");
  return `knowledge_${value.toString("hex")}`;
}

export function legacyKnowledgeAlias(kind: KnowledgeKind, key: string): string {
  const normalized = String(key || "").replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "").normalize("NFC");
  if (!normalized || /[\u0000-\u001f]/.test(normalized)) throw new Error("Legacy Knowledge alias must be non-empty and contain no control characters.");
  return `${kind}:${normalized}`;
}

function normalizedAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim().normalize("NFC")).filter(alias => ALIAS_SCHEME.test(alias)))].sort();
}

export function readKnowledgeIdentity(
  frontmatter: Record<string, unknown>,
  kind: KnowledgeKind,
  currentKey: string,
): Partial<KnowledgeIdentityMetadata> & { aliases: string[] } {
  const knowledgeId = String(frontmatter.knowledgeId || "");
  const revision = Number(frontmatter.revision || 0);
  return {
    ...(KNOWLEDGE_ID.test(knowledgeId) ? { schema: KNOWLEDGE_SCHEMA_V1, knowledgeId } : {}),
    ...(Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}),
    aliases: [...new Set([...normalizedAliases(frontmatter.aliases), legacyKnowledgeAlias(kind, currentKey)])].sort(),
  };
}

export function nextKnowledgeIdentity(
  existing: Partial<KnowledgeIdentityMetadata> | undefined,
  kind: KnowledgeKind,
  previousKey: string,
  nextKey: string,
  idFactory: () => string = createKnowledgeId,
): KnowledgeIdentityMetadata {
  const knowledgeId = String(existing?.knowledgeId || "");
  const nextId = KNOWLEDGE_ID.test(knowledgeId) ? knowledgeId : idFactory();
  if (!KNOWLEDGE_ID.test(nextId)) throw new Error("Knowledge ID factory returned an invalid identity.");
  const revision = Number(existing?.revision || 0);
  const aliases = [
    ...normalizedAliases(existing?.aliases),
    legacyKnowledgeAlias(kind, previousKey || nextKey),
    legacyKnowledgeAlias(kind, nextKey),
  ];
  return {
    schema: KNOWLEDGE_SCHEMA_V1,
    knowledgeId: nextId,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision + 1 : 1,
    aliases: [...new Set(aliases)].sort(),
  };
}

export function compileKnowledgeIdentityV1(value: unknown): KnowledgeIdentityCompileResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a Knowledge identity object." }] };
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).filter(key => !["schema", "knowledgeId", "revision", "aliases"].includes(key)).sort()) {
    diagnostics.push({ code: "unknown-field", pointer: `/${key}`, message: `Unknown field ${key}.` });
  }
  if (record.schema !== KNOWLEDGE_SCHEMA_V1) diagnostics.push({ code: "schema", pointer: "/schema", message: `Expected ${KNOWLEDGE_SCHEMA_V1}.` });
  if (!KNOWLEDGE_ID.test(String(record.knowledgeId || ""))) diagnostics.push({ code: "knowledge-id", pointer: "/knowledgeId", message: "Expected knowledge_<24 lowercase hex>." });
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) diagnostics.push({ code: "revision", pointer: "/revision", message: "Expected a positive safe integer." });
  if (!Array.isArray(record.aliases) || record.aliases.some(alias => typeof alias !== "string" || !ALIAS_SCHEME.test(alias))) {
    diagnostics.push({ code: "aliases", pointer: "/aliases", message: "Expected portable typed legacy aliases." });
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return {
    ok: true,
    model: {
      schema: KNOWLEDGE_SCHEMA_V1,
      knowledgeId: String(record.knowledgeId),
      revision: Number(record.revision),
      aliases: [...new Set((record.aliases as string[]).map(alias => alias.normalize("NFC")))].sort(),
    },
    diagnostics: [],
  };
}

export function compileKnowledgeLinksV1(value: unknown): { ok: true; links: KnowledgeLinkV1[]; diagnostics: [] } | { ok: false; diagnostics: KnowledgeDiagnostic[] } {
  const diagnostics: KnowledgeDiagnostic[] = [];
  if (!Array.isArray(value)) return { ok: false, diagnostics: [{ code: "links", pointer: "", message: "Expected a link array." }] };
  const links: KnowledgeLinkV1[] = [];
  value.forEach((item, index) => {
    const pointer = `/${index}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      diagnostics.push({ code: "link", pointer, message: "Expected a link object." });
      return;
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record).filter(key => !["relation", "target", "mode", "required", "targetRevision"].includes(key)).sort()) {
      diagnostics.push({ code: "unknown-field", pointer: `${pointer}/${key}`, message: `Unknown field ${key}.` });
    }
    const relation = String(record.relation || "").trim().normalize("NFC");
    const target = String(record.target || "").trim();
    const mode = record.mode;
    const required = record.required;
    const targetRevision = String(record.targetRevision || "").trim();
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(relation)) diagnostics.push({ code: "relation", pointer: `${pointer}/relation`, message: "Expected a portable relation identifier." });
    if (!/^pkm:\/\/(knowledge\/knowledge_[a-f0-9]{24}|script\/script_[A-Za-z0-9._-]+|project\/project_[A-Za-z0-9._-]+)$/.test(target)) {
      diagnostics.push({ code: "target", pointer: `${pointer}/target`, message: "Expected a canonical PKM Knowledge, Script, or Project URI." });
    }
    if (mode !== "floating" && mode !== "pinned") diagnostics.push({ code: "mode", pointer: `${pointer}/mode`, message: "Expected floating or pinned." });
    if (typeof required !== "boolean") diagnostics.push({ code: "required", pointer: `${pointer}/required`, message: "Expected a boolean." });
    if (mode === "pinned" && !targetRevision) diagnostics.push({ code: "target-revision", pointer: `${pointer}/targetRevision`, message: "Pinned links require a target revision." });
    if (mode === "floating" && targetRevision) diagnostics.push({ code: "target-revision", pointer: `${pointer}/targetRevision`, message: "Floating links cannot persist a target revision." });
    if (relation && target && (mode === "floating" || mode === "pinned") && typeof required === "boolean"
      && ((mode === "pinned" && targetRevision) || (mode === "floating" && !targetRevision))) {
      links.push({ relation, target, mode, required, ...(targetRevision ? { targetRevision } : {}) });
    }
  });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, links, diagnostics: [] };
}

export function validateKnowledgeIdentitySet(
  values: readonly Pick<KnowledgeIdentityMetadata, "knowledgeId" | "aliases">[],
): KnowledgeDiagnostic[] {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const ids = new Map<string, number>();
  const aliases = new Map<string, number>();
  values.forEach((value, index) => {
    const previousId = ids.get(value.knowledgeId);
    if (previousId !== undefined) {
      diagnostics.push({ code: "duplicate-knowledge-id", pointer: `/${index}/knowledgeId`, message: `Knowledge ID duplicates item ${previousId}.` });
    } else ids.set(value.knowledgeId, index);
    for (const alias of value.aliases) {
      const previousAlias = aliases.get(alias);
      if (previousAlias !== undefined && previousAlias !== index) {
        diagnostics.push({ code: "alias-collision", pointer: `/${index}/aliases`, message: `Alias ${alias} is already owned by item ${previousAlias}.` });
      } else aliases.set(alias, index);
    }
  });
  return diagnostics;
}
