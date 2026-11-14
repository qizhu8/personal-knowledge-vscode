import { createHash } from "node:crypto";

export const bundleLimits = Object.freeze({
  wireBytes: Number.MAX_SAFE_INTEGER, snapshotBytes: 32 * 1024 * 1024,
  files: 4096, fileBytes: 1_048_576, totalBytes: 32 * 1024 * 1024,
  assets: 2048, assetBytes: 16 * 1024 * 1024, depth: 32,
});
export type BundleArea = "notes" | "skills" | "papers" | "packages";
export interface BundleFile {
  readonly area: BundleArea;
  readonly path: string;
  readonly stagePath: string;
  readonly content: string;
  readonly sha256: string;
  readonly encoding?: "base64";
}
export function bundleError(code: string): never {
  const error = new Error(`Subscription bundle rejected: ${code}.`);
  Object.assign(error, { code });
  throw error;
}
export function bundleHash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function bundleObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bundleError("INVALID_FORMAT");
  return value as Record<string, unknown>;
}
export function bundlePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || value !== value.normalize("NFC")
    || value.split("/").length > bundleLimits.depth
    || /[\\<>:"|?*\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) bundleError("UNSAFE_PATH");
  return value;
}
export function bundleBase64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > bundleLimits.wireBytes * 2) bundleError("INVALID_FORMAT");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || bytes !== undefined && decoded.length !== bytes) bundleError("INVALID_FORMAT");
  return decoded;
}
export function bundleJson(bytes: Uint8Array): Record<string, unknown> {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text).equals(Buffer.from(bytes))) bundleError("INVALID_FORMAT");
  // Bound nesting before JSON.parse, independently of the number of extracted files.
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > bundleLimits.depth) bundleError("QUOTA_EXCEEDED"); }
    else if (char === "}" || char === "]") depth--;
  }
  try { return bundleObject(JSON.parse(text)); } catch { bundleError("INVALID_FORMAT"); }
}
export function extractBundle(bytes: Uint8Array, counts: Readonly<Record<string, number>>, itemCount: number): readonly BundleFile[] {
  const bundle = bundleJson(bytes);
  if (bundle.version !== "3") bundleError("UNSUPPORTED_FORMAT");
  const supported = ["notes", "skills", "papers", "packages"] as const;
  const kinds = [...supported, "prompts", "scripts", "servers", "recipes"];
  if (Object.keys(bundle).some(key => !["version", "from", "created_at", "assets", ...kinds].includes(key))) bundleError("UNSUPPORTED_FORMAT");
  let members = 0, boundedFiles = 0, boundedBytes = 0, assetCount = 0;
  const files: BundleFile[] = [], seen = new Set<string>();
  const add = (area: BundleArea, relative: unknown, content: unknown) => {
    const path = bundlePath(relative), stagePath = `content/${area}/${path}`;
    const folded = stagePath.toLowerCase();
    if (typeof content !== "string" || Buffer.from(content).toString("utf8") !== content) bundleError("INVALID_FORMAT");
    const size = Buffer.byteLength(content);
    if (area !== "notes" && (size > bundleLimits.fileBytes
      || ++boundedFiles > bundleLimits.files
      || (boundedBytes += size) > bundleLimits.totalBytes)) bundleError("QUOTA_EXCEEDED");
    if (seen.has(folded) || [...seen].some(p => p.startsWith(`${folded}/`) || folded.startsWith(`${p}/`))) bundleError("PATH_COLLISION");
    seen.add(folded);
    files.push(Object.freeze({ area, path, stagePath, content, sha256: bundleHash(content) }));
  };
  for (const kind of kinds) {
    const list = bundle[kind] ?? [];
    if (!Array.isArray(list) || kind !== "notes" && list.length > bundleLimits.files) bundleError("QUOTA_EXCEEDED");
    if ((counts[kind] ?? 0) !== list.length) bundleError("MEMBERSHIP_MISMATCH");
    members += list.length;
    if (!supported.includes(kind as BundleArea) && list.length) bundleError("UNSUPPORTED_FORMAT");
    const packages = new Set<string>();
    for (const value of list) {
      const item = bundleObject(value);
      if (kind === "packages") {
        const name = bundlePath(item.name);
        if (name.includes("/") || packages.has(name.toLowerCase())) bundleError("PATH_COLLISION");
        packages.add(name.toLowerCase());
        if (!Array.isArray(item.files) || item.files.length > bundleLimits.files) bundleError("INVALID_FORMAT");
        for (const raw of item.files) {
          const file = bundleObject(raw);
          if (Object.keys(file).some(k => k !== "path" && k !== "content")) bundleError("UNSUPPORTED_FORMAT");
          add("packages", `${name}/${bundlePath(file.path)}`, file.content);
        }
        const assets = bundle.assets ?? [];
        if (!Array.isArray(assets) || assets.length > bundleLimits.assets) bundleError("QUOTA_EXCEEDED");
        for (const raw of assets) {
          const asset = bundleObject(raw);
          if (!["notes", "skills", "papers"].includes(String(asset.type))) bundleError("INVALID_FORMAT");
          const path = bundlePath(asset.path), area = asset.type as BundleArea, stagePath = `content/${area}/${path}`;
          if (!path.split("/").some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"))
            || typeof asset.data !== "string") bundleError("INVALID_FORMAT");
          const bytes = Buffer.from(asset.data, "base64");
          if (bytes.toString("base64") !== asset.data || bundleHash(bytes) !== asset.digest) bundleError("HASH_MISMATCH");
          const folded = stagePath.toLowerCase();
          if (seen.has(folded) || [...seen].some(p => p.startsWith(`${folded}/`) || folded.startsWith(`${p}/`))) bundleError("PATH_COLLISION");
          const isTodoBoard = area === "notes" && path.split("/").at(-1)?.toLowerCase() === "pkm-todo-board.json";
          if (++assetCount > bundleLimits.assets || !isTodoBoard && (asset.data.length > bundleLimits.assetBytes * 2
            || bytes.length > bundleLimits.assetBytes
            || ++boundedFiles > bundleLimits.files
            || (boundedBytes += bytes.length) > bundleLimits.totalBytes)) bundleError("QUOTA_EXCEEDED");
          seen.add(folded);
          files.push(Object.freeze({ area, path, stagePath, content: asset.data, encoding: "base64" as const, sha256: bundleHash(bytes) }));
        }
      } else if (kind === "skills") {
        const category = item.metadata === undefined ? undefined : bundleObject(item.metadata).category;
        if (typeof item.name !== "string" || category !== undefined && typeof category !== "string") bundleError("INVALID_FORMAT");
        add("skills", `${category ? `${category}/` : ""}${item.name}.md`, item.content);
      } else if (kind === "notes") {
        if (typeof (item.slug || item.title) !== "string") bundleError("INVALID_FORMAT");
        add("notes", `${item.slug || item.title}.md`, item.content);
      } else if (kind === "papers") {
        if (typeof (item.slug || item.title) !== "string" || item.category !== undefined && typeof item.category !== "string") bundleError("INVALID_FORMAT");
        add("papers", `${item.slug || [item.category, item.title].filter(Boolean).join("/")}.md`, item.content);
      }
    }
  }
  if (Object.keys(counts).some(k => !kinds.includes(k as typeof kinds[number])) || members !== itemCount) bundleError("MEMBERSHIP_MISMATCH");
  return Object.freeze(files);
}
