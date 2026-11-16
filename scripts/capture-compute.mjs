import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(root, "legacy");
const files = ["__init__.py", "__main__.py", "engine.py", "memory.py"];
const source = "modules/pkm-memory-engine/src/pkm_memory_engine";
const target = "compute/pkm_memory_engine";
const check = process.argv.slice(2);
if (check.length && (check.length !== 1 || check[0] !== "--check")) throw new Error("Usage: capture-compute.mjs [--check]");
const manifest = join(root, "migration/compute-provenance.json");
const { sourceCommit } = JSON.parse(await readFile(manifest, "utf8"));
const records = [];
for (const name of files) {
  const original = await readFile(join(sourceRoot, source, name));
  const sourceBlob = execFileSync("git", ["hash-object", "--stdin"], { cwd: root, input: original, encoding: "utf8" }).trim();
  // Relocation commits are not the original capture's source revision.
  const historicalBlob = execFileSync("git", ["rev-parse", `${sourceCommit}:${source}/${name}`], { cwd: root, encoding: "utf8" }).trim();
  if (sourceBlob !== historicalBlob) throw new Error(`Original compute source differs: ${sourceCommit}:${source}/${name}`);
  const destination = join(root, target, name);
  if (check.length) {
    if (!(await readFile(destination)).equals(original)) throw new Error(`Captured compute differs: ${name}`);
  } else {
    await mkdir(join(root, target), { recursive: true });
    await writeFile(destination, original);
  }
  const captured = await readFile(destination);
  records.push({
    source: `${source}/${name}`, captured: relative(root, destination).replaceAll("\\", "/"),
    bytes: captured.length,
    sourceSha256: createHash("sha256").update(original).digest("hex"),
    capturedSha256: createHash("sha256").update(captured).digest("hex"),
    sourceBlob,
  });
}
const provenance = JSON.stringify({
  schema: "pkm.next.compute-provenance/v1",
  sourceCommit,
  capture: "node next-server/scripts/capture-compute.mjs",
  verification: "node next-server/scripts/capture-compute.mjs --check",
  transformation: "Byte-identical package capture. worker.py supplies a separate restricted stdio entrypoint.",
  runtime: "Python >=3.10 standard library; persistent worker-owned SQLite schema 2. No extension runtime imports.",
  authority: "Runtime computation cache only; Markdown Chat/knowledge is authoritative. Explicit-memory APIs remain Node Markdown-only.",
  files: records,
}, null, 2) + "\n";
if (check.length) {
  if (await readFile(manifest, "utf8") !== provenance) throw new Error("Compute provenance differs; recapture deliberately.");
} else {
  await mkdir(join(root, "migration"), { recursive: true });
  await writeFile(manifest, provenance);
}
console.log(`Compute capture ${check.length ? "verified" : "written"} (${files.length} byte-identical files).`);
