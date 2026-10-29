import { createHash } from "crypto";
import type { RetrievalCandidateV1 } from "./retrieval-contracts";
import { memoryTerms, memoryMatchScore } from "../chat/chat-memory";

type Span = { start: number; end: number };
type Section = Span & { headings: Span[]; scope?: string };
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

// Keep prose clauses, their attached lists, and fenced examples indivisible. This
// deliberately does not sentence-slice: language/measurement boundaries are unsafe.
function blocks(body: string, section: Section): Span[] {
  const result:Span[] = [];
  let start = section.start, fence:{ character:string; length:number } | undefined;
  const push = (end:number) => {
    if (body.slice(start, end).trim()) result.push({ start, end });
    start = end;
  };
  for (const line of body.slice(section.start, section.end).matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const offset = section.start + line.index!, end = offset + line[0].length;
    const value = line[0].replace(/[\r\n]+$/, ""), delimiter = value.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) { push(offset); fence = { character:delimiter[1][0], length:delimiter[1].length }; }
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length
        && value.slice(delimiter[0].length).trim() === "") { fence = undefined; push(end); }
    } else if (!fence && !value.trim()) push(end);
  }
  push(section.end);
  const merged:Span[] = [];
  for (const unit of result) {
    const previous = merged[merged.length - 1];
    const text = body.slice(unit.start, unit.end).trimStart();
    const before = previous && body.slice(previous.start, previous.end).trimEnd();
    // Blank lines can occur between a lead-in and its list, or inside a wrapped
    // clause/measurement. Conservatively retain that dependency as one unit.
    if (previous && (/^(?:[-+*] |\d+[.)] )/.test(text)
      || /(?:\b(?:not|no|never)\b|不|没有|禁止)/i.test(before!) && !/[.!?。！？]["\'”’)]*$/.test(before!)
      || /[0-9]/.test(before!.slice(-1)) && /^(?:[%°µμ]|[\p{L}])/u.test(text))) previous.end = unit.end;
    else merged.push({ ...unit });
  }
  return merged;
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

// RST subset: adornment headings and intact sections (including indented ::
// literals/directives and grid tables), not a full parser or directive executor.
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
    const scope = section.headings.map(heading => body.slice(heading.start, heading.end).trim()).join(" > ");
    if (section.end - section.start <= 4000 || format === "rst") return [{ ...section, scope, headings:dependencies }];
    const units = blocks(body, section);
    const conditions = units.filter(unit => /^(?:\*\*)?(?:shared\s+)?(?:test\s+)?(?:conditions|configuration|environment|units|setup)\s*[:*]/i.test(body.slice(unit.start, unit.end).trim()));
    return units.flatMap(unit => {
      const table = tableRows(body, unit);
      if (!table || unit.end - unit.start <= 4000) return [{ ...unit, scope, headings:[...dependencies, ...conditions] }];
      const prose = units.filter(other => other !== unit && !tableRows(body, other));
      return table.rows.map(row => ({ ...row, scope, headings:[...dependencies, ...conditions, ...prose, table.header] }));
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
  const keys = new Set<string>();
  let duplicateKey = false;
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
    const key: string = JSON.parse(body.slice(span.start, colon));
    if (keys.has(key)) duplicateKey = true;
    keys.add(key);
    return { ...span, valueStart, scope:`$[${body.slice(span.start, colon).trim()}]` };
  });
  if (duplicateKey || properties.filter(property => body[property.valueStart] === "[").length > 1) {
    return [{ start, end, headings:[] }];
  }
  // Scalar siblings carry shared record conditions. Retaining them also refuses
  // an oversized scalar record rather than presenting an unqualified fragment.
  const shared = properties.filter(property => !/^[\[{]/.test(body[property.valueStart]));
  return properties.flatMap(property => {
    const dependencies = shared.filter(other => other !== property).map(({ start, end }) => ({ start, end }));
    if (body[property.valueStart] !== "[") return [{ ...property, headings:dependencies }];
    const arrayKey = { start:property.start, end:property.valueStart + 1 };
    // Objects alongside a record array can contain shared configuration too.
    const context = properties.filter(other => other !== property && body[other.valueStart] !== "[")
      .map(({ start, end }) => ({ start, end }));
    return jsonValues(body, property.valueStart, property.end).map((span, index) => ({
      ...span, scope:`${property.scope}[${index}]`, headings:[...context, arrayKey],
    }));
  });
}

function sourceExtension(parent: RetrievalCandidateV1): string | undefined {
  const extensions = /\.(md|markdown|rst|json|csv|tsv|py|pyi|ts|tsx|js|jsx|mjs|cjs|cs|go|java|cpp|cc|c|h|hpp|rs|rb|swift|kt|kts|scala|php)(?:$|[?#])/i;
  return (parent.sourceUri.match(extensions) || parent.label.match(extensions)
    || parent.kind.match(extensions))?.[1].toLowerCase();
}

function codeLanguage(parent: RetrievalCandidateV1): string | undefined {
  const extension = sourceExtension(parent);
  return extension && !["md", "markdown", "rst", "json", "csv", "tsv"].includes(extension) ? extension : undefined;
}

// A conservative lexical subset, not a compiler: mask strings/comments before
// finding unindented Python/Ruby or brace-depth-zero symbol declarations.
function codeSections(body: string, language: string): Section[] {
  const python = language === "py" || language === "pyi", ruby = language === "rb";
  let quote = "", blockComment = false, lineComment = false;
  const masked:string[] = [];
  for (let index = 0; index < body.length; index++) {
    const character = body[index], pair = body.slice(index, index + 2);
    const hide = (length:number) => {
      for (let offset = 0; offset < length; offset++) masked.push(body[index + offset] === "\n" ? "\n" : " ");
      index += length - 1;
    };
    if (lineComment) { if (character === "\n") lineComment = false; hide(1); }
    else if (blockComment) { if (pair === "*/") { blockComment = false; hide(2); } else hide(1); }
    else if (quote) {
      if (character === "\\") hide(Math.min(2, body.length - index));
      else if (body.startsWith(quote, index)) { const length = quote.length; quote = ""; hide(length); }
      else hide(1);
    } else if ((!python && !ruby && pair === "//") || ((python || ruby) && character === "#")) { lineComment = true; hide(1); }
    else if (!python && !ruby && pair === "/*") { blockComment = true; hide(2); }
    else if (character === '"' || character === "'" || character === "`") {
      quote = python && body.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
      hide(quote.length);
    } else masked.push(character);
  }
  const declarations:Array<Span & { scope:string }> = [];
  let depth = 0, decorator:number | undefined;
  for (const line of masked.join("").matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const value = line[0], start = line.index!;
    // Long declaration lines are left in their surrounding atomic range. Never
    // run the ambiguous modifier/type alternatives on unbounded input.
    const match = value.length > 512 ? null : python || ruby
      ? value.match(/^(?:(?:async\s+)?def|class|module)\s+([\w.]+)/)
      : depth === 0 && value.match(/^\s*(?:(?:export|default|declare|public|private|protected|internal|static|abstract|sealed|partial|final|async|pub|unsafe|open)\s+)*(?:(?:class|interface|enum|struct|record|trait|object|function\*?|fn|type)\s+([\w$]+)|func\s+(?:\([^)]*\)\s*)?([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=|(?:[\w<>[\],?*]+\s+)+([\w$]+)\s*\([^;]*\)\s*(?:\{|=>))/);
    if (match) {
      declarations.push({ start:decorator ?? start, end:start + line[0].length, scope:match.slice(1).find(Boolean)! });
      decorator = undefined;
    } else if (depth === 0 && /^@/.test(value)) decorator ??= start;
    else if (value.trim()) decorator = undefined;
    if (!python && !ruby) for (const character of value) {
      if (character === "{") depth++;
      else if (character === "}") depth = Math.max(0, depth - 1);
    }
  }
  if (!declarations.length) return [{ start:0, end:body.length, headings:[] }];
  const preamble = declarations[0].start > 0 && body.slice(0, declarations[0].start).trim()
    ? { start:0, end:declarations[0].start } : undefined;
  const result:Section[] = declarations.map((declaration, index) => ({
    start:declaration.start, end:declarations[index + 1]?.start ?? body.length,
    headings:preamble ? [preamble] : [], scope:declaration.scope,
  }));
  if (preamble) result.unshift({ ...preamble, headings:[] });
  return result;
}

function delimitedSections(body: string, delimiter: "," | "\t"): Section[] {
  const rows: Span[] = [];
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let start = 0, columns = 1, width: number | undefined;
  const finish = (end: number) => {
    if (width === undefined) {
      if (columns < 2) throw new SyntaxError("A table requires a header with at least two columns.");
      width = columns;
    } else if (columns !== width) throw new SyntaxError("Table row width differs from its header.");
    rows.push({ start, end });
    start = end; columns = 1; state = "start";
  };
  for (let index = body.startsWith("\uFEFF") ? 1 : 0; index < body.length; index++) {
    const character = body[index];
    if (state === "quoted") {
      if (character === '"') {
        if (body[index + 1] === '"') index++;
        else state = "closed";
      }
      continue;
    }
    if (character === delimiter) { columns++; state = "start"; }
    else if (character === "\r" || character === "\n") {
      if (character === "\r" && body[index + 1] === "\n") index++;
      finish(index + 1);
    } else if (character === '"' && state === "start") state = "quoted";
    else {
      if (character === '"' || state === "closed") throw new SyntaxError("Invalid table field quoting.");
      state = "plain";
    }
  }
  if (state === "quoted") throw new SyntaxError("Unclosed quoted table field.");
  if (start < body.length) finish(body.length);
  if (!rows.length) throw new SyntaxError("A table requires a header.");
  const header = rows[0];
  return rows.slice(1).map((row, index) => ({ ...row, headings:[header], scope:`row ${index + 2}` }));
}

export function ruleSourcePassages(parent: RetrievalCandidateV1, body: string, query: string,
  format: "markdown" | "rst" | "json" | "csv" | "tsv" | "atomic" = "markdown"): { candidates: RetrievalCandidateV1[]; warning?: string } {
  if (!parent.sourceId || !parent.sourceRevision || !parent.contentHash) throw new Error("Passage retrieval requires an immutable L1 parent.");
  if (format === "rst" && /(?:^|\n)[ \t]*\.\.\s+(?:(?:include|raw)::|\|[^|\r\n]+\|\s+[A-Za-z][\w-]*::)|:(?:ref|doc):`/.test(body)) {
    return { candidates:[], warning:"The RST deterministic path is unavailable: external includes, raw content, substitutions or document references require unresolved context. No directive was executed, no text was rewritten and no LLM fallback was used." };
  }
  const keywords = memoryTerms(query), score = (value: string) => memoryMatchScore(value, keywords);
  let spans:Section[];
  if (format === "csv" || format === "tsv") {
    try { spans = delimitedSections(body, format === "csv" ? "," : "\t"); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { candidates:[], warning:`The ${format.toUpperCase()} deterministic path is unavailable: ${error.message} No partial rows, rewritten text or LLM fallback were returned.` };
    }
  } else if (format === "json") {
    try { spans = jsonSections(body); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { candidates:[], warning:"The JSON deterministic path is unavailable: invalid JSON. No text was rewritten and no LLM fallback was used." };
    }
  } else {
    const language = codeLanguage(parent);
    spans = language ? codeSections(body, language) : format === "atomic"
      ? [{ start:0, end:body.length, headings:[] }] : structuralSections(body, format);
  }
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
      selected:false, reason:reason.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, ""), content, serving:{ providerId:"pkm-rule-passages", providerVersion:"1",
        route:"lexical", scoreSemantics:"engine-defined" },
    };
  };
  const ranked = spans.map(span => ({ ...span, score:score(body.slice(span.start, span.end)) }))
    .filter(span => span.score > 0).sort((a, b) => b.score - a.score || a.start - b.start);
  const candidates: RetrievalCandidateV1[] = [];
  let oversized = false;
  for (const span of ranked) {
    if (span.end - span.start > 4000) { oversized = true; continue; }
    const evidence = candidate(span, "Query-matched original source range; no rewriting or prefix substitution"
      + (span.scope ? `; scope: ${span.scope}` : ""));
    const contexts = span.headings.filter((header, index, all) => (header.start < span.start || header.end > span.end)
      && all.findIndex(other => other.start === header.start && other.end === header.end) === index)
      .map(header => candidate(header, "Required original structural/shared-condition context for a selected passage"));
    if (contexts.length > 16 || contexts.some(context => context.content!.length > 4000)) { oversized = true; continue; }
    evidence.contextIds = contexts.map(context => context.id);
    // A range may already have been added as another passage's shared context.
    // Promote it to evidence so its own scope/dependencies are not discarded.
    const existing = candidates.findIndex(item => item.id === evidence.id);
    if (existing < 0) candidates.push(evidence);
    else candidates[existing] = evidence;
    for (const context of contexts) if (!candidates.some(item => item.id === context.id)) candidates.push(context);
    if (candidates.length >= 16) break;
  }
  // Context promotion can make mutually dependent conditions into a cycle.
  // Collapse each strongly connected group to one selectable evidence root,
  // retaining all reachable original ranges as its direct required context.
  const reachable = new Map<string, Set<string>>();
  for (const item of candidates) {
    const seen = new Set<string>(), pending = [...(item.contextIds || [])];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(candidates.find(candidate => candidate.id === id)?.contextIds || []));
    }
    reachable.set(item.id, seen);
  }
  const grouped = new Set<string>();
  for (const item of candidates) {
    if (grouped.has(item.id) || !reachable.get(item.id)!.has(item.id)) continue;
    const members = candidates.filter(other => reachable.get(item.id)!.has(other.id)
      && reachable.get(other.id)!.has(item.id));
    const contexts = [...reachable.get(item.id)!].filter(id => id !== item.id);
    if (contexts.length > 16) return { candidates:[], warning:"Required passage context group exceeds the 16-context boundary; original ranges were not truncated." };
    item.contextIds = contexts;
    for (const member of members) {
      grouped.add(member.id);
      if (member !== item) member.contextIds = [];
    }
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
    const extension = sourceExtension(parent);
    const inferredJson = !extension && /^[\s\uFEFF]*[\[{]/.test(content);
    const rst = extension === "rst" || !extension
      && /(?:^|\n)([=~*+#^])\1{2,}\r?\n[^\s][^\n]*\r?\n\1{3,}(?:\r?\n|$)/.test(content);
    const format = extension === "csv" || extension === "tsv" ? extension
      : extension === "json" || inferredJson ? "json" : rst ? "rst"
      : extension === "md" || extension === "markdown" ? "markdown"
      : codeLanguage(parent) ? "atomic"
      : ["skill", "note", "research", "subscription"].includes(parent.kind) ? "markdown" : "atomic";
    let result = ruleSourcePassages(parent, content, query, format);
    if (result.warning) warnings.push(result.warning);
    if (inferredJson && result.warning?.includes("invalid JSON")) {
      // Explicit JSON callers retain fail-closed validation; the L1 refinement
      // route can fall back to exact original prose blocks, never JSON repair.
      result = ruleSourcePassages(parent, content, query, "markdown");
      warnings.push("Invalid JSON: falling back to original rule-based text ranges; no JSON key scope is claimed.");
      if (result.warning) warnings.push(result.warning);
    }
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
