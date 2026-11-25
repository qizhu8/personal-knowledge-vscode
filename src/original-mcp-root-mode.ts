import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, fstatSync, fchmodSync, fsyncSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";

const fail = (): never => { throw new Error("ORIGINAL_MCP_ROOT_MODE: Canonical owned paths, backed permission plan and real cold fence are required."); };
export interface OriginalMcpRootModePlan {
  readonly schema: "pkm.original-mcp-root-mode/v1";
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: string;
  readonly gid: string;
  readonly fromMode: number;
  readonly toMode: 448;
  readonly planSha256: string;
}
export function planOriginalMcpRootMode(root: string): OriginalMcpRootModePlan {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined || resolve(root) !== root || root === sep) return fail();
  let path: string = sep;
  for (const part of root.split(sep).filter(Boolean)) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  const stat = lstatSync(root, { bigint: true });
  if (realpathSync(root) !== root || stat.uid !== BigInt(uid) || (stat.mode & 0o7002n) !== 0n) fail();
  const body = { schema: "pkm.original-mcp-root-mode/v1" as const, root, device: String(stat.dev),
    inode: String(stat.ino), uid: String(stat.uid), gid: String(stat.gid), fromMode: Number(stat.mode & 0o777n), toMode: 0o700 as const };
  return Object.freeze({ ...body, planSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}
export async function applyOriginalMcpRootMode(plan: OriginalMcpRootModePlan, options: {
  writerFence: LinuxRootWriterFence;
  backupDirectory: string;
  approvedMode: 448;
}): Promise<{ changed: boolean; receiptPath: string }> {
  if (options.approvedMode !== 0o700 || !isTrustedLinuxRootWriterFence(options.writerFence, plan.root)) fail();
  options.writerFence.assertHeld();
  await assertLinuxLegacyWritersQuiescent(plan.root);
  if (JSON.stringify(planOriginalMcpRootMode(plan.root)) !== JSON.stringify(plan)) fail();
  const backup = options.backupDirectory;
  if (resolve(backup) !== backup || backup === plan.root || backup.startsWith(plan.root + sep)
    || plan.root.startsWith(backup + sep) || realpathSync(dirname(backup)) !== dirname(backup)) fail();
  const parent = lstatSync(dirname(backup));
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o7077) !== 0) fail();
  mkdirSync(backup, { mode: 0o700 });
  const receiptPath = join(backup, "root-mode.before.json");
  const record = openSync(receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(record, JSON.stringify({ plan, automaticPermissionLoosening: false })); fsyncSync(record); }
  finally { closeSync(record); }
  for (const path of [backup, dirname(backup)]) {
    const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  const root = openSync(plan.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    options.writerFence.assertHeld();
    const before = fstatSync(root, { bigint: true });
    if (String(before.dev) !== plan.device || String(before.ino) !== plan.inode || String(before.uid) !== plan.uid
      || String(before.gid) !== plan.gid || Number(before.mode & 0o777n) !== plan.fromMode) fail();
    fchmodSync(root, 0o700);
    fsyncSync(root);
    const after = planOriginalMcpRootMode(plan.root);
    if (after.device !== plan.device || after.inode !== plan.inode || after.fromMode !== 0o700) fail();
    options.writerFence.assertHeld();
    return { changed: plan.fromMode !== 0o700, receiptPath };
  } finally { closeSync(root); }
}
