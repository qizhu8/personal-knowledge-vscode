import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { checkNativeRecords } from "./migration.mjs";

const root = resolve(import.meta.dirname, "..");
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !["--check", "--refresh-native"].includes(mode))
  throw new Error("Usage: node scripts/capture-manager-chat.mjs --check|--refresh-native");
if (mode === "--check") {
  const record = JSON.parse(await readFile(resolve(root, "migration/manager-chat-provenance.json"), "utf8"));
  if (record.schema !== "pkm.next.native-composition/v1" || record.captures?.length !== 0
    || !record.implementation?.length || !record.reuse?.length) throw new Error("Malformed native Manager composition provenance.");
  const issues = await checkNativeRecords([...record.implementation, ...record.reuse]
    .map(value => ({ file: value.path, sha256: value.sha256 })));
  if (issues.length) throw new Error(JSON.stringify(issues));
  console.log("Native Manager composition pins checked read-only; no original captures claimed.");
} else {
const sha256 = value => createHash("sha256").update(value).digest("hex");
const files = async paths => Promise.all(paths.map(async path => ({
  path, sha256: sha256(await readFile(resolve(root, path))),
})));
const provenance = {
  schema: "pkm.next.native-composition/v1",
  notes: "New operational composition. No legacy source literals or implementations were copied; captures is deliberately empty. Reuse is through actual existing module interfaces.",
  captures: [],
  implementation: await files(["src/manager-chat.ts", "src/domain/manager-chat-contracts.ts"]),
  reuse: await files(["src/manager-plan.ts", "src/domain/manager-plan-validation.ts", "src/manager-runtime.ts",
    "src/manager-progress.ts", "src/domain/manager-progress.ts",
    "src/chat-turn.ts", "src/chat-turn-store.ts", "src/chat-turn-adapters.ts",
    "src/model-provider.ts", "src/model-config.ts"]),
  exports: ["createManagerChatComposition", "createManagerChatExactComposition", "createManagerChatExactChecks",
    "managerChatPlannerResponseSchema", "managerChatDeliverySchema", "managerChatIntegrationSchema",
    "managerChatVerificationSchema", "managerChatCanonicalPath", "managerChatWithin"],
  fixtures: ["tests/manager-chat-fixtures.mjs", "tests/manager-chat.test.mjs"],
  supportedTaskTypes: ["Native persisted bounded scoped exact-text-artifact generation and same-owner repairs"],
  unsupportedTaskTypes: ["General code edits or migrations", "Filesystem writes", "Command execution",
    "Arbitrary tool calls", "Human approval routing (no tool catalog installed)", "Automatic interrupted effect replay"],
  authority: "Fixed native CompletionContract and exact expected path/content map gate model calls in the safe default builder. Native check evidence binds actor, native owner, workspace, workspace version, run and exact input pin. Model claims/check counts are never certificates.",
  bounds: "Default k=4 active Chat turns, 128 conservatively reserved run turns, 65536 input and 8192 output token/byte upper bounds per turn, 120000ms turn deadline, one safe structured repair. Native Manager independently caps task/workers/attempt quotas.",
  integration: "Explicit standalone CLI manager-text configuration constructs the exact native composition on the shared workspace connection. The public actor-bound artifact read requires the frozen manifest pin. General coding and filesystem workers remain unsupported. Exclusive native startup owns recovery.",
  persistence: "Same SQLite connection persists Chat turns, effect-to-turn prompt pins, accepted evidence, immutable deliveries, whole freeze and integration pins. Existing effect pins only inspect existing handles. Reconciliation is always unknown, never positively authorizes replay.",
  validation: "npm run build; node --test tests/manager-chat.test.mjs tests/manager-plan.test.mjs tests/manager-runtime.test.mjs tests/manager-progress.test.mjs tests/chat-turn-chain.test.mjs",
};
await writeFile(resolve(root, "migration/manager-chat-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log("Recorded actual native module reuse; no fabricated original captures.");
}
