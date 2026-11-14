import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../legacy/", import.meta.url));
const files = ["__init__.py", "__main__.py", "engine.py", "memory.py"];
const source = "modules/pkm-memory-engine/src/pkm_memory_engine";
const target = "next-server/compute/pkm_memory_engine";
const check = process.argv.slice(2);
if (check.length && (check.length !== 1 || check[0] !== "--check")) throw new Error("Usage: capture-compute.mjs [--check]");
const records = [];
for (const name of files) {
  const original = await readFile(join(root, source, name));
  const destination = join(root, target, name);
  if (check.length) {
    if (!(await readFile(destination)).equals(original)) throw new Error(`Captured compute differs: ${name}`);
  } else {
    await mkdir(join(root, target), { recursive: true });
    await writeFile(destination, original);
  }
  const captured = await readFile(destination);
  records.push({
    source: `${source}/${name}`, captured: relative(join(root, "next-server"), destination).replaceAll("\\", "/"),
    bytes: captured.length,
    sourceSha256: createHash("sha256").update(original).digest("hex"),
    capturedSha256: createHash("sha256").update(captured).digest("hex"),
    sourceBlob: execFileSync("git", ["hash-object", "--stdin"], { cwd: root, input: original, encoding: "utf8" }).trim(),
  });
}
const provenance = JSON.stringify({
  schema: "pkm.next.compute-provenance/v1",
  sourceCommit: execFileSync("git", ["log", "-1", "--format=%H", "--", source], { cwd: root, encoding: "utf8" }).trim(),
  capture: "node next-server/scripts/capture-compute.mjs",
  verification: "node next-server/scripts/capture-compute.mjs --check",
  transformation: "Byte-identical package capture. worker.py supplies a separate restricted stdio entrypoint.",
  runtime: "Python >=3.10 standard library; persistent worker-owned SQLite schema 2. No extension runtime imports.",
  authority: "Runtime computation cache only; Markdown Chat/knowledge is authoritative. Explicit-memory APIs remain Node Markdown-only.",
  files: records,
}, null, 2) + "\n";
const manifest = join(root, "next-server/migration/compute-provenance.json");
if (check.length) {
  if (await readFile(manifest, "utf8") !== provenance) throw new Error("Compute provenance differs; recapture deliberately.");
} else {
  await mkdir(join(root, "next-server/migration"), { recursive: true });
  await writeFile(manifest, provenance);
}
console.log(`Compute capture ${check.length ? "verified" : "written"} (${files.length} byte-identical files).`);
