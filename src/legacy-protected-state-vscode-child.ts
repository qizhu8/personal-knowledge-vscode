import { basename, join, resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { planLegacyImport, importLegacyWorkspace } from "./legacy-import.js";
import { planLegacyStateImport, readImportedProtectedSubscriptionSnapshot,
  type LegacyProtectedSubscriptionImport, type LegacyStateImportPlan } from "./legacy-state-import.js";
import { readLegacyStateReceipt, verifyBoundLegacyStateBytes } from "./host-composition-legacy-state.js";
import { cancelProtectedMembershipFixture, inspectProtectedMembershipRetryFixture, prepareProtectedMembershipFixture, publishProtectedMembershipFixture,
  publishProtectedRefreshFixture, readProtectedRefresh } from "./legacy-subscription-refresh.js";
import { readMembershipIntent, readMembershipOutcome } from "./legacy-subscription-membership-intent.js";
import type { MembershipChange } from "./legacy-subscription-membership-change.js";
import { Storage } from "./storage.js";

let started = false;
process.once("message", (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  started = true;
  const request = raw as Record<string, unknown>;
  void (async () => {
    if (typeof request.fixture !== "string" || resolve(request.fixture) !== request.fixture
      || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== request.fixture
      || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(basename(request.fixture))
      || typeof request.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(request.nonce)
      || typeof request.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.shareId)
      || !["import", "read", "binding", "refresh", "membership-prepare", "membership-check", "membership-publish", "membership-cancel",
        "membership-outcome"].includes(String(request.action))) throw new Error("Denied.");
    if (["binding", "refresh", "membership-prepare", "membership-check", "membership-publish", "membership-cancel",
      "membership-outcome"].includes(String(request.action))) {
      const fixture = request.fixture;
      const root = join(fixture, "original"), profile = join(fixture, "profile");
      for (const dir of [fixture, root, profile, join(fixture, "imported")]) {
        const stat = await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dir) !== dir
          || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) throw new Error("Denied.");
      }
      const marker = JSON.parse(await readFile(join(fixture, "subscription-state-fixture.json"), "utf8")) as Record<string, unknown>;
      const rootStat = await lstat(root, { bigint: true }), profileStat = await lstat(profile, { bigint: true });
      if (marker.schema !== "pkm.protected-subscription-state-fixture/v1" || marker.nonce !== request.nonce
        || marker.rootPin !== `${rootStat.dev}:${rootStat.ino}` || marker.profilePin !== `${profileStat.dev}:${profileStat.ino}`) throw new Error("Denied.");
      const destination = join(request.fixture, "imported");
      const identity = JSON.parse(await readFile(join(destination, ".pkm-next-workspace"), "utf8")) as { id?: unknown };
      if (typeof identity.id !== "string" || !/^[a-f0-9-]{36}$/i.test(identity.id)) throw new Error("Denied.");
      const db = new DatabaseSync(join(destination, "core.sqlite"), { readOnly: true });
      try {
        const receipt = readLegacyStateReceipt(db, identity.id);
        if (!receipt?.plan.statePlan?.protectedSubscriptions || receipt.outcome.destination !== destination
          || receipt.plan.statePlan.sourceRoot !== root || receipt.plan.statePlan.subscriptionRoot !== profile) throw new Error("Denied.");
        await verifyBoundLegacyStateBytes(db, destination, identity.id);
        if (request.action === "binding") {
          const refresh = readProtectedRefresh(db, identity.id);
          process.send?.({ type: "result", statePlan: receipt.plan.statePlan,
            refreshHead: refresh?.head ?? null, refreshState: refresh?.state
              ?? JSON.parse(await readFile(join(destination, "subscriptions/subscriptions.json"), "utf8")),
            membershipPending: readMembershipIntent(db, identity.id)?.intent ?? null });
        } else if (request.action === "membership-outcome") {
          if (typeof request.operationId !== "string") throw new Error("Denied.");
          process.send?.({ type: "result", membershipOutcome: readMembershipOutcome(db, identity.id, request.operationId) ?? null });
        }
      } finally { db.close(); }
      if (request.action === "refresh") {
        if (process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1"
          || request.publisherNodeId !== undefined && (typeof request.publisherNodeId !== "string" || !/^[a-f0-9]{64}$/.test(request.publisherNodeId))
          || request.expectedHead !== null && (typeof request.expectedHead !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedHead)))
          throw new Error("Denied.");
        const store = await Storage.open(destination);
        try {
          const head = await publishProtectedRefreshFixture(store, profile, request.expectedHead as string | null, request.shareId, request.nonce,
            request.crashAfterFirstFile === true && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "1",
            request.replayOnly === true,
            request.crashAfterCommit === true && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "4",
            request.failure === true, request.priority === true, request.publisherNodeId as string | undefined);
          process.send?.({ type: "result", refreshHead: head });
        } finally { await store.close(); }
      } else if (["membership-prepare", "membership-check", "membership-publish", "membership-cancel"].includes(String(request.action))) {
        if (process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1" || typeof request.operationId !== "string"
          || !/^[a-f0-9-]{36}$/.test(request.operationId)) throw new Error("Denied.");
        const store = await Storage.open(destination);
        try {
          if (request.action === "membership-cancel") {
            await cancelProtectedMembershipFixture(store, profile, request.nonce, request.operationId);
            process.send?.({ type: "result", cancelled: true });
          } else {
            if (!request.change || typeof request.change !== "object" || Array.isArray(request.change)) throw new Error("Denied.");
            const change = request.change as MembershipChange;
            if (request.action === "membership-prepare") {
              if (request.expectedHead !== null && (typeof request.expectedHead !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedHead)))
                throw new Error("Denied.");
              await prepareProtectedMembershipFixture(store, profile, request.nonce, request.operationId,
                request.expectedHead as string | null, change);
              process.send?.({ type: "result", prepared: true });
            } else if (request.action === "membership-check") {
              const status = await inspectProtectedMembershipRetryFixture(store, profile, request.nonce, request.operationId, change);
              process.send?.({ type: "result", ...status });
            } else {
              const head = await publishProtectedMembershipFixture(store, profile, request.nonce, request.operationId,
                change, request.verifiedPull === true,
                request.crashAfterFirstFile === true && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "6",
                request.crashAfterCommit === true && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "7");
              process.send?.({ type: "result", refreshHead: head });
            }
          }
        } finally { await store.close(); }
      }
      return;
    }
    if (typeof request.secret !== "string" || !request.secret || Buffer.byteLength(request.secret) > 4096) throw new Error("Denied.");
    const fixture = request.fixture, root = join(fixture, "original"), profile = join(fixture, "profile"),
      destination = join(fixture, "imported"), shareId = request.shareId;
    const shareIds = request.shareIds === undefined ? [shareId] : request.shareIds;
    if (!Array.isArray(shareIds) || shareIds.length < 1 || shareIds.length > 32
      || shareIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      || new Set(shareIds).size !== shareIds.length || !shareIds.includes(shareId)) throw new Error("Denied.");
    const rawSecrets = request.secrets;
    if (rawSecrets !== undefined && (!rawSecrets || typeof rawSecrets !== "object" || Array.isArray(rawSecrets)
      || Object.keys(rawSecrets).length !== shareIds.length || shareIds.some(id =>
        !Object.hasOwn(rawSecrets, id) || typeof (rawSecrets as Record<string, unknown>)[id] !== "string"
        || !(rawSecrets as Record<string, string>)[id] || Buffer.byteLength((rawSecrets as Record<string, string>)[id]!) > 4096)))
      throw new Error("Denied.");
    const secret = Buffer.from(request.secret);
    request.secret = undefined;
    const secrets = new Map<string, Buffer>(shareIds.map(id => [id, rawSecrets
      ? Buffer.from((rawSecrets as Record<string, string>)[id]!) : Buffer.from(secret)]));
    request.secrets = undefined;
    const policy: LegacyProtectedSubscriptionImport = {
      fixture, nonce: request.nonce, authorityId: "vscode-private-profile", epoch: "fixture-v1",
      async authorizeState(binding) {
        return binding.root === root && binding.profile === profile && shareIds.includes(binding.shareId)
          && binding.authorityId === "vscode-private-profile" && binding.epoch === "fixture-v1";
      },
      authority: {
        async authorize(binding) { return binding.root === root && binding.profile === profile && shareIds.includes(binding.shareId); },
        async secret(binding) {
          const value = secrets.get(binding.shareId);
          return value ? Buffer.from(value) : undefined;
        },
      },
    };
    try {
      if (request.action === "import") {
        await planLegacyStateImport(root, profile, undefined, undefined, policy);
        const plan = await planLegacyImport(root, {}, { subscriptionRoot: profile, protectedSubscription: policy });
        if (!plan.ready || !plan.statePlan) {
          const error = Object.assign(new Error("Fixture import blocked."), { code: plan.blockers[0]?.code ?? "FIXTURE_DENIED" });
          throw error;
        }
        await importLegacyWorkspace(plan, destination, { pythonExecutable: "/usr/bin/python3", protectedSubscription: policy });
        process.send?.({ type: "result", statePlan: plan.statePlan });
      } else {
        if (!request.statePlan || typeof request.statePlan !== "object") throw new Error("Denied.");
        const result = await readImportedProtectedSubscriptionSnapshot(request.statePlan as LegacyStateImportPlan, destination, shareId, policy);
        try { process.send?.({ type: "result", plaintextSha256: result.plaintextSha256, itemCount: result.itemCount }); }
        finally { result.plaintext.fill(0); }
      }
    } finally { secret.fill(0); for (const value of secrets.values()) value.fill(0); }
  })().catch(error => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "FIXTURE_DENIED";
    const messages = ["Subscription workspace changed while opening.", "Subscription snapshot changed during reading.",
      "Subscription file changed before reading.", "Subscription file changed during reading.",
      "Subscription refresh changed during reading.", "Subscription snapshot changed; retry from the first page.",
      "Subscription refresh changed during retrieval."];
    const reason = error instanceof Error ? messages.indexOf(error.message) : -1;
    process.send?.({ type: "error", code, ...(reason < 0 ? {} : { reason }) });
  }).finally(() => { if (process.connected) process.disconnect?.(); });
});
