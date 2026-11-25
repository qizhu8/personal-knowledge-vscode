import { createHash } from "node:crypto";
import { z } from "zod";
import {
  openOriginalMcpCustodyReader,
  verifyOriginalMcpCustody,
} from "./original-mcp-root.js";
import {
  isTrustedLinuxRootWriterFence,
  type LinuxRootWriterFence,
} from "./linux-root-writer-fence.js";
import { originalMcpFailure, type OriginalMcpPlan } from "./original-mcp-root-custody.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const areaSchema = z.strictObject({
  area: z.enum(["notes", "skills", "papers"]),
  exists: z.boolean(),
  bucketCount: z.number().int().nonnegative(),
  pathCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  directoryCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  opaqueSha256: digest,
});
export const originalMcpTrashCustodySchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-trash-custody/v1"),
  planSha256: digest,
  areas: z.array(areaSchema).length(3),
  receiptSha256: digest,
});
export type OriginalMcpTrashCustody = z.infer<typeof originalMcpTrashCustodySchema>;

const areas = ["notes", "skills", "papers"] as const;
const maximumTrashPaths = 65_536;

/**
 * Produces an opaque, read-only inventory bound to a verified original-root custody plan.
 * It intentionally does not parse legacy metadata or publish bucket names/content.
 */
export async function inspectOriginalMcpTrashCustody(
  input: OriginalMcpPlan,
  writerFence: LinuxRootWriterFence,
): Promise<OriginalMcpTrashCustody> {
  if (!isTrustedLinuxRootWriterFence(writerFence, input.root))
    originalMcpFailure("Original Trash custody inspection requires the actual root writer fence.");
  writerFence.assertHeld();
  const plan = await verifyOriginalMcpCustody(input);
  const reader = await openOriginalMcpCustodyReader(plan);
  try {
    const summaries = [];
    let totalPaths = 0;
    let totalBytes = 0;
    for (const area of areas) {
      const base = `${area}/.trash`;
      const hash = createHash("sha256");
      const buckets = new Set<string>();
      let exists = false;
      let pathCount = 0;
      let fileCount = 0;
      let directoryCount = 0;
      let bytes = 0;
      for (const row of reader.entries(base)) {
        if (row.path !== base && !row.path.startsWith(`${base}/`))
          originalMcpFailure("Original Trash custody returned a path outside its selected area.");
        exists = true;
        pathCount++;
        totalPaths++;
        if (totalPaths > Math.min(maximumTrashPaths, plan.limits.maxEntries))
          originalMcpFailure("Original Trash custody exceeds its explicit path bound.");
        if (row.kind === "file") {
          fileCount++;
          bytes += Number(row.size);
          totalBytes += Number(row.size);
          if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(totalBytes)
            || totalBytes > plan.limits.maxBytes)
            originalMcpFailure("Original Trash custody exceeds its explicit byte bound.");
        } else directoryCount++;
        if (row.path === base) {
          if (row.kind === "file") buckets.add("");
        } else {
          buckets.add(row.path.slice(base.length + 1).split("/")[0]!);
        }
        hash.update(JSON.stringify([
          row.path, row.kind, row.device, row.inode, row.mode, row.uid, row.gid,
          row.size, row.mtime, row.ctime, row.sha256, row.mutable,
        ]) + "\n");
      }
      summaries.push({
        area, exists, bucketCount: buckets.size, pathCount, fileCount, directoryCount, bytes,
        opaqueSha256: hash.digest("hex"),
      });
    }
    writerFence.assertHeld();
    const body = {
      schema: "pkm.original-mcp-trash-custody/v1" as const,
      planSha256: plan.planSha256,
      areas: summaries,
    };
    const receipt = originalMcpTrashCustodySchema.parse({
      ...body,
      receiptSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    });
    return receipt;
  } finally {
    reader.close();
  }
}
