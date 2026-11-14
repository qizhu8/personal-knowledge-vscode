import { PkmLocatorInventoryEntry, PkmLocatorSubscriptionGroup, resolvePkmLocator } from "../knowledge/knowledge-locator";

export function panelSearchTarget(
  sourceUri: string,
  inventory: readonly (PkmLocatorInventoryEntry & { name?: string })[],
  subscriptions: readonly (PkmLocatorSubscriptionGroup & { alias?: string })[] = [],
): { openTarget: { type: string; key: string }; category: string; displayPath: string } {
  // Legacy retrieval URIs omit .md; Quick Open's physical-file contract requires it.
  const locator = /^pkm:\/\/(?:skills|notes|papers)\//.test(sourceUri) && !sourceUri.endsWith(".md")
    ? `${sourceUri}.md` : sourceUri;
  const target = resolvePkmLocator(locator, inventory.map(entry =>
    entry.area === "skills" ? { ...entry, slug: entry.name || entry.title } : entry), subscriptions);
  if (target.kind !== "panel") throw new Error("This search result cannot be opened in the knowledge panel.");
  if (target.type === "subscriptionItem") {
    const group = subscriptions.find(group => group.items.some(item => item.key === target.key));
    const item = group?.items.find(item => item.key === target.key);
    if (!group || !item) throw new Error("Subscribed search result is no longer cached.");
    const parent = item.path.split("/").slice(0, -1).join("/");
    return { openTarget: { type: target.type, key: target.key },
      category: ["Subscriptions", group.alias || group.shareId, parent].filter(Boolean).join("/"), displayPath: item.path };
  }
  if (target.type === "packageFile") throw new Error("Package files are outside this search collection.");
  const area = { skill: "skills", note: "notes", paper: "papers", script: "scripts" }[target.type];
  const matches = inventory.filter(entry => entry.area === area
    && (target.type === "skill" ? (entry.name || entry.title) === target.key : entry.slug === target.key || entry.relativePath === target.key));
  if (matches.length !== 1) throw new Error("Search result has no unique target in the current knowledge inventory.");
  const entry = matches[0];
  return { openTarget: { type: target.type, key: target.key },
    category: entry.relativePath.split("/").slice(0, -1).join("/"), displayPath: entry.relativePath };
}
