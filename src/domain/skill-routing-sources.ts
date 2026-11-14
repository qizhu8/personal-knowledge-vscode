export const SKILL_ROUTER_PERSONAL_SOURCE = "pkm-personal";
export const SKILL_ROUTER_NATIVE_SOURCE = "agent-native";

export interface SkillRouterSubscriptionSource {
  id: string;
  alias?: string;
  brokerName?: string;
  shareId?: string;
  publisher?: string;
}

export interface SkillRouterSource {
  id: string;
  label: string;
  kind: "personal" | "native" | "subscriber";
  detail: string;
}

export function skillRouterSubscriberSourceId(subscriptionId: string): string {
  return `subscriber:${subscriptionId}`;
}

export function availableSkillRouterSources(
  subscriptions: readonly SkillRouterSubscriptionSource[],
): SkillRouterSource[] {
  const subscribers = subscriptions
    .filter(subscription => String(subscription.id || "").trim())
    .map(subscription => ({
      id: skillRouterSubscriberSourceId(subscription.id),
      label: String(subscription.alias || subscription.brokerName || subscription.shareId || subscription.publisher || "Subscriber"),
      kind: "subscriber" as const,
      detail: `Subscriber · ${String(subscription.publisher || subscription.brokerName || subscription.shareId || "Broker")}`,
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return [
    {
      id: SKILL_ROUTER_PERSONAL_SOURCE,
      label: "PKM Personal",
      kind: "personal",
      detail: "Skills authored in this Personal Knowledge Root",
    },
    {
      id: SKILL_ROUTER_NATIVE_SOURCE,
      label: "Agent Native",
      kind: "native",
      detail: "Skills supplied and selected by the active Agent host",
    },
    ...subscribers,
  ];
}

export function normalizeSkillRouterSourcePriority(
  configured: readonly string[] | undefined,
  sources: readonly SkillRouterSource[],
): string[] {
  const available = new Set(sources.map(source => source.id));
  const normalized: string[] = [];
  for (const id of configured || []) {
    if (available.has(id) && !normalized.includes(id)) normalized.push(id);
  }
  for (const source of sources) {
    if (!normalized.includes(source.id)) normalized.push(source.id);
  }
  return normalized;
}
