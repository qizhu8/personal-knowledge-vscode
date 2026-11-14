import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.PKM_TEST_NEXT_SERVER_DIST;
const root = process.env.PKM_TEST_ROOT, config = process.env.PKM_TEST_CONFIG;
const parent = Number(process.env.PKM_TEST_PARENT), control = process.env.PKM_TEST_CONTROL;
const load = name => import(pathToFileURL(join(dist, `${name}.js`)).href);
const { adoptLegacyRootInPlaceExperimental } = await load("legacy-root-adoption");
const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
const { createOwnerHostSessions } = await load("owner-host-sessions");
const { bindOwnerParentSession } = await load("owner-parent-session");
const adopted = await adoptLegacyRootInPlaceExperimental(root, {
  snapshotAdmission: { authorityId: "private-parent-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
});
const endpoint = "http://127.0.0.1:12345/v1";
const unified = await startAdoptedRootUnifiedHost({
  optIn: true, dataPath: root, configPath: config, expectedWorkspaceId: adopted.workspaceId,
  policy: { authorizedConfigPath: config, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
    allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
  resolveSecret: async () => "fixture",
}, adopted);
const registry = createOwnerHostSessions(unified.ownerResourceContext(), adopted.workspaceId);
assert.throws(() => bindOwnerParentSession({
  registry, hostKey: "wrong-parent", expectedParentPid: parent + 1,
  assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError() {},
}), /direct parent/);
const session = bindOwnerParentSession({
  registry, hostKey: "private-direct-parent", expectedParentPid: parent,
  assertHostCurrent() {},
  assertScopeCurrent(scope) { if (scope !== "chat" && scope !== "environment") throw new Error("Scope not granted."); },
  onCloseError(error) { writeFileSync(join(control, "error"), String(error)); },
});
session.assertCurrent("chat");
session.registerChildClose("chat", async () => {
  writeFileSync(join(control, "draining"), "");
  for (let i = 0; i < 500 && !existsSync(join(control, "release")); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(join(control, "release"))) throw new Error("Private effect did not finish.");
});
session.registerChildClose("environment", async () => {
  writeFileSync(join(control, "scope-draining"), "");
  for (let i = 0; i < 500 && !existsSync(join(control, "release-scope")); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(join(control, "release-scope"))) throw new Error("Private scope effect did not finish.");
});
process.on("message", message => {
  if (message?.type !== "inspect-private-session") return;
  const allowed = scope => { try { session.assertCurrent(scope); return true; } catch { return false; } };
  process.send?.({ type: "private-session-status", chat: allowed("chat"), environment: allowed("environment") });
});
session.signal.addEventListener("abort", () => {
  void (async () => {
    await session.revoke();
    await unified.managed.close();
    writeFileSync(join(control, "connected-after-drain"), String(process.connected));
    writeFileSync(join(control, "drained"), "");
  })().catch(error => { writeFileSync(join(control, "error"), String(error)); process.exitCode = 1; });
}, { once: true });
process.send?.({ type: "ready", workspaceId: adopted.workspaceId, sessionId: session.sessionId });
import assert from "node:assert/strict";
