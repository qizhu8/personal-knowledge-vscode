import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const wheel = "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl";
const member = "adaptive_skill_retrieval/architecture_retriever.py";
const extract = spawnSync("python", ["-c", `
import ast,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 source=archive.read(sys.argv[2]).decode()
 tree=ast.parse(source)
 names=["_document_text","_sections","_scores","_dot","_normalize"]
 functions={node.name:ast.get_source_segment(source,node) for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names}
 if sorted(functions)!=sorted(names): raise ValueError("Original retrieval function boundary changed")
 methods={}
 for node in ast.walk(tree):
  if isinstance(node,ast.ClassDef) and node.name in ["ArchitectureRetriever","SentenceTransformerArchitectureEncoder"]:
   for method in node.body:
    if isinstance(method,ast.FunctionDef) and method.name in ["_dense","_ordered","search","_encode_sentences"]:
     methods[node.name+"."+method.name]=ast.get_source_segment(source,method)
 print(json.dumps({"memberSource":source,"functions":functions,"methods":methods}))
`, resolve(repository, wheel), member], { encoding: "utf8", maxBuffer: 1024 * 1024 });
if (extract.status !== 0) throw new Error(extract.stderr || "Original wheel capture failed.");
const original = JSON.parse(extract.stdout);
const captured = "src/domain/retrieval-runtime-original.ts";
await writeFile(resolve(root, captured), "// Exact original Python algorithm declarations; data only, exercised by synthetic fixtures.\n"
  + `export const retrievalOriginalFunctions = ${JSON.stringify(original.functions, null, 2)} as const;\n`
  + `export const retrievalOriginalMethods = ${JSON.stringify(original.methods, null, 2)} as const;\n`);
const hash = value => createHash("sha256").update(value).digest("hex");
const paths = [
  captured, "src/domain/retrieval-runtime.ts", "src/retrieval-runtime.ts",
  "src/retrieval-runtime-contracts.ts", "tests/retrieval-runtime.test.mjs",
  "tests/retrieval-runtime-original.test.mjs", "scripts/capture-retrieval-runtime.mjs",
];
const files = await Promise.all(paths.map(async path => ({
  source: `${wheel}!/${member}`, sourceRoot: repository, capturedRoot: root, captured: path,
  sourceSha256: hash(original.memberSource), archiveSha256: hash(await readFile(resolve(repository, wheel))),
  capturedSha256: hash(await readFile(resolve(root, path))),
})));
const sourceEvidence = await Promise.all([
  "src/retrieval/retrieval-worker.ts", "src/retrieval/retrieval-provider.ts",
  "resources/retrieval_worker.py", "resources/retrieval_serving.py", "resources/retrieval_solution_index.py",
].map(async source => ({ sourceRoot: repository, source, sourceSha256: hash(await readFile(resolve(repository, source))) })));
await writeFile(resolve(root, "migration/retrieval-runtime-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1",
  algorithm: "dense-section",
  notes: [
    "Original vendored ArchitectureRetriever _sections, normalized encoder output, dense max-pooling, _ordered ID ties and SearchHit reciprocal-rank scores. Original retrieval-worker public limit defaults to 5 (bound 100). Cosine evidence uses scale-safe normalization of explicitly injected vectors.",
    "Exact original function/method texts are captured as inert data. Original _sections/_normalize/_dot/_scores/_dense/_ordered/search execute with synthetic data only, including Unicode whitespace section boundaries.",
    "Only dense-section is supported. PCA, hierarchical candidate filters, BM25/RRF, cross-encoder, token late interaction, graph expansion, model download and old filesystem caches are not silently approximated.",
    "Existing shared DatabaseSync only; explicit authoritative source reader and authorization callbacks. No database opened, network, host environment, private root scan, model fallback or learning update.",
    "Bounded staged checkpoints persist vectors and digests, qualify and activate via shared DB transaction and active-pointer CAS. Query rechecks whole source membership/pins and actor admission after async embedding.",
  ],
  sourceEvidence, files,
}, null, 2) + "\n");
