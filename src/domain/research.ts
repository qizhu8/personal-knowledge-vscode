import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { PaperRecord } from "../research-contracts.js";

export interface PaperSource { rel: string; mtime: number; fm: Record<string, unknown>; body: string }

function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [String(v)] : [];
}

function relNoExt(rel: string): string { return rel.replace(/\.md$/i, ""); }

function catOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(0, keyPath.lastIndexOf("/")) : "";
}

function nameOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(keyPath.lastIndexOf("/") + 1) : keyPath;
}

export interface Cite { paper: string; note: string; }

function normalizeCites(v: any): Cite[] {
  if (!Array.isArray(v)) return [];
  const out: Cite[] = [];
  for (const e of v) {
    if (typeof e === "string") { if (e.trim()) out.push({ paper: e.trim(), note: "" }); }
    else if (e && typeof e === "object") {
      const paper = String(e.paper ?? e.key ?? e.target ?? "").trim();
      if (paper) out.push({ paper, note: String(e.note ?? e.comment ?? "") });
    }
  }
  return out;
}

function toYear(v: any): number | null {
  if (typeof v === "number") return v;
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export function projectPaper(f: PaperSource): unknown {
  const { fm, body } = f;
  const key = relNoExt(f.rel);
  return {
    slug: key,
    ...readKnowledgeIdentity(fm, "research", key),
    title: fm.title || nameOf(key),
    description: fm.description || "",
    kind: fm.kind === "idea" ? "idea" : "paper",
    group: (fm.group && String(fm.group).trim()) || "Papers",
    pinned: fm.pinned === true,
    authors: asArray(fm.authors),
    year: toYear(fm.year),
    topic: fm.topic || "",
    publisher: fm.publisher || "",
    tags: asArray(fm.tags),
    url: fm.url || "",
    file: fm.file || "",
    conclusions: asArray(fm.conclusions),
    implementation: asArray(fm.implementation),
    assumptions: asArray(fm.assumptions),
    links: Array.isArray(fm.links) ? fm.links : [],
    cites: normalizeCites(fm.cites),
    category: catOf(key),
    content: body,
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(f.mtime).toISOString(),
  };
}

export function createPaperQueries(papers: PaperRecord[]) {
  function allPaperFiles() { return papers; }
  function paperFromFile(paper: PaperRecord) { return paper; }

function buildPaperResolver(all: any[]): (ref: string) => string | null {
  const byKey = new Map<string, string>(), byTitle = new Map<string, string>();
  for (const p of all) { byKey.set(p.slug.toLowerCase(), p.slug); byTitle.set(String(p.title).toLowerCase(), p.slug); }
  return (ref: string) => {
    const r = String(ref || "").toLowerCase().replace(/\.md$/i, "");
    return byKey.get(r) || byTitle.get(r) || null;
  };
}

function citationCounts(all: any[]): Map<string, number> {
  const resolve = buildPaperResolver(all);
  const counts = new Map<string, number>();
  for (const p of all) for (const c of p.cites) {
    const t = resolve(c.paper);
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

function paperList(): any[] {
  const all = allPaperFiles().map(paperFromFile);
  const counts = citationCounts(all);
  return all
    .map(({ content, ...meta }) => ({ ...meta, citationCount: counts.get(meta.slug) || 0 }))
    .sort((a, b) => (b.citationCount - a.citationCount) || ((b.year || 0) - (a.year || 0)) || a.title.localeCompare(b.title));
}

function paperFacets(): { topics: { name: string; count: number }[]; tags: { name: string; count: number }[]; years: number[] } {
  const all = allPaperFiles().map(paperFromFile);
  const topics = new Map<string, number>(), tags = new Map<string, number>(), years = new Set<number>();
  for (const p of all) {
    if (p.topic) topics.set(p.topic, (topics.get(p.topic) || 0) + 1);
    for (const t of p.tags) tags.set(t, (tags.get(t) || 0) + 1);
    if (p.year) years.add(p.year);
  }
  const sortByCount = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { topics: sortByCount(topics), tags: sortByCount(tags), years: [...years].sort((a, b) => b - a) };
}

function paperGraph(opts: {
  topic?: string; tag?: string; minYear?: number; maxYear?: number; limit?: number; neighbors?: boolean; q?: string;
} = {}): any {
  const all = allPaperFiles().map(paperFromFile);
  const resolve = buildPaperResolver(all);
  const counts = citationCounts(all);
  const bySlug = new Map<string, any>(all.map(p => [p.slug, p]));

  const nlc = (opts.q || "").toLowerCase();
  const filtered = all.filter(p => {
    if (opts.topic && p.topic !== opts.topic) return false;
    if (opts.tag && !p.tags.includes(opts.tag)) return false;
    if (opts.minYear && (p.year || 0) < opts.minYear) return false;
    if (opts.maxYear && (p.year || 9999) > opts.maxYear) return false;
    if (nlc && !(p.title.toLowerCase().includes(nlc) || p.topic.toLowerCase().includes(nlc) ||
                 (p.authors as string[]).join(" ").toLowerCase().includes(nlc))) return false;
    return true;
  });
  filtered.sort((a, b) => (counts.get(b.slug)! || 0) - (counts.get(a.slug)! || 0) || ((b.year || 0) - (a.year || 0)));

  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const nodeSet = new Set<string>(filtered.slice(0, limit).map(p => p.slug));

  if (opts.neighbors) {
    for (const s of [...nodeSet]) {
      const p = bySlug.get(s);
      if (!p) continue;
      for (const c of p.cites) { const t = resolve(c.paper); if (t) nodeSet.add(t); }      // parents (cited)
      for (const q of all) for (const c of q.cites) { if (resolve(c.paper) === s) nodeSet.add(q.slug); } // children (citing)
    }
  }

  const nodes = [...nodeSet].map(s => bySlug.get(s)).filter(Boolean).map(p => ({
    key: p.slug, title: p.title, year: p.year, topic: p.topic, authors: p.authors, tags: p.tags,
    kind: p.kind, group: p.group, pinned: p.pinned, citationCount: counts.get(p.slug) || 0,
    conclusions: p.conclusions, implementation: p.implementation, assumptions: p.assumptions,
    cites: p.cites, url: p.url, file: p.file, category: p.category,
  }));
  const edges: any[] = [];
  for (const p of all) {
    if (!nodeSet.has(p.slug)) continue;
    for (const c of p.cites) {
      const t = resolve(c.paper);
      if (t && nodeSet.has(t)) edges.push({ from: t, to: p.slug, note: c.note });
    }
  }
  return { nodes, edges, total: filtered.length, shown: nodes.length };
}

function paperGroups(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of allPaperFiles().map(paperFromFile)) {
    const g = p.group || "Papers";
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  counts.set("Papers", counts.get("Papers") || 0); // always present
  const custom = [...counts.entries()].filter(([n]) => n !== "Papers")
    .sort((a, b) => a[0].localeCompare(b[0]));
  return [...custom, ["Papers", counts.get("Papers")!] as [string, number]]
    .map(([name, count]) => ({ name, count }));
}

  return { paperList, paperFacets, paperGraph, paperGroups };
}
