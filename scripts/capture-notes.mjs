import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sourcePath = "src/knowledge/filestore.ts";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const found = parsed.statements.filter(statement => "name" in statement && statement.name
    && ts.isIdentifier(statement.name) && statement.name.text === name);
  if (found.length !== 1) throw new Error(`Note capture boundary changed: ${name}`);
  return found[0];
}
const fn = declaration("noteFromFile");
if (!ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("Note projection body changed.");
const row = fn.body.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "row"));
if (!row) throw new Error("Note projection row changed.");
const rowText = row.getText(parsed).replace('createHash("sha256").update(readFileSync(boardFile)).digest("hex")', "boardStat.digest");
if (rowText.includes("readFileSync") || !rowText.includes("boardStat.digest")) throw new Error("Note Board digest seam changed.");
const names = ["asArray", "relNoExt", "catOf", "nameOf"];
const content = `import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { NoteRecord } from "../note-contracts.js";

export interface NoteSource {
  rel: string; mtime: number; fm: Record<string, unknown>; body: string;
  board?: { mtimeMs: number; digest: string };
}

${names.map(name => declaration(name).getText(parsed)).join("\n\n")}

export function projectNote(f: NoteSource, includeContent = true): unknown {
  const { fm, body } = f;
  const key = relNoExt(f.rel);
  const boardStat = f.board;
  ${rowText}
  return row;
}

export function createNoteQueries<T extends NoteRecord>(notes: T[]) {
  function allNoteFiles() { return notes; }
  function noteFromFile(note: T, includeContent = true) {
    if (includeContent) return note;
    const { content: _content, ...metadata } = note;
    return metadata;
  }

${declaration("noteList").getText(parsed).replace(/^export /, "")}

  return { noteList };
}
`;
const captured = "src/domain/notes.ts";
await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
await writeFile(resolve(packageRoot, captured), content);
await writeFile(resolve(packageRoot, "migration/notes-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected original Note row and list filter/order bodies. Source projection receives validated Markdown/mtime and optional checked Board digest/mtime, replacing direct filesystem reads and omitting the metadata cache. List nested over validated records. Mutations, search, Board commands/import and host APIs excluded.",
  files: [{ source: sourcePath, sourceSha256: hash(source), captured, capturedSha256: hash(content), declarations: [...names, "noteFromFile", "noteList"] }],
  qualification: "Isolated Note read/classification tests only; original full Note/Board integrations and lifecycle import are not claimed.",
}, null, 2) + "\n");
console.log("Captured original Note read projection, Board classification and list ordering.");
