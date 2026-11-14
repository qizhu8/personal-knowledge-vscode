import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkNativeRecords, hash, packageRoot } from "./migration.mjs";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !["--check", "--refresh-native"].includes(mode)) {
  throw new Error("Usage: node scripts/capture-native-qualification.mjs --check|--refresh-native");
}
const path = resolve(packageRoot, "migration/native-qualification.json");
const migrationRoot = resolve(packageRoot, "migration");
async function nativeCompositionFiles() {
  return (await readdir(migrationRoot)).filter(file => file.endsWith("-provenance.json")).sort();
}
async function checkNativeCompositionPins() {
  const issues = [];
  for (const name of await nativeCompositionFiles()) {
    const metadata = JSON.parse(await readFile(resolve(migrationRoot, name), "utf8"));
    if (metadata.schema !== "pkm.next.native-composition/v1") continue;
    if (!Array.isArray(metadata.implementation) || metadata.implementation.length === 0
      || !Array.isArray(metadata.reuse) || metadata.reuse.length === 0) {
      throw new Error(`Malformed native-composition provenance: ${name}`);
    }
    issues.push(...await checkNativeRecords([...metadata.implementation, ...metadata.reuse].map(pin => ({
      file: pin.path, sha256: pin.sha256,
    }))));
  }
  return issues;
}
async function refreshNativeCompositionPins() {
  let refreshed = 0;
  for (const name of await nativeCompositionFiles()) {
    const provenancePath = resolve(migrationRoot, name);
    const before = await readFile(provenancePath, "utf8");
    const metadata = JSON.parse(before);
    if (metadata.schema !== "pkm.next.native-composition/v1") continue;
    if (!Array.isArray(metadata.implementation) || metadata.implementation.length === 0
      || !Array.isArray(metadata.reuse) || metadata.reuse.length === 0) {
      throw new Error(`Malformed native-composition provenance: ${name}`);
    }
    for (const pin of [...metadata.implementation, ...metadata.reuse]) {
      if (typeof pin.path !== "string" || pin.path.startsWith("/")
        || pin.path.includes("\\") || pin.path.split("/").some(part => part === "." || part === "..")
        || typeof pin.sha256 !== "string") {
        throw new Error(`Malformed native-composition pin in ${name}`);
      }
      pin.sha256 = hash(await readFile(resolve(packageRoot, pin.path)));
    }
    const after = `${JSON.stringify(metadata, null, 2)}\n`;
    if (after !== before) {
      await writeFile(provenancePath, after);
      refreshed++;
    }
  }
  return refreshed;
}
if (mode === "--check") {
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record.schema !== "pkm.native-qualification/v1" || !Array.isArray(record.native) || !record.native.length) {
    throw new Error("Native qualification is missing exact implementation pins.");
  }
  const issues = await checkNativeRecords(record.native);
  const compositionIssues = await checkNativeCompositionPins();
  if (issues.length || compositionIssues.length) throw new Error(JSON.stringify([...issues, ...compositionIssues]));
  console.log(`Native-only qualification: ${record.native.length} exact pins; no original-source reuse claimed`);
} else {
  const refreshedCompositions = await refreshNativeCompositionPins();
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record.schema !== "pkm.native-qualification/v1" || typeof record.qualification !== "string"
    || typeof record.originalSourceReuse !== "string" || !Array.isArray(record.limitations)) {
    throw new Error("Native pin refresh requires existing reviewed qualification claims.");
  }
  const nativeFiles = new Set([
    ...(Array.isArray(record.native) ? record.native.map(item => item.file) : []),
    "src/native-runtime.ts", "src/core.ts", "src/http.ts", "src/browser-host.ts", "src/storage.ts", "src/storage-worker.ts", "src/contracts.ts",
    "src/cli.ts", "src/legacy-import-cli.ts", "src/standalone-host.ts", "src/host-composition-review.ts", "src/host-composition-manager.ts",
    "src/legacy-note-mcp.ts", "src/legacy-capability-mcp.ts",
    "src/legacy-todo-board-create.ts", "src/legacy-todo-board-create-contracts.ts",
    "src/legacy-knowledge-recovery.ts",
    "src/domain/legacy-mcp-registry.ts", "src/domain/legacy-mcp-memory-contract.ts",
    "compat/legacy-note-inventory.py", "compat/legacy-compact-mcp.py",
    "tests/legacy-note-mcp.test.mjs", "tests/legacy-mcp-chat.test.mjs",
    "tests/legacy-todo-board-create.test.mjs", "tests/legacy-todo-board-create-mcp.test.mjs",
    "tests/legacy-knowledge-recovery.test.mjs",
    "scripts/capture-legacy-mcp-contracts.mjs",
    "src/legacy-mcp-python.ts", "compat/legacy-knowledge-mcp.py", "compat/legacy-knowledge-captured.py",
    "scripts/capture-legacy-knowledge-mcp.mjs", "tests/legacy-knowledge-mcp.test.mjs",
    "src/memory-import.ts", "src/memory-scope-continuity.ts", "src/domain/memory-import-contracts.ts",
    "tests/memory-import.test.mjs",
    "src/legacy-router-config.ts",
    "src/legacy-retrieval-index.ts", "src/legacy-retrieval-subscriptions.ts",
    "src/legacy-retrieval-snapshot-captured.ts", "src/legacy-retrieval-projection-captured.ts",
    "src/legacy-subscription-cache-import.ts",
    "compat/legacy-retrieval-index.py", "compat/legacy-retrieval-worker-captured.py",
    "scripts/capture-legacy-retrieval.mjs",
    "tests/legacy-retrieval-index.test.mjs", "tests/legacy-retrieval-subscriptions.test.mjs",
    "tests/legacy-retrieval-mcp.test.mjs", "tests/legacy-subscription-cache-import.test.mjs",
    "tests/legacy-subscription-identity.test.mjs",
    "src/legacy-skill-maintenance.ts",
    "src/legacy-mcp-python-worker.ts",
    "src/legacy-retrieval-model.ts", "src/legacy-retrieval-learning.ts",
    "src/legacy-retrieval-history-import.ts",
    "src/legacy-retrieval-learning-upgrade.ts",
    "src/legacy-knowledge-recovery.ts", "src/legacy-todo-board-create.ts",
    "src/legacy-action-catalog.ts", "src/legacy-action-mcp.ts", "src/legacy-action-package.ts",
    "src/domain/legacy-action-mcp-original.ts", "src/legacy-knowledge-snapshots.ts",
    "src/legacy-action-artifacts.ts", "src/legacy-knowledge-snapshot-scheduler-state.ts",
    "src/legacy-knowledge-snapshot-scheduler.ts",
    "tests/legacy-action-artifact-snapshot-coexistence.test.mjs",
    "tests/legacy-action-artifacts-mcp.test.mjs", "tests/legacy-action-artifacts.test.mjs",
    "tests/legacy-knowledge-snapshot-scheduler-mcp.test.mjs",
    "tests/legacy-knowledge-snapshot-scheduler.test.mjs", "tests/managed-snapshot-scheduler.test.mjs",
    "compat/legacy-action-package.py", "compat/legacy-knowledge-snapshots.py",
    "compat/legacy-knowledge-snapshots-captured.py",
    "scripts/capture-legacy-action-mcp.mjs", "scripts/capture-knowledge-snapshots.mjs",
    "tests/legacy-action-catalog-fixture.mjs", "tests/legacy-action-catalog.test.mjs",
    "tests/legacy-action-get-mcp.test.mjs", "tests/legacy-action-mcp.test.mjs",
    "tests/legacy-knowledge-snapshots-mcp.test.mjs", "tests/legacy-knowledge-snapshots.test.mjs",
    "src/legacy-todo-board-create-contracts.ts",
    "tests/legacy-todo-board-create.test.mjs", "tests/legacy-todo-board-create-mcp.test.mjs",
    "tests/legacy-knowledge-recovery.test.mjs", "tests/legacy-knowledge-recovery-mcp.test.mjs",
    "tests/legacy-retrieval-learning-upgrade.test.mjs",
    "tests/legacy-retrieval-frozen-fixture.py", "tests/legacy-retrieval-history-fixture.py",
    "tests/legacy-retrieval-history-import.test.mjs", "tests/legacy-retrieval-architecture-oracle.py",
    "compat/legacy-retrieval-model.py", "compat/legacy-retrieval-learning.py",
    "compat/legacy-retrieval-learning-captured.py",
    "tests/legacy-retrieval-model.test.mjs", "tests/legacy-retrieval-learning.test.mjs",
    "tests/legacy-retrieval-model-owner.test.mjs", "tests/legacy-retrieval-learning-oracle.py",
    "tests/legacy-retrieval-tiny-model.py", "tests/legacy-retrieval-no-model-deps.py",
    "tests/legacy-skill-maintenance.test.mjs", "tests/legacy-skill-maintenance-import.test.mjs",
    "tests/legacy-skill-maintenance-mcp.test.mjs", "tests/legacy-skill-maintenance-oracle.mjs",
    "src/legacy-knowledge-snapshot.ts", "src/legacy-knowledge-write.ts",
    "src/legacy-knowledge-trash.ts",
    "tests/legacy-trash-coexistence.test.mjs",
    "src/legacy-mcp-note-policy.ts",
    "tests/legacy-knowledge-move-mcp.test.mjs", "tests/legacy-knowledge-write-mcp.test.mjs",
    "tests/legacy-knowledge-trash-mcp.test.mjs", "tests/legacy-note-write-mcp.test.mjs",
    "tests/legacy-mcp-note-policy.test.mjs", "tests/legacy-mcp-coverage.test.mjs",
    "tests/legacy-knowledge-import-writer.test.mjs", "tests/legacy-note-workitems-schema.test.mjs",
    "compat/legacy-agent-captured.py",
    "scripts/assess-legacy-mcp-coverage.mjs",
    "tests/legacy-native-read-mcp.test.mjs", "tests/legacy-agent-read-mcp.test.mjs",
    "tests/legacy-recipe-read-mcp.test.mjs", "tests/legacy-recipe-run-get-mcp.test.mjs",
    "compat/legacy-recipe-run-read.py", "tests/legacy-router-config-mcp.test.mjs",
    "tests/legacy-managed-fixture.mjs",
    "experimental/managed-migration.mjs", "experimental/managed-migration.d.mts",
    "experimental/managed-launch-client.mjs", "experimental/managed-launch-client.d.mts",
    "experimental/managed-launcher.py", "experimental/python-bootstrap.py", "experimental/python-dependencies.py",
    "clients/vscode-host/managed-migration.ts", "clients/vscode-host/extension.ts",
    "clients/vscode-host/build.mjs", "clients/vscode-host/package.json",
    "clients/vscode-host/migration-electron-test.mjs", "clients/vscode-host/migration-electron-test-runner.cjs",
    "tests/managed-migration.test.mjs", "tests/managed-memory-migration.test.mjs",
    "src/host-composition-subscription-bundle.ts", "src/host-composition-legacy-project-contracts.ts",
    "src/host-composition-legacy-trash.ts", "src/host-composition-legacy-note-workitems.ts",
    "src/human-review.ts", "src/human-review-contracts.ts", "src/domain/human-review-intent.ts",
    "src/host-services.ts", "src/action-runtime.ts", "src/action-runtime-process.ts", "src/workspace-backup.ts",
    "src/manager-chat.ts", "src/domain/manager-chat-contracts.ts",
    "src/host-config.ts", "src/manager-plan.ts", "src/manager-runtime.ts", "src/manager-runtime-contracts.ts",
    "src/manager-progress.ts", "src/domain/manager-progress.ts", "src/migration-runtime.ts", "src/migration-preflight.ts",
    "src/knowledge-mutations.ts", "src/knowledge-mutations-contracts.ts", "src/trash-lifecycle.ts", "src/trash-lifecycle-contracts.ts",
    "src/legacy-control-import.ts", "src/legacy-project-command.ts", "src/legacy-project-command-contracts.ts",
    "src/legacy-import.ts", "src/legacy-library.ts", "src/rename-no-replace.ts", "src/file-mtime.ts", "src/import-parity-project.ts", "src/domain/legacy-import.ts",
    "src/legacy-state-import.ts", "src/host-composition-legacy-state.ts",
    "src/legacy-trash-import.ts", "src/legacy-trash-import-native.ts", "src/legacy-trash-import-backup.ts", "src/trash-remove.ts",
    "src/domain/legacy-trash-import-contracts.ts", "src/domain/legacy-trash-import-original.ts",
    "src/legacy-note-workitems.ts", "src/legacy-note-workitems-contracts.ts",
    "src/legacy-note-workitems-journal.ts", "src/legacy-note-workitems-admission.ts",
    "src/domain/legacy-note-workitems-provenance.json",
    "src/legacy-snapshot-restore.ts", "src/legacy-snapshot-restore-contracts.ts",
    "src/host-composition-legacy-snapshot-restore.ts", "src/domain/legacy-snapshot-restore-source-pins.ts",
    "src/domain/legacy-snapshot-restore-recovery.ts",
    "src/host-composition-legacy-batch15-assets.ts", "src/host-composition-legacy-batch15-contracts.ts",
    "src/host-composition-legacy-batch15-errors.ts", "src/host-composition-legacy-batch15-skill.ts",
    "src/legacy-asset-provider.ts", "src/legacy-skill-lifecycle.ts", "src/legacy-skill-lifecycle-native.ts",
    "src/host-composition-legacy-skill-source.ts", "src/host-composition-legacy-skill-source-contracts.ts",
    "src/legacy-skill-source.ts", "src/legacy-skill-source-native.ts", "src/legacy-skill-source-backup.ts",
    "src/legacy-inline-note-contracts.ts", "src/legacy-inline-note-journal.ts",
    "src/legacy-inline-note-native.ts", "src/host-composition-legacy-inline-note.ts",
    "src/host-composition-legacy-batch16-classification.ts", "src/host-composition-legacy-batch16-contracts.ts",
    "src/host-composition-legacy-batch16-fence.ts", "src/host-composition-legacy-batch16-memory.ts",
    "src/legacy-classification-native.ts", "src/legacy-memory-erasure.ts", "src/legacy-memory-erasure-worker.ts",
    "src/legacy-classification-command.ts", "src/legacy-classification-command-contracts.ts",
    "src/legacy-classification-command-host.ts", "src/legacy-classification-command-backup.ts",
    "src/legacy-memory-engine-backup.ts", "src/legacy-memory-engine-backup-paired.ts",
    "src/legacy-memory-engine-backup-python.ts", "src/compute/chat-memory-worker.ts",
    "src/domain/legacy-inline-note-reducer.ts",
    "src/legacy-project-envelope.ts", "src/domain/legacy-project-envelope-provenance.ts",
    "src/legacy-read-race.ts",
    "src/legacy-project-thread-parity.ts", "src/project-mutations.ts", "src/project-mutations-contracts.ts",
    "src/project-recipes.ts", "src/project-recipes-contracts.ts", "src/domain/project-recipes.ts",
    "src/legacy-command-extension-journal.ts", "src/legacy-command-extension-recovery.ts",
    "src/legacy-command-extension-runtime.ts", "src/legacy-command-extension-seam.ts",
    "src/host-composition-legacy-commands.ts", "src/host-composition-portal.ts",
    "src/portal-lifecycle.ts", "src/portal-lifecycle-contracts.ts", "src/domain/channel-runtime-model.ts",
    "src/mcp.ts",
    "src/remote-runtime.ts", "src/remote-runtime-subscription.ts", "src/remote-runtime-subscription-bundle-contracts.ts",
    "src/legacy-subscription-identity.ts", "src/subscription-reads-contracts.ts",
    "src/sync-plan.ts", "src/sync-apply.ts", "src/sync-apply-contracts.ts",
    "browser/index.html", "browser/bootstrap.mjs", "browser/host-config.mjs", "browser/protocol.mjs", "browser/workspace.mjs", "browser/workspace.css", "browser/integration.mjs",
    "tests/batch06-manager-fixtures.mjs", "tests/batch06-manager-integration.test.mjs", "tests/batch06-manager-mcp-child.mjs",
    "tests/batch06-data-integration.test.mjs", "tests/batch06-process-integration.test.mjs",
    "tests/batch06-browser.test.mjs", "tests/batch06-browser-qualification.py",
    "browser/human-review.mjs", "browser/human-review.css",
    "clients/vscode/client.ts", "clients/vscode/contracts.ts", "clients/vscode/bridge.ts", "clients/vscode/activity.ts", "clients/vscode/index.ts",
    "clients/vscode/workflow-surfaces.ts",
    "tests/batch07-cli-fixtures.mjs", "tests/batch07-cli.test.mjs", "tests/legacy-import-cli.test.mjs",
    "tests/batch07-human-browser.test.mjs", "tests/batch07-human-browser.py",
    "tests/batch07-manager-cli.test.mjs", "tests/batch07-native-services.test.mjs",
    "clients/vscode/knowledge-lifecycle.ts",
    "tests/batch09-native-bundles.test.mjs", "tests/batch09-native-bundles-mcp-child.mjs",
    "tests/batch09-native-controls.test.mjs", "tests/batch09-original-control-import.test.mjs",
    "tests/batch09-original-control-fixtures.mjs", "tests/import-parity-project.test.mjs",
    "tests/batch09-client-browser.test.mjs", "tests/batch09-client-browser.py",
    "tests/batch09-client-vscode.test.mjs",
    "tests/host-composition-legacy-state.test.mjs", "tests/batch10-native-portal.test.mjs",
    "tests/batch10-native-commands.test.mjs", "tests/legacy-state-import.test.mjs",
    "tests/legacy-subscription-identity.test.mjs", "tests/legacy-subscription-identity-child.mjs",
    "tests/legacy-subscription-identity-fixture.mjs", "tests/subscription-reads.test.mjs",
    "tests/legacy-command-extension-journal.test.mjs", "tests/legacy-command-extension-recovery.test.mjs",
    "tests/portal-lifecycle.test.mjs", "tests/channel-runtime.test.mjs", "tests/server.test.mjs",
    "tests/legacy-import.test.mjs", "tests/legacy-library-import.test.mjs", "tests/rename-no-replace.test.mjs", "tests/import-parity.test.mjs", "tests/native-runtime-integration.test.mjs",
    "tests/batch09-native-controls.test.mjs", "tests/workspace-backup.test.mjs", "tests/project-mutations.test.mjs",
    "tests/batch11-native-trash-import.test.mjs", "tests/legacy-trash-import-native.test.mjs", "tests/trash-remove.test.mjs",
    "tests/legacy-project-thread-parity.test.mjs", "tests/trash-lifecycle.test.mjs",
    "src/host-composition-legacy-recipe-trash.ts", "src/legacy-recipe-trash.ts", "src/legacy-recipe-trash-contracts.ts",
    "tests/host-composition-legacy-recipe-trash.test.mjs", "tests/project-create-recovery.test.mjs",
    "tests/legacy-recipe-trash.test.mjs", "tests/legacy-regression-batch12.test.mjs",
    "tests/legacy-regression-batch12.report.json",
    "tests/legacy-note-workitems-bridge.test.mjs", "tests/legacy-note-workitems-journal.test.mjs",
    "tests/legacy-note-workitems-runtime.test.mjs",
    "tests/legacy-snapshot-restore-captures.mjs", "tests/legacy-inline-note-captures.mjs",
    "tests/legacy-snapshot-restore.test.mjs", "tests/legacy-inline-note-original.test.mjs",
    "tests/legacy-inline-note-journal.test.mjs", "tests/legacy-inline-note-backup.test.mjs",
    "tests/legacy-inline-note-policy.test.mjs",
    "tests/host-composition-legacy-batch15-captures.mjs",
    "tests/host-composition-legacy-batch16-classification.test.mjs",
    "tests/host-composition-legacy-batch16-memory.test.mjs",
    "tests/host-composition-legacy-batch16-backup-fence.test.mjs",
    "tests/host-composition-legacy-batch16-restore-fixture.mjs",
    "tests/legacy-classification-native.test.mjs", "tests/legacy-classification-safety.test.mjs",
    "tests/legacy-memory-erasure.test.mjs", "tests/legacy-memory-erasure-worker.test.mjs",
    "tests/legacy-memory-engine-backup.test.mjs", "tests/legacy-memory-engine-backup-paired.test.mjs",
    "tests/host-composition-legacy-batch15-transport.test.mjs",
    "tests/host-composition-legacy-batch15-backup.test.mjs",
    "tests/legacy-asset-provider.test.mjs", "tests/legacy-skill-lifecycle.test.mjs",
    "tests/legacy-skill-lifecycle-native.test.mjs",
    "tests/legacy-skill-source.test.mjs", "tests/legacy-skill-source-native.test.mjs",
    "tests/host-composition-legacy-skill-source-transport.test.mjs",
    "tests/host-composition-legacy-skill-source-backup.test.mjs",
    "tests/host-composition-legacy-shared-captures.mjs",
    "tests/host-composition-legacy-shared-transport.test.mjs",
    "tests/host-composition-legacy-shared-backup.test.mjs",
    "tests/legacy-project-envelope.test.mjs", "tests/legacy-project-envelope-normal-import.test.mjs",
    "tests/sync-privacy-transition.test.mjs", "tests/client-manager-workflow.test.mjs",
    "tests/legacy-read-race.test.mjs", "tests/legacy-read-race-runner.mjs",
    "tests/legacy-read-race-hook.mjs", "tests/legacy-read-race-writer.mjs",
    "tests/legacy-read-race.report.json",
    "src/storage-io-fault-probe.ts", "tests/storage-io-fault-baseline.mjs", "tests/storage-io-fault-cases.mjs",
    "tests/storage-io-fault-child.mjs", "tests/storage-io-fault-observations.mjs",
    "tests/storage-io-fault-report.mjs", "tests/storage-io-fault.test.mjs",
    "tests/knowledge-mutations.test.mjs", "tests/folder-lifecycle.test.mjs",
    "tests/migration-preflight.test.mjs", "tests/migration.test.mjs", "tests/project-recipes.test.mjs",
    "tests/legacy-regression-oracle.test.mjs", "tests/legacy-regression-oracle.report.json",
    "tests/project-mutations-fixtures.mjs", "tests/project-mutations-fixtures.test.mjs",
    "tests/memory.test.mjs", "tests/markdown.test.mjs", "tests/uploads.test.mjs",
    "tests/batch04-integration.test.mjs", "tests/batch06-data-integration.test.mjs",
    "tests/provenance-readonly.test.mjs", "tests/readiness.test.mjs", "tests/legacy-classification-command.test.mjs",
    "scripts/migration.mjs", "scripts/verify.mjs", "scripts/capture-native-qualification.mjs", "scripts/capture-project-recipes.mjs",
    "scripts/capture-channel-runtime.mjs", "scripts/capture-legacy-state-import-native.mjs", "scripts/capture-model-config.mjs",
    "scripts/qualify-legacy-regression-fixedpoint.mjs",
  ]);
  const native = await Promise.all([...nativeFiles].sort().map(async file => ({
    file, sha256: hash(await readFile(resolve(packageRoot, file))),
  })));
  const bytes = JSON.stringify({
    schema: "pkm.native-qualification/v1",
    qualification: "actual-local-cli-socket-sse-native-human-chromium-manager-text-action-process-backup-import-controls-bundle-client-boundaries-batch11-trash-project-thread-state-portal-command-batch12-project-recipe-trash-command-schema18-batch13-note-bridge-raw-project-envelope-core-read-fences-batch14-paused-snapshot-restore-inline-note-actions-batch15-fixture-only-skill-lifecycle-legacy-assets-batch16-fixture-strict-classification-derived-memory-forget-batch17-fixture-native-classification-adoption-schema21-batch18-fixture-paired-memory-engine-backup-restore-schema21-batch19-original-compatible-classification-adoption-schema22-batch20-canonical-skill-source-install-batch21-managed-source-remove-batch22-old-skill-source-bridge-batch23-native-subscription-identity-batch24-isolated-vscode-host-batch25-sync-complete-entity-restore-batch26-manager-client-workflow-schema23-catalog217",
    originalSourceReuse: "None claimed for the new native composition, Manager progress architecture, browser, encrypted state-import seam, Portal lifecycle, command extensions, Note/Board journal adapter, raw Project envelope adoption, read-race guards, paused Snapshot restore composition, inline Note writer, Batch15 Skill/asset composition, Batch20 canonical Skill source installer, Batch21 managed Skill source remover, Batch22 old Skill-source bridge, Batch23 subscription identity secret migration or Batch25 Sync recovery. Original Project/Thread/Recipe/Snapshot/inline-note, Batch15 Skill/asset, Batch19 classification and Batch20–22 Skill writer/source references are independently hash-checked without claiming new captured copies. Native implementations and host composition are separately pinned. Original source/capture pairs are independently checked in existing domain provenance.",
    limitations: [
      "Injected synthetic Manager adapters do not qualify autonomous real providers or production tasks.",
      "Actual configured CLI socket SSE qualifies twenty simultaneous model-only Chat workers with native exact SQLite text manifest acceptance, not generic coding or filesystem workers.",
      "Restart replays only after a trusted host explicitly confirms an interrupted effect never executed; unknown effects stay fenced.",
      "Real Chromium exercises a native safe-DOM modal with one-use operator enrollment and separate short-lived HttpOnly human session; machine bearer HTTP cannot decide even when a native cookie exists.",
      "Actual native Action compiler/dispatcher/process child auth, redacted results, cancellation, receipt replay and quiescent backup/restore are qualified; Action process command policy requires trusted native callbacks and is not a CLI JSON command grant.",
      "The single project.legacy.command@1 capability admits Project archive/create, global/project Recipe create/update and the bounded source-matched Batch11 project-create, thread-create, thread-rename and thread-move commands under explicit host authorization, original-store checks and the shared journal. Authenticated Core HTTP/MCP tests compare original ProjectStore identity/snapshots, exercise no-op receipts/replay, stale-CAS denial, recognized pre-effect and mixed-move recovery, tamper fencing and backup lineage. Historical opaque command IDs replay their current snapshot; project.update remains a separate strict-CAS path. No separate Thread canonical operation exists; other imported mutations remain fail-closed, and this is not complete legacy operation parity.",
      "Batch11 trash import is limited to explicitly authorized quiescent original Notes/Skills/Papers trash with stable identities and exact paired assets/folder subtrees. Ordered opaque deletion history is preserved and projected through an authenticated canonical native receipt; import uses one fresh caller-owned composed stage, exact parent inventory/root identity pins, and no overwrite, in-place merge or permanent delete. Unknown buckets/journals, pending locks/temp state, symlinks, tamper, collisions, outside references, secrets, Board/Memory/System/path-derived identity and unsupported Prompts/Scripts trash fail closed. Missing native layout/policy/source authority denies access. Isolated synthetic original-writer/native-restore, receipt/history, restart/recovery and backup-rebinding tests do not constitute production-data acceptance or full cutover.",
      "Original encrypted Agent Snapshot import is qualified only with an explicitly supplied epoch-bound native key authority and exact outer receipt/source/ownership verification. Original encrypted bytes are preserved; plaintext projections exist only in memory. Subscription state containing a private key is blocked; this does not qualify restore, spawn, persistent plaintext or key storage, or a real Knowledge Root.",
      "Portal qualification composes existing Channel/collaboration state only: trusted public HTTP/MCP read and directed route plus separately authorized native lifecycle operations. Revocation and fresh-admission generation fences are tested; restart does not reconnect. This does not qualify remote transport, command execution, full Portal/Meeting parity or production authority.",
      "The original encrypted subscription-bundle path is qualified only for explicitly injected fork authority with exact wire/ciphertext/plaintext/file receipts and ACL/key-epoch fences. Unsupported archives/content and readonly or production-provider authority are not qualified.",
      "Batch09 browser and typed VS Code tests exercise an isolated host/client bridge and rendered Chromium flows; this does not qualify installed production extension activation or complete legacy client UX.",
      "SIGKILL restart waits the actual thirty-second owner lease; unknown model effects never replay. Immediate restart remains denied.",
      "Backup uses an actual quiescent SQLite snapshot and refuses active Manager/Chat/Action/process work, pending/unknown intents and tampered layouts. Schema v18 and isolated workspace/backup inputs 12–17 are exercised only in migration tests and migrate only on explicit open; no pending native workspace backup, power-loss, production SLO or complete stability acceptance is claimed.",
      "Knowledge trash restore continues to use the existing knowledge.trash.restore v1 operation and actual native receipt; legacy trash import adds no transport operation, does not mint historical move receipts, and does not qualify permanent deletion.",
      "Batch12 adds a separate project.recipe.trash.command@1 native capability with explicit default-deny host authorization, strict opaque original-command validation, actor/workspace/source-control/root binding and one native global receipt. A move/restore uses one fresh caller-owned import stage and one atomic no-replace publish, then preserves original Recipe bytes, categories, IDs and opaque history. Exact global replay survives 258 alternating original/native operations and rolling-256 legacy receipt eviction; unknown/mixed state and unapproved operations remain fenced.",
      "Batch13 schema v17 added the paired Note/Board journal intent; Batch14 schema v18 added paused Snapshot and inline Note journals; Batch15 schema v19 adds Skill intent/receipt/history tables while preserving the prior intents. Original workspace/backup schemas 12 through 18 remain accepted isolated inputs; backups preserve their recorded schema until explicit open migrates them. Project-create recovery validates the exact root pin before effects and recognizes only the authenticated empty-directory pre-effect state; this is bounded fixture qualification, not external-writer or power-loss proof.",
      "Batch13 Note/Board conditional native bridge exposes only legacy.note.workitems.read@1, legacy.note.workitems.notes@1, legacy.note.workitems.command@1 and legacy.note.workitems.upsert@1 through Core HTTP/MCP. Note Markdown and Board backing files have no fixed byte ceiling; large payloads may increase latency and memory use. Admission binds the trusted native actor to exact attached-Board bytes and canonical Board authority; every ordinary workspace operation and backup is fenced while the authenticated journal intent is pending. Original worker create/edit/claim/release/comment/transition effects are admitted only when complete normalized Board/audit effects match; mcp:external upsert is limited to exact supported shapes. Full original snapshot receipts bind operation, actor, arguments and operation ID; historical replay, canonical Todo receipts, restart recovery, backup/restore and original-worker parity are exercised. Inline Markdown writes, worker-token grants and non-equivalent command effects remain unavailable.",
      "Batch13 raw Project envelope import supports only schema-1 .pkm/state/projects.json up to 16 MiB; projected files are limited to 2 MiB each and 64 MiB total, 20,000 files and depth 32. Normal import stages exact opaque envelope bytes and canonical projection once, publishes one fresh owned stage atomically without replacement, retains the original ordered receipt prefix and records the native adoption/current-store suffix. Public Project mutation continues through project.legacy.command@1. Current reads, command retries, second close/reopen, backup/restore and tamper rejection are tested; unknown schema/records, mixed controls, pending markers/intents/locks, malformed identities/receipts and unsupported contents fail closed. These are isolated fixtures; source references are not new captured-code claims.",
      "Batch13 selected Core read guards cover knowledge.document.list/get, knowledge.note.search/list and knowledge.asset.list/get through actual Core HTTP/MCP registration. Production-path controlled child writes return explicit conflicts without mixed results; the separate seven-row deterministic helper report includes six helper-wrapped races and one constructed mixed-aggregate denial, not six production-Core wiring claims. Guards compare pre/post identity/revision/digest and are not atomic snapshots or locks; ABA change-and-restore and original cross-process Board CAS remain unsupported.",
      "Batch14 adds native-only agent.snapshot.restore-paused@1, agent.snapshot.resume-native@1, agent.snapshot.cancel-native@1, agent.snapshot.restore-get@1 and agent.snapshot.confirm-native@1. The source-qualified importer preserves ciphertext and original bytes, validates the complete safe state before effects, and creates a paused restore; resume and cancellation require explicit native actor/owner/epoch/expiry fences and human approval. Unknown snapshot state permits only scoped get, cancel or inspect-only native confirmation, never implicit startup replay. Native callback policy defaults unavailable; full original Agent/process/spawn/collaboration/packed-history behavior remains unsupported.",
      "Batch14's original inline Note writer retains the eleven source actions and MCP upsert through Core HTTP/MCP with actor-specific policy, human acceptance/focus/revocation fences, exact Markdown/history receipts and schema-v18 global atomic receipt triggers. Unknown inline intent permits only an explicit identical request retry by the same currently authorized actor; startup never replays it. The inline writer is not a Board conversion and does not expand beyond exact source-qualified effects.",
      "Snapshot restore and inline-writer suites passed 18 tests across the source oracle, transport and backup runners; schema-18 backup restores actual paused BLOBs, inline history and receipts, and prior schemas 12–17 remain input fixtures. These synthetic fixtures do not qualify real-root import, production native key authority, power loss, physical storage faults, an approved SLO, the full 379-file original suite or cutover. No workstream acceptance is implied.",
      "Historical injected storage-I/O qualification exercised 28 cases twice: 24 recognized recoveries, four tamper denials and zero blockers per run, with 48 zero-syscall HTTP/MCP receipt replays per run and 56 injected adapter hits total. Current-fingerprint evidence must be separately checked in the source-bound report; this matrix covers Document, Upload, Resource and Project, not Skill, classification or memory fault recovery. Maximum request/recovery/close times and resource counts are bounded observations only, not approved SLOs; physical power loss and real kernel ENOSPC are not qualified.",
      "The Batch12 source-bound oracle passed 18 cases twice with an identical report, 16 verified mappings, 68 assertions, one explicitly unsupported work item bridge and zero mismatches. It is a distinct tranche from the prior 15-case/109-assertion oracle; counts are not added into a full-suite claim. The original 379-file regression suite remains not run.",
      "Batch15 registers only legacy.skill.router.inject@1 and legacy.skill.router.remove@1 writes plus knowledge.legacy-links.resolve@1 and knowledge.asset.ownership.validate@1 reads. All are strict-schema Core HTTP/MCP operations with native callbacks unavailable by default; Skill mutation and sidecar resolution require an explicitly trusted native-owned disposable fixture and do not grant serialized or bearer authority. The SQLite lease does not prevent hostile external parent replacement. Asset reads are actor-filtered, root-pinned and revision-CAS checked. Skill installs/upgrades, modified projections, routing materialization, remote subscriptions, execution and original classification apply/rollback writing remained unavailable in Batch15. Batch15 original writer/source references are separately hash-checked; no original code capture or general parity is claimed.",
      "Batch16 separately registers knowledge.classification.native-strict.command@1 and memory.scope.forget.native@1 behind default-deny native callbacks. Classification is opt-in disposable-fixture-only and rejects the whole selection, unlike the original ordered skip/UUID result; it is not approved production parity. Forget is logical derived SQLite memory only, not Markdown, history, transcripts or physical erasure. Owned worker drain is not an interprocess lock or hostile-filesystem guarantee. Unknown engine journal state never autostarts or replays.",
      "Batch17 adds fixture-only classified backup restore through a separate trusted native adoption approval before staging and again before publication. Approval binds actor, workspace, source identity, manifest, source epoch, destination parent, stage pins and policy identity; original opaque receipts remain unchanged in an immutable native-adoption ledger, and publication is no-replace with stage identity checks. The strict whole-selection classifier remains a candidate, not original ordered-skip parity. Hostile external writers, production authority, authority self-enrollment and cutover are not qualified.",
      "Schema 21 preserves isolated workspace/backup inputs 12–20 until explicit open. Erased-memory backup remains unavailable because the external engine is not consistently snapshotted; logical forgetting is not cross-engine or physical erasure. Missing markers do not prove a backup predates erasure. No production import, authority enrollment or acceptance is granted.",
      "Batch23 subscription identity import is limited to disposable fixtures with an explicitly injected durable native secret authority. Private keys never enter plans, receipts, backups, sanitized JSON, sidecars or transport output; the new subscription.identity.get@1 operation is read-only and unaccepted. This does not qualify signing, grants, providers, production identity authority or a real Knowledge Root.",
      "Batch24's isolated VS Code host package is not the installed production extension and has no Electron acceptance claim. Batch25 Sync restore validates complete entity membership and fails closed on unsupported mode-only privacy transitions; its fixture recovery tests do not establish hostile external-writer exclusion or power-loss durability. Batch26 adds typed Manager client workflow surfaces and does not qualify autonomous production workers or the full VS Code user journey.",
      "No real Knowledge Root, production cutover, external calls or full legacy workstream acceptance is qualified.",
    ],
    ...record,
    native,
  }, null, 2) + "\n";
  let prior;
  try { prior = await readFile(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (prior !== bytes) await writeFile(path, bytes);
  console.log(`Refreshed ${native.length} native-only pins and ${refreshedCompositions} native-composition records; original-source hashes are untouched`);
}
