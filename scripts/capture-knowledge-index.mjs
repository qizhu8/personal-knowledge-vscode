import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) {
  throw new Error("Usage: node next-server/scripts/capture-knowledge-index.mjs [--check]");
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Transformed bridge provenance, NOT byte-identical Python recapture. Existing compute capture
// remains independently verified by capture-compute.mjs. A deliberate recapture records reviewed drift.
const mappings = [
  ["modules/pkm-memory-engine/src/pkm_memory_engine/engine.py", "src/domain/knowledge-index.ts"],
  ["modules/pkm-memory-engine/src/pkm_memory_engine/memory.py", "src/domain/knowledge-index.ts"],
  ["src/memory/chat-memory-service.ts", "src/domain/knowledge-index.ts"],
  ["src/retrieval/retrieval-snapshot.ts", "src/domain/knowledge-index.ts"],
  ["next-server/src/domain/knowledge-contracts.ts", "src/domain/knowledge-index.ts"],
  ["next-server/src/knowledge-snapshot.ts", "src/compute/knowledge-index.ts"],
  ["next-server/src/links.ts", "src/compute/knowledge-index.ts"],
  ["next-server/src/compute/contracts.ts", "src/compute/knowledge-index.ts"],
];
const sourceHistory = [{
  source: "next-server/src/compute/chat-memory-worker.ts",
  previousSourceSha256: "1c9023df5d900ad2d7af149c4116cfa7d942bb65439f38f41dc14e4684db9fbf",
  captured: "src/compute/knowledge-index.ts",
  capturedSha256: "5d124574f9923b66ea3f7816f86f4f1fc15dbce97114de51bc8dae878c930e3b",
  supersededIn: "Batch18",
  reason: "This native worker was extended for paired engine backup and restore; the captured hash is an archival Batch18 value, not a claim about the current file. Current bytes are recorded by the active capture and separately pinned as native implementation.",
}];
const { sourceCommit } = JSON.parse(await readFile(join(root, "migration/compute-provenance.json"), "utf8"));
async function sourceBytes(source) {
  // The frozen runtime snapshot contains a later retrieval implementation.
  // This bridge used the original revision still preserved with the compute capture.
  if (source === "src/retrieval/retrieval-snapshot.ts") {
    try {
      return execFileSync("git", ["show", `${sourceCommit}:${source}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      throw new Error(`Required original knowledge-index source unavailable: ${sourceCommit}:${source}; SHA-256 d0963b3f32c6c1e339035a66382bfb06d931ac128f0ccc2bfc3d57c7485b72f1`, { cause });
    }
  }
  return readFile(source.startsWith("next-server/")
    ? join(root, source.slice("next-server/".length))
    : join(root, "legacy", source));
}
const files = await Promise.all(mappings.map(async ([source, captured]) => ({
  source, captured,
  sourceSha256: hash(await sourceBytes(source)),
  capturedSha256: hash(await readFile(join(root, captured))),
})));
const manifest = {
  schema: "pkm.next.knowledge-index-provenance/v1",
  capture: "node next-server/scripts/capture-knowledge-index.mjs",
  verification: "node next-server/scripts/capture-knowledge-index.mjs --check",
  transformation: "Reviewed TypeScript bridge, not byte-identical extraction. Original Chat ingestion supplies scoped immutable source references, 16000-code-point observation chunks and append/CAS/typed-edge semantics. Markdown Note/Skill/Paper adapters did not exist in Chat ingestion: these are generic pieces with explicit native-kind/body/all-metadata projection. Only explicit supported Knowledge links become edges. knowledgeSnapshot and the existing link-revision compiler are reused. Compute source pins strengthen metadata-only revisions with raw/body/projected-field SHA-256. The native ChatMemoryWorker is pinned separately and is not represented as an original source capture.",
  boundary: "Host library only, trusted factory for a new worker in a new staging directory. Existing worker/Python read-only. No model, network, public RPC, live DB replacement, source mutation, incremental replay or production activation.",
  qualification: "Original create/append/link operation receipts are idempotent, but source body replacement/removal/reconciliation has no safe API. This capture qualifies rebuild-only, not durable incremental updates.",
  tests: "npm --prefix next-server run build && node --test next-server/tests/compute-knowledge-index.test.mjs",
  files,
  sourceHistory,
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;
const path = join(root, "migration/knowledge-index-provenance.json");
if (args[0] === "--check") {
  if (await readFile(path, "utf8") !== text) throw new Error("Knowledge index provenance drift; review and deliberately recapture.");
} else {
  await writeFile(path, text);
}
console.log(`Knowledge index transformed capture ${args[0] === "--check" ? "verified" : "recorded"} (${files.length} source/capture hash pairs).`);
