import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "legacy");
const sourcePath = resolve(repoRoot, "src/knowledge/filestore.ts");
const source = await readFile(sourcePath, "utf8");
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const declarations = ["SearchOptions", "searchMatches", "noteSearch", "skillSearch", "paperSearch"];

function capture(name) {
  const startPattern = new RegExp(`^(?:export )?(?:interface|function) ${name}\\b`, "m");
  const match = startPattern.exec(source);
  if (!match) throw new Error(`Original search declaration not found: ${name}`);
  const start = match.index;
  const remainder = source.slice(start + match[0].length);
  const next = /^(?:export )?(?:interface|type|function|const|let|class)\b/m.exec(remainder);
  const end = next ? start + match[0].length + next.index : source.length;
  const text = source.slice(start, end).replace(/\s+$/, "") + "\n";
  const startLine = source.slice(0, start).split("\n").length;
  const endLine = startLine + text.split("\n").length - 2;
  return { name, startLine, endLine, sha256: hash(text), text };
}

const implementationPaths = [
  "src/search-contracts.ts",
  "src/search.ts",
  "src/domain/search.ts",
  "tests/search.test.mjs",
];
const capturedFiles = [];
for (const path of implementationPaths) {
  const text = await readFile(resolve(packageRoot, path), "utf8");
  capturedFiles.push({ path, sha256: hash(text) });
}
const files = capturedFiles.map(file => ({
  source: "src/knowledge/filestore.ts",
  captured: file.path,
  sourceSha256: hash(source),
  capturedSha256: file.sha256,
}));

const provenance = {
  schema: "pkm.knowledge-search-provenance/v1",
  files,
  source: {
    path: "src/knowledge/filestore.ts",
    sha256: hash(source),
    declarations: declarations.map(capture),
  },
  capturedFiles,
  searchableFields: {
    notes: [
      "title", "description", "content", "slug", "category", "type",
      "relative Markdown path", "portable notes/<relative Markdown path>", "tags",
    ],
    skills: ["name", "_key", "description", "content", "category", "source_project", "tags"],
    papers: [
      "slug", "title", "description", "content", "topic", "publisher", "category", "group", "url", "file",
      "year", "authors", "tags", "conclusions", "implementation", "assumptions", "cites[].paper", "cites[].note",
    ],
  },
  ordering: {
    notes: "updated_at descending; stable ties retain the depth-first path order from knowledgeSnapshot",
    skills: "depth-first path order from knowledgeSnapshot",
    papers: "citationCount descending, year descending, title ascending",
  },
  portability: {
    noteAbsolutePath: "Omitted because legacy file.full is host-specific; relative paths remain searchable.",
    regex: "Explicitly rejected; literal query is escaped before matching.",
  },
};

await writeFile(resolve(packageRoot, "migration/search-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
console.log(`Captured ${declarations.length} original declarations and ${capturedFiles.length} implementation files.`);
