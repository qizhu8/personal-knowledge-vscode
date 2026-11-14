import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AutomaticActionTrustAuthority } from "../src/runtime/action-trust-authority.ts";
import { createVscodeActionTrustBridge } from "../next-server/src/vscode-action-trust-bridge.ts";

test("native Action trust bridge binds one root and actor to the live VS Code authority", async t => {
  const root = resolve(import.meta.dirname, `.vscode-action-trust-bridge-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let trusted = true;
  const authority = new AutomaticActionTrustAuthority({
    storePath: () => root,
    isTrusted: () => trusted,
    enabled: () => true,
    prepare: async () => ({ ok: true, state: "tested" }),
  });
  await authority.start();
  const bridge = createVscodeActionTrustBridge({
    workspaceRoot: root, workspaceId: "workspace:bridge-e2e", actorId: "mcp:external",
  });
  t.after(async () => {
    await bridge.close();
    await authority.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const initial = await bridge.refresh();
  assert.equal(initial.trustedWorkspace, true);
  assert.equal(initial.workspaceId, "workspace:bridge-e2e");
  assert.equal(initial.actorId, "mcp:external");
  assert.equal(await bridge.authorize("example.safe-action", "a".repeat(64), initial.epoch), true);
  assert.equal(await bridge.authorize("example.safe-action", "a".repeat(64), "stale-epoch"), false);
  assert.equal(await bridge.authorize("example.safe-action", "invalid", initial.epoch), false);

  trusted = false;
  assert.equal((await bridge.refresh()).trustedWorkspace, false);
  trusted = true;
  const restored = await bridge.refresh();
  assert.equal(restored.trustedWorkspace, true);
  assert.notEqual(restored.epoch, initial.epoch);
  assert.equal(await bridge.authorize("example.safe-action", "a".repeat(64), initial.epoch), false);

  const previousEpoch = restored.epoch;
  await bridge.revoke();
  assert.equal(bridge.current().trustedWorkspace, false);
  assert.notEqual(bridge.current().epoch, previousEpoch);
  assert.equal((await bridge.refresh()).trustedWorkspace, false,
    "revocation remains fail-closed while the VS Code workspace is otherwise trusted");
  assert.equal(await bridge.authorize("example.safe-action", "a".repeat(64), previousEpoch), false);
});
