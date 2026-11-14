import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sourcePath = "src/knowledge/filestore.ts";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const helpers = ["asArray", "relNoExt", "catOf", "nameOf", "Cite", "normalizeCites", "toYear", "paperFromFile"];
const queries = ["buildPaperResolver", "citationCounts", "paperList", "paperFacets", "paperGraph", "paperGroups"];
function declaration(name) {
  const found = parsed.statements.filter(statement => "name" in statement && statement.name
    && ts.isIdentifier(statement.name) && statement.name.text === name);
  if (found.length !== 1) throw new Error(`Research declaration boundary changed: ${name}`);
  return found[0].getText(parsed);
}
const originalProjection = declaration("paperFromFile");
const projection = originalProjection
  .replace("function paperFromFile(f: MdFile): any", "export function projectPaper(f: PaperSource): unknown")
  .replace('const { fm, body } = parseFrontmatter(readFileSync(f.full, "utf-8"));', "const { fm, body } = f;");
if (projection === originalProjection || projection.includes("readFileSync") || projection.includes("MdFile")) {
  throw new Error("Research projection dependency seam changed.");
}
const content = `import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { PaperRecord } from "../research-contracts.js";

export interface PaperSource { rel: string; mtime: number; fm: Record<string, unknown>; body: string }

${helpers.filter(name => name !== "paperFromFile").map(declaration).join("\n\n")}

${projection}

export function createPaperQueries(papers: PaperRecord[]) {
  function allPaperFiles() { return papers; }
  function paperFromFile(paper: PaperRecord) { return paper; }

${queries.map(name => declaration(name).replace(/^export /, "")).join("\n\n")}

  return { paperList, paperFacets, paperGraph, paperGroups };
}
`;
const captured = "src/domain/research.ts";
await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
await writeFile(resolve(packageRoot, captured), content);
await writeFile(resolve(packageRoot, "migration/research-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected original Paper projection, citation resolver/counts, list, graph, facets and groups. Projection accepts prevalidated Markdown metadata/body/mtime instead of reading legacy files. Query bodies unchanged; exports nested in a factory over validated Paper records. No legacy filesystem, mutation, search or host adapter captured.",
  files: [{ source: sourcePath, sourceSha256: hash(source), captured, capturedSha256: hash(content), declarations: [...helpers, ...queries] }],
  qualification: "Isolated regression/transport tests qualify this adapter; no original full filestore integration suite or complete research lifecycle parity is claimed.",
}, null, 2) + "\n");
console.log("Captured original research read models and query rules with explicit filesystem seams.");
