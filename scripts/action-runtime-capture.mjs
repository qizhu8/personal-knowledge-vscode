import { resolve } from "node:path";
import { checkCaptureRecords, packageRoot } from "./migration.mjs";
import { ACTION_RUNTIME_ORIGINAL_PROVENANCE as provenance } from "../dist/domain/action-runtime-original.js";

const sourceRoot = resolve(packageRoot, provenance.sourceRoot);
const capturedRoot = resolve(packageRoot, provenance.capturedRoot);
const issues = await checkCaptureRecords(provenance.records, sourceRoot, capturedRoot, { dataset: "runtime-historical-3d" });
if (issues.length) throw new Error(`Action runtime source capture is stale: ${JSON.stringify(issues)}`);
console.log(JSON.stringify({
  schema: provenance.schema,
  sourceRoot,
  capturedRoot,
  records: provenance.records,
}, null, 2));
