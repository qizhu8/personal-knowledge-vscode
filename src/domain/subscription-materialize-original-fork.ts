import { createHash } from "node:crypto";

export function forkRootName(brokerName: string, publisherUser: string, publisherHost: string): string {
  const clean = (value: string, fallback: string, limit: number): string => value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, limit) || fallback;
  const cleanBroker = clean(brokerName.replace(/^_folk_+/i, ""), "Broker", 48);
  const user = clean(publisherUser, "unknown-user", 32);
  const host = clean(publisherHost, "unknown-host", 48);
  const identity = [cleanBroker, user, host].map(value => value.toLocaleLowerCase()).join("\u0000");
  const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `_folk_${cleanBroker} - ${user} - ${host}--${identityHash}`;
}
