import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const capturePath = resolve(root, "src/domain/retrieval-learning-original.ts");
const provenancePath = resolve(root, "migration/retrieval-learning-provenance.json");
const sources = [
  {
    key: "algorithm",
    path: "resources/retrieval_solutions.py",
    extract(source) {
      const start = source.indexOf("class RetrievalLearning:\n");
      const end = source.indexOf("\n\nclass SolutionManager:", start);
      if (start < 0 || end < 0) throw new Error("Cannot locate the original RetrievalLearning class boundaries.");
      return source.slice(start, end);
    },
    purpose: "Original bounded ranker/calibrator, replay, feedback and acceptance formulas.",
  },
  {
    key: "adapter",
    path: "src/chat/chat-retrieval-learning.ts",
    extract(source) { return source; },
    purpose: "Original retrieval candidate priority and user/model feedback-selection adapter.",
  },
  {
    key: "tests",
    path: "tests/test-retrieval-learning.py",
    extract(source) { return source; },
    purpose: "Original exact fixtures, ranking improvement, cutoff thresholds, privacy and precedence tests.",
  },
];

const hash = value => createHash("sha256").update(value).digest("hex");
const contents = await Promise.all(sources.map(async source => {
  const bytes = await readFile(resolve(repository, source.path));
  return {
    ...source,
    sourceSha256: hash(bytes),
    text: source.extract(bytes.toString("utf8")),
  };
}));
const capture = [
  "export const retrievalLearningOriginalSources = Object.freeze({",
  ...contents.map(source => `  ${source.key}: ${JSON.stringify(source.text)},`),
  "});",
  "",
].join("\n");
const captureBytes = Buffer.from(capture);
const provenance = {
  schema: "pkm.domain-capture/v1",
  files: contents.map(source => ({
    source: source.path,
    captured: "src/domain/retrieval-learning-original.ts",
    sourceSha256: source.sourceSha256,
    capturedSha256: hash(captureBytes),
    sourceExcerptSha256: hash(source.text),
    purpose: source.purpose,
  })),
  transformation: "Repeatably captures the original Python learner, TypeScript chat judgment adapter and Python behavior suite as exact UTF-8 string evidence. The deterministic TypeScript replay port retains the original hashed feature map, sigmoid calibrator, bounded gradient updates, query-level user precedence, EWMA threshold and safe-streak acceptance gate.",
  qualification: "Local deterministic embedding score reranking only. It accepts explicit source/index/model pins from the shared next-server RetrievalRuntime, never embeds or updates embeddings, never invokes a model/network, stores no raw query/source IDs/text, and requires injected native authorization before configuration or feedback training. Candidate/receipt/model replay and version history are bounded to 512; this is not a public HTTP handler.",
};
const provenanceText = JSON.stringify(provenance, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const [existingCapture, existingProvenance] = await Promise.all([
    readFile(capturePath, "utf8").catch(() => undefined),
    readFile(provenancePath, "utf8").catch(() => undefined),
  ]);
  if (existingCapture !== capture || existingProvenance !== provenanceText) {
    console.error("Retrieval-learning capture is stale; run the capture script before qualification.");
    process.exitCode = 1;
  } else console.log("Retrieval-learning source capture is current.");
} else {
  await Promise.all([writeFile(capturePath, capture), writeFile(provenancePath, provenanceText)]);
  console.log("Captured original retrieval-learning sources and SHA-256 provenance.");
}
