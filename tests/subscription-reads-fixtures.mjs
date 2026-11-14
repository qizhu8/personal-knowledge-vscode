import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Minimal read-model source files, not a runnable broker or a production storage export.
export const subscriptionReadSourceFiles = {
  "subscriptions.json": {
    schema: 1, nodeId: "fixture-local",
    shares: [{
      shareId: "fixture-share", summary: { shareId: "fixture-share" },
      accountMode: "open", accessMode: "block-list", ipRules: ["203.0.113.0/24"],
    }],
    subscriptions: [{
      id: "fixture-sub", alias: "Fixture subscription", brokerName: "Fixture broker",
      nodeId: "fixture-remote", publisher: "Fixture publisher", publisherUser: "fixture-user",
      publisherHost: "fixture-host", endpoint: "", shareId: "fixture-share", publicKey: "", magicLink: "",
      revision: 1, collectionHash: "fixture-hash", topics: [], tags: [], counts: { notes: 1 },
      itemCount: 1, etag: "", status: "current",
    }],
  },
  "subscriber-stats.json": { schema: 1, automaticBlocks: {} },
};

export async function installSubscriptionReadTransportFixtures(root) {
  const directory = join(root, "subscriptions");
  await mkdir(directory);
  for (const [name, content] of Object.entries(subscriptionReadSourceFiles)) {
    await writeFile(join(directory, name), JSON.stringify(content), { flag: "wx" });
  }
}

const subscription = {
  id: "fixture-sub", alias: "Fixture subscription", priority: "normal", brokerName: "Fixture broker",
  nodeId: "fixture-remote", publisher: "Fixture publisher", publisherUser: "fixture-user",
  publisherHost: "fixture-host", shareId: "fixture-share", revision: 1, collectionHash: "fixture-hash",
  topics: [], tags: [], counts: { notes: 1 }, itemCount: 1, status: "current",
};
export function subscriptionReadTransportFixtures(actorId = "local:owner") {
  const policy = {
    shareId: "fixture-share", accountMode: "open", accountRules: [],
    networkMode: "block-list", ipRules: ["203.0.113.0/24"], automaticBlocks: [],
  };
  // Every successful result also contains revision: /^[a-f0-9]{64}$/.
  return [
    { operation: "subscription.list", args: { limit: 1 }, result: { total: 1, items: [subscription], nextOffset: null } },
    { operation: "subscription.get", args: { id: "fixture-sub" }, result: { subscription } },
    ...[
      { sourceIp: "192.0.2.10", action: "download", allowed: true },
      { sourceIp: "203.0.113.10", action: "download", allowed: false },
      { sourceIp: "192.0.2.10", action: "unknown-action", allowed: false },
    ].map(({ sourceIp, action, allowed }) => ({
      operation: "subscription.acl.evaluate",
      args: { shareId: "fixture-share", sourceIp, action },
      result: { shareId: "fixture-share", actorId, sourceIp, action, allowed, policy, evaluationOnly: true },
    })),
  ];
}
