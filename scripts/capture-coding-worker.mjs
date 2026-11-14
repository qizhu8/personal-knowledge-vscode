import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "migration/coding-worker-provenance.json");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const implementation = ["src/coding-worker.ts", "src/coding-worker-workspace.ts", "src/domain/coding-worker-contracts.ts"];
const reuse = [
  "src/manager-runtime.ts", "src/manager-plan.ts", "src/domain/manager-plan-validation.ts",
  "src/chat-turn.ts", "src/chat-turn-store.ts", "src/chat-turn-adapters.ts",
  "src/model-provider.ts", "src/model-config.ts", "src/process-bridge.ts",
  "src/runtime-process.ts", "src/runtime-process-store.ts", "src/tool-gateway.ts",
  "src/domain/tool-gateway-projection.ts",
];
const fixtures = ["tests/coding-worker-fixtures.mjs", "tests/coding-worker.test.mjs"];
const files = async paths => Promise.all(paths.map(async path => ({
  path, sha256: sha256(await readFile(resolve(root, path))),
})));
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !["--check", "--refresh-native"].includes(mode))
  throw new Error("Usage: node scripts/capture-coding-worker.mjs --check|--refresh-native");
if (mode === "--check") {
  const saved = JSON.parse(await readFile(target, "utf8"));
  if (saved.schema !== "pkm.next.native-composition/v1" || saved.captures?.length !== 0
    || JSON.stringify(saved.implementation.map(item => item.path)) !== JSON.stringify(implementation)
    || JSON.stringify(saved.reuse.map(item => item.path)) !== JSON.stringify(reuse)
    || JSON.stringify(saved.fixtures.map(item => item.path)) !== JSON.stringify(fixtures))
    throw new Error("Malformed coding worker actual-reuse provenance.");
  for (const item of [...saved.implementation, ...saved.reuse, ...saved.fixtures])
    if (sha256(await readFile(resolve(root, item.path))) !== item.sha256) throw new Error(`Stale actual native reuse pin: ${item.path}`);
  console.log("Coding worker actual module reuse pins checked; no legacy captures or parity claimed.");
} else {
  const record = {
    schema: "pkm.next.native-composition/v1",
    captures: [],
    notes: "New narrow native coding composition, not copied legacy code. Captures is deliberately empty; only imports actually used by this implementation are claimed as native reuse.",
    implementation: await files(implementation), reuse: await files(reuse), fixtures: await files(fixtures),
    exports: ["createCodingWorkerWorkspace", "createCodingWorkerManagerHost", "recoverCodingWorkerEffects", "codingWorkerHash",
      "codingWorkerProposalSchema", "codingWorkerReadSchema", "codingWorkerListSchema", "codingWorkerPath", "CODING_WORKER_LIMITS"],
    authority: "Host-only opaque disposable workspace capability; fresh source clones only. Host fixes owner, original source hashes, exact readable/writable relative paths, immutable Node check scripts/literal arguments, source data admission, check approval and output redaction. Never writes the original source, KnowledgeRoot, Board, real checkout, Git state, production, or external network. No public catalog or absolute-root/shell capability is installed.",
    integration: "createCodingWorkerManagerHost returns the existing ManagerRuntimeHost and native scopes/receipt/manifest/recover/close hooks. Canonical Manager plan validation and exact contract/task pin gates are reused. Native ChatTurnService uses the existing ModelProviderService SSE adapter and only source.list/source.read ChatTurnToolPort. The existing ToolGateway canonical projection binds pins; the unrestricted Core gateway is intentionally not installed for coding. All writes are native execution of strict structured substring-edit proposals with host scope/before-hash/source-read receipts, not executable model tool calls.",
    execution: "Pinned immutable host Node check scripts run actual stage modules via the existing process-bridge and RuntimeProcessService. A distinct durable host-owned process journal and per-journal serialized checks respect its exclusive singleton lease; no takeover of an existing runtime. Source/task/effect/input pins and full check-script hashes bind acceptance. Changed source/contract invalidates proof. Model self-checks are rejected as extra proposal fields, never certificates.",
    persistence: "Full-synchronous distinct file-backed SQLite journals required. Main DB file effect intents commit before directory/file writes, contain exact before/after contents and hashes, and precede exclusive staging-file+fsync+rename+directory-fsync effects. Multi-file atomicity is logical/failclosed, NOT a filesystem transaction: mixed crash outcomes are unknown and fenced. Recovery observes exact before/after/mixed/other without modifying files, replaying patches, or inferring authorization. Interrupted inference/checks stay unknown; completed old proofs cannot be installed in a newly-issued capability.",
    concurrency: "Fresh per-attempt stages isolate parallel workers. Frozen delivery manifests require accepted native proof and complete worker coverage. Only valid disjoint changes merge into the fresh Integrator clone; duplicate paths, changed before hashes and stale inputs escalate without overwrite. Feedback remains task-scoped data; cancellation fences authority and close drains every tracked native model/check effect.",
    bounds: "Native defaults cap files128, file bytes32768, all source bytes131072, patches16, reserved turns64, active workers4, input65536/output8192 per turn, run input4194304/output524288, deadline120000ms. Host can only lower bounds; no command/network/model-created permissions. Native checks retain original process bounds, raw stdout is ephemeral, stderr persistence is zero, and host-redacted structured check results alone become acceptance evidence.",
    validation: "npm run build; node --test tests/coding-worker.test.mjs tests/manager-runtime.test.mjs tests/manager-plan.test.mjs tests/chat-turn-chain.test.mjs tests/process-bridge.test.mjs; node scripts/capture-coding-worker.mjs --check",
    scenarios: [
      "Native fragmented SSE -> real source read -> structured patch -> actual Node numeric assertions -> delivery -> two-file frozen merge -> actual composed-module E2E; one task fails and repairs.",
      "Parallel independent stages, stable task owner/hash, fenced wrong actor, scope traversal/absolute/check script/hash/ambiguous/shell/self-check attacks.",
      "Changed stage or immutable check invalidates acceptance; changed Integrator beforehash conflicts without overwrite; changed contract or source invalidates final proof.",
      "Journal crash before/after files and mixed Integrator write; exact recovery observations remain unknown with no automatic patch or rollback.",
      "Conservative durable run budget and k bounds, targeted urgent feedback, run cancellation, native timeout/drain, distinct restart capability refusing stale proofs.",
      "Root/path/ancestor symlinks, hardlinks, original source hash pins, source admission and check policy denial.",
    ],
    qualification: "These are disposable synthetic functional E2E evidence through actual native protocols and real files, NOT installed native-model endpoint parity, production isolation certification, OS sandbox enforcement, full Manager/Portal meeting lifecycle, measured power-loss durability, resource soak, signed operator readiness, or production cutover authorization. This slice is not automatically added to public server/CLI/client configuration; the trusted parent must explicitly assemble it with approved capabilities.",
  };
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log("Recorded coding worker actual module reuse and synthetic real-source E2E scope; no fabricated legacy captures.");
}
