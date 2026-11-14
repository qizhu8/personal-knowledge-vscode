import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../legacy");
const source = readFileSync(resolve(root, "resources/knowledge_snapshots.py"));
const sha256 = createHash("sha256").update(source).digest("hex");
if (sha256 !== "406527c1886d1228d690d67586cf68e70b58ce7fb7b948b60f6e0ac6ca577fd8") throw new Error("Original Knowledge snapshot source changed.");
const target = resolve(root, "next-server/compat/legacy-knowledge-snapshots-captured.py");
if (process.argv.includes("--check")) {
  if (!readFileSync(target).equals(source)) throw new Error("Original Knowledge snapshot capture drift.");
} else writeFileSync(target, source);
console.log("Knowledge snapshots: exact original source SHA256 " + sha256);
