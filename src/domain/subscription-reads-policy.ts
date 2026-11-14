import type { BrokerAclPolicy } from "./subscription-reads-acl.js";

export function persistedBrokerAclPolicy(share: {
  summary: { shareId: string };
  accountMode?: BrokerAclPolicy["accountMode"];
  accountRules?: string[];
  accessMode?: BrokerAclPolicy["networkMode"];
  ipRules?: string[];
}, stats: { automaticBlocks: Record<string, Record<string, unknown>> }): BrokerAclPolicy {
  const policy = {
    shareId: share.summary.shareId,
    accountMode: share.accountMode || "open",
    accountRules: share.accountRules || [],
    networkMode: share.accessMode || "block-list",
    ipRules: share.ipRules || [],
    automaticBlocks: Object.keys(stats.automaticBlocks[share.summary.shareId] || {}),
  } as const;
  return policy;
}
