import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(script), "../legacy");
const nextServerRoot = resolve(dirname(script), "..");
const output = resolve(repositoryRoot, "../migration/legacy-import-provenance.json");
const pairs = [
  ["src/knowledge/note-work-items.ts", "src/domain/note-work-items.ts"],
  ["src/knowledge/knowledge-contracts.ts", "src/domain/knowledge-contracts.ts"],
];
const digest = value => createHash("sha256").update(value).digest("hex");
const files = [], issues = [];

for (const [source, captured] of pairs) {
  try {
    const sourceSha256 = digest(await readFile(resolve(repositoryRoot, source)));
    const capturedSha256 = digest(await readFile(resolve(nextServerRoot, captured)));
    if (sourceSha256 === capturedSha256) files.push({ source, captured, sourceSha256, capturedSha256 });
    else issues.push({ source, captured, sourceSha256, capturedSha256, code: "hash-mismatch" });
  } catch {
    issues.push({ source, captured, code: "file-unavailable" });
  }
}

const provenance = {
  schema: "pkm.legacy-import-provenance/v1",
  ready: issues.length === 0 && files.length === pairs.length,
  files,
  issues,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
if (!provenance.ready) {
  console.error("Legacy import source capture is incomplete; the provenance file records the mismatch.");
  process.exitCode = 1;
} else {
  console.log(`Captured ${files.length} byte-identical original/generated source files.`);
}
