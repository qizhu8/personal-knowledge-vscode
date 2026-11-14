import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { Storage } from "./storage.js";
import { assetImportDefinition, assetImportOperation } from "./asset-import.js";

const maxBundleBytes = 96 * 1024 * 1024;
const text = z.string();
const strings = z.array(text);
const tags = z.union([strings, text]).optional();
const identityFields = { schema: text.optional(), knowledgeId: text.optional(), revision: z.number().int().optional(), aliases: strings.optional() };
const identity = { ...identityFields, created_at: text.optional(), updated_at: text.optional() };
const empty = z.array(z.unknown()).max(0).optional();
const links = z.array(z.unknown()).optional();
const skill = z.strictObject({
  ...identity, name: text.min(1), content: text.optional(), links,
  metadata: z.strictObject({ ...identityFields, description: text.optional(), category: text.optional(), tags,
    source_project: text.optional(), created_at: text.optional(), links }).optional(),
});
const note = z.strictObject({
  ...identity, slug: text.min(1), title: text.min(1).optional(), content: text.optional(),
  description: text.optional(), type: text.optional(), tags, category: text.optional(),
  pinned: z.boolean().optional(), links, documentKind: z.literal("markdown").optional(),
});
const paper = z.strictObject({
  ...identity, slug: text.min(1).optional(), title: text.min(1), content: text.optional(),
  description: text.optional(), kind: text.optional(), group: text.optional(), pinned: z.boolean().optional(),
  authors: strings.optional(), year: z.number().int().nullable().optional(), topic: text.optional(),
  publisher: text.optional(), tags, url: text.optional(), file: text.optional(),
  conclusions: strings.optional(), implementation: strings.optional(), assumptions: strings.optional(),
  links, cites: z.array(z.unknown()).optional(), category: text.optional(),
});
const bundleSchema = z.strictObject({
  operationId: z.string().uuid(), prefix: text.optional(), from: text.optional(), created_at: text.optional(), version: text.optional(),
  skills: z.array(skill).optional(), notes: z.array(note).optional(), papers: z.array(paper).optional(),
  assets: z.array(z.strictObject({ type: z.enum(["skills", "notes", "papers"]), path: text, data: text, digest: text })).optional(),
  prompts: empty, scripts: empty, packages: empty, servers: empty, recipes: empty,
  actions: empty, components: empty,
});

function sourceIdentity(value: { schema?: string; knowledgeId?: string; revision?: number; aliases?: string[] }) {
  const identity = { schema: value.schema, knowledgeId: value.knowledgeId, revision: value.revision, aliases: value.aliases };
  return Object.values(identity).some(item => item !== undefined) ? identity : undefined;
}

function normalizedTags(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined || Array.isArray(value)) return value;
  let result: unknown;
  try { result = JSON.parse(value); } catch { throw new Error("Bundle tags must be a string array or a JSON-encoded string array."); }
  if (!strings.safeParse(result).success) throw new Error("Bundle tags must be a string array or a JSON-encoded string array.");
  return result as string[];
}

async function readBundle(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBundleBytes)
    throw new Error(`Bundle must be a regular non-symlink file of at most ${maxBundleBytes} bytes.`);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBundleBytes)
      throw new Error("Bundle file changed or is not a regular file.");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, maxBundleBytes + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBundleBytes) throw new Error(`Bundle exceeds ${maxBundleBytes} bytes.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || total !== stat.size) throw new Error("Bundle file changed while reading.");
    const bytes = Buffer.concat(chunks);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Bundle must be UTF-8 JSON.");
    try { return JSON.parse(content); } catch { throw new Error("Bundle must be valid JSON."); }
  } finally { await file.close(); }
}

export async function runBundleImportCli(args: string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (option !== "--data" && option !== "--bundle") throw new Error(`Unknown bundle-import option: ${option}`);
    const value = args[++i];
    if (!value || value.startsWith("--") || options.has(option)) throw new Error(`Missing or duplicate value for ${option}.`);
    if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path.`);
    options.set(option, value);
  }
  for (const option of ["--data", "--bundle"]) if (!options.has(option)) throw new Error(`Required option: ${option}`);
  const parsed = bundleSchema.safeParse(await readBundle(options.get("--bundle")!));
  if (!parsed.success) throw new Error(`Invalid or unsupported bundle member: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "bundle"}: ${issue.message}`).join("; ")}`);
  const bundle = parsed.data;
  const documents = [
    ...(bundle.skills ?? []).map(item => {
      const top = sourceIdentity(item), nested = sourceIdentity(item.metadata ?? {});
      if (top && nested) throw new Error("Skill identity must be supplied either at top level or in metadata, not both.");
      if (item.links !== undefined && item.metadata?.links !== undefined) throw new Error("Skill links must be supplied either at top level or in metadata, not both.");
      return { area: "skills" as const, path: [item.metadata?.category, `${item.name}.md`].filter(Boolean).join("/"),
        title: item.name, content: item.content ?? "", identity: top ?? nested, metadata: { name: item.name, description: item.metadata?.description,
          tags: normalizedTags(item.metadata?.tags), source_project: item.metadata?.source_project, created: item.metadata?.created_at ?? item.created_at,
          links: item.links ?? item.metadata?.links } };
    }),
    ...(bundle.notes ?? []).map(item => ({ area: "notes" as const, path: `${item.slug}.md`, title: item.title,
      content: item.content ?? "", identity: sourceIdentity(item), metadata: { description: item.description, type: item.type, tags: normalizedTags(item.tags),
        pinned: item.pinned, created: item.created_at, links: item.links } })),
    ...(bundle.papers ?? []).map(item => ({ area: "papers" as const, path: `${item.slug || [item.category, item.title].filter(Boolean).join("/")}.md`,
      title: item.title, content: item.content ?? "", identity: sourceIdentity(item), metadata: { description: item.description, kind: item.kind, group: item.group,
        pinned: item.pinned, authors: item.authors, year: item.year, topic: item.topic, publisher: item.publisher,
        tags: normalizedTags(item.tags), url: item.url, file: item.file, conclusions: item.conclusions,
        implementation: item.implementation, assumptions: item.assumptions, created: item.created_at, links: item.links, cites: item.cites } })),
  ];
  const request = { operationId: bundle.operationId, prefix: bundle.prefix ?? "", documents, assets: bundle.assets ?? [] };
  if (!assetImportDefinition.input.safeParse(request).success) throw new Error("Bundle contains invalid document paths, resource paths, prefix, or sizes.");
  const storage = await Storage.open(options.get("--data")!);
  let receipt: unknown;
  try {
    receipt = await storage.request({ operation: assetImportOperation, actorId: "local:owner", args: request });
  } finally { await storage.close(); }
  console.log(JSON.stringify({ receipt }));
}
