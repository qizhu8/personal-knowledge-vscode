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
  aliases?: string[];
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
  | { kind: "script"; locator: string; scriptId: string }
  | { kind: "script-path"; locator: string; path: string }
  | { kind: "recipe"; locator: string; recipeId: string }
  | { kind: "recipe-path"; locator: string; path: string }
  | { kind: "entity"; locator: string; area: "projects" | "actions" | "components"; id: string }
  | { kind: "package-file"; locator: string; path: string }
  | { kind: "chat"; locator: string; namespace: string; chatId: string }
  | { kind: "local-path"; locator: string; area: "skills" | "notes" | "papers"; path: string }
  | { kind: "subscription"; locator: string; nodeId: string; shareId: string; contentType: string; path: string };

export type ResolvedPkmLocator =
  | { kind: "chat"; locator: string; namespace: string; chatId: string; title: string }
  | { kind: "panel"; locator: string; type: "skill" | "note" | "paper" | "script" | "packageFile" | "subscriptionItem"; key: string; tab?: string; title: string }
  | { kind: "recipe"; locator: string; recipeId: string; title: string }
  | { kind: "entity"; locator: string; area: "projects" | "actions" | "components"; id: string; title: string }
  | { kind: "subscribed-server"; locator: string; key: string; title: string };

const KNOWLEDGE_ID = /^(?:knowledge_[a-f0-9]{24}|action_(?:[a-f0-9]{24}|[a-f0-9]{32}))$/;
const SCRIPT_ID = /^script_[A-Za-z0-9._-]+$/;
const RECIPE_ID = /^recipe_[A-Za-z0-9_-]+$/;
const CHAT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LOCAL_AREAS = new Set(["skills", "notes", "papers"]);
const SUBSCRIPTION_TYPES = new Set(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"]);

export function chatPkmUrl(namespace: string, chatId: string): string {
  if (!/^[a-f0-9]{16}$/.test(namespace) || !CHAT_ID.test(chatId)) throw new PkmLocatorError("invalid", "Choose a Chat with a valid workspace and identity.");
  return `pkm://chats/${namespace}/${chatId}`;
}

export function chatIdFromPkmUrl(value: string, namespace: string): string {
  if (CHAT_ID.test(value)) return value;
  const parsed = parsePkmLocator(value);
  if (parsed.kind !== "chat") throw new PkmLocatorError("invalid", "Choose a PKM Chat URL.");
  if (parsed.namespace !== namespace) throw new PkmLocatorError("not-found", "This Chat belongs to another workspace. Open its original workspace.");
  return parsed.chatId;
}

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
    if (rawPath.includes("//")) throw new PkmLocatorError("invalid", "PKM paths cannot contain empty segments.");
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
  if (authority === "projects" || authority === "actions" || authority === "components") {
    if (parts.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(parts[0]) || locator.endsWith("/")) {
      throw new PkmLocatorError("invalid", `pkm://${authority}/ requires one entity identity.`);
    }
    return { kind: "entity", locator, area: authority, id: parts[0] };
  }
  if (authority === "packages") {
    if (parts.length < 2 || locator.endsWith("/") || parts.some(part => /[/\\:\u0000-\u001f]/.test(part))) {
      throw new PkmLocatorError("invalid", "Package paths must identify a package-relative file.");
    }
    return { kind: "package-file", locator, path: parts.join("/") };
  }
  if (authority === "chats") {
    if (parts.length !== 2 || locator.endsWith("/")) throw new PkmLocatorError("invalid", "Chat paths must use pkm://chats/<workspace>/<Chat UUID>.");
    const [namespace, chatId] = parts;
    chatPkmUrl(namespace, chatId);
    return { kind: "chat", locator, namespace, chatId };
  }
  if (authority === "knowledge") {
    if (parts.length !== 1 || !KNOWLEDGE_ID.test(parts[0])) {
      throw new PkmLocatorError("invalid", "Knowledge paths require knowledge_<24 lowercase hex> or an Action identity action_<24 or 32 lowercase hex>.");
    }
    return { kind: "knowledge", locator, knowledgeId: parts[0] };
  }
  if (authority === "script") {
    if (parts.length !== 1 || !SCRIPT_ID.test(parts[0]) || locator.endsWith("/")) {
      throw new PkmLocatorError("invalid", "Script paths must use pkm://script/script_<identity>.");
    }
    return { kind: "script", locator, scriptId: parts[0] };
  }
  if (authority === "scripts") {
    if (!parts.length || locator.endsWith("/") || parts.some(part => /[/\\:\u0000-\u001f]/.test(part))) {
      throw new PkmLocatorError("invalid", "Legacy Script paths must identify a store-relative file.");
    }
    return { kind: "script-path", locator, path: parts.join("/") };
  }
  if (authority === "recipes") {
    if (!parts.length || locator.endsWith("/") || parts.some(part => /[/\\:\u0000-\u001f]/.test(part))) {
      throw new PkmLocatorError("invalid", "Recipe paths must identify a Recipe, not a folder.");
    }
    return parts.length === 1 && RECIPE_ID.test(parts[0])
      ? { kind: "recipe", locator, recipeId: parts[0] }
      : { kind: "recipe-path", locator, path: parts.join("/") };
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
  if (entry.area === "actions" || entry.area === "components" || entry.area === "projects") {
    return { kind: "entity", locator, area: entry.area, id: entry.slug, title: entry.title };
  }
  if (entry.area === "packages") {
    const slash = entry.relativePath.indexOf("/");
    return { kind: "panel", locator, type: "packageFile", key: entry.relativePath.slice(0, slash) + "|" + entry.relativePath.slice(slash + 1), tab: "packages", title: entry.title };
  }
  throw new PkmLocatorError("unsupported", `Knowledge item belongs to an unsupported area: ${entry.area}.`);
}

export function resolvePkmLocator(
  value: string,
  inventory: readonly PkmLocatorInventoryEntry[],
  subscriptionGroups: readonly PkmLocatorSubscriptionGroup[] = [],
): ResolvedPkmLocator {
  const parsed = parsePkmLocator(value);
  if (parsed.kind === "chat") return { ...parsed, title: "PKM Chat" };
  if (parsed.kind === "entity" || parsed.kind === "package-file") {
    const matches = inventory.filter(entry => parsed.kind === "entity"
      ? entry.area === parsed.area && entry.slug === parsed.id
      : entry.area === "packages" && entry.relativePath === parsed.path);
    if (!matches.length) throw new PkmLocatorError("not-found", `PKM item was not found: ${parsed.locator}`);
    if (matches.length > 1) throw new PkmLocatorError("duplicate", `PKM item identity is duplicated: ${parsed.locator}`);
    return localTarget(matches[0], parsed.locator);
  }
  if (parsed.kind === "knowledge") {
    const matches = inventory.filter(entry => entry.knowledgeId === parsed.knowledgeId);
    if (!matches.length) throw new PkmLocatorError("not-found", `Knowledge item was not found: ${parsed.knowledgeId}`);
    if (matches.length > 1) throw new PkmLocatorError("duplicate", `Knowledge ID is duplicated across ${matches.length} items: ${parsed.knowledgeId}`);
    return localTarget(matches[0], parsed.locator);
  }
  if (parsed.kind === "script" || parsed.kind === "script-path" || parsed.kind === "recipe" || parsed.kind === "recipe-path") {
    const matches = inventory.filter(entry => {
      if (parsed.kind === "recipe") return entry.area === "recipes"
        && entry.slug.slice(entry.slug.lastIndexOf(".") + 1) === parsed.recipeId;
      if (parsed.kind === "recipe-path") return entry.area === "recipes"
        && entry.slug.replace(/\.recipe_[A-Za-z0-9_-]+$/, "") === parsed.path;
      if (entry.area !== "scripts") return false;
      if (parsed.kind === "script") return entry.knowledgeId === parsed.scriptId || entry.aliases?.includes(parsed.locator);
      return entry.relativePath === parsed.path || entry.aliases?.includes(parsed.locator);
    });
    if (!matches.length) throw new PkmLocatorError("not-found", `PKM item was not found: ${parsed.locator}`);
    if (matches.length > 1) throw new PkmLocatorError("duplicate", `PKM reference resolves to multiple items: ${parsed.locator}`);
    const entry = matches[0];
    if (parsed.kind === "recipe") return { kind: "recipe", locator: parsed.locator, recipeId: parsed.recipeId, title: entry.title };
    if (parsed.kind === "recipe-path") return localTarget(entry, parsed.locator);
    return { kind: "panel", locator: parsed.locator, type: "script", key: entry.relativePath, tab: "scripts", title: entry.title };
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
