#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createRetrievalSnapshot } = require("../dist/retrieval-snapshot.js");
const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

const groups = ["Broker A", "Broker B", "Broker C"].map((alias, index) => ({
  subscriptionId: `sub-${index}`,
  alias,
  priority: index === 0 ? "highest" : index === 1 ? "high" : "normal",
  publisher: `publisher-${index}`,
  nodeId: `node-${index}`,
  shareId: `share-${index}`,
  revision: index + 1,
  syncedAt: "2026-09-16T00:00:00Z",
  items: [{ key: `remote-${index}`, title: `Remote ${index}`, path: `Team/Remote ${index}.md`, type: "skills",
    pkmPath: `pkm://subscriptions/node-${index}/share-${index}/skills/Team/Remote%20${index}.md` }],
}));
const sources = {
  skills: [{ _key: "Coding/Local Skill", name: "Local Skill", description: "Local procedure", content: "skill body", category: "Coding", tags: '["local"]', priority: "high" }],
  notes: [{ slug: "Research/Local Note", title: "Local Note", description: "Observation", content: "note body", category: "Research", type: "observation", tags: "[]" }],
  scripts: [{ path: "Scope/local.script", file: "local.script", category: "Scope", lang: "scope", extension: ".script", content: "script body" }],
  subscriptionGroups: groups,
  readSubscription: key => ({ contentType: "skills", content: `body:${key}`, provenance: { upstream: key } }),
};

const first = createRetrievalSnapshot(sources);
const second = createRetrievalSnapshot({ ...sources, subscriptionGroups: [...groups].reverse() });
assert.strictEqual(first.documents.length, 6, "one local document per type plus all three Brokers must share one index");
assert.strictEqual(first.corpus_revision, second.corpus_revision, "corpus revision must not depend on input ordering");
assert.deepStrictEqual(first.documents.filter(item => item.read_only).map(item => item.provenance.broker), ["Broker A", "Broker B", "Broker C"]);
assert.deepStrictEqual(first.documents.filter(item => item.read_only).map(item => item.metadata.source_priority), ["highest", "high", "normal"]);
assert.strictEqual(first.documents.find(item => item.provenance.broker === "Broker A").provenance.source_priority, "highest");
assert(first.documents.some(item => item.skill_id === "skill:Coding/Local Skill" && item.source_uri === "pkm://skills/Coding/Local%20Skill"));
assert.strictEqual(first.documents.find(item => item.skill_id === "skill:Coding/Local Skill").metadata.priority, "high");
assert(first.documents.some(item => item.skill_id === "note:Research/Local Note" && item.content_type === "note"));
assert(first.documents.some(item => item.skill_id === "script:Scope/local.script" && item.content_type === "script"));
assert(first.documents.filter(item => item.content_type === "subscription").every(item => item.skill_id === item.source_uri && item.provenance.provider === "broker"));
const changed = createRetrievalSnapshot({ ...sources, subscriptionGroups: groups.slice(0, 2) });
assert.notStrictEqual(changed.corpus_revision, first.corpus_revision, "unsubscribe must change the visible corpus revision");
assert.strictEqual(changed.documents.length, 5);
const reprioritized = createRetrievalSnapshot({ ...sources, subscriptionGroups: groups.map(group => ({ ...group, priority: "normal" })) });
assert.notStrictEqual(reprioritized.corpus_revision, first.corpus_revision, "source priority must invalidate the retrieval corpus");
assert.match(extension, /scheduleRetrievalRefresh\(context, 10_000\)/, "activation/runtime setup must defer the initial snapshot until first content can render");
assert.match(extension, /function scheduleRetrievalRefresh\(context: vscode\.ExtensionContext, delay = 5_000\)/, "repeated file events must coalesce before rebuilding the search index");
assert.match(extension, /title: "PKM: Updating search index"/, "background search indexing must be visible without blocking the CatTree");
assert.match(extension, /onChanged:[\s\S]{0,250}scheduleRetrievalRefresh\(context\)/, "Broker updates must refresh the Subscriber index");
assert.match(extension, /_watcherRefreshTimer = setTimeout[\s\S]{0,1200}scheduleRetrievalRefresh\(context\)/, "local file updates must refresh the Subscriber index");
console.log("retrieval snapshot test: local Skill/Note/Script plus three Broker partitions produce one deterministic typed corpus OK");
