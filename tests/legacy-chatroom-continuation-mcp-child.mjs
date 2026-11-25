const nonce = process.argv[5];
if (!nonce || process.env.PKM_IN_PLACE_PRIVATE_FIXTURE !== nonce) throw new Error("Private Chatroom fixture required.");
if (process.env.PKM_CHAT_INTERRUPT_AFTER_PROVIDER === nonce) {
  const { LegacyChatroomContinuation } = await import("../dist/legacy-chatroom-continuation.js");
  const continueChat = LegacyChatroomContinuation.prototype.continue;
  LegacyChatroomContinuation.prototype.continue = async function (...args) {
    await continueChat.apply(this, args);
    console.error("INJECTED_PRIVATE_FIXTURE_EXIT_AFTER_PROVIDER_SUCCESS");
    process.exit(76);
  };
}
await import("../legacy/tests/next-trial-electron/in-place-server.cjs");
