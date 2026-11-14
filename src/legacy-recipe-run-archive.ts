import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "./contracts.js";
import { legacyKnowledgeTree } from "./legacy-knowledge-snapshot.js";
import { inspectLegacyUiBootstrapCompatibility } from "./legacy-ui-bootstrap-compatibility.js";

const runIdPattern = /^recipe_run_[a-f0-9]{24}$/;
function inventory(root: string) {
  let area = "recipe-usage-reads", files = legacyKnowledgeTree(root, area, ".pkm/state/recipe-runs", true);
  if (!files.length && lstatSync(join(root, ".pkm/state/recipe-runs"), { throwIfNoEntry: false })) {
    const proof = inspectLegacyUiBootstrapCompatibility(root);
    if (!proof || proof.project.storeVersion <= 1)
      throw new CoreError("ACCESS_DENIED", "Original Recipe history has no verified immutable source scope.");
    area = ".pkm";
    files = legacyKnowledgeTree(root, area, "state/recipe-runs", true);
  }
  if (files.length > 200 || files.reduce((total, file) => total + file.size, 0) > 4_194_304)
    throw new CoreError("RESOURCE_LIMIT", "Original Recipe history exceeds its read budget.");
  return files.filter(file => !file.directory).map(file => ({ ...file, fullPath: join(root, area, file.path) }));
}
function read(file: ReturnType<typeof inventory>[number]) {
  if (!/^(?:\.pkm\/)?state\/recipe-runs\/recipe_run_[a-f0-9]{24}\.json$/.test(file.path))
    throw new CoreError("INVALID_DOCUMENT", "Unsupported original Recipe history entity.");
  const fd = openSync(file.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const before = fstatSync(fd, { bigint: true });
    const pin = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (!before.isFile() || before.nlink !== 1n || pin(before) !== file.pin || before.size > 4_194_304n)
      throw new CoreError("CONFLICT", "Original Recipe source changed before reading.");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== Number(before.size) || pin(fstatSync(fd, { bigint: true })) !== file.pin
      || pin(lstatSync(file.fullPath, { bigint: true })) !== file.pin)
      throw new CoreError("CONFLICT", "Original Recipe source changed during reading.");
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
  const record = JSON.parse(raw) as Record<string, unknown> | null;
  if (!record || Array.isArray(record) || record.schema !== "pkm.recipe.run/v1" || typeof record.runId !== "string" || !runIdPattern.test(record.runId)
    || !file.path.endsWith(`/${record.runId}.json`) || !["running", "completed", "failed", "cancelled"].includes(String(record.status)))
    throw new CoreError("INVALID_DOCUMENT", "Unsupported original Recipe history state.");
  return { record, raw, sha256: createHash("sha256").update(raw).digest("hex"), pin: file.pin };
}
export function originalRecipeRunSummaries(root: string) {
  return inventory(root).map(file => {
    const { record, sha256, pin } = read(file);
    return { runId: String(record.runId), name: String(record.recipeName), originalState: String(record.status),
      state: record.status === "running" ? "unknown" : String(record.status), sha256, pin,
      execution: "historical-only" as const, replay: "never" as const };
  });
}
export function readOriginalRecipeRun(root: string, runId: string, expectedSha256: string) {
  if (!runIdPattern.test(runId) || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new CoreError("INVALID_ARGUMENT", "An exact original run identity and observed SHA-256 are required.");
  const file = inventory(root).find(file => file.path.endsWith(`/${runId}.json`));
  if (!file) throw new CoreError("NOT_FOUND", "Original Recipe history was not found in this exact source scope.");
  const result = read(file);
  if (result.sha256 !== expectedSha256) throw new CoreError("CONFLICT", "Original Recipe history changed from the observed SHA-256.");
  return { schema: "pkm.recipe.historical-run/v1", runId, sourceSha256: result.sha256, pin: result.pin,
    originalState: String(result.record.status), state: result.record.status === "running" ? "unknown" : String(result.record.status),
    execution: "historical-only", replay: "never", ownership: "unattributed-original-record",
    raw: result.raw, record: result.record };
}
