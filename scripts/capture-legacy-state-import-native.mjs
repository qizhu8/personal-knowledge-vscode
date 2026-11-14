import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageRoot } from "./migration.mjs";

const mode = process.argv[2];
if (!["--check", "--refresh-native"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/capture-legacy-state-import-native.mjs --check|--refresh-native");
}

const provenancePath = resolve(packageRoot, "migration/legacy-state-import-provenance.json");
const repositoryRoot = resolve(packageRoot, "legacy");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
if (provenance.schema !== "pkm.legacy-state-import-provenance/v1"
  || !Array.isArray(provenance.originalSources) || !Array.isArray(provenance.nativeSeamPins)
  || provenance.nativeSeamPins.length === 0) {
  throw new Error("Legacy state-import provenance is malformed.");
}

for (const source of provenance.originalSources) {
  if (typeof source.path !== "string" || source.path.startsWith("/")
    || source.path.split(/[\\/]/).includes("..") || typeof source.sha256 !== "string") {
    throw new Error("Legacy state-import original-source references are malformed.");
  }
  const actual = digest(await readFile(resolve(repositoryRoot, source.path)));
  if (actual !== source.sha256) throw new Error(`Original source changed: ${source.path}`);
}

for (const pin of provenance.nativeSeamPins) {
  if (typeof pin.path !== "string" || !pin.path.startsWith("next-server/")
    || pin.path.includes("\\") || pin.path.split("/").includes("..")
    || typeof pin.sha256 !== "string") {
    throw new Error("Legacy state-import native seam pins are malformed.");
  }
  const file = resolve(repositoryRoot, pin.path);
  const actual = digest(await readFile(file));
  if (mode === "--check" && actual !== pin.sha256) {
    throw new Error(`Native seam pin changed: ${pin.path}`);
  }
  if (mode === "--refresh-native") pin.sha256 = actual;
}

if (mode === "--refresh-native") {
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log("Refreshed native state-import seam pins only; original-source references are untouched.");
} else {
  console.log(`Legacy state-import provenance: ${provenance.originalSources.length} original references and ${provenance.nativeSeamPins.length} native seam pins verified.`);
}
