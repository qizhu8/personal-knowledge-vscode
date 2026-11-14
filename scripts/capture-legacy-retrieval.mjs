import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--capture"].includes(mode))
  throw new Error("Use --check or --capture.");
const source = ts.createSourceFile("retrieval-snapshot.ts",
  await readFile(resolve(root, "legacy/src/retrieval/retrieval-snapshot.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["RetrievalDocument", "RetrievalSnapshot", "RetrievalSnapshotSources", "tags", "uriPath",
  "documentHash", "sourceRevision", "sourceLinks", "canonicalRecipeBody", "researchRetrievalBody", "createRetrievalSnapshot",
  "indexedRetrievalDocument"]);
const nodes = source.statements.filter(node => node.name && names.has(node.name.text));
if (nodes.length !== names.size) throw new Error("Original retrieval snapshot declarations changed.");
const snapshot = `// Generated from original retrieval-snapshot.ts; do not edit.
import { createHash } from "node:crypto";
import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "./domain/knowledge-contracts.js";
type RetrievalContentType = "skill" | "note" | "research" | "script" | "recipe" | "subscription" | "action";
type CachedSubscriptionGroup = any;
type SharedContentType = string;
${nodes.map(node => node.getText(source)).join("\n\n")}
`;
const workerSource = await readFile(resolve(root, "legacy/resources/retrieval_worker.py"), "utf8");
const filestore = ts.createSourceFile("filestore.ts",
  await readFile(resolve(root, "legacy/src/knowledge/filestore.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const projections = new Set(["asArray", "skillPriority", "normalizeCites", "toYear"]);
const projectionNodes = filestore.statements.filter(node => node.name && projections.has(node.name.text));
if (projectionNodes.length !== projections.size) throw new Error("Original source normalizers changed.");
const projection = `// Generated original source normalizers; do not edit.
type Cite = { paper: string; note: string };
type SkillPriority = "normal" | "high" | "highest";
${projectionNodes.map(node => `export ${node.getText(filestore)}`).join("\n\n")}
`;
const worker = spawnSync("python3", ["-c", `
import ast,sys
source=sys.stdin.read()
names={"source_content_type","matches_content_types","make_document","build_snapshot_unlocked",
       "get_source","lexical_match_evidence","dual_path_hits","search_unmeasured","apply_delta","status","update_work"}
nodes=[node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name in names]
if len(nodes)!=len(names): raise ValueError("Original retrieval worker declarations changed")
print("# Generated original worker functions; no server or source-database initialization.\\n"
      + "\\n\\n".join(ast.get_source_segment(source,node) for node in nodes))
`], { input: workerSource, encoding: "utf8" });
if (worker.status !== 0) throw new Error(worker.stderr);
const learning = spawnSync("python3", ["-c", `
import ast,sys
source=sys.stdin.read()
node,=[node for node in ast.parse(source).body if isinstance(node,ast.ClassDef) and node.name=="RetrievalLearning"]
print("# Generated exact original learner; native adapter supplies only an in-memory connection.\\n"
      + "import hashlib,json,math,os,re,secrets,sqlite3,threading\\nfrom pathlib import Path\\n"
      + ast.get_source_segment(source,node))
`], { input: await readFile(resolve(root, "legacy/resources/retrieval_solutions.py"), "utf8"), encoding: "utf8" });
if (learning.status !== 0) throw new Error(learning.stderr);
for (const [path, content] of [
  ["src/legacy-retrieval-snapshot-captured.ts", snapshot],
  ["compat/legacy-retrieval-worker-captured.py", worker.stdout],
  ["src/legacy-retrieval-projection-captured.ts", projection],
  ["compat/legacy-retrieval-learning-captured.py", learning.stdout],
]) {
  const target = resolve(root, path);
  if (mode === "--capture") await writeFile(target, content);
  else if (await readFile(target, "utf8") !== content) throw new Error(`Original retrieval capture changed: ${path}`);
}
console.log(`Original retrieval snapshot, eleven worker functions and exact learner ${mode}.`);
