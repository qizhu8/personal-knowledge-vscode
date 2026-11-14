import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sourcePath = "src/knowledge/filestore.ts";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const names = ["asArray", "relNoExt", "catOf", "nameOf", "SkillPriority", "skillPriority", "skillFromFile", "skillList"];
function declaration(name) {
  const found = parsed.statements.filter(statement => "name" in statement && statement.name
    && ts.isIdentifier(statement.name) && statement.name.text === name);
  if (found.length !== 1) throw new Error(`Skill capture boundary changed: ${name}`);
  return found[0].getText(parsed);
}
const projection = declaration("skillFromFile")
  .replace("function skillFromFile(f: MdFile): any", "export function projectSkill(f: SkillSource): unknown")
  .replace('const { fm, body } = parseFrontmatter(readFileSync(f.full, "utf-8"));', "const { fm, body } = f;");
if (projection.includes("MdFile") || projection.includes("readFileSync") || !projection.includes("projectSkill")) {
  throw new Error("Skill projection filesystem seam changed.");
}
const content = `import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { SkillRecord } from "../skill-contracts.js";

export interface SkillSource { rel: string; mtime: number; fm: Record<string, unknown>; body: string }

${names.filter(name => !["skillFromFile", "skillList"].includes(name)).map(declaration).join("\n\n")}

${projection}

export function createSkillQueries<T extends SkillRecord>(skills: T[]) {
  function allSkillFiles() { return skills; }
  function skillFromFile(skill: T) { return skill; }

${declaration("skillList").replace(/^export /, "")}

  return { skillList };
}
`;
const captured = "src/domain/skills.ts";
await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
await writeFile(resolve(packageRoot, captured), content);
await writeFile(resolve(packageRoot, "migration/skills-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected original Skill projection/priority and list filtering/sorting bodies. Filesystem projection accepts prevalidated metadata/body/mtime; list is nested over validated records. Search, mutations, name-first filesystem lookup and host routing are excluded. Adapter adds stable addresses/pins and rejects ambiguous names instead of choosing an arbitrary first file.",
  files: [{ source: sourcePath, sourceSha256: hash(source), captured, capturedSha256: hash(content), declarations: names }],
  qualification: "Isolated read/transport tests only; full old filestore mutation/routing/import parity is not claimed.",
}, null, 2) + "\n");
console.log("Captured original Skill read projection, priority and list rules.");
