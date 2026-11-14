import { basename, extname } from "node:path";
import { CoreError } from "./contracts.js";
import { readSubscriptions } from "./subscription-reads.js";
import { legacyKnowledgeTree } from "./legacy-knowledge-snapshot.js";
import { readProtectedRefreshAtRoot } from "./legacy-subscription-refresh.js";

const types = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"];
function json(raw: string | undefined) {
  try { return JSON.parse(raw ?? ""); } catch { return {}; }
}

/** Cache membership comes only from the validated native subscriber state, never cache-directory names. */
export async function legacyRetrievalSubscriptions(root: string) {
  const head = readProtectedRefreshAtRoot(root)?.head ?? null;
  const records: any[] = [];
  let offset: number | null = 0, revision: string | undefined;
  while (offset !== null) {
    const page = await readSubscriptions(root, { operation: "subscription.list", actorId: "mcp:external",
      args: { offset, limit: 100, ...(revision ? { expectedRevision: revision } : {}) } }) as {
        revision: string; items: any[]; nextOffset: number | null;
      };
    records.push(...page.items); offset = page.nextOffset; revision = page.revision;
  }
  const cache = legacyKnowledgeTree(root, "subscriptions", "cache", false, path => {
    const parts = path.split("/");
    if (parts.length === 4 && parts[3] === "_subscription.json") return true;
    return parts[3] === "content" && types.includes(parts[4] ?? "")
      && !parts.slice(5, -1).some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"));
  });
  if ((readProtectedRefreshAtRoot(root)?.head ?? null) !== head)
    throw new CoreError("REVISION_CONFLICT", "Subscription refresh changed during retrieval.");
  const recognized = new Set(records.map(record => `${record.nodeId}/${record.shareId}`));
  if (cache.some(file => !file.directory && !recognized.has(file.path.split("/").slice(1, 3).join("/"))))
    throw new CoreError("NOT_AVAILABLE", "Subscription cache has no exact native subscriber identity.");
  const groups: any[] = [], details = new Map<string, { contentType: string; content: string; provenance: any }>();
  const known = new Map(cache.map(file => [file.path, file]));
  for (const type of types) for (const record of records) {
    const prefix = `cache/${record.nodeId}/${record.shareId}`;
    const metadata = json(known.get(`${prefix}/_subscription.json`)?.raw);
    if (metadata.subscriptionId && metadata.subscriptionId !== record.id
      || metadata.nodeId && metadata.nodeId !== record.nodeId || metadata.shareId && metadata.shareId !== record.shareId)
      throw new CoreError("CONFLICT", "Subscription cache identity differs from its native subscriber.");
    const contentPrefix = `${prefix}/content/${type}/`;
    const items: any[] = [];
    for (const file of [...cache].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      if (file.directory || !file.path.startsWith(contentPrefix) || file.path.endsWith(".pkm-source.json")) continue;
      const path = file.path.slice(contentPrefix.length);
      if (path.split("/").slice(0, -1).some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"))) continue;
      if (file.raw === undefined) throw new CoreError("NOT_AVAILABLE", "Subscribed retrieval requires complete valid UTF-8 cache sources.");
      const key = Buffer.from(JSON.stringify({ subscriptionId: record.id, type, path })).toString("base64url");
      const provenance = json(known.get(`${file.path}.pkm-source.json`)?.raw);
      if (!provenance || typeof provenance !== "object" || Array.isArray(provenance))
        throw new CoreError("INVALID_DATA", "Subscription source provenance must be an object.");
      provenance.brokerName ||= record.brokerName || record.alias || record.publisher;
      provenance.nodeId ||= record.nodeId; provenance.shareId ||= record.shareId;
      provenance.sourcePriority = record.priority;
      const pkmPath = `pkm://subscriptions/${encodeURIComponent(record.nodeId)}/${encodeURIComponent(record.shareId)}/${type}/${path.split("/").map(encodeURIComponent).join("/")}`;
      let title = basename(path, extname(path));
      if (type === "recipes") title = String(json(file.raw)?.name || title).trim() || title;
      items.push({ key, title, path, type, pkmPath });
      details.set(key, { contentType: type, content: file.raw, provenance });
    }
    if (type === "packages") {
      const packages = new Map<string, any>();
      for (const item of items) {
        const name = item.path.split("/")[0];
        if (!name || packages.has(name)) continue;
        const representative = items.find(value => value.path.startsWith(`${name}/`) && /^readme(?:\.|$)/i.test(basename(value.path))) || item;
        packages.set(name, { ...representative, title: name, path: name, packageName: name });
      }
      items.splice(0, items.length, ...packages.values());
    }
    if (type === "servers") {
      const servers = items.filter(item => item.path.split("/").length === 2 && item.path.endsWith("/server.link.json"))
        .map(item => ({ ...item, title: String(json(details.get(item.key)?.content)?.name || item.path.split("/")[0]).trim() || item.path.split("/")[0] }));
      items.splice(0, items.length, ...servers);
    }
    if (items.length) groups.push({ subscriptionId: record.id,
      alias: record.alias || record.brokerName || record.publisher, priority: record.priority,
      publisher: record.publisher, nodeId: record.nodeId, shareId: record.shareId, revision: record.revision,
      syncedAt: metadata.syncedAt || record.lastUpdated || "", items });
  }
  return { groups, revision, cache, read(key: string) {
    const detail = details.get(key);
    if (!detail) throw new CoreError("NOT_FOUND", "Subscribed source is absent from the pinned native cache snapshot.");
    return detail;
  } };
}
