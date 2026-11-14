export type SharedContentType = "skills" | "notes" | "papers" | "prompts" | "scripts" | "packages" | "recipes" | "servers" | string;

export interface ShareMarkerDefinition {
  shareId: string;
  name: string;
  published?: boolean;
  contentTypes?: string[];
  selected?: Record<string, string[] | undefined>;
  folders?: Record<string, string[] | undefined>;
}

export interface BrokerShareReference { id: string; name: string; published: boolean }
export interface BrokerShareMarker { brokers: BrokerShareReference[] }
export interface BrokerShareMarkerState {
  items: Record<string, BrokerShareMarker>;
  folders: Record<string, BrokerShareMarker>;
}

type Item = Record<string, any>;

export function sharedContentIdentity(type: SharedContentType, item: Item): string {
  if (type === "skills" || type === "packages") return String(item.name || "");
  if (type === "notes" || type === "papers") return String(item.slug || "");
  if (type === "prompts") return `${item.project || ""}/${item.task || ""}`;
  if (type === "scripts") return String(item.path || `${item.category === "(root)" ? "" : `${item.category || ""}/`}${item.file || ""}`).replace(/^\/+/, "");
  if (type === "recipes") return String(item.recipeId || "");
  return String(item.slug || "");
}

export function sharedContentFolder(type: SharedContentType, item: Item): string {
  if (type === "skills") return String(item.metadata?.category ?? item.category ?? "");
  if (type === "notes" || type === "recipes" || type === "servers") return String(item.category || "");
  if (type === "papers") return String(item.category || item.topic || "");
  if (type === "prompts") return String(item.project || "");
  if (type === "scripts") return item.category === "(root)" ? "" : String(item.category || "");
  return "";
}

const normalizeFolder = (value: unknown): string => String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const folderAncestors = (value: string): string[] => {
  const parts = normalizeFolder(value).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

export function brokerShareMarkers(type: SharedContentType, items: Item[], shares: ShareMarkerDefinition[]): BrokerShareMarkerState {
  const itemBrokers = new Map<string, Map<string, BrokerShareReference>>();
  const folderBrokers = new Map<string, Map<string, BrokerShareReference>>();
  const add = (target: Map<string, Map<string, BrokerShareReference>>, key: string, broker: BrokerShareReference) => {
    if (!key) return;
    const brokers = target.get(key) ?? new Map<string, BrokerShareReference>();
    brokers.set(broker.id, broker);
    target.set(key, brokers);
  };
  for (const share of shares ?? []) {
    if (!(share.contentTypes ?? []).includes(type)) continue;
    const broker = { id: share.shareId, name: share.name, published: share.published !== false };
    const exact = new Set(share.selected?.[type] ?? []);
    const selectedFolders = (share.folders?.[type] ?? []).map(normalizeFolder);
    for (const selected of selectedFolders) for (const ancestor of folderAncestors(selected)) add(folderBrokers, ancestor, broker);
    for (const item of items ?? []) {
      const id = sharedContentIdentity(type, item);
      const folder = normalizeFolder(sharedContentFolder(type, item));
      const included = exact.has(id) || selectedFolders.some(selected => selected === "" || folder === selected || folder.startsWith(`${selected}/`));
      if (!included || !id) continue;
      add(itemBrokers, id, broker);
      for (const ancestor of folderAncestors(folder)) add(folderBrokers, ancestor, broker);
    }
  }
  const serialize = (source: Map<string, Map<string, BrokerShareReference>>): Record<string, BrokerShareMarker> =>
    Object.fromEntries([...source].map(([key, brokers]) => [key, {
      brokers: [...brokers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    }]));
  return { items: serialize(itemBrokers), folders: serialize(folderBrokers) };
}
