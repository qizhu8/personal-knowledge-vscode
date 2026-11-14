import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { assertSelectedChatRecovery } from "../dist/selected-chat-recovery.js";

test("recovery admission binds the exact workspace, source and snapshot", t => {
  const root = resolve("..", ".migration-test-work", `selected-admission-${randomUUID()}`);
  const parent = join(root, "trial"), workspace = join(parent, "workspace"), legacyRoot = join(root, "legacy");
  const snapshotRoot = join(parent, "control", `selected-chat-${randomUUID()}`, `chat-snapshot-${randomUUID()}`);
  for (const dir of [workspace, legacyRoot, snapshotRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  writeFileSync(join(workspace, ".pkm-next-workspace"), JSON.stringify({ id: workspaceId }), { mode: 0o600 });
  writeFileSync(join(workspace, "core.sqlite"), "fixture", { mode: 0o600 });
  const id = file => { const stat = lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
  const pin = { schema: "pkm.next-selected-chat-recovery/v1", parent, parentIdentity: id(parent),
    workspaceIdentity: id(workspace), databaseIdentity: id(join(workspace, "core.sqlite")),
    markerIdentity: id(join(workspace, ".pkm-next-workspace")), legacyRoot, legacyIdentity: id(legacyRoot),
    workspaceId, namespace: "0123456789abcdef", chatId: randomUUID(), snapshotRoot,
    snapshotParentIdentity: id(dirname(snapshotRoot)), snapshotIdentity: id(snapshotRoot), sourceFingerprint: "a".repeat(64) };
  assert.doesNotThrow(() => assertSelectedChatRecovery(pin, legacyRoot));
  assert.throws(() => assertSelectedChatRecovery({ ...pin, legacyRoot: workspace }, workspace), /paths are invalid/);
  assert.throws(() => assertSelectedChatRecovery({ ...pin, extra: true }, legacyRoot), /pin is invalid/);
  renameSync(snapshotRoot, `${snapshotRoot}-old`);
  mkdirSync(snapshotRoot, { mode: 0o700 });
  assert.throws(() => assertSelectedChatRecovery(pin, legacyRoot), /changed/);
});
