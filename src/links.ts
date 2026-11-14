import { createHash } from "node:crypto";
import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "./domain/knowledge-contracts.js";
import {
  knowledgeLinksSnapshot,
  knowledgeLinksResolveInput,
  type KnowledgeLinksSnapshotSource,
  type KnowledgeLinksSnapshot,
  type KnowledgeLinksResolveInput,
} from "./domain/links.js";
import type { KnowledgeArea } from "./document-path.js";
import type { MarkdownRecord } from "./markdown.js";

export { linksDefinitions } from "./domain/links.js";
export {
  knowledgeLinkDiagnostic,
  knowledgeLinkEdge,
  knowledgeLinkNode,
  knowledgeLinksResolveInput,
  knowledgeLinksResolveOutput,
  knowledgeLinksSnapshot,
  linksSnapshotPins,
} from "./domain/links.js";
export type {
  KnowledgeLinksResolveInput,
  KnowledgeLinksResolveOutput,
  KnowledgeLinksSnapshot,
  KnowledgeLinksSnapshotSource,
} from "./domain/links.js";

const KNOWLEDGE_URI = /^pkm:\/\/knowledge\/knowledge_[a-f0-9]{24}$/;
const TARGET_PROBE = "pkm://knowledge/knowledge_000000000000000000000000";
const MAX_SNAPSHOT_LINKS = 20_000;
const MAX_DIAGNOSTICS = 100;

export type KnowledgeLinkSnapshotCollection = "notes" | "skills" | "research";
export interface KnowledgeSnapshotSource {
  document: MarkdownRecord;
  rel: string;
  mtime: number;
  fm: Record<string, unknown>;
  body: string;
}
export type KnowledgeLinkSnapshotInputs = Record<KnowledgeLinkSnapshotCollection, readonly KnowledgeSnapshotSource[]>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringRevision(value: unknown): string {
  return String(value ?? "").trim();
}

function stringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [String(value)];
}

function providerBody(collection: KnowledgeLinkSnapshotCollection, source: KnowledgeSnapshotSource): string {
  const { fm, body } = source;
  if (collection === "notes" && fm.documentKind === "todo-board") {
    const revision = stringRevision(fm.revision);
    if (!revision) {
      throw new LinksSnapshotError("INVALID_SNAPSHOT", "A Todo Board without metadata revision needs its checked Board digest before it can be pinned.");
    }
    return body;
  }
  if (collection !== "research") return body;
  return [
    body,
    ...stringArray(fm.conclusions),
    ...stringArray(fm.implementation),
    ...stringArray(fm.assumptions),
  ].join("\n");
}

function sourceRevision(collection: KnowledgeLinkSnapshotCollection, source: KnowledgeSnapshotSource): string {
  const metadataRevision = stringRevision(source.fm.revision);
  const revision = metadataRevision || sha256(providerBody(collection, source));
  if (revision.length > 256) {
    throw new LinksSnapshotError("INVALID_SNAPSHOT", "A source revision exceeds the bounded 256-character link contract.");
  }
  return revision;
}

function collectionPin(sources: readonly KnowledgeSnapshotSource[]): string {
  const rows = [...sources]
    .sort((left, right) => Buffer.compare(Buffer.from(left.rel), Buffer.from(right.rel)))
    .map(({ document, rel }) => [document.record.id, rel, document.record.sha256]);
  return sha256(JSON.stringify(rows));
}

function collectionName(area: KnowledgeArea): KnowledgeLinkSnapshotCollection {
  return area === "papers" ? "research" : area;
}

export function buildKnowledgeLinksSnapshot(inputs: KnowledgeLinkSnapshotInputs): KnowledgeLinksSnapshot {
  const collections: KnowledgeLinkSnapshotCollection[] = ["notes", "skills", "research"];
  const pins = {
    notes: collectionPin(inputs.notes),
    skills: collectionPin(inputs.skills),
    research: collectionPin(inputs.research),
  };
  const sourceByUri = new Map<string, KnowledgeLinksSnapshotSource>();
  const sources: KnowledgeLinksSnapshotSource[] = [];
  for (const collection of collections) {
    for (const source of inputs[collection]) {
      if (collectionName(source.document.record.area) !== collection) {
        throw new LinksSnapshotError("INVALID_SNAPSHOT", `Knowledge source belongs to a different area than ${collection}.`);
      }
      const knowledgeId = String(source.fm.knowledgeId || "");
      if (!/^knowledge_[a-f0-9]{24}$/.test(knowledgeId)) continue;
      const uri = `pkm://knowledge/${knowledgeId}`;
      if (sourceByUri.has(uri)) throw new LinksSnapshotError("INVALID_SNAPSHOT", `Duplicate canonical Knowledge URI in snapshot: ${uri}`);
      const item: KnowledgeLinksSnapshotSource = {
        uri,
        collection,
        sourceRevision: sourceRevision(collection, source),
        links: source.fm.links,
      };
      sourceByUri.set(uri, item);
      sources.push(item);
    }
  }
  sources.sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
  const snapshot = { pins, sources };
  const parsed = knowledgeLinksSnapshot.safeParse(snapshot);
  if (!parsed.success) throw new LinksSnapshotError("INVALID_SNAPSHOT", "Knowledge link snapshot exceeds its source/link contract.");
  return parsed.data;
}

export class LinksSnapshotError extends Error {
  constructor(readonly code: "INVALID_SNAPSHOT" | "SNAPSHOT_MISMATCH" | "BUSY", message: string) {
    super(message);
    this.name = "LinksSnapshotError";
  }
}

interface CandidateEdge {
  key: string;
  source: string;
  target: string;
  relation: string;
  mode: KnowledgeLinkV1["mode"];
  required: boolean;
  targetRevision?: string;
  targetKind: "knowledge" | "unsupported";
}

interface QueuedNode {
  uri: string;
  depth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeTarget(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2048) : "";
}

function candidateFrom(value: unknown, source: string, index: number): CandidateEdge | undefined {
  if (!isRecord(value)) return undefined;
  const target = safeTarget(value.target);
  if (KNOWLEDGE_URI.test(target)) {
    const compiled = compileKnowledgeLinksV1([value]);
    if (!compiled.ok) return undefined;
    const link = compiled.links[0]!;
    if (link.targetRevision && link.targetRevision.length > 256) return undefined;
    return {
      key: `${source}\u0000${index}`,
      source,
      target: link.target,
      relation: link.relation,
      mode: link.mode,
      required: link.required,
      ...(link.targetRevision ? { targetRevision: link.targetRevision } : {}),
      targetKind: "knowledge",
    };
  }

  if (!target) return undefined;
  const compiled = compileKnowledgeLinksV1([{ ...value, target: TARGET_PROBE }]);
  if (!compiled.ok) return undefined;
  const link = compiled.links[0]!;
  if (link.targetRevision && link.targetRevision.length > 256) return undefined;
  return {
    key: `${source}\u0000${index}`,
    source,
    target,
    relation: link.relation,
    mode: link.mode,
    required: link.required,
    ...(link.targetRevision ? { targetRevision: link.targetRevision } : {}),
    targetKind: "unsupported",
  };
}

function pinMismatch(snapshot: KnowledgeLinksSnapshot, request: KnowledgeLinksResolveInput): boolean {
  const expected = request.snapshotPins;
  return expected !== undefined && (["notes", "skills", "research"] as const).some(collection =>
    snapshot.pins[collection] !== expected[collection]);
}

export function resolveKnowledgeLinks(
  snapshotValue: KnowledgeLinksSnapshot,
  requestValue: KnowledgeLinksResolveInput,
) {
  const parsedSnapshot = knowledgeLinksSnapshot.safeParse(snapshotValue);
  const parsedRequest = knowledgeLinksResolveInput.safeParse(requestValue);
  if (!parsedSnapshot.success) {
    throw new LinksSnapshotError("INVALID_SNAPSHOT", "The link snapshot does not match the bounded source contract.");
  }
  if (!parsedRequest.success) throw new TypeError("Invalid Knowledge link resolution request.");

  const snapshot = parsedSnapshot.data;
  const request = parsedRequest.data;
  if (pinMismatch(snapshot, request)) {
    throw new LinksSnapshotError("SNAPSHOT_MISMATCH", "One or more Knowledge collections changed; restart resolution with fresh snapshot pins.");
  }

  const sources = new Map<string, typeof snapshot.sources[number]>();
  const orderedSources = [...snapshot.sources].sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
  let linkCount = 0;
  for (const source of orderedSources) {
    if (sources.has(source.uri)) {
      throw new LinksSnapshotError("INVALID_SNAPSHOT", `Duplicate canonical Knowledge URI in snapshot: ${source.uri}`);
    }
    sources.set(source.uri, source);
    if (Array.isArray(source.links)) linkCount += source.links.length;
    else if (source.links !== undefined) linkCount++;
    if (linkCount > MAX_SNAPSHOT_LINKS) {
      throw new LinksSnapshotError("BUSY", `Link snapshot exceeds ${MAX_SNAPSHOT_LINKS} source links.`);
    }
  }

  const edges: CandidateEdge[] = [];
  const outgoing = new Map<string, CandidateEdge[]>();
  const incoming = new Map<string, CandidateEdge[]>();
  const diagnostics: Array<{
    code: string;
    message: string;
    source?: string;
    target?: string;
    relation?: string;
    pointer?: string;
  }> = [];
  const sourceDiagnostics = new Map<string, typeof diagnostics>();
  const addDiagnostic = (diagnostic: (typeof diagnostics)[number]) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
  };
  const addSourceDiagnostic = (source: string, diagnostic: (typeof diagnostics)[number]) => {
    const items = sourceDiagnostics.get(source) || [];
    items.push(diagnostic);
    sourceDiagnostics.set(source, items);
  };

  const addEdge = (edge: CandidateEdge) => {
    edges.push(edge);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
    if (edge.targetKind === "knowledge") incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
  };

  for (const source of orderedSources) {
    if (!Array.isArray(source.links)) {
      if (source.links !== undefined) addSourceDiagnostic(source.uri, {
        code: "invalid-link",
        message: "Expected the source links metadata to be an array.",
        source: source.uri,
        pointer: "/links",
      });
      continue;
    }
    source.links.forEach((value, index) => {
      const candidate = candidateFrom(value, source.uri, index);
      if (candidate) {
        addEdge(candidate);
        return;
      }
      const target = isRecord(value) ? safeTarget(value.target) : "";
      const compiled = compileKnowledgeLinksV1([value]);
      addSourceDiagnostic(source.uri, {
        code: target && !KNOWLEDGE_URI.test(target) && isRecord(value) && candidateFrom({ ...value, target: TARGET_PROBE }, source.uri, index)
          ? "unsupported-target"
          : "invalid-link",
        message: target && !KNOWLEDGE_URI.test(target)
          ? "Only canonical Knowledge targets are resolved; external, Script, Project, and other targets are unsupported."
          : compiled.ok ? "The link is invalid." : compiled.diagnostics.map(item => item.message).join("; "),
        source: source.uri,
        ...(target ? { target } : {}),
        ...(isRecord(value) && typeof value.relation === "string" ? { relation: value.relation } : {}),
        pointer: `/links/${index}`,
      });
    });
  }

  const selectedRelations = request.relations?.length ? new Set(request.relations) : undefined;
  const nodes: Array<{ uri: string; collection: "notes" | "skills" | "research"; sourceRevision: string }> = [];
  const resultEdges: Array<{
    source: string;
    target: string;
    relation: string;
    mode: "floating" | "pinned";
    required: boolean;
    targetRevision?: string;
    resolved: boolean;
  }> = [];
  const queue: QueuedNode[] = [];
  const queued = new Set<string>();
  const visited = new Set<string>();
  const emittedEdges = new Set<string>();
  const diagnosticKeys = new Set<string>();
  let truncated = false;

  const queueStart = (uri: string) => {
    if (!KNOWLEDGE_URI.test(uri)) {
      addDiagnostic({
        code: "unsupported-start",
        message: "Only canonical Knowledge URIs backed by Notes, Skills, or Papers can be graph starts.",
        target: uri,
      });
      return;
    }
    if (!sources.has(uri)) {
      addDiagnostic({ code: "missing-start", message: "The canonical Knowledge start is not present in the pinned snapshot.", target: uri });
      return;
    }
    if (!queued.has(uri)) {
      queue.push({ uri, depth: 0 });
      queued.add(uri);
    }
  };
  request.starts.forEach(queueStart);

  const edgeResult = (edge: CandidateEdge) => {
    if (edge.targetKind === "unsupported") {
      return { result: false, code: "unsupported-target" as const,
        message: "Only canonical Knowledge targets are resolved; external, Script, Project, and other targets are unsupported." };
    }
    const target = sources.get(edge.target);
    if (!target) {
      return { result: false, code: "missing-target" as const,
        message: "The canonical Knowledge target is not present in the pinned Notes, Skills, or Papers snapshot." };
    }
    if (edge.mode === "pinned" && edge.targetRevision !== target.sourceRevision) {
      return { result: false, code: "pinned-revision-mismatch" as const,
        message: "Pinned target revision does not exactly match the target's current source revision." };
    }
    return { result: true, code: undefined, message: "" };
  };

  while (queue.length) {
    if (nodes.length >= request.maxNodes) {
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    if (visited.has(current.uri)) continue;
    visited.add(current.uri);
    const source = sources.get(current.uri)!;
    nodes.push({ uri: source.uri, collection: source.collection, sourceRevision: source.sourceRevision });
    for (const diagnostic of sourceDiagnostics.get(source.uri) || []) addDiagnostic(diagnostic);
    if (current.depth >= request.maxDepth) continue;

    const candidates = [
      ...(request.direction === "backlink" ? [] : outgoing.get(current.uri) || []),
      ...(request.direction === "forward" ? [] : incoming.get(current.uri) || []),
    ];
    for (const edge of candidates) {
      if (selectedRelations && !selectedRelations.has(edge.relation)) continue;
      if (emittedEdges.has(edge.key)) continue;
      if (resultEdges.length >= request.maxEdges) {
        truncated = true;
        break;
      }
      emittedEdges.add(edge.key);
      const resolution = edgeResult(edge);
      resultEdges.push({
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        mode: edge.mode,
        required: edge.required,
        ...(edge.targetRevision ? { targetRevision: edge.targetRevision } : {}),
        resolved: resolution.result,
      });
      if (!resolution.result) {
        const key = `${resolution.code}\u0000${edge.key}`;
        if (!diagnosticKeys.has(key)) {
          diagnosticKeys.add(key);
          addDiagnostic({
            code: resolution.code!,
            message: resolution.message,
            source: edge.source,
            target: edge.target,
            relation: edge.relation,
          });
        }
        continue;
      }

      const nextUri = edge.source === current.uri ? edge.target : edge.source;
      if (visited.has(nextUri)) {
        const key = `cycle\u0000${edge.key}`;
        if (!diagnosticKeys.has(key)) {
          diagnosticKeys.add(key);
          addDiagnostic({ code: "cycle", message: "Graph cycle was bounded by the visited set.", source: nextUri, relation: edge.relation });
        }
      } else if (!queued.has(nextUri)) {
        queue.push({ uri: nextUri, depth: current.depth + 1 });
        queued.add(nextUri);
      }
    }
    if (truncated) break;
  }

  if (truncated) addDiagnostic({ code: "truncated", message: "Graph traversal stopped at the configured node or edge budget." });
  const nodePage = nodes.slice(request.nodeOffset, request.nodeOffset + request.pageSize);
  const edgePage = resultEdges.slice(request.edgeOffset, request.edgeOffset + request.pageSize);
  const nextNodeOffset = request.nodeOffset + nodePage.length < nodes.length
    ? request.nodeOffset + nodePage.length : null;
  const nextEdgeOffset = request.edgeOffset + edgePage.length < resultEdges.length
    ? request.edgeOffset + edgePage.length : null;
  return {
    snapshotPins: snapshot.pins,
    nodes: nodePage,
    edges: edgePage,
    diagnostics,
    totalNodes: nodes.length,
    totalEdges: resultEdges.length,
    nextNodeOffset,
    nextEdgeOffset,
    truncated,
  };
}
