import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hash, packageRoot } from "./migration.mjs";

const replace = process.argv[2] === "--replace-unverified";
if (process.argv.length !== 2 && !(replace && process.argv.length === 3)) {
  throw new Error("Usage: node scripts/prepare-linux-candidate.mjs [--replace-unverified]");
}
const destination = resolve(packageRoot, "migration/linux-candidate-inputs.json");
if (replace) {
  const existing = JSON.parse(await readFile(destination, "utf8"));
  if (existing.schema !== "pkm.linux-candidate-inputs/v1" || existing.status !== "unverified-input-snapshot") {
    throw new Error("Only an explicitly unverified candidate input snapshot may be replaced.");
  }
}
const historicalManifests = [], files = new Map();
for (const name of (await readdir(resolve(packageRoot, "migration"))).filter(name =>
  name.endsWith("-provenance.json") || name === "native-qualification.json").sort()) {
  const file = `migration/${name}`, bytes = await readFile(resolve(packageRoot, file));
  const metadata = JSON.parse(bytes.toString("utf8"));
  historicalManifests.push({ file, sha256: hash(bytes) });
  const records = [
    ...(metadata.native ?? []).map(row => ({ file: row.file, sha256: row.sha256, role: "native" })),
    ...[...(metadata.implementation ?? []), ...(metadata.reuse ?? [])]
      .map(row => ({ file: row.path, sha256: row.sha256, role: "native" })),
    ...(metadata.capturedFiles ?? []).flatMap(row => [
      { ...row, file: row.path, role: "captured" }, { ...row, file: row.path, role: "native" },
    ]),
    ...(metadata.migrated ?? []).map(row => ({ file: row.path, sha256: row.sha256, role: "native" })),
    ...(metadata.nextServerEvidence ?? []).map(row => ({
      file: row.source, sha256: row.sha256 ?? row.sourceSha256, role: "native",
    })),
    ...(metadata.nativeSeamPins ?? []).map(row => ({
      file: row.path.replace(/^next-server\//, ""), sha256: row.sha256, role: "native",
    })),
    ...(metadata.files ?? []).flatMap(row => ["captured", "native"].map(role => ({
      file: row.captured ?? metadata.capture?.path ?? metadata.captured,
      sha256: row.capturedSha256 ?? metadata.capture?.sha256 ?? metadata.capturedSha256,
      role,
    }))),
    ...(metadata.captures ?? []).map(row => ({
      file: row.destination, sha256: row.captureSha256, role: "captured",
    })),
  ];
  for (const record of records) {
    if (!record.file || !record.sha256) continue;
    if (record.file.startsWith("/") || record.file.includes("\\")
      || record.file.split("/").some(part => part === ".." || part === ".")) {
      throw new Error(`Invalid candidate input path: ${record.file}`);
    }
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`Invalid historical pin in ${file}`);
    if (!files.has(record.file)) files.set(record.file, {
      file: record.file, sha256: hash(await readFile(resolve(packageRoot, record.file))), historical: [],
    });
    const target = files.get(record.file);
    if (!target.historical.some(row => row.sha256 === record.sha256 && row.role === record.role)) {
      target.historical.push({ sha256: record.sha256, role: record.role });
    }
  }
}
const result = {
  schema: "pkm.linux-candidate-inputs/v1",
  scope: "isolated-linux-pkm-v5-candidate-not-production-or-windows",
  status: "unverified-input-snapshot",
  qualification: "These hashes define inputs for a new explicit candidate regression, not a passing receipt. Historical manifests and native qualification remain unchanged. Acceptance requires a successful matching fresh candidate run and isolated installation.",
  historicalManifests,
  files: [...files.values()].sort((a, b) => a.file.localeCompare(b.file)),
};
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: replace ? "w" : "wx" });
console.log(`Prepared ${files.size} candidate inputs; no test, installation or production qualification claimed.`);
