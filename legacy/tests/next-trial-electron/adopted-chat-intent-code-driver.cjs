"use strict";
const fs = require("node:fs"), path = require("node:path"), vscode = require("vscode");
const { randomUUID, createHash } = require("node:crypto");

exports.activate = context => {
  const fixture = process.env.PKM_CHAT_INTENT_FIXTURE;
  if (!fixture || !path.isAbsolute(fixture)) throw new Error("The isolated intent fixture is required.");
  const root = path.join(fixture, "knowledge-root");
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
  const store = require("./dist/knowledge/filestore.js");
  const { requestAdoptedRootChatAuthority } = require("./dist/chat/adopted-root-chat-authority.js");
  store.setStorePath(root);
  const chat = { namespace: "a".repeat(16), chatId: randomUUID(), title: "Private original Chat" };
  const workspaceId = randomUUID(), sessionId = randomUUID(), fingerprint = createHash("sha256").update("fixture-config").digest("hex");
  let connection = new AbortController(), grant, attempt = 0, pending = false;
  const write = (name, value) => fs.writeFileSync(path.join(fixture, name), JSON.stringify(value), { mode: 0o600 });
  context.subscriptions.push(
    vscode.commands.registerCommand("pkmIntentFixture.ask", async () => {
      if (pending || grant) throw new Error("The fixture already has a pending or active grant.");
      pending = true;
      const currentAttempt = ++attempt;
      try {
        grant = await requestAdoptedRootChatAuthority(context, {
          root, workspaceId, sessionId, configurationFingerprint: fingerprint, candidates: [chat],
          hostSignal: connection.signal,
          assertHostCurrent(binding) {
            if (connection.signal.aborted || binding.root !== root || binding.workspaceId !== workspaceId
              || binding.sessionId !== sessionId || binding.configurationFingerprint !== fingerprint)
              throw new Error("Fixture host is no longer current.");
          },
        });
        if (!grant) { write(`attempt-${currentAttempt}.json`, { status: "cancelled" }); return; }
        const binding = { root, workspaceId, sessionId, actorId: "local:owner", profileId: grant.profileId, chats: [chat] };
        grant.assertCurrent(binding);
        let denied = false;
        try { grant.assertCurrent({ ...binding, chats: [{ ...chat, chatId: randomUUID() }] }); } catch { denied = true; }
        if (!denied) throw new Error("An unapproved Chat was admitted.");
        write(`attempt-${currentAttempt}.json`, { status: "approved", root, chatId: chat.chatId,
          sessionId, deniedOtherChat: denied, trusted: vscode.workspace.isTrusted });
        grant.signal.addEventListener("abort", () => write("revoked.json", { aborted: true }), { once: true });
      } catch (error) {
        write(`attempt-${currentAttempt}.json`, { status: "error", message: String(error.stack || error) });
      } finally { pending = false; }
    }),
    vscode.commands.registerCommand("pkmIntentFixture.revoke", () => {
      if (!grant) throw new Error("No intent was granted.");
      connection.abort();
      let denied = false;
      try { grant.assertCurrent({ root, workspaceId, sessionId, actorId: "local:owner", profileId: grant.profileId }); }
      catch { denied = true; }
      write("revoke-check.json", { denied, aborted: grant.signal.aborted });
      grant.dispose(); grant = undefined;
      connection = new AbortController();
    }),
  );
  write("driver-ready.json", { trusted: vscode.workspace.isTrusted, profile: context.globalStorageUri.fsPath });
};
