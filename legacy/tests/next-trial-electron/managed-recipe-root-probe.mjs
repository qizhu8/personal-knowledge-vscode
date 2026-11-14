import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, root, fixture] = process.argv.slice(2);
const require = createRequire(import.meta.url);
try {
  const { inspectLinuxLegacyWriterQuiescence } = await import(pathToFileURL(join(dist, "linux-legacy-writer-quiescence.js")));
  console.log(JSON.stringify({ phase: "quiescence", result: await inspectLinuxLegacyWriterQuiescence(root) }));
  const { prepareLegacyRootAdoptionExperimental, rollbackPreparedLegacyRootAdoptionExperimental } =
    await import(pathToFileURL(join(dist, "legacy-root-adoption.js")));
  const nonce = readFileSync(join(fixture, "in-place-fixture-token"), "utf8");
  const options = require("./in-place-options.cjs").options({ fixture, root, nonce });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options);
  console.log(JSON.stringify({ phase: "prepared-only", result: prepared }));
  const rollback = await rollbackPreparedLegacyRootAdoptionExperimental(root, options);
  console.log(JSON.stringify({ phase: "prepared-only-rollback", result: rollback, postcommitRollbackQualified: false }));
} catch (error) {
  console.error(JSON.stringify({ phase: "refused-or-unavailable", code: error?.code ?? null, message: String(error?.message ?? error) }));
  process.exitCode = 2;
}
