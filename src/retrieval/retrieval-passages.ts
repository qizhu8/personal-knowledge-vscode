import { createHash } from "crypto";
import type { RetrievalCandidateV1 } from "./retrieval-contracts";
import { memoryTerms, memoryMatchScore } from "../chat/chat-memory";

type Span = { start: number; end: number };
type Section = Span & { headings: Span[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function sections(body: string): Section[] {
  const result: Section[] = [], headings: Array<Span & { depth: number }> = [];
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => line[0]);
  let start = 0, fence: { character: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], value = line[0].replace(/[\r\n]+$/, ""), offset = line.index!;
    const delimiter = value.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = { character:delimiter[1][0], length:delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length
        && value.slice(delimiter[0].length).trim() === "") fence = undefined;
      continue;
    }
    if (fence) continue;
    const atx = value.match(/^(?:\uFEFF)?(#{1,6})\s+\S/);
    const underline = index + 1 < lines.length && /^[ \t]*(?:={3,}|-{3,})[ \t]*\r?\n?$/.test(lines[index + 1][0]) && value.trim();
    if (!atx && !underline) continue;
    if (offset > start) result.push({ start, end:offset, headings:headings.map(({ start, end }) => ({ start, end })) });
    const depth = atx ? atx[1].length : lines[index + 1][0].trim()[0] === "=" ? 1 : 2;
    while (headings.length && headings[headings.length - 1].depth >= depth) headings.pop();
    const end = offset + line[0].length + (underline ? lines[index + 1][0].length : 0);
    headings.push({ start:offset, end, depth });
    start = offset;
    if (underline) index++;
  }
  if (start < body.length) result.push({ start, end:body.length, headings });
  return result;
}

function blocks(body: string, section: Section): Span[] {
  const result: Span[] = [];
  let start = section.start, fence: { character: string; length: number } | undefined;
  const text = body.slice(section.start, section.end);
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const value = line[0].replace(/[\r\n]+$/, ""), delimiter = value.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = { character:delimiter[1][0], length:delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length
        && value.slice(delimiter[0].length).trim() === "") fence = undefined;
    }
    if (!fence && !value.trim()) {
      const end = section.start + line.index! + line[0].length;
      if (body.slice(start, end).trim()) result.push({ start, end });
      start = end;
    }
  }
  if (start < section.end && body.slice(start, section.end).trim()) result.push({ start, end:section.end });
  return result;
}

function tableRows(body: string, span: Span): { header:Span; rows:Span[] } | undefined {
  const lines = [...body.slice(span.start, span.end).matchAll(/[^\n]+(?:\n|$)/g)];
  if (lines.length < 3 || !/^\s*\|/.test(lines[0][0])
    || !/^\s*\|(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*\r?\n?$/.test(lines[1][0])
    || lines.slice(2).some(line => !/^\s*\|/.test(line[0]))) return undefined;
  const start = span.start + lines[0].index!, end = span.start + lines[2].index!;
  return { header:{ start, end }, rows:lines.slice(2).map(line => ({
    start:span.start + line.index!, end:span.start + line.index! + line[0].length,
  })) };
}

function rstSections(body: string): Section[] {
  const result:Section[] = [], headings:Array<Span & { depth:number }> = [];
  const styles:string[] = [];
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => line[0]);
  const text = (index:number) => lines[index]?.[0].replace(/[\r\n]+$/, "").replace(/^\uFEFF/, "") || "";
  const adornment = (value:string) => /^([=\-~`^"'*+#:_.])\1{2,}$/.test(value);
  let start = 0;
  for (let index = 0; index < lines.length - 1; index++) {
    let titleIndex = index, endIndex = index + 1;
    const overline = adornment(text(index));
    if (overline) { titleIndex++; endIndex++; }
    const title = text(titleIndex), underline = text(endIndex);
    if (!title || /^\s/.test(title) || adornment(title) || !adornment(underline)
      || Array.from(underline).length < Array.from(title.trimEnd()).length
      || (overline && text(index) !== underline)
      || (index > 0 && text(index - 1).trim())) continue;
    const style = `${overline ? "overline" : "underline"}:${underline[0]}`;
    if (!styles.includes(style)) styles.push(style);
    const depth = styles.indexOf(style) + 1, offset = lines[index].index!;
    if (offset > start) result.push({ start, end:offset, headings:headings.map(({ start, end }) => ({ start, end })) });
    while (headings.length && headings[headings.length - 1].depth >= depth) headings.pop();
    headings.push({ start:offset, end:lines[endIndex].index! + lines[endIndex][0].length, depth });
    start = offset;
    index = endIndex;
  }
  if (start < body.length) result.push({ start, end:body.length, headings });
  return result;
}

function structuralSections(body: string, format: "markdown" | "rst"): Section[] {
  const source = format === "rst" ? rstSections(body) : sections(body);
  const preamble = format === "rst" && source[0]?.headings.length === 0 ? [source[0]] : [];
  return source.flatMap(section => {
    const ancestors = section.headings.slice(0, -1).flatMap(heading => {
      const introduction = source.find(item => item.start === heading.start);
      return introduction && body.slice(heading.end, introduction.end).trim()
        ? [{ start:heading.end, end:introduction.end }] : [];
    });
    const shared = source.filter(item => {
      const heading = item.headings[item.headings.length - 1];
      const title = heading && body.slice(heading.start, heading.end).trim().split(/\r?\n/)
        .find(line => !/^([=\-~`^"'*+#:_.])\1{2,}$/.test(line));
      return title && /^(?:#{1,6}\s+)?(?:shared\s+)?(?:test\s+)?(?:conditions|configuration|environment|units|setup)\b/i.test(title)
        && item.headings.length === section.headings.length
        && item.headings.slice(0, -1).every((parent, index) => parent.start === section.headings[index]?.start);
    }).map(({ start, end }) => ({ start, end }));
    const dependencies = [...section.headings, ...ancestors, ...shared, ...preamble];
    if (section.end - section.start <= 4000 || format === "rst") return [{ ...section, headings:dependencies }];
    const units = blocks(body, section);
    const conditions = units.filter(unit => /^(?:\*\*)?(?:shared\s+)?(?:test\s+)?(?:conditions|configuration|environment|units|setup)\s*[:*]/i.test(body.slice(unit.start, unit.end).trim()));
    return units.flatMap(unit => {
      const table = tableRows(body, unit);
      if (!table || unit.end - unit.start <= 4000) return [{ ...unit, headings:[...dependencies, ...conditions] }];
      const prose = units.filter(other => other !== unit && !tableRows(body, other));
      return table.rows.map(row => ({ ...row, headings:[...dependencies, ...conditions, ...prose, table.header] }));
    });
  });
}

function jsonValues(body: string, start: number, end: number): Span[] {
  const values:Span[] = [];
  let first = start + 1, depth = 0, quoted = false, escaped = false;
  const push = (last:number) => {
    while (first < last && /\s/.test(body[first])) first++;
    while (last > first && /\s/.test(body[last - 1])) last--;
    if (last > first) values.push({ start:first, end:last });
  };
  for (let offset = first; offset < end - 1; offset++) {
    const character = body[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") depth++;
    else if (character === "]" || character === "}") depth--;
    else if (character === "," && depth === 0) { push(offset); first = offset + 1; }
  }
  push(end - 1);
  return values;
}

function jsonSections(body: string): Section[] {
  const trimmed = body.trim();
  JSON.parse(trimmed);
  const start = body.indexOf(trimmed), end = start + trimmed.length;
  if (trimmed.startsWith("[")) return jsonValues(body, start, end).map(span => ({ ...span, headings:[] }));
  if (!trimmed.startsWith("{")) return [{ start, end, headings:[] }];
  const properties = jsonValues(body, start, end).map(span => {
    let quoted = false, escaped = false, colon = span.start;
    for (; colon < span.end; colon++) {
      const character = body[colon];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === ":") break;
    }
    let valueStart = colon + 1;
    while (valueStart < span.end && /\s/.test(body[valueStart])) valueStart++;
    return { ...span, valueStart };
  });
  const arrays = properties.filter(property => body[property.valueStart] === "[");
  if (arrays.length !== 1) return [{ start, end, headings:[] }];
  const records = arrays[0], shared = properties.filter(property => property !== records).map(({ start, end }) => ({ start, end }));
  const arrayKey = { start:records.start, end:records.valueStart + 1 };
  return jsonValues(body, records.valueStart, records.end).map(span => ({ ...span, headings:[...shared, arrayKey] }));
}

export function ruleSourcePassages(parent: RetrievalCandidateV1, body: string, query: string,
  format: "markdown" | "rst" | "json" | "atomic" = "markdown"): { candidates: RetrievalCandidateV1[]; warning?: string } {
  if (!parent.sourceId || !parent.sourceRevision || !parent.contentHash) throw new Error("Passage retrieval requires an immutable L1 parent.");
  if (format === "rst" && /(?:^|\n)[ \t]*\.\.\s+(?:(?:include|raw)::|\|[^|\r\n]+\|\s+[A-Za-z][\w-]*::)|:(?:ref|doc):`/.test(body)) {
    return { candidates:[], warning:"The RST deterministic path is unavailable: external includes, raw content, substitutions or document references require unresolved context. No directive was executed, no text was rewritten and no LLM fallback was used." };
  }
  const keywords = memoryTerms(query), score = (value: string) => memoryMatchScore(value, keywords);
  let spans:Section[];
  if (format === "json") {
    try { spans = jsonSections(body); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { candidates:[], warning:"The JSON deterministic path is unavailable: invalid JSON. No text was rewritten and no LLM fallback was used." };
    }
  } else spans = format === "atomic" ? [{ start:0, end:body.length, headings:[] }] : structuralSections(body, format);
  const bodyHash = hash(body);
  const candidate = (span: Span, reason: string): RetrievalCandidateV1 => {
    const content = body.slice(span.start, span.end);
    return {
      id:`passage:${hash(JSON.stringify([parent.sourceId, parent.sourceRevision, bodyHash, span.start, span.end]))}`,
      level:"l2-passage", kind:parent.kind, label:parent.label, sourceUri:parent.sourceUri,
      sourceId:parent.sourceId, sourceRevision:parent.sourceRevision, contentHash:hash(content),
      parentId:parent.id, parentRevision:parent.sourceRevision, parentContentHash:parent.contentHash,
      range:{ start:span.start, end:span.end, unit:"characters" }, offsetEncoding:"utf16",
      score:score(content), scoreSemantics:"engine-defined", method:"rule:structural-passage-v1",
      selected:false, reason, content, serving:{ providerId:"pkm-rule-passages", providerVersion:"1",
        route:"lexical", scoreSemantics:"engine-defined" },
    };
  };
  const ranked = spans.map(span => ({ ...span, score:score(body.slice(span.start, span.end)) }))
    .filter(span => span.score > 0).sort((a, b) => b.score - a.score || a.start - b.start);
  const candidates: RetrievalCandidateV1[] = [];
  let oversized = false;
  for (const span of ranked) {
    if (span.end - span.start > 4000) { oversized = true; continue; }
    const evidence = candidate(span, "Query-matched original source range; no rewriting or prefix substitution");
    const contexts = span.headings.filter((header, index, all) => (header.start < span.start || header.end > span.end)
      && all.findIndex(other => other.start === header.start && other.end === header.end) === index)
      .map(header => candidate(header, "Required original structural/shared-condition context for a selected passage"));
    if (contexts.length > 16 || contexts.some(context => context.content!.length > 4000)) { oversized = true; continue; }
    evidence.contextIds = contexts.map(context => context.id);
    for (const item of [evidence, ...contexts]) if (!candidates.some(existing => existing.id === item.id)) candidates.push(item);
    if (candidates.length >= 16) break;
  }
  return { candidates, ...(oversized ? { warning:"Some matching structural units exceed 4,000 characters and were not truncated; fetch the original source to inspect them." } : {}) };
}

export function refineRuleCandidates(parents: RetrievalCandidateV1[], query: string): { candidates: RetrievalCandidateV1[]; warnings: string[] } {
  const candidates: RetrievalCandidateV1[] = [], warnings: string[] = [];
  for (const parent of parents) {
    if (!parent.content || parent.content.length <= 4000 || parent.level === "l2-passage") {
      if (candidates.length < 100) candidates.push(parent);
      else warnings.push("The 100-candidate evidence boundary was reached; remaining sources were not injected.");
      continue;
    }
    const { content, ...source } = parent;
    if (!source.sourceId || !source.sourceRevision || !source.contentHash) {
      if (candidates.length < 100) candidates.push({ ...source, reason:"Long source requires L2 but lacks immutable provenance; not truncated or injected." });
      warnings.push("A long source cannot be refined without immutable provenance.");
      continue;
    }
    const structured = /^[\s\uFEFF]*[\[{]/.test(content);
    const rst = /\.rst(?:$|[?#])/i.test(parent.sourceUri) || /\.rst$/i.test(parent.label)
      || /(?:^|\n)([=~*+#^])\1{2,}\r?\n[^\s][^\n]*\r?\n\1{3,}(?:\r?\n|$)/.test(content);
    const result = ruleSourcePassages(parent, content, query, structured ? "json" :
      ["skill", "note", "research", "subscription"].includes(parent.kind) ? rst ? "rst" : "markdown" : "atomic");
    if (result.warning) warnings.push(result.warning);
    if (candidates.length + result.candidates.length + 1 > 100) {
      warnings.push("The 100-candidate evidence boundary was reached; this source's passages were not injected.");
      continue;
    }
    candidates.push({ ...source, reason:result.candidates.length ? "Authorized L1 parent; only recorded original L2 ranges may be injected." : "No bounded query-matching structural passage; original source was not truncated." },
      ...result.candidates);
  }
  return { candidates, warnings:[...new Set(warnings)] };
}

export function passageReferenceGroup(candidate: RetrievalCandidateV1, candidates: RetrievalCandidateV1[]): RetrievalCandidateV1[] {
  const contexts = (candidate.contextIds || []).map(id => {
    const context = candidates.find(item => item.id === id);
    if (!context || context.parentId !== candidate.parentId || context.parentRevision !== candidate.parentRevision
      || context.parentContentHash !== candidate.parentContentHash || !context.content) throw new Error("Required passage context is missing or belongs to a different source revision.");
    return context;
  });
  return [...contexts, candidate];
}
