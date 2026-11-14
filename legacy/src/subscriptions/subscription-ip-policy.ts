import * as ipaddr from "ipaddr.js";

export function normalizeClientIp(value: string): string {
  let input = String(value || "").trim().replace(/^\[|\]$/g, "");
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  try {
    const parsed = ipaddr.parse(input);
    return parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address().toString()
      : parsed.toNormalizedString();
  } catch { return input; }
}

export function validIpBlockRule(value: string): boolean {
  const rule = value.trim();
  if (!rule) return false;
  if (rule.includes("*")) {
    const parts = rule.split(".");
    return parts.length === 4 && parts.every(part => part === "*" || /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  try {
    if (rule.includes("/")) { ipaddr.parseCIDR(rule); return true; }
    ipaddr.parse(rule); return true;
  } catch { return false; }
}

export function normalizeIpBlockRules(values: unknown[]): string[] {
  const rules = [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
  const invalid = rules.find(rule => !validIpBlockRule(rule));
  if (invalid) throw new Error(`Invalid Block List rule: ${invalid}. Use an exact IP, CIDR, or IPv4 wildcard such as 10.20.*.*.`);
  return rules;
}

export function ipMatchesBlockRule(clientIp: string, value: string): boolean {
  const ip = normalizeClientIp(clientIp);
  const rule = value.trim();
  if (!validIpBlockRule(rule)) return false;
  if (rule.includes("*")) {
    const addressParts = ip.split(".");
    const ruleParts = rule.split(".");
    return addressParts.length === 4 && ruleParts.every((part, index) => part === "*" || part === addressParts[index]);
  }
  try {
    const address = ipaddr.parse(ip);
    if (rule.includes("/")) {
      const range = ipaddr.parseCIDR(rule);
      return address.kind() === range[0].kind() && address.match(range);
    }
    const blocked = ipaddr.parse(rule);
    return address.kind() === blocked.kind() && address.toNormalizedString() === blocked.toNormalizedString();
  } catch { return false; }
}

export function isIpBlocked(clientIp: string, rules: string[]): boolean {
  return rules.some(rule => ipMatchesBlockRule(clientIp, rule));
}
