import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { workspaceStoragePaths } from "./workspace-storage-paths.js";
import { acquireSharedManagerControlGuard } from "./shared-manager-control.js";

const uuid = z.string().regex(/^[a-f0-9-]{36}$/i), hash = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(4096).refine(isAbsolute);
const manager = z.strictObject({
  schema: z.literal("pkm.shared-manager/v1"), serviceId: uuid, managedRoot: absolute,
  phase: z.enum(["starting", "accepting", "draining", "action-required", "closed"]),
  generation: uuid.optional(), workspaceId: uuid.optional(), dataPath: absolute.optional(),
  writable: z.boolean().optional(), catalogSha256: hash.optional(), runtimeBuild: hash.optional(),
  backendKind: z.enum(["native-public-mcp", "standalone-core"]).optional(),
  revokedCredentials: z.array(hash).max(128).refine(values => new Set(values).size === values.length).optional(),
  receipts: z.array(z.strictObject({ id: uuid, clientId: uuid, tool: z.string().max(1024), generation: uuid,
    outcome: z.enum(["pending", "unknown"]) })).max(4096),
  history: z.array(z.strictObject({ id: uuid,
    action: z.enum(["switch", "recover", "cleanup-runtime", "reset-index", "reconcile", "revoke-access", "human-review-enrollment"]),
    from: uuid.nullable(), to: uuid.nullable(), phase: z.enum(["prepared", "completed", "failed", "interrupted"]),
    at: z.number().int().safe(), bodySha256: hash.optional(),
    receiptId: uuid.optional(), clientId: uuid.optional(), tool: z.string().max(1024).optional(),
  }).refine(item => item.action === "reconcile"
    ? !!item.receiptId && !!item.clientId && !!item.tool
    : item.receiptId === undefined && item.clientId === undefined && item.tool === undefined)).max(1024).optional(),
});
const lifecycle = z.strictObject({
  schema: z.literal("pkm.managed-runtime-history/v1"),
  transitions: z.array(z.strictObject({ sequence: z.number().int().positive(), from: uuid.nullable(), to: uuid,
    phase: z.enum(["prepared", "switched", "aborted"]), dataRollback: z.literal(false).optional() })).max(100_000),
  retired: z.array(uuid).max(100_000),
});
const fail = (message: string): never => { throw new CoreError("RECOVERY_REQUIRED", message); };
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false });
function owned(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    fail("Runtime controls must be private, owned regular files and real directories.");
  return stat;
}

/** Returns control-relative files; guards and interrupted atomic writes are never exported. */
export function inspectWorkspaceRuntimeControls(root: string, snapshot = false): string[] {
  return inspectRuntimeControlDirectory(workspaceStoragePaths(root).runtimeControl, snapshot);
}
function inspectRuntimeControlDirectory(directory: string, snapshot = false): string[] {
  if (!exists(directory)) return [];
  owned(directory, true);
  const files: string[] = [];
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, full = join(path, name);
      if (!prefix && name === "shared-manager") { owned(full, true); visit(full, name); continue; }
      const document = relative === "managed-runtime-history.json" || relative === "shared-manager/shared-manager.json";
      const guard = relative === ".managed-runtime-history.guard" || relative === "shared-manager/shared-manager.guard";
      const pending = /^(?:managed-runtime-history\.json|shared-manager\/shared-manager\.json)\.[a-f0-9-]{36}\.pending$/i.test(relative);
      if (!document && !guard && !pending) fail("Unknown runtime-control entry cannot be treated as credential-free server data.");
      const stat = owned(full, false);
      if (stat.size > 1_048_576 || guard && stat.size !== 0) fail("Runtime control size or guard contents are invalid.");
      if (pending && snapshot) fail("An interrupted atomic runtime-control write must be reconciled before backup.");
      if (!document) { if (!snapshot) files.push(relative); continue; }
      const value = JSON.parse(readFileSync(full, "utf8"));
      if (relative === "managed-runtime-history.json") {
        const parsed = lifecycle.parse(value);
        if (parsed.transitions.some((item, index) => item.sequence !== index + 1))
          fail("Runtime selection history sequence changed.");
        if (snapshot && parsed.transitions.some(item => item.phase === "prepared"))
          fail("An unresolved managed-runtime transition must be reconciled before backup.");
      } else {
        const parsed = manager.parse(value);
        if (snapshot && (parsed.phase !== "closed" || parsed.receipts.length
          || parsed.history?.some(item => item.phase === "prepared")))
          fail("Close the shared manager and reconcile pending/unknown outcomes before server-data backup.");
      }
      files.push(relative);
    }
  };
  visit(directory, "");
  return files;
}

/** Serializes snapshots with the actual manager and runtime-history writer guard families. */
export async function acquireWorkspaceRuntimeControlSnapshot(root: string, directory = workspaceStoragePaths(root).runtimeControl) {
  if (!exists(join(directory, "managed-runtime-history.json"))
    && exists(join(root, "runtime", "managed-server", "runtime-lifecycle.json")))
    fail("Legacy managed-runtime history is outside durable server data. Run managed-runtime cleanup to migrate history before backup.");
  for (const path of [directory, join(directory, "shared-manager")]) {
    if (!exists(path)) mkdirSync(path, { mode: 0o700 });
    owned(path, true);
  }
  const leases: Awaited<ReturnType<typeof acquireSharedManagerControlGuard>>[] = [];
  try {
    for (const path of [join(directory, ".managed-runtime-history.guard"), join(directory, "shared-manager", "shared-manager.guard")])
      leases.push(await acquireSharedManagerControlGuard(path));
    inspectRuntimeControlDirectory(directory, true);
  } catch (error) {
    for (const lease of leases.reverse()) await lease.release();
    throw new CoreError("RECOVERY_REQUIRED", `Runtime controls are not quiescent for backup: ${error instanceof Error ? error.message : "unknown guard state"}`);
  }
  return {
    assertHeld() { for (const lease of leases) lease.assertHeld(); inspectRuntimeControlDirectory(directory, true); },
    async release() { for (const lease of leases.reverse()) await lease.release(); },
  };
}
