import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { parseStoreFrontmatter } from "./filestore";
import { legacyKnowledgeAlias, readKnowledgeIdentity, KnowledgeKind } from "./knowledge-contracts";
import { isContentPathPrivate, PrivacyContentType, setPrivacyStoreRoot } from "./content-privacy";
import { readSyncScriptIdentity, syncScriptSidecarPath } from "../sync/github-sync-script-identity";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import { withFsRetry } from "../workflows/project-filesystem-store";

/** Model-free, review-only classification. Asset identities are never created or changed. */
export interface ClassificationEvidence { dimension: string; rule: string; confidence: number; }
export interface AssetClassificationProposal {
  id: string; type: "classification" | "duplicate" | "near-duplicate" | "correction";
  asset: string; locator: string; hash: string; target: string; targetHash: string | null;
  classification: Record<string, string>; evidence: ClassificationEvidence[];
  relatedAsset?: string; suggestion?: string;
}
export interface AssetClassificationPreview {
  id: string; root: string; proposals: AssetClassificationProposal[];
  skipped: number; truncated: boolean; modelCalls: 0;
}
export interface ClassificationResult { journalId: string; applied: string[]; skipped: Array<{ id: string; reason: string }>; }
const areas: Record<string, string> = { skills: "skill", notes: "note", scripts: "script", components: "component", actions: "action", recipes: "recipe", papers: "paper" };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const digest = (file: string): string | null => fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;

function checked(root: string, relative: string): string {
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f:]/.test(part))) throw new Error("Unsafe classification path.");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Classification refuses symbolic links."); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  return current;
}
function atomic(file: string, content: Buffer, mode = 0o600): void {
  const staging = `${file}.${randomUUID()}.pending`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(staging, "wx", mode);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    withFsRetry(() => fs.renameSync(staging, file));
  } finally { fs.rmSync(staging, { force: true }); }
}
function metadataTarget(asset: string): string {
  return /\.md$/i.test(asset) ? asset : path.posix.join(path.posix.dirname(asset), `.${path.posix.basename(asset)}.pkm-classification`);
}
function metadataBytes(bytes: Buffer, classification: Record<string, string>): Buffer {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Markdown must be valid UTF-8.");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = text.slice(bom.length);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const line = `pkmClassification: ${JSON.stringify(classification)}`;
  const match = /^---\r?\n([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(source);
  if (!match) {
    if (source.startsWith("---")) throw new Error("Unsupported frontmatter.");
    return Buffer.from(`${bom}---${eol}${line}${eol}---${eol}${source}`);
  }
  let header = match[1];
  if (/^pkmClassification:/m.test(header)) {
    const existing = /^pkmClassification: (\{[^\r\n]*\})$/m.exec(header);
    if (!existing) throw new Error("Unsupported classification metadata.");
    JSON.parse(existing[1]);
    header = header.replace(/^pkmClassification:.*$/m, line);
  } else header += `${eol}${line}`;
  return Buffer.from(`${bom}---${eol}${header}${match[2]}---${source.slice(match[0].length)}`);
}
function shingles(text: string): Set<string> {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const result = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) result.add(words.slice(i, i + 3).join(" "));
  return result;
}

/** This operation intentionally performs no writes, including preview/state persistence. */
export function previewAssetClassification(storeRoot: string): AssetClassificationPreview {
  const root = fs.realpathSync(storeRoot);
  setPrivacyStoreRoot(root);
  const proposals: AssetClassificationProposal[] = [];
  const bodies: Array<{ proposal: AssetClassificationProposal; hash: string; shingles: Set<string> }> = [];
  let skipped = 0, truncated = false, scanned = 0, bytesRead = 0;
  const walk = (relative: string, area: string): void => {
    const directory = checked(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "_assets" || entry.name.endsWith(".assets") || entry.name.endsWith(".pkm-meta.json")) continue;
      if (scanned >= 1000) { truncated = true; return; }
      const asset = `${relative}/${entry.name}`;
      const local = asset.slice(area.length + 1);
      if (entry.isSymbolicLink()) { skipped++; continue; }
      // Private content is excluded from all review payloads, including transport/usage logs.
      const privacyArea = area === "components" ? "scripts" : area;
      if (isContentPathPrivate(privacyArea as PrivacyContentType, local)) { skipped++; continue; }
      if (entry.isDirectory()) { walk(asset, area); continue; }
      if (!entry.isFile()) continue;
      scanned++;
      const full = checked(root, asset);
      const size = fs.statSync(full).size;
      if (size > 2 * 1024 * 1024) { skipped++; continue; }
      if (bytesRead + size > 32 * 1024 * 1024) { skipped++; truncated = true; continue; }
      bytesRead += size;
      const bytes = fs.readFileSync(full), text = bytes.toString("utf8");
      const markdown = /\.md$/i.test(asset);
      const parsed = markdown ? parseStoreFrontmatter(text.replace(/^\uFEFF/, "")) : { fm: {} as Record<string, any>, body: text };
      let fm = parsed.fm;
      if (!markdown && /\.json$/i.test(asset)) {
        try { const value = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) fm = value; } catch { /* Opaque files still receive a sidecar proposal. */ }
      }
      if (fm.private === true || fm.privacy === "private" || fm.pkmClassification?.privacy === "private") { skipped++; continue; }
      const classification: Record<string, string> = {};
      const evidence: ClassificationEvidence[] = [];
      const assign = (dimension: string, value: string, rule: string, confidence: number): void => {
        classification[dimension] = value; evidence.push({ dimension, rule, confidence });
      };
      const metadata = (key: string): string => typeof fm[key] === "string" && fm[key].length < 128 ? fm[key] : "";
      assign("kind", areas[area], "storage-area", 1);
      const domain = metadata("domain") || metadata("category") || (local.includes("/") ? local.split("/")[0] : "unclassified");
      assign("domain", domain, metadata("domain") || metadata("category") ? "existing-metadata" : "path-category", 0.8);
      assign("project", metadata("project") || metadata("source_project") || "unassigned", "existing-project-or-unknown", 0.8);
      assign("scope", metadata("scope") || (classification.project !== "unassigned" ? "project" : "unspecified"), "project-scope", 0.7);
      assign("maturity", metadata("maturity") || (/^#{1,6}\s+(?:validation|tests|verified)\b/im.test(parsed.body) ? "validation-described" : "unreviewed"), "metadata-or-validation-heading", 0.65);
      assign("privacy", "local", "local-only-not-publication-authorization", 1);
      assign("provenance", metadata("provenance") || (metadata("source") || metadata("source_url") || /\]\(https?:\/\//.test(parsed.body) ? "linked-source" : "unspecified"), "metadata-or-source-link", 0.8);
      const target = metadataTarget(asset);
      let locator = `pkm://${area}/${local.split("/").map(encodeURIComponent).join("/")}`;
      if (["skills", "notes", "papers"].includes(area)) {
        const kind = (area === "papers" ? "research" : areas[area]) as KnowledgeKind;
        const identity = readKnowledgeIdentity(fm, kind, local.replace(/\.md$/i, ""));
        locator = identity.knowledgeId ? `pkm://knowledge/${identity.knowledgeId}` : legacyKnowledgeAlias(kind, local.replace(/\.md$/i, ""));
      }
      if (/^(?:knowledge_[a-f0-9]{24}|action_(?:[a-f0-9]{24}|[a-f0-9]{32}))$/.test(String(fm.knowledgeId || ""))) locator = `pkm://knowledge/${fm.knowledgeId}`;
      else if (area === "recipes" && /^recipe_[A-Za-z0-9_-]+$/.test(String(fm.recipeId || ""))) locator = `pkm://recipes/${fm.recipeId}`;
      else if (["actions", "components"].includes(area)) {
        const id = fm.actionId || fm.action_id || fm.componentId;
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(id || ""))) locator = `pkm://${area}/${id}`;
      } else if (area === "scripts") {
        const identityFile = checked(root, syncScriptSidecarPath(asset));
        if (fs.existsSync(identityFile)) {
          try { locator = `pkm://script/${readSyncScriptIdentity(fs.readFileSync(identityFile)).knowledgeId}`; }
          catch { skipped++; continue; }
        }
      }
      const proposal: AssetClassificationProposal = { id: "", type: "classification", asset, locator, hash: hash(bytes), target,
        targetHash: digest(checked(root, target)), classification, evidence };
      proposal.id = hash(JSON.stringify(proposal));
      try {
        if (markdown) metadataBytes(bytes, classification);
        else if (proposal.targetHash !== null) {
          const existing = JSON.parse(fs.readFileSync(checked(root, target), "utf8"));
          if (existing.schema !== "pkm.asset-classification/v1" || existing.asset !== locator) { skipped++; continue; }
        }
      } catch { skipped++; continue; }
      proposals.push(proposal);
      if (!bytes.includes(0) && Buffer.from(text).equals(bytes)) bodies.push({ proposal, hash: hash(parsed.body), shingles: shingles(parsed.body) });
      const declared = metadata("kind");
      if (declared && declared !== areas[area] && !(area === "papers" && declared === "research")) {
        proposals.push({ ...proposal, id: hash(`${proposal.id}:correction`), type: "correction", evidence: [{ dimension: "kind", rule: "declared-kind-conflicts-with-storage", confidence: 0.7 }], suggestion: "Compare declared kind with storage role; correct metadata only after review. No move is proposed." });
      }
    }
  };
  for (const area of Object.keys(areas)) walk(area, area);
  let duplicateSuggestions = 0;
  duplicates: for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    const exact = a.hash === b.hash;
    let intersection = 0;
    if (!exact && a.shingles.size >= 8 && b.shingles.size >= 8) for (const item of a.shingles) if (b.shingles.has(item)) intersection++;
    const score = exact ? 1 : intersection / (a.shingles.size + b.shingles.size - intersection || 1);
    if (score < 0.82) continue;
    if (duplicateSuggestions++ >= 2000) { truncated = true; break duplicates; }
    proposals.push({ ...a.proposal, id: hash(`${a.proposal.id}:${b.proposal.id}:duplicate`), type: exact ? "duplicate" : "near-duplicate",
      relatedAsset: b.proposal.asset, evidence: [{ dimension: "dedupe", rule: exact ? "body-sha256" : "three-token-shingle-jaccard", confidence: score }],
      suggestion: "Compare sources, preserve provenance, and consider updating the existing asset. Review only: no merge or deletion is executable." });
  }
  return { id: hash(JSON.stringify(proposals)), root, proposals, skipped, truncated, modelCalls: 0 };
}

interface JournalEntry { id: string; asset: string; target: string; before: string | null; beforeHash: string | null; afterHash: string; mode: number; }
interface Journal { schema: 1; entries: JournalEntry[]; }
function stateFile(root: string, name: string): string { return checked(root, `.pkm/state/asset-classification/${name}`); }
function saveJournal(root: string, id: string, journal: Journal): void { atomic(stateFile(root, `${id}.json`), Buffer.from(JSON.stringify(journal))); }

/** Callers must retain the original preview locally; caller-supplied proposal bodies are not an approval API. */
export function applyAssetClassification(storeRoot: string, preview: AssetClassificationPreview, proposalIds: string[]): ClassificationResult {
  const root = fs.realpathSync(storeRoot);
  if (preview.root !== root || preview.id !== hash(JSON.stringify(preview.proposals))) throw new Error("Invalid classification preview.");
  if (!Array.isArray(proposalIds) || !proposalIds.length || proposalIds.some(id => !preview.proposals.some(p => p.id === id))) throw new Error("Explicit proposal IDs from this preview are required.");
  setPrivacyStoreRoot(root);
  return withCrossProcessLockSync(stateFile(root, "mutation.lock"), "asset classification", () => {
    const result: ClassificationResult = { journalId: randomUUID(), applied: [], skipped: [] };
    const journal: Journal = { schema: 1, entries: [] };
    for (const id of [...new Set(proposalIds)]) {
      const p = preview.proposals.find(item => item.id === id)!;
      if (p.type !== "classification") { result.skipped.push({ id, reason: "review-only" }); continue; }
      try {
        if (!Object.keys(areas).some(area => p.asset.startsWith(`${area}/`)) || p.target !== metadataTarget(p.asset)) throw new Error("Invalid target.");
        const area = p.asset.split("/")[0];
        if (isContentPathPrivate((area === "components" ? "scripts" : area) as PrivacyContentType, p.asset.slice(area.length + 1))) {
          result.skipped.push({ id, reason: "privacy-changed-since-preview" }); continue;
        }
        const asset = checked(root, p.asset), target = checked(root, p.target);
        if (digest(asset) !== p.hash || digest(target) !== p.targetHash) { result.skipped.push({ id, reason: "changed-since-preview" }); continue; }
        const previous = p.targetHash === null ? null : fs.readFileSync(target);
        const after = p.target === p.asset ? metadataBytes(fs.readFileSync(asset), p.classification)
          : Buffer.from(JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n");
        const mode = previous ? fs.statSync(target).mode & 0o777 : 0o600;
        journal.entries.push({ id, asset: p.asset, target: p.target, before: previous?.toString("base64") ?? null, beforeHash: p.targetHash, afterHash: hash(after), mode });
        // Write-ahead journal permits recovery even if the process exits during publication.
        saveJournal(root, result.journalId, journal);
        if (digest(asset) !== p.hash || digest(target) !== p.targetHash) { result.skipped.push({ id, reason: "changed-since-preview" }); continue; }
        atomic(target, after, mode);
        result.applied.push(id);
      } catch { result.skipped.push({ id, reason: "unsafe-or-unavailable" }); }
    }
    return result;
  });
}

export function rollbackAssetClassification(storeRoot: string, journalId: string): ClassificationResult {
  if (!/^[a-f0-9-]{36}$/.test(journalId)) throw new Error("Invalid classification journal ID.");
  const root = fs.realpathSync(storeRoot);
  return withCrossProcessLockSync(stateFile(root, "mutation.lock"), "classification rollback", () => {
    const journal: Journal = JSON.parse(fs.readFileSync(stateFile(root, `${journalId}.json`), "utf8"));
    if (journal.schema !== 1 || !Array.isArray(journal.entries)) throw new Error("Invalid classification journal.");
    const result: ClassificationResult = { journalId, applied: [], skipped: [] };
    for (const item of [...journal.entries].reverse()) {
      try {
        if (!Object.keys(areas).some(area => item.asset.startsWith(`${area}/`)) || item.target !== metadataTarget(item.asset)) throw new Error("Invalid rollback target.");
        const target = checked(root, item.target);
        const current = digest(target);
        if (current === item.beforeHash) { result.skipped.push({ id: item.id, reason: "already-restored-or-not-written" }); continue; }
        if (current !== item.afterHash) { result.skipped.push({ id: item.id, reason: "changed-since-apply" }); continue; }
        if (item.before === null) fs.unlinkSync(target);
        else {
          const bytes = Buffer.from(item.before, "base64");
          if (hash(bytes) !== item.beforeHash) throw new Error("Invalid backup.");
          atomic(target, bytes, item.mode);
        }
        result.applied.push(item.id);
      } catch { result.skipped.push({ id: item.id, reason: "unsafe-or-unavailable" }); }
    }
    return result;
  });
}
