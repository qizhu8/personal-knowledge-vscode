export type SubscriptionPriority = "normal" | "high" | "highest";

export interface SubscriptionRecord {
  id: string;
  alias: string;
  priority?: SubscriptionPriority;
  brokerName?: string;
  nodeId: string;
  publisher: string;
  publisherUser: string;
  publisherHost: string;
  endpoint: string;
  shareId: string;
  publicKey: string;
  magicLink: string;
  revision: number;
  collectionHash: string;
  topics: string[];
  tags: string[];
  counts: Record<string, number>;
  itemCount: number;
  etag: string;
  secretProtected?: boolean;
  secretSalt?: string;
  lastChecked?: string;
  lastUpdated?: string;
  status: "new" | "current" | "updating" | "offline" | "error";
  error?: string;
  source?: { type: "github"; targetId?: string; credentialTargetId?: string; repository: string; branch: string; commit: string; selectedPaths?: string[]; selectedFolders?: string[] };
}

export function subscriptionPriority(value: unknown, strict = false): SubscriptionPriority {
  const normalized = String(value || "normal").trim().toLowerCase();
  if (normalized === "normal" || normalized === "high" || normalized === "highest") return normalized;
  if (strict) throw new Error("Subscription priority must be normal, high, or highest.");
  return "normal";
}
