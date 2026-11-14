import * as fs from "node:fs/promises";
import { mock } from "node:test";

process.once("message", async ({ plan, stage, state, secret, shareId, nonce }) => {
  const statePath = `${plan.subscriptionRoot}/subscriptions.json`;
  const virtualState = Buffer.from(state);
  const withSize = stat => {
    const result = Object.create(stat);
    Object.defineProperty(result, "size", { value: typeof stat.size === "bigint" ? BigInt(virtualState.length) : virtualState.length });
    return result;
  };
  const patched = { ...fs,
    async lstat(path, options) {
      const stat = await fs.lstat(path, options);
      return path === statePath ? withSize(stat) : stat;
    },
    async open(path, ...args) {
      if (path !== statePath) return fs.open(path, ...args);
      return { async stat(options) { return withSize(await fs.lstat(path, options)); },
        async readFile() { return Buffer.from(virtualState); }, async close() {} };
    },
  };
  mock.module("node:fs/promises", { namedExports: patched, defaultExport: patched });
  try {
    const { readImportedProtectedSubscriptionSnapshot } = await import("../dist/legacy-state-import.js");
    const policy = { fixture: process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT, nonce, authorityId: "in-memory-test-authority", epoch: "one",
      async authorizeState(binding) { return binding.root === plan.sourceRoot && binding.profile === plan.subscriptionRoot
        && binding.shareId === shareId && binding.stateSha256 === plan.entries.find(entry => entry.projection === "protected-subscription").sourceSha256
        && binding.ciphertextSha256 === plan.protectedSubscriptions.snapshots.find(item => item.status === "authenticated-current").sha256; },
      authority: {
      async authorize(binding) { return binding.root === plan.sourceRoot && binding.profile === plan.subscriptionRoot && binding.shareId === shareId; },
      async secret() { return Buffer.from(secret); },
    } };
    const result = await readImportedProtectedSubscriptionSnapshot(plan, stage, shareId, policy);
    result.plaintext.fill(0);
    process.send?.({ ok: true, hash: result.plaintextSha256, itemCount: result.itemCount });
  } catch (error) {
    process.send?.({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "ERROR" });
  } finally { virtualState.fill(0); process.disconnect?.(); }
});
