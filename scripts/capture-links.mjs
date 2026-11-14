import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageRoot, hash } from "./migration.mjs";

const sourceRoot = resolve(packageRoot, "legacy");
const files = [
  { source: "src/knowledge/link-graph.ts", captured: "src/domain/links.ts" },
  { source: "src/retrieval/retrieval-snapshot.ts", captured: "src/links.ts" },
  { source: "tests/test-link-graph.js", captured: "tests/links.test.mjs" },
];
const records = [];
for (const file of files) {
  const [source, captured] = await Promise.all([
    readFile(resolve(sourceRoot, file.source)),
    readFile(resolve(packageRoot, file.captured)),
  ]);
  records.push({
    ...file,
    sourceSha256: hash(source),
    capturedSha256: hash(captured),
  });
}

await writeFile(resolve(packageRoot, "migration/links-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "The original graph's exact pinned/floating resolution rules and retrieval provider sourceRevision convention are adapted into a bounded next-server snapshot executor. Link definitions and snapshot construction are new adapter code; no legacy extension module is imported at runtime.",
  files: records,
  semantics: [
    "Original sourceRevision selects the trimmed string form of metadata revision, otherwise SHA-256 of provider body; Paper provider body appends conclusions, implementation and assumptions with newlines.",
    "The original retrieval index subsequently wraps that provider revision as <providerRevision>:<sha256(JSON.stringify(indexed document))>; this executor accepts the exact opaque provider token supplied by its Markdown adapter and does not fabricate the index-only suffix.",
    "The original pure graph compares pinned targetRevision and node sourceRevision by exact string equality; floating links use the target in the current snapshot.",
    "Snapshot collection pins are SHA-256 of JSON rows [documentId,path,whole-file SHA-256], sorted by UTF-8 path bytes. A new complete snapshot is required when any collection pin changes.",
    "Notes, Skills, and Papers are the only indexed areas. Script, Project, external URL, alias, and title targets are intentionally unsupported."
  ]
}, null, 2) + "\n");
console.log(`Captured ${records.length} original-to-next-server link provenance records.`);
