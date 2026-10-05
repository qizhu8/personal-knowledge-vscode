#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRetrievalSnapshot } = require("../dist/retrieval-snapshot.js");
const storage = require("../dist/storage.js");
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
  skills: [{ _key: "Coding/Local Skill", knowledgeId: "knowledge_0123456789abcdef01234567", revision: 3, name: "Local Skill", description: "Local procedure", content: "skill body", category: "Coding", tags: '["local"]', priority: "high" }],
  notes: [{ slug: "Research/Local Note", knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", revision: 2, title: "Local Note", description: "Observation", content: "note body", category: "Research", type: "observation", tags: "[]" }],
  papers: [
    { slug: "Papers/Parent", knowledgeId: "knowledge_cccccccccccccccccccccccc", revision: 5, title: "Parent Paper", description: "Prior art", content: "parent body", topic: "Retrieval", conclusions: ["bounded graph"] },
    { slug: "Papers/Child", knowledgeId: "knowledge_dddddddddddddddddddddddd", revision: 2, title: "Child Paper", description: "Follow-up", content: "child body", topic: "Retrieval", cites: [{ paper: "Parent Paper", note: "builds on" }] },
  ],
  scripts: [{ path: "Scope/local.script", knowledgeId: "script_0123456789abcdef01234567", file: "local.script", category: "Scope", lang: "scope", extension: ".script", content: "script body" }],
  recipes: [{ recipeId: "recipe_local", knowledgeId: "knowledge_bbbbbbbbbbbbbbbbbbbbbbbb", revision: 4,
    name: "Local Recipe", description: "Executable workflow", category: "Automation",
    executableDigest: "c".repeat(64), definition: { schema: "pkm.workflow.definition/v1", spec: { nodes: [] } } }],
  subscriptionGroups: groups,
  readSubscription: key => ({ contentType: "skills", content: `body:${key}`, provenance: { upstream: key } }),
};

const first = createRetrievalSnapshot(sources);
const second = createRetrievalSnapshot({ ...sources, subscriptionGroups: [...groups].reverse() });
assert.strictEqual(first.documents.length, 9, "local Skill/Note/Research/Script/Recipe plus all three Brokers must share one index");
assert.strictEqual(first.corpus_revision, second.corpus_revision, "corpus revision must not depend on input ordering");
assert.deepStrictEqual(first.documents.filter(item => item.read_only).map(item => item.provenance.broker), ["Broker A", "Broker B", "Broker C"]);
assert.deepStrictEqual(first.documents.filter(item => item.read_only).map(item => item.metadata.source_priority), ["highest", "high", "normal"]);
assert.strictEqual(first.documents.find(item => item.provenance.broker === "Broker A").provenance.source_priority, "highest");
assert(first.documents.some(item => item.skill_id === "skill:Coding/Local Skill"
  && item.knowledge_id === "knowledge_0123456789abcdef01234567"
  && item.source_uri === "pkm://knowledge/knowledge_0123456789abcdef01234567"
  && item.metadata.legacy_uri === "pkm://skills/Coding/Local%20Skill"));
assert.strictEqual(first.documents.find(item => item.skill_id === "skill:Coding/Local Skill").metadata.priority, "high");
assert(first.documents.some(item => item.skill_id === "note:Research/Local Note"
  && item.knowledge_id === "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa"
  && item.source_uri === "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa"
  && item.content_type === "note"));
const script = first.documents.find(item => item.content_type === "script");
assert(script && script.source_id === "pkm://script/script_0123456789abcdef01234567"
  && script.source_uri === script.source_id && script.skill_id === script.source_id
  && script.metadata.legacy_uri === "pkm://scripts/Scope/local.script");
const movedScript = createRetrievalSnapshot({ ...sources, scripts: [{ ...sources.scripts[0], path: "Scope/moved.script", updatedAt: "tomorrow" }] }).documents.find(item => item.content_type === "script");
assert.strictEqual(movedScript.source_id, script.source_id, "moving a script must preserve its identity");
assert.strictEqual(movedScript.source_revision, script.source_revision, "path and timestamp cannot change the content revision");
const editedScript = createRetrievalSnapshot({ ...sources, scripts: [{ ...sources.scripts[0], content: "new script body" }] }).documents.find(item => item.content_type === "script");
assert.strictEqual(editedScript.source_id, script.source_id);
assert.notStrictEqual(editedScript.source_revision, script.source_revision, "editing content must change its content revision");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-identity-"));
try {
  storage.setStorePath(root);
  fs.mkdirSync(path.join(root, "scripts", "Scope"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "Scope", "local.script"), "script body");
  const original = storage.scriptGet("Scope/local.script");
  const canonicalUri = `pkm://script/${original.knowledgeId}`;
  const legacyId = `script_${require("crypto").createHash("sha256").update("Scope/local.script").digest("hex").slice(0, 24)}`;
  assert.strictEqual(original.knowledgeId, legacyId, "adopting a legacy Script must preserve its existing canonical URI");
  assert(fs.existsSync(storage.scriptIdentityFile(original.path)), "identity must be persisted beside the source");
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-identity-peer-"));
  try {
    fs.mkdirSync(path.join(secondRoot, "scripts", "Scope"), { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "scripts", "Scope", "local.script"), "script body");
    storage.setStorePath(secondRoot);
    assert.strictEqual(storage.scriptGet("Scope/local.script").knowledgeId, original.knowledgeId,
      "independent machines must adopt the same legacy Script identity before the first sync");
  } finally {
    storage.setStorePath(root);
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
  assert.strictEqual(storage.scriptList().length, 1, "sidecar must not appear as a Script");
  assert(storage.scriptMove("Scope/local.script", "Moved"));
  const moved = storage.scriptGet(canonicalUri);
  assert.strictEqual(moved.knowledgeId, original.knowledgeId);
  assert.strictEqual(moved.path, "Moved/local.script");
  assert.strictEqual(storage.scriptGet("pkm://scripts/Scope/local.script").knowledgeId, original.knowledgeId);
  assert.strictEqual(storage.scriptGet(`pkm://script/${legacyId}`).knowledgeId, original.knowledgeId);
  assert.strictEqual(storage.scriptGet("Scope/local.script").knowledgeId, original.knowledgeId);
  fs.writeFileSync(path.join(root, "scripts", "Scope", "local.script"), "another script");
  assert.strictEqual(storage.scriptMove("Moved/local.script", "Scope"), false, "moving cannot overwrite a different Script");
  const replacement = storage.scriptGet("Scope/local.script");
  assert.notStrictEqual(replacement.knowledgeId, original.knowledgeId, "a reused path cannot steal the moved Script's ID");
  assert.strictEqual(storage.scriptGet("pkm://scripts/Scope/local.script").knowledgeId, original.knowledgeId,
    "the old URI continues to identify the moved Script after path reuse");
  const reusedExports = storage.scriptExport();
  const reusedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-identity-reuse-"));
  try {
    storage.setStorePath(reusedRoot);
    assert.strictEqual(storage.scriptImport(reusedExports), 2);
    assert.strictEqual(storage.scriptGet("Scope/local.script").knowledgeId, replacement.knowledgeId);
    assert.strictEqual(storage.scriptGet("pkm://scripts/Scope/local.script").knowledgeId, original.knowledgeId,
      "export/import must not reassign a moved Script's old alias to its replacement");
  } finally {
    storage.setStorePath(root);
    fs.rmSync(reusedRoot, { recursive: true, force: true });
  }
  fs.rmSync(path.join(root, "scripts", "Scope", "local.script"));
  fs.writeFileSync(path.join(root, "scripts", moved.path), "edited body");
  assert.strictEqual(storage.scriptGet(canonicalUri).knowledgeId, original.knowledgeId);
  assert.strictEqual(storage.scriptList().length, 1);
  const exported = storage.scriptExport();
  assert.strictEqual(exported[0].identity.knowledgeId, original.knowledgeId);
  const importedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-identity-import-"));
  try {
    storage.setStorePath(importedRoot);
    assert.strictEqual(storage.scriptImport(exported), 1);
    assert.strictEqual(storage.scriptGet("Moved/local.script").knowledgeId, original.knowledgeId,
      "an unprefixed Script import preserves the source identity after a move");
    const updatedIdentity = { ...exported[0].identity, aliases: [...exported[0].identity.aliases, "pkm://scripts/Before/local.script"] };
    assert.strictEqual(storage.scriptImport([{ ...exported[0], identity: updatedIdentity }]), 1);
    assert.strictEqual(storage.scriptGet("pkm://scripts/Before/local.script").knowledgeId, original.knowledgeId,
      "subsequent imports merge newly learned legacy aliases for the same Script");
    assert.strictEqual(storage.scriptImport([{ ...exported[0], category: "Copy", identity: undefined }]), 1);
    assert.notStrictEqual(storage.scriptGet("Copy/local.script").knowledgeId, original.knowledgeId,
      "a prefixed import creates an independent Script");
    assert.strictEqual(storage.scriptImport([{ ...exported[0], category: "Other" }]), 0,
      "the same identity cannot be imported under a second path");
  } finally {
    storage.setStorePath(root);
    fs.rmSync(importedRoot, { recursive: true, force: true });
  }
} finally {
  storage.setStorePath("");
  fs.rmSync(root, { recursive: true, force: true });
}
const childPaper = first.documents.find(item => item.skill_id === "research:Papers/Child");
assert(childPaper && childPaper.content_type === "research"
  && childPaper.source_id === "pkm://knowledge/knowledge_dddddddddddddddddddddddd"
  && childPaper.source_revision === "2");
assert.deepStrictEqual(childPaper.links, [{
  relation: "cites",
  target: "pkm://knowledge/knowledge_cccccccccccccccccccccccc",
  mode: "floating",
  required: false,
}]);
assert(first.documents.some(item => item.skill_id === "recipe:recipe_local"
  && item.knowledge_id === "knowledge_bbbbbbbbbbbbbbbbbbbbbbbb"
  && item.content_type === "recipe"
  && item.source_uri === "pkm://knowledge/knowledge_bbbbbbbbbbbbbbbbbbbbbbbb"));
assert(first.documents.filter(item => item.content_type === "subscription").every(item => item.skill_id === item.source_uri && item.provenance.provider === "broker"));
const changed = createRetrievalSnapshot({ ...sources, subscriptionGroups: groups.slice(0, 2) });
assert.notStrictEqual(changed.corpus_revision, first.corpus_revision, "unsubscribe must change the visible corpus revision");
assert.strictEqual(changed.documents.length, 8);
const reprioritized = createRetrievalSnapshot({ ...sources, subscriptionGroups: groups.map(group => ({ ...group, priority: "normal" })) });
assert.notStrictEqual(reprioritized.corpus_revision, first.corpus_revision, "source priority must invalidate the retrieval corpus");
assert.throws(() => createRetrievalSnapshot({
  ...sources,
  skills: [{ ...sources.skills[0], links: [{ relation: "supports", target: "relative/path", mode: "floating", required: true }] }],
}), /Invalid Knowledge links/, "invalid canonical links must fail instead of disappearing from the derived graph");
assert.match(extension, /scheduleRetrievalRefresh\(context, 10_000\)/, "activation/runtime setup must defer the initial snapshot until first content can render");
assert.match(extension, /function scheduleRetrievalRefresh\(context: vscode\.ExtensionContext, delay = 5_000\)/, "repeated file events must coalesce before rebuilding the search index");
assert.match(extension, /title: "PKM: Updating search index"/, "background search indexing must be visible without blocking the CatTree");
assert.match(extension, /onChanged:[\s\S]{0,500}scheduleRetrievalRefresh\(context\)/, "Broker updates must refresh the Subscriber index");
assert.match(extension, /_watcherRefreshTimer = setTimeout[\s\S]{0,1200}scheduleRetrievalRefresh\(context\)/, "local file updates must refresh the Subscriber index");
console.log("retrieval snapshot test: local Skill/Note/Research/Script/Recipe plus Broker partitions and canonical citations OK");
