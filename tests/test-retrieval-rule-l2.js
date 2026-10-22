const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { ruleSourcePassages, refineRuleCandidates, passageReferenceGroup } = require("../dist/retrieval/retrieval-passages");
const { sanitizeRetrievalCandidatesV1 } = require("../dist/retrieval/retrieval-contracts");
const parent = {
  id:"rule-l2", sourceId:"pkm://notes/rule-l2", sourceRevision:"r1", contentHash:"a".repeat(64),
  kind:"note", label:"Rules", sourceUri:"pkm://notes/rule-l2", method:"lexical:l1",
  score:1, selected:false, reason:"L1", level:"l1-source",
};
const padding = "Unrelated background paragraph.\n\n".repeat(160);
const sha = text => createHash("sha256").update(text).digest("hex");
const evidence = (result, needle) => {
  const item = result.candidates.find(candidate => candidate.content?.includes(needle));
  assert(item, `Missing evidence: ${needle}; ${result.warning || result.warnings || ""}`);
  return item;
};
function originalRanges(result, body) {
  for (const item of result.candidates.filter(candidate => candidate.content)) {
    assert.equal(item.content, body.slice(item.range.start, item.range.end));
    assert.equal(item.contentHash, sha(item.content));
    assert.equal(item.parentId, parent.id);
    assert.equal(item.parentRevision, parent.sourceRevision);
    assert.equal(item.parentContentHash, parent.contentHash);
    assert.equal(item.offsetEncoding, "utf16");
  }
  assert.equal(sanitizeRetrievalCandidatesV1(result.candidates).incomplete, false);
}

test("RET-04 Markdown nested headings carry exact heading-path context and stable identities", () => {
  const body = "\uFEFF# Manual 🐦\r\n\r\n## Runtime\r\n\r\n### Background\r\n\r\n" + padding + "### Limit\r\n\r\nlatency must not exceed 125 ms.\r\n";
  const result = ruleSourcePassages(parent, body, "latency");
  const item = evidence(result, "125 ms");
  const group = passageReferenceGroup(item, result.candidates);
  for (const heading of ["# Manual", "## Runtime", "### Limit"]) assert(group.some(context => context.content.includes(heading)));
  assert.match(item.reason, /scope:.*Manual.*Runtime.*Limit/s);
  originalRanges(result, body);
  assert.deepEqual(result, ruleSourcePassages(parent, body, "latency"));
});

test("RET-04 fences remain atomic even without surrounding blank lines and with fake headings", () => {
  const block = "````ts\n# Fake heading\n\nconst latency = 125;\n```\n````\n";
  const body = "# Example\n\n" + padding + "Lead-in.\n" + block + "Trailing explanation.\n";
  const result = ruleSourcePassages(parent, body, "latency");
  assert.equal(evidence(result, "const latency").content, block);
  originalRanges(result, body);
});

test("RET-04 every emitted Markdown table row carries header and separator context", () => {
  const header = "| Entity | Limit (ms) |\r\n| :--- | ---: |\r\n";
  const body = "# Results\r\n\r\n" + header + Array.from({ length:220 }, (_, index) => `| latency-${index} | 125 |\r\n`).join("");
  const result = ruleSourcePassages(parent, body, "latency");
  const rows = result.candidates.filter(item => item.content.includes("| latency-"));
  assert(rows.length > 1);
  for (const row of rows) assert(passageReferenceGroup(row, result.candidates).some(item => item.content === header));
  originalRanges(result, body);
});

test("RET-04 CSV and TSV rows retain original headers, quoted newlines and escaped quotes", () => {
  for (const delimiter of [",", "\t"]) {
    const header = `\uFEFFentity${delimiter}limit (ms)${delimiter}conditions\r\n`;
    const row = `"latency${delimiter}""critical""\r\nprofile"${delimiter}125${delimiter}"never deploy"\r\n`;
    const body = header + `other${delimiter}1${delimiter}ignored\r\n` + row;
    const result = ruleSourcePassages(parent, body, "latency", delimiter === "," ? "csv" : "tsv");
    const item = evidence(result, "125");
    assert.equal(item.content, row);
    assert.match(item.reason, /scope: row 3/);
    assert(passageReferenceGroup(item, result.candidates).some(context => context.content === header));
    originalRanges(result, body);
    assert.deepEqual(result, ruleSourcePassages(parent, body, "latency", delimiter === "," ? "csv" : "tsv"));
  }
});

test("RET-04 automatic CSV/TSV routing is explicit and never guesses table structure from prose", () => {
  for (const [extension, delimiter] of [["csv", ","], ["tsv", "\t"]]) {
    const header = `entity${delimiter}limit\r\n`;
    const row = `latency${delimiter}125\r\n`;
    const body = header + `other${delimiter}unrelated\r\n`.repeat(600) + row;
    for (const source of [{ sourceUri:`file:///data.${extension}?revision=1` }, { label:`data.${extension}` }]) {
      const result = refineRuleCandidates([{ ...parent, ...source, content:body }], "latency");
      assert.equal(evidence(result, "125").content, row);
      assert(passageReferenceGroup(evidence(result, "125"), result.candidates).some(item => item.content === header));
      originalRanges(result, body);
    }
  }
  assert.deepEqual(ruleSourcePassages(parent, "entity,limit\nlatency,125\n", "latency", "atomic").candidates[0].contextIds, []);
});

test("RET-04 malformed tables fail closed without returning an earlier apparently valid row", () => {
  for (const body of [
    'entity,limit\nlatency,125\n"unclosed,1',
    'entity,limit\nlatency,125\nbad"quote,1\n',
    'entity,limit\nlatency,125\n"closed"extra,1\n',
    'entity,limit\nlatency,125\nextra,columns,1\n',
    'entity,limit\nlatency,125\nmissing\n',
    'latency\n125\n',
    '',
  ]) {
    const result = ruleSourcePassages(parent, body, "latency", "csv");
    assert.deepEqual(result.candidates, [], body);
    assert.match(result.warning, /CSV deterministic path is unavailable/);
  }
});

test("RET-04 oversized table rows or required headers are not truncated and other bounded rows survive", () => {
  const header = "entity,limit\n";
  const body = header + 'latency,"' + "x".repeat(4100) + '"\nlatency,125\n';
  const result = ruleSourcePassages(parent, body, "latency", "csv");
  assert.equal(evidence(result, "125").content, "latency,125\n");
  assert.match(result.warning, /not truncated/);
  originalRanges(result, body);
  const oversizedHeader = "entity," + "h".repeat(4100) + "\nlatency,125\n";
  assert.deepEqual(ruleSourcePassages(parent, oversizedHeader, "latency", "csv").candidates, []);
});

test("RET-04 parent sentences stay with blank-separated and nested list items", () => {
  const list = "Deployment rules:\n\n- latency is not approved\n\n  - never exceed 125 ms\n\n- keep no production access\n";
  const body = "# Rules\n\n" + padding + list;
  const result = ruleSourcePassages(parent, body, "latency");
  const item = evidence(result, "latency is not approved");
  assert(item.content.includes("Deployment rules:"));
  assert(item.content.includes("never exceed 125 ms"));
  assert(item.content.includes("no production access"));
  originalRanges(result, body);
});

test("RET-04 RST subset supports adornment hierarchy and intact :: literals", () => {
  for (const decoration of ["~", "^", "=", "-", "+", "*"]) {
    const body = "Manual\n======\n\nBackground\n----------\n\n" + padding +
      "Reset\n=====\n\nLimits\n" + decoration.repeat(6) + "\n\nExample::\n\n   latency must not exceed 125 ms\n\n   fake heading\n   ------------\n";
    const rstParent = { ...parent, sourceUri:"pkm://notes/rules.rst" };
    const result = ruleSourcePassages(rstParent, body, "latency", "rst");
    const item = evidence(result, "latency");
    assert(item.content.includes("Example::\n\n   latency"));
    assert(item.content.includes("fake heading\n   ------------"));
    assert.match(item.reason, /scope:.*Limits/s);
    originalRanges(result, body);
  }
});

const symbols = [
  ["py", 'def other():\n    return "unrelated"\n\n', 'def latency():\n    """literal\ndef fake():\n    pass\n"""\n    return "never exceed 125 ms"\n\n', 'class Tail:\n    pass\n'],
  ["ts", 'export function other() { return "unrelated"; }\n', 'export async function latency() {\n  const text = "} function fake() {";\n  // }\n  return 125;\n}\n', 'export class Tail {}\n'],
  ["js", 'function other() {}\n', 'const latency = () => {\n  const text = `} function fake() {`;\n  return 125;\n};\n', 'function tail() {}\n'],
  ["cs", 'public class Other {}\n', 'public class Latency {\n  public int Value() { return 125; }\n}\n', 'public class Tail {}\n'],
  ["go", 'func other() {}\n', 'func latency() int {\n  /* } func fake() {} */\n  return 125\n}\n', 'func tail() {}\n'],
];
for (const [extension, before, symbol, after] of symbols) {
  test(`RET-04 .${extension} splits top-level symbols without splitting their bodies`, () => {
    const body = before.repeat(400) + symbol + after;
    const codeParent = { ...parent, sourceUri:`file:///rules.${extension}?revision=1`, kind:"file" };
    const result = refineRuleCandidates([{ ...codeParent, content:body }], "latency");
    const item = evidence(result, "125");
    assert.equal(item.content, symbol);
    assert.match(item.reason, /scope: latency/i);
    originalRanges(result, body);
  });
}

test("RET-04 code recognizes source label/type extensions and keeps decorators attached", () => {
  const body = "def irrelevant():\n    pass\n".repeat(400) + '@cached\ndef latency():\n    return "125 ms"\n' + "def tail():\n    pass\n";
  for (const source of [{ label:"rules.py" }, { kind:"file.py" }]) {
    const result = refineRuleCandidates([{ ...parent, ...source, content:body }], "latency");
    assert.equal(evidence(result, "125 ms").content, '@cached\ndef latency():\n    return "125 ms"\n');
    originalRanges(result, body);
  }
});

test("RET-04 code symbol evidence carries exact module preamble conditions and imports", () => {
  for (const [extension, preamble, before, symbol] of [
    ["py", '"""Only CPU; do not deploy. All measurements in ms."""\r\nfrom settings import UNIT\r\nMAXIMUM = 125\r\n\r\n',
      "def other():\n    return 0\n", "def p99_latency():\n    return MAXIMUM\n"],
    ["ts", 'import { limit } from "./settings";\r\n// Only CPU; do not deploy. All measurements in ms.\r\n',
      "function other() { return 0; }\n", "function p99_latency() { return limit; }\n"],
    ["go", 'package benchmark\r\nimport "settings"\r\n// Only CPU; do not deploy. All measurements in ms.\r\n',
      "func other() {}\n", "func p99_latency() int { return settings.Limit }\n"],
  ]) {
    const body = preamble + before.repeat(400) + symbol;
    const result = refineRuleCandidates([{ ...parent, kind:"file", sourceUri:`file:///policy.${extension}`, content:body }], "p99_latency");
    const item = evidence(result, "p99_latency");
    assert.equal(item.content, symbol);
    assert(passageReferenceGroup(item, result.candidates).some(context => context.content === preamble));
    originalRanges(result, body);
  }
});

test("RET-04 an oversized code preamble refuses dependent symbol fragments instead of losing scope", () => {
  const body = "# Only CPU; do not deploy. All measurements in ms.\n".repeat(100)
    + "def p99_latency():\n    return 125\n";
  const result = refineRuleCandidates([{ ...parent, kind:"file", sourceUri:"file:///policy.py", content:body }], "p99_latency");
  assert(result.candidates.every(item => !item.content));
  assert(result.warnings.some(warning => /not truncated/.test(warning)));
});

test("RET-04 JSON top-level keys and array entities retain key-path scopes without rewriting", () => {
  const body = '\uFEFF\r\n' + JSON.stringify({
    "a.b":{ latency:125, unit:"ms", approved:false },
    "quoted\"key":{ latency:250, unit:"ms" },
    records:[{ latency:125, unit:"ms", message:'Never split escaped "strings", {braces}' }],
  }, null, 2);
  const result = ruleSourcePassages(parent, body, "latency", "json");
  assert(result.candidates.some(item => item.reason.includes('scope: $["a.b"]')));
  assert(result.candidates.some(item => item.reason.includes('scope: $["quoted\\"key"]')));
  const entity = result.candidates.find(item => item.reason.includes('scope: $["records"][0]'));
  assert(entity);
  assert.equal(JSON.parse(entity.content).unit, "ms");
  assert(passageReferenceGroup(entity, result.candidates).some(item => item.content.includes('"records": [')));
  originalRanges(result, body);
});

test("RET-04 JSON shared contexts promoted to evidence retain their own key scopes", () => {
  const body = JSON.stringify({ first:"latency one", second:"latency two" });
  const result = ruleSourcePassages(parent, body, "latency", "json");
  for (const key of ["first", "second"]) {
    const item = evidence(result, `"${key}"`);
    assert(item.reason.includes(`scope: $["${key}"]`));
    assert(item.contextIds.length <= 1);
  }
  originalRanges(result, body);
});

test("RET-04 multi-array and duplicate-key JSON objects stay atomic rather than dropping uncertain scope", () => {
  for (const filler of ["", "background".repeat(600)]) {
    for (const body of [
      JSON.stringify({ conditions:["never deploy", "unit ms"], records:[{ filler }, { latency:125 }] }),
      '{"unit":"us","\\u0075nit":"ms","records":[' + JSON.stringify({ filler }) + ',{"latency":125}]}',
    ]) {
      const result = ruleSourcePassages(parent, body, "latency", "json");
      if (body.length <= 4000) {
        assert.equal(evidence(result, "125").content, body, "Keep all original ambiguous/shared scope together");
        originalRanges(result, body);
      } else {
        assert.deepEqual(result.candidates, []);
        assert.match(result.warning, /not truncated/);
        const inferred = refineRuleCandidates([{ ...parent, content:body }], "latency");
        assert(inferred.candidates.every(item => !item.content));
        assert(!inferred.warnings.some(warning => /falling back/.test(warning)));
      }
    }
  }
});

test("RET-04 malformed JSON refinement falls back to original rule text and warns", () => {
  const body = '{invalid JSON\n\n' + padding + 'latency must not exceed 125 ms.\n';
  const result = refineRuleCandidates([{ ...parent, content:body }], "latency");
  assert(result.warnings.some(warning => /invalid JSON/i.test(warning)));
  assert(result.warnings.some(warning => /falling back.*original rule-based text/.test(warning)));
  assert.equal(evidence(result, "125 ms").content, 'latency must not exceed 125 ms.\n');
  originalRanges(result, body);
  // Explicit JSON parsing remains fail-closed for existing callers.
  assert.equal(ruleSourcePassages(parent, '{invalid latency}', "latency", "json").candidates.length, 0);
});

test("RET-04 declared JSON rejects malformed content instead of silently treating it as prose", () => {
  for (const source of [
    { sourceUri:"file:///policy.JSON?revision=1" },
    { label:"policy.json" },
    { kind:"file.json" },
  ]) {
    for (const prefix of ["{invalid JSON\n\n", "This is not JSON.\n\n"]) {
      const body = prefix + padding + "latency must not exceed 125 ms.\n";
      const result = refineRuleCandidates([{ ...parent, ...source, content:body }], "latency");
      assert(result.candidates.every(item => !item.content), JSON.stringify(source));
      assert(result.warnings.some(warning => /invalid JSON/.test(warning)));
      assert(!result.warnings.some(warning => /falling back/.test(warning)));
    }
  }
});

test("RET-04 explicit text formats work for Script/file sources before JSON-looking content heuristics", () => {
  for (const [extension, body] of [
    ["rst", "[citation]\r\n\r\nManual\r\n======\r\n\r\nBackground\r\n~~~~~~~~~~\r\n\r\n" + padding + "Limits\r\n~~~~~~\r\n\r\nlatency must not exceed 125 ms.\r\n"],
    ["md", "[citation]\n\n# Manual\n\n## Background\n\n" + padding + "## Limits\n\nlatency must not exceed 125 ms.\n"],
  ]) {
    const source = { ...parent, kind:"script", sourceUri:`file:///policy.${extension}?revision=1`, label:"misleading.csv", content:body };
    const result = refineRuleCandidates([source], "latency");
    const item = evidence(result, "125 ms");
    assert.match(item.reason, /scope:.*Limits/s);
    assert(!result.warnings.some(warning => /JSON|CSV|falling back/.test(warning)));
    originalRanges(result, body);
  }
  const python = "['module initialization']\n" + "def other():\n    return 0\n".repeat(400) + "def latency():\n    return 125\n";
  const result = refineRuleCandidates([{ ...parent, kind:"file", sourceUri:"file:///policy.py", label:"misleading.json", content:python }], "latency");
  assert.match(evidence(result, "125").reason, /scope: latency/);
  assert(!result.warnings.some(warning => /JSON|falling back/.test(warning)));
  originalRanges(result, python);
});

test("RET-04 explicit Markdown does not invent JSON array-entity scopes", () => {
  const body = JSON.stringify([{ background:"x".repeat(4500) }, { latency:125 }], null, 2);
  const result = refineRuleCandidates([{ ...parent, sourceUri:"file:///policy.md", label:"misleading.json", content:body }], "latency");
  assert(result.candidates.every(item => !item.content), "The oversized Markdown block stays atomic");
  assert(result.warnings.some(warning => /not truncated/.test(warning)));
});

test("RET-04 negations remain with their clauses across blank lines", () => {
  for (const negation of ["not", "no", "never", "不", "没有", "禁止", "not under any circumstances"]) {
    const body = "# Safety\n\n" + padding + `Policy ${negation}\n\nlatency deployment above 125 ms.\n`;
    const result = ruleSourcePassages(parent, body, "latency");
    assert(evidence(result, "latency deployment").content.includes(`Policy ${negation}\n\nlatency`));
    originalRanges(result, body);
  }
});

test("RET-04 numbers and units remain together across whitespace/blank lines", () => {
  for (const unit of ["ms", "requests/s", "%", "°C", "千克"]) {
    const body = "# Measurements\n\n" + padding + `latency limit is 125\n\n${unit} maximum.\n`;
    const result = ruleSourcePassages(parent, body, "latency");
    assert(evidence(result, "latency limit").content.includes(`125\n\n${unit}`));
    originalRanges(result, body);
  }
});

test("RET-04 oversized atomic fences, lists, literals and symbols refuse with warnings, not truncation", () => {
  const sources = [
    [parent, '# Example\n\n```text\nlatency\n' + 'x'.repeat(4500) + '\n```\n', "markdown"],
    [parent, '# Example\n\nRules:\n\n- latency\n\n- ' + 'x'.repeat(4500), "markdown"],
    [parent, 'Example\n=======\n\n::\n\n   latency\n   ' + 'x'.repeat(4500), "rst"],
    [{ ...parent, sourceUri:"file:///rules.py" }, 'def latency():\n    value = "' + 'x'.repeat(4500) + '"\n', "atomic"],
    [parent, JSON.stringify({ latency:{ value:125, data:"x".repeat(4500) } }), "json"],
  ];
  for (const [source, body, format] of sources) {
    const result = ruleSourcePassages(source, body, "latency", format);
    assert.deepEqual(result.candidates, []);
    assert.match(result.warning, /not truncated/);
  }
});


function chatReferenceRoots(knowledge) {
  // Same reference-root filter as src/chat/api-chat-view.ts.
  const contextIds = new Set(knowledge.flatMap(candidate => candidate.contextIds || []));
  return knowledge.filter(candidate => candidate.content && !contextIds.has(candidate.id));
}

test("RET-04 mutually dependent evidence retains selectable Chat roots without cycles", () => {
  for (const [body, format] of [
    ["Conditions: latency 125 ms.\n\nSetup: latency CPU only.\n\n" + padding, "markdown"],
    [JSON.stringify({ first:"latency one", second:"latency two", third:"latency three" }), "json"],
  ]) {
    const result = ruleSourcePassages(parent, body, "latency", format);
    const roots = chatReferenceRoots(result.candidates);
    assert.equal(roots.length, 1);
    const group = passageReferenceGroup(roots[0], result.candidates);
    for (const needle of format === "json" ? ["latency one", "latency two", "latency three"] : ["125 ms", "CPU only"])
      assert(group.some(item => item.content.includes(needle)));
    function visit(item, path = new Set()) {
      assert(!path.has(item.id), "contextIds must be acyclic");
      const next = new Set([...path, item.id]);
      for (const id of item.contextIds || []) visit(result.candidates.find(candidate => candidate.id === id), next);
    }
    for (const item of result.candidates) visit(item);
    originalRanges(result, body);
  }
});

test("RET-04 adversarial numeric paragraphs and modifier lines complete under 200ms", () => {
  const { performance } = require("node:perf_hooks");
  for (const [source, body, format] of [
    [parent, "1".repeat(40000) + "x\n\nlatency 125 ms.\n", "markdown"],
    [{ ...parent, sourceUri:"file:///rules.ts" }, "public ".repeat(16000) + "!\nfunction latency() { return 125; }\n", "atomic"],
  ]) {
    const start = performance.now();
    const result = ruleSourcePassages(source, body, "latency", format);
    const elapsed = performance.now() - start;
    assert(elapsed < 200, `Adversarial ${format} input took ${elapsed.toFixed(1)}ms`);
    if (format === "atomic") {
      assert.deepEqual(result.candidates, [], "The oversized code prefix is still required context");
      assert.match(result.warning, /not truncated/);
    } else evidence(result, "125");
    originalRanges(result, body);
  }
});

test("RET-04 long heading scopes cannot overflow reason metadata contracts", () => {
  const heading = "# " + "h".repeat(950);
  const body = heading + "\n\nlatency must not exceed 125 ms.\n";
  const result = ruleSourcePassages(parent, body, "latency");
  const item = evidence(result, "125 ms");
  assert(item.reason.length <= 1024);
  assert.match(item.reason, /scope:/);
  assert.equal(item.content, body);
  originalRanges(result, body);
});
