import { legacySubscriptionProfileFixture } from "../dist/legacy-subscription-profile-fixture.js";

process.once("message", async message => {
  const { root, nonce, shareId, operation, crash } = message;
  const authority = {
    authorityId: "private-fixture-authority", epoch: "fixture-epoch-1",
    async authorize(binding) { return binding.root === root && binding.shareId === shareId; },
    async secret() {
      process.send({ type: "secret-request" });
      return await new Promise(resolve => process.once("message", value => resolve(value.secret ? Buffer.from(value.secret, "base64") : undefined)));
    },
  };
  try {
    const result = await legacySubscriptionProfileFixture(root, { nonce, shareId, operation, authority,
      checkpoint(phase) { if (phase === crash) process.exit(77); } });
    const payload = "plaintext" in result ? result.plaintext.toString("utf8") : undefined;
    result.plaintext?.fill(0);
    process.send({ type: "result", receipt: result.receipt, payload });
    process.disconnect();
  } catch (error) {
    process.send({ type: "error", code: error.code || "UNEXPECTED" });
    process.disconnect();
  }
});
