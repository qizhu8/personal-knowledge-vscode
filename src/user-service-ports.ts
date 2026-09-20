import { createHash } from "crypto";
import { userInfo } from "os";

export type UserServicePort = "serversProxyPort" | "contentGatewayPort" | "chatHubPort" | "subscriptionPort";

const BASE_PORTS: Record<UserServicePort, number> = {
  serversProxyPort: 20_000,
  contentGatewayPort: 28_000,
  chatHubPort: 36_000,
  subscriptionPort: 44_000,
};

export function stableUserPort(service: UserServicePort, identity = userInfo()): number {
  const numericUid = Number(identity.uid);
  const slot = Number.isInteger(numericUid) && numericUid >= 0
    ? numericUid % 7_000
    : createHash("sha256").update(String(identity.username || "user")).digest().readUInt16BE(0) % 7_000;
  return BASE_PORTS[service] + slot;
}