import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const load = name => import(pathToFileURL(join(config.dist, `${name}.js`)).href);
const { adoptLegacyRootInPlaceExperimental } = await load("legacy-root-adoption");
const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
const { attachAdoptedRootSessionChat } = await load("adopted-root-session-chat");
const { createOwnerHostSessions } = await load("owner-host-sessions");
const { bindOwnerParentSession } = await load("owner-parent-session");
const { createLegacyManagedChatLocalModel } = await load("legacy-api-chat-managed-provider");
const adoption = await adoptLegacyRootInPlaceExperimental(config.root, {
  snapshotAdmission: { authorityId: "private-crash-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
});
const options = { optIn: true, dataPath: config.root, configPath: config.hostConfig, expectedWorkspaceId: adoption.workspaceId,
  policy: { authorizedConfigPath: config.hostConfig, allowedProviders: ["openai-compatible"], allowedEndpoints: [config.endpoint],
    allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
  resolveSecret: async () => "fixture" };
const unified = await startAdoptedRootUnifiedHost(options, adoption), { managed } = unified;
const database = new DatabaseSync(config.processDb);
const sessions = createOwnerHostSessions(unified.ownerResourceContext(), adoption.workspaceId);
const session = bindOwnerParentSession({ registry: sessions, hostKey: "crash-fixture-host", expectedParentPid: process.ppid,
  assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError(error) { console.error(error); } });
process.on("message", value => {
  if (value?.type !== "fixture-check-environment") return;
  try { session.assertCurrent("environment"); process.send?.({ type: "fixture-environment-ok" }); }
  catch { process.send?.({ type: "fixture-environment-unavailable" }); }
});
process.once("disconnect", () => { void managed.close().then(() => database.close(), error => { console.error(error); process.exitCode = 1; }); });
const model = createLegacyManagedChatLocalModel({ endpoint: config.endpoint, model: "fixture", apiKey: "fixture",
  tools: async () => [{ name: "run_process", description: "run", parameters: { type: "object", properties: {}, additionalProperties: true } }] });
const child = await attachAdoptedRootSessionChat({ managed, owner: unified.ownerResourceContext(), session,
  profile: { workspaceId: adoption.workspaceId, actorId: "local:owner", root: config.root, profileId: "crash-profile",
    signal: new AbortController().signal, assertCurrent() {} }, onCloseError(error) { console.error(error); },
  ownerOptions: { database, captureDirectory: config.capture, commands: [{ id: "fixture", program: process.execPath, cwd: config.root,
    arguments: args => args.length === 1 && args[0] === config.script }],
    policy: async () => ({ available: true, trusted: true, permissionMode: "ask", localControls: true }),
    remember: async () => { throw new Error("No remembered grants."); } },
  chat: { chats: [config.identity], authorize: async () => true, provider: async () => "unused",
    managed: { model, authorize: async () => true, tools: { available: true, execute: async () => { throw new Error("Unexpected tool."); } } } } });
const rpc = async input => {
  const response = await fetch(`${child.endpoint}/rpc`, { method: "POST",
    headers: { authorization: `Bearer ${child.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
    body: JSON.stringify(input) });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body.value;
};
const history = await rpc({ method: "history", ...config.identity });
await rpc({ method: "task-control", input: { ...config.identity, kind: "create", title: "Crash Task",
  operationId: randomUUID(), expectedRevision: history.taskControl.revision } });
const operationId = randomUUID();
await rpc({ method: "continue", ...config.identity, operationId, expectedRevision: 0, text: "Run the fixture." });
let prompt;
for (let i = 0; i < 500 && !prompt; i++) {
  prompt = (await rpc({ method: "process-approvals", ...config.identity }))[0];
  if (!prompt) await new Promise(resolve => setTimeout(resolve, 20));
}
if (!prompt) throw new Error("Process approval not presented.");
await rpc({ method: "process-approval-decide", ...config.identity, id: prompt.id, choice: "approve" });
await child.managed.settled(config.identity, operationId);
for (let i = 0; i < 500 && !(existsSync(config.parentTicks) && existsSync(config.childTicks)); i++)
  await new Promise(resolve => setTimeout(resolve, 20));
if (!existsSync(config.parentTicks) || !existsSync(config.childTicks)) throw new Error("Process tree did not start.");
const ownerId = database.prepare("SELECT owner_id FROM runtime_process_owner WHERE singleton=1").get().owner_id;
const status = await rpc({ method: "status" });
process.send?.({ type: "ready", workspaceId: adoption.workspaceId, processOwnerId: ownerId, operationId,
  sessionId: session.sessionId, endpoint: child.endpoint, bearer: child.bearer, sourceFingerprint: status.sourceFingerprint });
