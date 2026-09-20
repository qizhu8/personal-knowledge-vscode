import { subscribedContentPath } from "./subscriptions";
import type { CachedSubscriptionGroup, SharedContentType } from "./subscriptions";

export interface SubscriptionNavigationNode {
  kind: "root" | "broker" | "folder" | "item";
  label: string;
  contentType: SharedContentType;
  subscriptionId?: string;
  path?: string;
  itemKey?: string;
  pkmPath?: string;
  count: number;
  children: SubscriptionNavigationNode[];
}

interface MutableFolder {
  folders: Map<string, MutableFolder>;
  items: CachedSubscriptionGroup["items"];
}

function folderNode(
  folder: MutableFolder,
  label: string,
  contentType: SharedContentType,
  subscriptionId: string,
  brokerPath: string,
  parentPath: string,
): SubscriptionNavigationNode {
  const folders = [...folder.folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => folderNode(child, name, contentType, subscriptionId, brokerPath, parentPath ? `${parentPath}/${name}` : name));
  const items = [...folder.items]
    .sort((left, right) => left.title.localeCompare(right.title))
    .map(item => ({
      kind: "item" as const,
      label: item.title,
      contentType,
      subscriptionId,
      path: item.path,
      itemKey: item.key,
      pkmPath: item.pkmPath,
      count: 0,
      children: [],
    }));
  const children = [...folders, ...items];
  return { kind: "folder", label, contentType, subscriptionId, path: parentPath,
    pkmPath: parentPath ? `${brokerPath}/${parentPath.split("/").map(encodeURIComponent).join("/")}` : brokerPath,
    count: children.length, children };
}

function brokerNode(group: CachedSubscriptionGroup, contentType: SharedContentType): SubscriptionNavigationNode {
  const root: MutableFolder = { folders: new Map(), items: [] };
  for (const item of group.items) {
    const parts = item.path.split("/").filter(Boolean);
    if (contentType === "packages" || contentType === "servers") {
      root.items.push(item);
      continue;
    }
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      let child = cursor.folders.get(part);
      if (!child) {
        child = { folders: new Map(), items: [] };
        cursor.folders.set(part, child);
      }
      cursor = child;
    }
    cursor.items.push(item);
  }
  const brokerPath = subscribedContentPath(group.nodeId, group.shareId, contentType);
  const virtualRoot = folderNode(root, group.alias, contentType, group.subscriptionId, brokerPath, "");
  return { ...virtualRoot, kind: "broker", count: group.items.length };
}

export function subscriptionNavigationRoot(
  contentType: SharedContentType,
  groups: CachedSubscriptionGroup[],
): SubscriptionNavigationNode | undefined {
  const brokers = groups
    .filter(group => group.items.length > 0)
    .sort((left, right) => left.alias.localeCompare(right.alias))
    .map(group => brokerNode(group, contentType));
  if (!brokers.length) return undefined;
  return {
    kind: "root",
    label: "From Brokers",
    contentType,
    count: brokers.reduce((sum, broker) => sum + broker.count, 0),
    children: brokers,
  };
}
