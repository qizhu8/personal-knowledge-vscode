import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { qualification, faults, domains, uuid } from "./storage-io-fault-cases.mjs";
import { baselineObservations } from "./storage-io-fault-baseline.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fingerprint() {
  const entries = [];
  async function walk(relative) {
    for (const entry of (await readdir(join(packageRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) entries.push([path, hash(await readFile(join(packageRoot, path)))]);
    }
  }
  for (const directory of ["src", "dist"]) await walk(directory);
  const outputs = new Set(["storage-io-fault-report.mjs", "storage-io-fault-observations.mjs"]);
  const codeTests = (await readdir(join(packageRoot, "tests"))).filter(name => name.endsWith(".mjs") && !outputs.has(name)).map(name => `tests/${name}`);
  const scripts = (await readdir(join(packageRoot, "scripts"))).filter(name => name.endsWith(".mjs")).map(name => `scripts/${name}`);
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", ...codeTests, ...scripts]) {
    entries.push([file, hash(await readFile(join(packageRoot, file)))]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return { sha256: hash(JSON.stringify(entries)), files: Object.fromEntries(entries) };
}
async function child(spec) {
  const parent = join(packageRoot, "tests", `.storage-io-fault-${randomUUID()}`);
  let proc, created = false;
  try {
    await mkdir(parent); created = true;
    await mkdir(join(parent, "workspace"));
    await mkdir(join(parent, "workspace", "notes"));
    await writeFile(join(parent, "workspace", ".pkm-next-workspace"),
      JSON.stringify({ schema: "pkm.next-workspace/v2", id: uuid(99) }));
    await writeFile(join(parent, "control.json"), JSON.stringify({ enabled: false }));
    await writeFile(join(parent, "trace.jsonl"), "");
    // Do not inherit user preload flags, host tokens, storage locations or daemon configuration.
    proc = spawn(process.execPath, ["--import", join(packageRoot, "dist/storage-io-fault-probe.js"),
      join(packageRoot, "tests/storage-io-fault-child.mjs"), JSON.stringify(spec)], {
      cwd: packageRoot, env: { PATH: process.env.PATH, HOME: parent, TMPDIR: parent, TMP: parent, TEMP: parent,
        PKM_STORAGE_IO_FAULT_FIXTURE: parent }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", overflow = false;
    proc.stdout.on("data", data => { stdout += data; if (stdout.length > qualification.bounds.outputBytes) { overflow = true; proc.kill("SIGKILL"); } });
    proc.stderr.on("data", data => { stderr += data; if (stderr.length > qualification.bounds.outputBytes) { overflow = true; proc.kill("SIGKILL"); } });
    const outcome = await new Promise((accept, reject) => {
      const timeout = setTimeout(() => { proc.kill("SIGKILL"); }, qualification.bounds.childTimeoutMs);
      proc.once("error", error => { clearTimeout(timeout); reject(error); });
      proc.once("close", (code, signal) => { clearTimeout(timeout); accept({ code, signal }); });
    });
    assert(!overflow, "bounded child output exceeded");
    assert.equal(outcome.signal, null, stderr);
    assert.equal(outcome.code, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await new Promise(accept => proc.once("close", accept));
    }
    if (created) await rm(parent, { recursive: true, force: true });
  }
}

test("Batch12 actual native filesystem boundary errors and restart qualification", { timeout: 600000 }, async () => {
  if (process.env.PKM_STORAGE_IO_FAULT_SAVE === "1") assert.equal(process.env.PKM_STORAGE_IO_FAULT_REPEAT, "1", "Frozen evidence requires repeated execution.");
  const sources = await fingerprint(), reports = [], measurements = [];
  const specs = domains.flatMap((domain, index) => [
    ...faults.map((fault, n) => ({ domain, fault, tamper: false, transport: (index + n) % 2 ? "mcp" : "http" })),
    { domain, fault: faults[3], tamper: true, transport: index % 2 ? "mcp" : "http" },
  ]);
  for (const spec of specs) {
    const result = await child(spec);
    reports.push(result.report); measurements.push({ domain: spec.domain, fault: spec.fault.name, tamper: spec.tamper, ...result.measurements });
  }
  const recognizedRecoveries = reports.filter(report => report.recovery.startsWith("recognized-")).length;
  const blockedRecoveries = reports.filter(report => report.recovery.startsWith("blocked-")).length;
  assert.equal(recognizedRecoveries, 24); assert.equal(blockedRecoveries, 0);
  const nativeSourceDigest = hash(JSON.stringify(Object.entries(sources.files).filter(([path]) => path.startsWith("src/") || path.startsWith("dist/"))));
  const report = { ...qualification, runtime: { node: process.version, platform: process.platform, arch: process.arch },
    repeatedExecutionVerified: process.env.PKM_STORAGE_IO_FAULT_REPEAT === "1", baselineObservations,
    baselineNativeSourceMatches: baselineObservations.fullBaseline?.nativeSourceDigest === nativeSourceDigest,
    functionalNativeSourceMatches: baselineObservations.currentFunctionalRegression?.nativeSourceDigest === nativeSourceDigest,
    sources, counts: { cases: specs.length, injectedHits: specs.length,
    recognizedRecoveries, blockedRecoveries, failClosedRecoveries: domains.length,
    dualTransportPostReceiptReplays: recognizedRecoveries * 2 }, outcomes: reports };
  const bytes = JSON.stringify(report);
  // Repeating execution, not merely serialization, is mandatory for reproducibility.
  if (process.env.PKM_STORAGE_IO_FAULT_REPEAT === "1") {
    const repeated = [];
    for (const spec of specs) repeated.push((await child(spec)).report);
    for (let i = 0; i < reports.length; i++) assert.deepEqual(repeated[i], reports[i], `non-repeatable case ${i}`);
    assert.equal(JSON.stringify({ ...report, outcomes: repeated }), bytes);
  }
  assert.deepEqual(await fingerprint(), sources, "source/dist fingerprint changed during qualification");
  if (process.env.PKM_STORAGE_IO_FAULT_SAVE === "1") {
    assert.equal(report.functionalNativeSourceMatches || report.baselineNativeSourceMatches, true,
      "Recorded current baseline/functional regression belongs to a different native source hash.");
    await writeFile(join(packageRoot, "tests/storage-io-fault-report.mjs"),
      "// Frozen qualification output; excluded from its own source fingerprint.\nexport default " + bytes + ";\n");
    await writeFile(join(packageRoot, "tests/storage-io-fault-observations.mjs"),
      "// Variable measurements, kept separate from the byte-repeatable qualification report.\nexport default " + JSON.stringify({
        schema: "pkm.storage-io-fault-observations/v1", sourceSha256: sources.sha256,
        command: qualification.freezeCommand, approvedSlo: false, cases: measurements,
      }) + ";\n");
  }
  console.log("STORAGE_IO_FAULT_QUALIFICATION " + bytes);
  console.log("STORAGE_IO_FAULT_MEASUREMENTS " + JSON.stringify({ approvedSlo: false, cases: measurements }));
});
