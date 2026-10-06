export type PkmLocatorErrorCode = "invalid" | "unsupported" | "not-found" | "duplicate";

export class PkmLocatorError extends Error {
  constructor(readonly code: PkmLocatorErrorCode, message: string) {
    super(message);
    this.name = "PkmLocatorError";
  }
}

export interface PkmLocatorInventoryEntry {
  area: string;
  relativePath: string;
  slug: string;
  title: string;
  knowledgeId?: string;
}

export interface PkmLocatorSubscriptionGroup {
  nodeId: string;
  shareId: string;
  items: {
    key: string;
    title: string;
    path: string;
    type: string;
    pkmPath: string;
  }[];
}

export type ParsedPkmLocator =
  | { kind: "knowledge"; locator: string; knowledgeId: string }
  | { kind: "local-path"; locator: string; area: "skills" | "notes" | "papers"; path: string }
  | { kind: "subscription"; locator: string; nodeId: string; shareId: string; contentType: string; path: string };

export type ResolvedPkmLocator =
  | { kind: "panel"; locator: string; type: "skill" | "note" | "paper" | "subscriptionItem"; key: string; tab?: string; title: string }
  | { kind: "recipe"; locator: string; recipeId: string; title: string }
  | { kind: "subscribed-server"; locator: string; key: string; title: string };

const KNOWLEDGE_ID = /^knowledge_[a-f0-9]{24}$/;
const LOCAL_AREAS = new Set(["skills", "notes", "papers"]);
const SUBSCRIPTION_TYPES = new Set(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"]);

function normalizedInput(value: string): string {
  const trimmed = String(value || "").trim();
  const wrapped = /^`([^`\r\n]+)`$/.exec(trimmed);
  return wrapped ? wrapped[1].trim() : trimmed;
}

function decodedPathSegments(locator: string): string[] {
  const raw = locator.slice("pkm://".length);
  const slash = raw.indexOf("/");
  const rawPath = slash >= 0 ? raw.slice(slash + 1) : "";
  try {
    const parts = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.some(part => part === "." || part === ".." || part.includes("\0"))) {
      throw new PkmLocatorError("invalid", "PKM paths cannot contain traversal segments.");
    }
    return parts;
  } catch (error) {
    if (error instanceof PkmLocatorError) throw error;
    throw new PkmLocatorError("invalid", "PKM path contains invalid URL encoding.");
  }
}

export function parsePkmLocator(value: string): ParsedPkmLocator {
  const locator = normalizedInput(value);
  if (!locator) throw new PkmLocatorError("invalid", "Enter a PKM path.");
  if (!locator.toLowerCase().startsWith("pkm://")) {
    throw new PkmLocatorError("invalid", "PKM paths must start with pkm://.");
  }
  let url: URL;
  try { url = new URL(locator); }
  catch { throw new PkmLocatorError("invalid", "Enter a valid PKM path."); }
  if (url.protocol !== "pkm:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new PkmLocatorError("invalid", "PKM paths cannot include credentials, ports, queries, or fragments.");
  }
  const parts = decodedPathSegments(locator);
  const authority = url.hostname.toLowerCase();
  if (authority === "knowledge") {
    if (parts.length !== 1 || !KNOWLEDGE_ID.test(parts[0])) {
      throw new PkmLocatorError("invalid", "Knowledge paths must use pkm://knowledge/knowledge_<24 lowercase hex>.");
    }
    return { kind: "knowledge", locator, knowledgeId: parts[0] };
  }
  if (LOCAL_AREAS.has(authority)) {
    if (!parts.length || locator.endsWith("/") || !parts[parts.length - 1].toLowerCase().endsWith(".md")) {
      throw new PkmLocatorError("invalid", `pkm://${authority}/ paths must identify a Markdown file, not a folder.`);
    }
    return { kind: "local-path", locator, area: authority as "skills" | "notes" | "papers", path: parts.join("/") };
  }
  if (authority === "subscriptions") {
    const [nodeId, shareId, contentType, ...contentParts] = parts;
    if (!nodeId || !shareId || !SUBSCRIPTION_TYPES.has(contentType) || !contentParts.length || locator.endsWith("/")) {
      throw new PkmLocatorError("invalid", "Subscribed paths must identify an item under pkm://subscriptions/<node>/<share>/<type>/.");
    }
    return { kind: "subscription", locator, nodeId, shareId, contentType, path: contentParts.join("/") };
  }
  throw new PkmLocatorError(
    "unsupported",
    `Quick Open does not support the pkm://${authority || "(missing)"}/ namespace yet.`,
  );
}

function localTarget(entry: PkmLocatorInventoryEntry, locator: string): ResolvedPkmLocator {
  if (entry.area === "skills") return { kind: "panel", locator, type: "skill", key: entry.slug, tab: "skills", title: entry.title };
  if (entry.area === "notes") return { kind: "panel", locator, type: "note", key: entry.slug, tab: "notes", title: entry.title };
  if (entry.area === "papers") return { kind: "panel", locator, type: "paper", key: entry.slug, tab: "papers", title: entry.title };
  if (entry.area === "recipes") {
    const recipeId = entry.slug.slice(entry.slug.lastIndexOf(".") + 1);
    if (!recipeId) throw new PkmLocatorError("not-found", `Recipe identity is incomplete: ${locator}`);
    return { kind: "recipe", locator, recipeId, title: entry.title };
  }
  throw new PkmLocatorError("unsupported", `Knowledge item belongs to an unsupported area: ${entry.area}.`);
}

export function resolvePkmLocator(
  value: string,
  inventory: readonly PkmLocatorInventoryEntry[],
  subscriptionGroups: readonly PkmLocatorSubscriptionGroup[] = [],
): ResolvedPkmLocator {
  const parsed = parsePkmLocator(value);
  if (parsed.kind === "knowledge") {
    const matches = inventory.filter(entry => entry.knowledgeId === parsed.knowledgeId);
    if (!matches.length) throw new PkmLocatorError("not-found", `Knowledge item was not found: ${parsed.knowledgeId}`);
    if (matches.length > 1) throw new PkmLocatorError("duplicate", `Knowledge ID is duplicated across ${matches.length} items: ${parsed.knowledgeId}`);
    return localTarget(matches[0], parsed.locator);
  }
  if (parsed.kind === "local-path") {
    const matches = inventory.filter(entry => entry.area === parsed.area && entry.relativePath === parsed.path);
    if (!matches.length) throw new PkmLocatorError("not-found", `Knowledge file was not found: ${parsed.locator}`);
    if (matches.length > 1) throw new PkmLocatorError("duplicate", `Knowledge path resolves to multiple items: ${parsed.locator}`);
    return localTarget(matches[0], parsed.locator);
  }
  const matches = subscriptionGroups
    .filter(group => group.nodeId === parsed.nodeId && group.shareId === parsed.shareId)
    .flatMap(group => group.items)
    .filter(item => item.type === parsed.contentType && item.path === parsed.path);
  if (!matches.length) throw new PkmLocatorError("not-found", `Subscribed item is not available in the local cache: ${parsed.locator}`);
  if (matches.length > 1) throw new PkmLocatorError("duplicate", `Subscribed path resolves to multiple cached items: ${parsed.locator}`);
  const item = matches[0];
  if (item.type === "servers") return { kind: "subscribed-server", locator: parsed.locator, key: item.key, title: item.title };
  return { kind: "panel", locator: parsed.locator, type: "subscriptionItem", key: item.key, tab: item.type, title: item.title };
}
