import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { membershipRequestSha256 } from "./legacy-subscription-membership-change.js";
import { readSubscriptions, SUBSCRIPTION_READ_LIMITS } from "./subscription-reads.js";
import { originalMcpPublicRequestActive, originalMcpRequestDigest, assertOriginalMcpNativeHost,
  type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalSubscriptionSourceSchema, originalSubscriptionTools } from "./original-mcp-subscription-contracts.js";
import type { Storage } from "./storage.js";
import type { RefreshView } from "./legacy-subscription-refresh.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { validateNativeGitHubTarget } from "./native-subscription-github.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const types = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"] as const;
const part = z.string().min(1).max(256).refine(value => !/[/\\\0]/.test(value) && ![".", ".."].includes(value));
const path = z.string().min(1).max(2048).refine(value => !value.includes("\\") && !value.includes("\0")
  && value.split("/").every(item => item && ![".", ".."].includes(item))
  && !value.endsWith(".pkm-source.json") && !value.split("/").some(item => item === "_assets" || item.toLowerCase().endsWith(".assets")));
const get = z.strictObject({ node_id: part, share_id: part, content_type: z.enum(types), path });
const search = z.strictObject({ query: z.string().max(2048), content_type: z.enum(types).nullable().optional(),
  alias: z.string().max(2048).nullable().optional(), limit: z.number().int().min(1).max(100).default(20) });
const invalid = (): never => { throw new CoreError("ACCESS_DENIED", "Exact current native Subscription membership/provider/corpus authority is required."); };
function decode(file: RefreshView["files"][number]) {
  if (file.bytes.length !== file.size || file.size > SUBSCRIPTION_READ_LIMITS.fileBytes || hash(file.bytes) !== file.sha256) invalid();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { return invalid(); }
}
function publicProvenance(raw: string, member: any, contentSha256: string, contentType: string, relative: string) {
  let value: any;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (member.source ? value.repository !== member.source.repository || value.branch !== member.source.branch
      || value.commit !== member.source.commit : value.nodeId !== member.nodeId || value.shareId !== member.shareId)
    || value.subscriptionId && value.subscriptionId !== member.id
    || value.revision !== undefined && value.revision !== member.revision
    || value.contentHash !== undefined && value.contentHash !== `sha256:${contentSha256}`
    || value.sourceSha256 !== undefined && value.sourceSha256 !== contentSha256
    || value.type !== undefined && value.type !== contentType || value.remotePath !== undefined && value.remotePath !== relative) return invalid();
  const result: Record<string, unknown> = { nodeId: member.nodeId, shareId: member.shareId, sourcePriority: member.priority };
  if (value.schema === 1) result.schema = 1;
  for (const key of ["subscriptionId", "subscriptionAlias", "brokerName", "publisher", "type", "remotePath", "contentHash",
    "contentType", "path", "sourcePath", "sourceSha256", "revision", "collectionHash", "syncedAt",
    "repository", "branch", "commit", "publisherUser", "publisherHost"])
    if (typeof value[key] === "string" && value[key].length <= 2048 || key === "revision" && Number.isSafeInteger(value[key]))
      result[key] = value[key];
  return result;
}
export async function readOriginalMcpSubscriptions(storage: Storage, host: OriginalMcpNativeHost,
  tool: string, arguments_: Record<string, unknown>, signal?: AbortSignal) {
  if (!originalSubscriptionTools.some(item => item === tool) || !originalMcpPublicRequestActive(storage, tool, arguments_)) invalid();
  assertOriginalMcpNativeHost(host, storage);
  return storage.withWorkspaceExclusive(async () => {
    const args = structuredClone(arguments_);
    let selection: z.infer<typeof get> | undefined, query: z.infer<typeof search> | undefined;
    if (tool === "list_subscriptions") z.strictObject({}).parse(args);
    else if (tool === "search_subscribed_content") query = search.parse(args);
    else if (tool === "get_subscribed_content") selection = get.parse(args);
    else {
      const { pkm_path } = z.strictObject({ pkm_path: z.string().max(4096) }).parse(args);
      const uri = new URL(pkm_path);
      if (uri.protocol !== "pkm:" || uri.hostname !== "subscriptions" || uri.username || uri.password || uri.port || uri.search || uri.hash) invalid();
      const parts = uri.pathname.slice(1).split("/").map(decodeURIComponent);
      selection = get.parse({ node_id: parts[0], share_id: parts[1], content_type: parts[2], path: parts.slice(3).join("/") });
    }
    const view = await host.captureSubscriptionSource(signal);
    if (view.files.length > SUBSCRIPTION_READ_LIMITS.files
      || view.files.reduce((total, file) => total + file.size, 0) > SUBSCRIPTION_READ_LIMITS.snapshotBytes
      || new Set(view.files.map(file => file.path)).size !== view.files.length) invalid();
    const page = await readSubscriptions(storage.workspaceRoot(), { operation: "subscription.list",
      actorId: "mcp:external", args: { limit: 100 } }, () => view) as { items: any[]; nextOffset: number | null };
    if (page.nextOffset !== null) throw new CoreError("LIMIT_EXCEEDED", "Original Subscription projection is limited to 100 admitted members.");
    const records = (view.state.subscriptions as any[]) ?? [];
    const members = page.items.map(publicMember => {
      const member = records.find(record => record.id === publicMember.id);
      if (!member || member.status !== "current") invalid();
      if (member.source) {
        z.object({ type: z.literal("github"), repository: z.string().min(1).max(2048),
          branch: z.string().min(1).max(2048), commit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(member.source);
        const prefix = `cache/${member.nodeId}/${member.shareId}/content/`;
        validateNativeGitHubTarget(view, { action: "github-refresh", publisherNodeId: member.nodeId,
          shareId: member.shareId, subscriptionId: member.id, repository: member.source.repository,
          branch: member.source.branch, commit: member.source.commit,
          credentialTargetId: member.source.credentialTargetId || member.source.targetId || null,
          files: view.files.filter(file => file.path.startsWith(prefix) && !file.path.endsWith(".pkm-source.json"))
            .map(file => ({ path: file.path.slice(prefix.length), sha256: file.sha256, size: file.size })) });
      } else {
        if (hash(member.publicKey) !== member.nodeId) invalid();
        membershipRequestSha256({ action: "add", publisherNodeId: member.nodeId, shareId: member.shareId,
          magicLink: member.magicLink, alias: member.alias, endpoint: member.endpoint, secretSalt: member.secretSalt ?? null });
      }
      return { subscriptionId: member.id, nodeId: member.nodeId, shareId: member.shareId,
        publicKeySha256: hash(member.publicKey), providerSha256: originalMcpRequestDigest({
          endpoint: member.endpoint, publisher: member.publisher, publisherUser: member.publisherUser, publisherHost: member.publisherHost,
          source: member.source ?? null }),
        membershipSha256: originalMcpRequestDigest({ id: member.id, nodeId: member.nodeId, shareId: member.shareId,
          magicLink: member.magicLink, secretProtected: !!member.secretProtected, secretSalt: member.secretSalt ?? null }),
        revision: member.revision, collectionHash: member.collectionHash };
    });
    const files = new Map(view.files.map(file => [file.path, file]));
    for (const file of view.files) {
      if (file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..")
        || file.bytes.length !== file.size || hash(file.bytes) !== file.sha256) invalid();
    }
    for (const member of page.items) {
      const file = files.get(`cache/${member.nodeId}/${member.shareId}/_subscription.json`);
      if (!file) invalid();
      let metadata: any;
      try { metadata = JSON.parse(decode(file!)); } catch { return invalid(); }
      const sourceMember = records.find(record => record.id === member.id);
      if (metadata.nodeId !== member.nodeId || metadata.shareId !== member.shareId) invalid();
      if (sourceMember.source) {
        const summaryFile = files.get(`cache/${member.nodeId}/${member.shareId}/summary.json`);
        if (!summaryFile) invalid();
        let summary: any;
        try { summary = JSON.parse(decode(summaryFile!)); } catch { return invalid(); }
        if (metadata.id !== member.id || originalMcpRequestDigest(metadata.source) !== originalMcpRequestDigest(sourceMember.source)
          || summary.revision !== member.revision || summary.collectionHash !== member.collectionHash) invalid();
      } else if (metadata.subscriptionId !== member.id || metadata.revision !== member.revision
        || metadata.collectionHash !== member.collectionHash) invalid();
    }
    const source = originalSubscriptionSourceSchema.parse({ schema: "pkm.original-subscription-read-source/v1",
      head: view.head, members, corpusSha256: originalMcpRequestDigest(view.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))) });
    const decision = await host.authorizeSubscriptionRead({ source, tool: tool as typeof originalSubscriptionTools[number],
      arguments: z.record(z.string(), z.json()).parse(args), argumentsSha256: originalMcpRequestDigest(args), noExecution: true }, signal);
    host.assertSubscriptionSource(view.head);
    const publicRecords = page.items.map(member => ({ subscriptionId: member.id, alias: member.alias, priority: member.priority,
      publisher: member.publisher, nodeId: member.nodeId, shareId: member.shareId, revision: member.revision,
      collectionHash: member.collectionHash, syncedAt: member.lastUpdated ?? "" }));
    function detail(member: any, contentType: string, relative: string) {
      const prefix = `cache/${member.nodeId}/${member.shareId}/content/${contentType}/${relative}`;
      const content = files.get(prefix), provenance = files.get(`${prefix}.pkm-source.json`);
      if (!content || !provenance) return { error: "Subscribed item not found." };
      return { content: decode(content), provenance: publicProvenance(decode(provenance),
        records.find(record => record.id === member.id), content.sha256, contentType, relative) };
    }
    const snapshotFiles: Array<{ area: string; path: string; raw: string }> = [];
    for (const [index, member] of page.items.entries()) {
      const prefix = `cache/${member.nodeId}/${member.shareId}/`;
      const metadata = JSON.parse(decode(files.get(`${prefix}_subscription.json`)!));
      snapshotFiles.push({ area: "subscriptions", path: `${prefix}_subscription.json`,
        raw: JSON.stringify({ ...publicRecords[index], syncedAt: typeof metadata.syncedAt === "string"
          ? metadata.syncedAt.slice(0, 2048) : publicRecords[index]!.syncedAt }) });
      if (tool === "list_subscriptions") continue;
      for (const file of view.files) {
        if (!file.path.startsWith(`${prefix}content/`) || file.path.endsWith(".pkm-source.json")) continue;
        const [contentType, ...rest] = file.path.slice(`${prefix}content/`.length).split("/"), relative = rest.join("/");
        if (!types.includes(contentType as any) || !path.safeParse(relative).success
          || query?.content_type && contentType !== query.content_type
          || selection && (member.nodeId !== selection.node_id || member.shareId !== selection.share_id
            || contentType !== selection.content_type || relative !== selection.path)) continue;
        const item = detail(member, contentType, relative);
        if (!("content" in item)) continue;
        snapshotFiles.push({ area: "subscriptions", path: file.path, raw: item.content! },
          { area: "subscriptions", path: `${file.path}.pkm-source.json`, raw: JSON.stringify(item.provenance) });
      }
    }
    const output = z.strictObject({ value: z.json(), text: z.string() }).parse(await runLegacyMcpPython(
      fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url)), [],
      { tool, arguments: args, files: snapshotFiles, recipes: [], subscriptionsPresent: snapshotFiles.length > 0 }));
    if (decision.expiresAtMs <= Date.now() || signal?.aborted) invalid();
    const after = await host.captureSubscriptionSource(signal, view.head);
    if (originalMcpRequestDigest(after) !== originalMcpRequestDigest(view)) invalid();
    host.assertSubscriptionSource(view.head);
    assertOriginalMcpNativeHost(host, storage);
    return output.text;
  });
}
