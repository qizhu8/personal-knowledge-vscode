import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureStatus, implementationDigest, packageRoot } from "./migration.mjs";

const evidence = resolve(packageRoot, "migration/verification.json");
await rm(evidence, { force: true });
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: "inherit", cwd: packageRoot });
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal) throw new Error(`Verification failed: ${code ?? signal}; no success evidence recorded.`);
}
try {
  const before = await implementationDigest();
  const captures = await captureStatus();
  if (captures.issues.length) throw new Error(`Domain capture is stale: ${JSON.stringify(captures.issues)}. Re-capture the affected original source before qualification.`);
  await run([resolve(packageRoot, "scripts/capture-legacy-retrieval.mjs"), "--check"]);
  await run([resolve(packageRoot, "scripts/capture-knowledge-snapshots.mjs"), "--check"]);
  await run([resolve(packageRoot, "scripts/capture-legacy-action-mcp.mjs"), "--check"]);
  await run([resolve(packageRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  await run([resolve(packageRoot, "node_modules/typescript/bin/tsc"), "-p", "clients/vscode/tsconfig.json"]);
  const tests = (await readdir(resolve(packageRoot, "tests")))
    .filter(name => name.endsWith(".test.mjs") && name !== "client-manager-workflow.test.mjs").sort();
  if (!tests.length) throw new Error("No tests discovered.");
  // Keep Chromium and native fixture workers concurrent without oversubscribing the host.
  await run(["--test-concurrency=4", "--test", ...tests.map(name => resolve(packageRoot, "tests", name))]);
  const clientTests = [
    resolve(packageRoot, "tests", "client-manager-workflow.test.mjs"),
    ...["vscode-client-boundaries.mjs", "vscode-client-integration.mjs"]
      .map(name => resolve(packageRoot, "legacy", "tests", name)),
  ];
  await run(["--experimental-transform-types", "--test", ...clientTests]);
  if (before !== await implementationDigest()) throw new Error("Implementation changed during tests; no success evidence recorded.");
  if ((await captureStatus()).issues.length) throw new Error("Original source/capture changed during tests; no success evidence recorded.");
  await writeFile(evidence, JSON.stringify({
    schema: "pkm.migration-verification/v1", passed: true, digest: before,
    command: "npm test", tests, clientTests, node: process.version, finishedAt: new Date().toISOString(),
  }, null, 2) + "\n");
} finally {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve(packageRoot, "scripts/migration.mjs"), "progress"], { cwd: packageRoot });
  console.log(stdout.split("\n").filter(line => /Full migration acceptance:|Foundation tests:|Legacy inventory:/.test(line)).join("\n"));
}
