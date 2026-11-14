import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./contracts.js";

export const routerConfigDestination = "knowledge-read-config/retrieval/router-config.json";
export const legacyRouterConfigPlanSchema = z.strictObject({
  source: z.string().min(1), destination: z.literal(routerConfigDestination),
  sourceRoot: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  device: z.string(), inode: z.string(), mtimeNs: z.string(), ctimeNs: z.string(),
});
export type LegacyRouterConfigPlan = z.infer<typeof legacyRouterConfigPlanSchema>;
const uniqueStrings = z.array(z.string().min(1)).refine(values => new Set(values).size === values.length);
const configSchema = z.strictObject({
  schema: z.literal(2),
  enabledSolutions: z.array(z.enum(["copilot_default", "l1_online"]))
    .refine(values => values.includes("copilot_default") && new Set(values).size === values.length),
  sourcePriority: uniqueStrings,
  sources: z.array(z.strictObject({
    id: z.string(), label: z.string(), kind: z.enum(["personal", "native", "subscriber"]), detail: z.string(),
  })),
}).refine(value => {
  const ids = new Set(value.sources.map(source => source.id));
  return ids.has("pkm-personal") && ids.has("agent-native")
    && value.sourcePriority.every(id => ids.has(id))
    && value.sources.every(source => source.kind === "personal" ? source.id === "pkm-personal"
      : source.kind === "native" ? source.id === "agent-native" : source.id.startsWith("subscriber:") && source.id.length > 11);
});

export function parseLegacyRouterConfig(raw: string): void {
  try { configSchema.parse(JSON.parse(raw)); }
  catch { throw new CoreError("INVALID_DOCUMENT", "Provided original router config is not the supported schema-2 writer state; preserve it for reconciliation."); }
}

export async function inspectLegacyRouterConfig(source: string, sourceRoot: string): Promise<{ plan: LegacyRouterConfigPlan; bytes: Buffer }> {
  const root = resolve(sourceRoot), file = resolve(source);
  const rel = relative(root, file);
  if (!isAbsolute(source) || basename(source) !== "router-config.json"
    || !isAbsolute(rel) && rel.split(sep)[0] !== "..") {
    throw new Error("Select the exact independent router-config.json disposable snapshot outside the source workspace.");
  }
  let current: string = sep;
  for (const part of file.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory())) throw new Error("Router config path must be canonical without links.");
  }
  if (await realpath(file) !== file) throw new Error("Router config path must be canonical.");
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n
    || before.size < 1n || before.size > 536_870_912n) throw new Error("Router config must fit the bounded import and be a private unlinked regular snapshot.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (stat: typeof before) => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.nlink === 1n && stat.isFile();
    if (!same(await handle.stat({ bigint: true }))) throw new Error("Router config changed before reading.");
    const bytes = await handle.readFile();
    if (!same(await handle.stat({ bigint: true })) || !same(await lstat(file, { bigint: true }))
      || bytes.length !== Number(before.size)) throw new Error("Router config changed while reading.");
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("Router config must be UTF-8.");
    parseLegacyRouterConfig(raw);
    return { bytes, plan: legacyRouterConfigPlanSchema.parse({
      source: file, destination: routerConfigDestination, sourceRoot: root,
      size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      device: String(before.dev), inode: String(before.ino),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs),
    }) };
  } finally { await handle.close(); }
}
