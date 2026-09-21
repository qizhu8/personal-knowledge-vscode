import type { ShareDefinition, SharedContentType } from "./subscriptions";

export interface BrokerShareReference {
  id: string;
  name: string;
  published: boolean;
}

export interface BrokerShareMarker {
  brokers: BrokerShareReference[];
}

export interface BrokerShareMarkerState {
  items: Record<string, BrokerShareMarker>;
  folders: Record<string, BrokerShareMarker>;
}

export function sharedContentIdentity(type: SharedContentType, item: any): string {
  if (type === "skills") return String(item.name || "");
  if (type === "notes" || type === "papers") return String(item.slug || "");
  if (type === "prompts") return `${item.project || ""}/${item.task || ""}`;
  if (type === "scripts") return String(item.path || `${item.category === "(root)" ? "" : `${item.category || ""}/`}${item.file || ""}`).replace(/^\/+/, "");
  if (type === "packages") return String(item.name || "");
  return String(item.slug || "");
}

export function sharedContentFolder(type: SharedContentType, item: any): string {
  if (type === "skills") return String(item.metadata?.category ?? item.category ?? "");
  if (type === "notes") return String(item.category || "");
  if (type === "papers") return String(item.category || item.topic || "");
  if (type === "prompts") return String(item.project || "");
  if (type === "scripts") return item.category === "(root)" ? "" : String(item.category || "");
  if (type === "servers") return String(item.category || "");
  return "";
}

function normalizeFolder(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function folderAncestors(value: string): string[] {
  const parts = normalizeFolder(value).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function brokerShareMarkers(type: SharedContentType, items: any[], shares: ShareDefinition[]): BrokerShareMarkerState {
  const itemBrokers = new Map<string, Map<string, BrokerShareReference>>();
  const folderBrokers = new Map<string, Map<string, BrokerShareReference>>();
  const add = (target: Map<string, Map<string, BrokerShareReference>>, key: string, broker: BrokerShareReference) => {
    if (!key) return;
    const brokers = target.get(key) || new Map<string, BrokerShareReference>();
    brokers.set(broker.id, broker);
    target.set(key, brokers);
  };

  for (const share of shares || []) {
    if (!(share.contentTypes || []).includes(type)) continue;
    const broker = { id: share.shareId, name: share.name, published: share.published !== false };
    const exact = new Set(share.selected?.[type] || []);
    const selectedFolders = (share.folders?.[type] || []).map(normalizeFolder);
    for (const selectedFolder of selectedFolders) {
      for (const ancestor of folderAncestors(selectedFolder)) add(folderBrokers, ancestor, broker);
    }
    for (const item of items || []) {
      const id = sharedContentIdentity(type, item);
      const folder = normalizeFolder(sharedContentFolder(type, item));
      const included = exact.has(id) || selectedFolders.some(selected => selected === "" || folder === selected || folder.startsWith(`${selected}/`));
      if (!included || !id) continue;
      add(itemBrokers, id, broker);
      for (const ancestor of folderAncestors(folder)) add(folderBrokers, ancestor, broker);
    }
  }

  const serialize = (source: Map<string, Map<string, BrokerShareReference>>): Record<string, BrokerShareMarker> =>
    Object.fromEntries([...source].map(([key, brokers]) => [key, { brokers: [...brokers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }]));
  return { items: serialize(itemBrokers), folders: serialize(folderBrokers) };
}