import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import { AutomaticActionTrustAuthority } from "../src/runtime/action-trust-authority.ts";

async function request(config, body) {
  const socket = createConnection(config.port, config.host);
  await once(socket, "connect");
  socket.write(`${JSON.stringify({ ...body, storePath: config.store_path, token: config.token })}\n`);
  let data = "";
  for await (const chunk of socket) {
    data += chunk;
    if (data.includes("\n")) break;
  }
  socket.destroy();
  return JSON.parse(data.split("\n", 1)[0]);
}

test("VS Code trust authority binds admission to exact revision and live workspace trust", async t => {
  const root = resolve(import.meta.dirname, `.action-trust-authority-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let trusted = true;
  let effectConsent = false;
  const prepared = [];
  const effectConsentRequests = [];
  const authority = new AutomaticActionTrustAuthority({
    storePath: () => root,
    isTrusted: () => trusted,
    enabled: () => true,
    authorizeEffects: async (actionId, contentHash) => {
      effectConsentRequests.push({ actionId, contentHash });
      return effectConsent;
    },
    prepare: async (actionId, contentHash, proposalId, trustEpoch) => {
      prepared.push({ actionId, contentHash, proposalId, trustEpoch });
      return { ok: true, state: "succeeded" };
    },
  });
  t.after(async () => {
    await authority.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await authority.start();
  const config = JSON.parse(readFileSync(resolve(root, ".pkm/state/actions/host-authority.json"), "utf8"));
  const actionId = "example.safe-action", contentHash = "a".repeat(64), proposalId = `proposal_${"b".repeat(32)}`;
  const status = await request(config, { operation: "status" });
  assert.equal(status.trusted, true);
  assert.equal(status.trustEpoch, config.trust_epoch);
  assert.equal((await request(config, { operation: "status", trustedWorkspace: true })).trusted, false,
    "the host API rejects caller-supplied trust assertions");
  const admitted = await request(config, {
    operation: "prepare", actionId, contentHash, proposalId, trustEpoch: config.trust_epoch,
  });
  assert.equal(admitted.ok, true);
  assert.deepEqual(prepared.map(({ actionId, contentHash, proposalId }) => ({ actionId, contentHash, proposalId })),
    [{ actionId, contentHash, proposalId }]);
  assert.equal((await request(config, {
    operation: "authorize", actionId, contentHash, trustEpoch: "stale-epoch",
  })).trusted, false);
  const consentRequest = { operation: "effect_consent", actionId, contentHash, trustEpoch: config.trust_epoch };
  assert.equal((await request(config, consentRequest)).consented, false);
  effectConsent = true;
  assert.equal((await request(config, consentRequest)).consented, true);
  assert.deepEqual(effectConsentRequests, [
    { actionId, contentHash },
    { actionId, contentHash },
  ]);
  const pipelineContext = { kind: "pipeline", components: ["core.constant", "core.math-expression", "core.cast", "core.lookup"],
    stepCount: 4, effects: ["pure"], inputDigest: "c".repeat(64) };
  assert.equal((await request(config, { ...consentRequest, effectContext: pipelineContext })).consented, true);
  assert.equal((await request(config, { ...consentRequest, effectContext: {
    ...pipelineContext, components: ["core.lookup", "core.file-path"],
  } })).reason, "INVALID_EFFECT_CONTEXT");
  const artifactContext = { kind: "artifact-copy", artifact: {
    artifactId: `artifact_${"d".repeat(32)}`, digest: "e".repeat(64), size: 7,
  }, effects: ["local-read", "local-write"], inputDigest: "f".repeat(64) };
  assert.equal((await request(config, { ...consentRequest, effectContext: artifactContext })).reason, "INVALID_EFFECT_CONTEXT");
  assert.equal((await request(config, { ...consentRequest, actionId: "core.artifact.copy",
    effectContext: artifactContext })).consented, true);
  assert.equal((await request(config, { ...consentRequest, actionId: "core.artifact.copy",
    effectContext: { ...artifactContext, artifact: { ...artifactContext.artifact, path: "/untrusted" } } })).reason,
  "INVALID_EFFECT_CONTEXT");
  trusted = false;
  const revoked = await request(config, {
    operation: "authorize", actionId, contentHash, trustEpoch: config.trust_epoch,
  });
  assert.equal(revoked.trusted, false);
  assert.equal((await request(config, {
    operation: "prepare", actionId, contentHash, proposalId, trustEpoch: config.trust_epoch,
  })).trusted, false);
  assert.equal((await request(config, consentRequest)).trusted, false);
  assert.equal(prepared.length, 1, "an untrusted workspace cannot prepare a proposal");
  assert.equal(effectConsentRequests.length, 4, "an untrusted workspace cannot prompt or authorize effects");
  trusted = true;
  const refreshed = await request(config, { operation: "status" });
  assert.equal(refreshed.trusted, true);
  assert.notEqual(refreshed.trustEpoch, config.trust_epoch, "re-trusting rotates the host epoch");
  const refreshedConfig = JSON.parse(readFileSync(resolve(root, ".pkm/state/actions/host-authority.json"), "utf8"));
  assert.equal(refreshedConfig.trust_epoch, refreshed.trustEpoch);
  assert.equal((await request(config, {
    operation: "prepare", actionId, contentHash, proposalId, trustEpoch: config.trust_epoch,
  })).trusted, false, "an old trust epoch cannot re-admit a revision");
  assert.equal((await request(refreshedConfig, {
    operation: "prepare", actionId, contentHash, proposalId, trustEpoch: refreshed.trustEpoch,
  })).ok, true);
  assert.equal(prepared.length, 2);
  assert.equal((await request(refreshedConfig, {
    operation: "revoke", trustEpoch: config.trust_epoch,
  })).ok, false, "an old trust epoch cannot revoke or mutate the current host state");
  assert.equal(authority.status().trusted, true);
  const explicitRevocation = await request(refreshedConfig, {
    operation: "revoke", trustEpoch: refreshed.trustEpoch,
  });
  assert.equal(explicitRevocation.ok, true);
  assert.equal(explicitRevocation.trusted, false);
  assert.notEqual(explicitRevocation.trustEpoch, refreshed.trustEpoch);
  assert.equal(authority.status().trusted, false);
  assert.equal((await request(refreshedConfig, { operation: "status" })).trusted, false,
    "explicit host revocation remains closed until the authority is recreated");
});
