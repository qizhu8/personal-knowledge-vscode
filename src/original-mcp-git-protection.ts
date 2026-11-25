import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, fsyncSync, writeFileSync, mkdirSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { legacyPrivateRootGuard } from "./legacy-effective-private-root.js";
import { atomicFileWrite } from "./file-write.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";

const begin = "# BEGIN PKM v5 private runtime state";
const end = "# END PKM v5 private runtime state";
const block = `${begin}\n/core.sqlite\n/core.sqlite-*\n/coding-process.sqlite\n/coding-process.sqlite-*\n/.pkm-*\n${end}\n`;
const samples = [
  "core.sqlite", "core.sqlite-wal", "core.sqlite-shm", "core.sqlite-journal",
  "coding-process.sqlite", "coding-process.sqlite-wal", "coding-process.sqlite-shm",
  ".pkm-next-workspace", ".pkm-next-writer-fenced.json", ".pkm-next-original-mcp.json",
  ".pkm-next-original-mcp.commit.json", ".pkm-next-original-mcp.rollback.json",
  ".pkm-next-original-mcp-rollback-example/native-state.sqlite",
  ".pkm-action-authority/receipt.json", ".pkm-plugin-authority/receipt.json", ".pkm-room-admission/receipt.json",
];
const pathspecs = [":(top,glob)core.sqlite", ":(top,glob)core.sqlite-*",
  ":(top,glob)coding-process.sqlite", ":(top,glob)coding-process.sqlite-*",
  ":(top,glob).pkm-*", ":(top,glob).pkm-*/**"];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (condition: string): never => { throw new Error(`ORIGINAL_MCP_GIT_PROTECTION: ${condition}`); };
const pin = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function git(root: string, args: string[], input?: string): string {
  try {
    return execFileSync("/usr/bin/git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "-C", root, ...args], { input, encoding: "utf8", timeout: 10000,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  } catch { return fail("native Git verification failed; no history or index was modified"); }
}
function rootGuard(root: string) {
  if (process.platform !== "linux" || resolve(root) !== root || !legacyPrivateRootGuard(root))
    fail("a canonical original root under an owned private ancestor is required");
  const directory = join(root, ".git");
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7002n) !== 0n
    || realpathSync(directory) !== directory || git(root, ["rev-parse", "--show-toplevel"]).trim() !== root)
    fail("the selected original root must own its real Git directory");
  return stat;
}
function original(root: string) {
  const path = join(root, ".gitignore");
  let stat;
  try { stat = lstatSync(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0), sha256: null, mode: 0o600, identity: null };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
    || (stat.mode & 0o7002n) !== 0n || stat.size > 2_097_152n) fail("original .gitignore is unsafe");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (pin(fstatSync(fd, { bigint: true })) !== pin(stat)) fail("original .gitignore changed while opening");
    const bytes = readFileSync(fd);
    if (pin(fstatSync(fd, { bigint: true })) !== pin(stat) || pin(lstatSync(path, { bigint: true })) !== pin(stat))
      fail("original .gitignore changed while reading");
    return { bytes, sha256: sha(bytes), mode: Number(stat.mode & 0o777n), identity: pin(stat) };
  } finally { closeSync(fd); }
}
function desired(before: Buffer): Buffer {
  if (before.includes(Buffer.from(begin)) || before.includes(Buffer.from(end))) {
    if (!before.includes(Buffer.from(block))) fail("a conflicting private-state exclusion block requires review");
    return before;
  }
  return Buffer.concat([before, before.length && before.at(-1) !== 10 ? Buffer.from("\n") : Buffer.alloc(0), Buffer.from(block)]);
}
export interface OriginalMcpGitProtectionPlan {
  readonly schema: "pkm.original-mcp-git-protection/v1";
  readonly root: string;
  readonly rootIdentity: string;
  readonly gitIdentity: string;
  readonly beforeSha256: string | null;
  readonly beforeIdentity: string | null;
  readonly desiredSha256: string;
  readonly writeRequired: boolean;
  readonly planSha256: string;
}
export function planOriginalMcpGitProtection(root: string): OriginalMcpGitProtectionPlan {
  const gitStat = rootGuard(root), rootStat = lstatSync(root, { bigint: true }), before = original(root);
  if (git(root, ["ls-files", "-z", "--", ...pathspecs]).length)
    fail("private native state is already tracked; preserve and review exposure before cutover");
  const after = desired(before.bytes);
  const body = {
    schema: "pkm.original-mcp-git-protection/v1" as const, root,
    rootIdentity: [rootStat.dev, rootStat.ino, rootStat.uid, rootStat.mode].join(":"),
    gitIdentity: [gitStat.dev, gitStat.ino, gitStat.uid, gitStat.mode].join(":"),
    beforeSha256: before.sha256, beforeIdentity: before.identity,
    desiredSha256: sha(after), writeRequired: !before.bytes.equals(after),
  };
  return Object.freeze({ ...body, planSha256: sha(JSON.stringify(body)) });
}
function durable(path: string, bytes: Uint8Array | string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function applyOriginalMcpGitProtection(plan: OriginalMcpGitProtectionPlan, options: {
  writerFence: LinuxRootWriterFence; backupDirectory: string;
}): Promise<{ changed: boolean; backupDirectory: string; assertCurrent(): void }> {
  if (!isTrustedLinuxRootWriterFence(options.writerFence, plan.root)) fail("the actual original-root fence is required");
  options.writerFence.assertHeld();
  await assertLinuxLegacyWritersQuiescent(plan.root);
  if (JSON.stringify(planOriginalMcpGitProtection(plan.root)) !== JSON.stringify(plan)) fail("the inspected Git protection plan changed");
  const backup = options.backupDirectory;
  if (resolve(backup) !== backup || backup === plan.root || backup.startsWith(plan.root + "/")
    || plan.root.startsWith(backup + "/") || realpathSync(dirname(backup)) !== dirname(backup))
    fail("a new private backup outside the original root is required");
  const parent = lstatSync(dirname(backup));
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o7077) !== 0)
    fail("the backup parent is not private and owned");
  const before = original(plan.root), after = desired(before.bytes);
  mkdirSync(backup, { mode: 0o700 });
  durable(join(backup, "gitignore.before"), before.bytes);
  durable(join(backup, "protection.json"), JSON.stringify({ plan, beforeMode: before.mode,
    beforeExisted: before.sha256 !== null, restorePolicy: "retain guards while any private native state/archive remains" }));
  syncDirectory(backup); syncDirectory(dirname(backup));
  options.writerFence.assertHeld();
  await assertLinuxLegacyWritersQuiescent(plan.root);
  if (JSON.stringify(planOriginalMcpGitProtection(plan.root)) !== JSON.stringify(plan)) fail("Git policy changed before publication");
  if (plan.writeRequired) {
    atomicFileWrite(join(plan.root, ".gitignore"), after, before.sha256, randomUUID());
    chmodSync(join(plan.root, ".gitignore"), before.mode);
    const fd = openSync(join(plan.root, ".gitignore"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(plan.root);
  }
  const admitted = original(plan.root);
  const assertCurrent = () => {
    options.writerFence.assertHeld();
    if (!legacyPrivateRootGuard(plan.root)) fail("the original-root privacy boundary changed");
    const root = lstatSync(plan.root, { bigint: true }), repository = lstatSync(join(plan.root, ".git"), { bigint: true });
    if (root.isSymbolicLink() || repository.isSymbolicLink()
      || [root.dev, root.ino, root.uid, root.mode].join(":") !== plan.rootIdentity
      || [repository.dev, repository.ino, repository.uid, repository.mode].join(":") !== plan.gitIdentity)
      fail("the original Git/root identity changed");
    const current = original(plan.root);
    if (current.identity !== admitted.identity || current.sha256 !== plan.desiredSha256)
      fail("the live private-state exclusion policy changed");
  };
  const matched = new Set(git(plan.root, ["check-ignore", "--no-index", "-z", "--stdin"], samples.join("\0") + "\0")
    .split("\0").filter(Boolean));
  if (samples.some(path => !matched.has(path))) fail("private runtime paths remain exposed to Git");
  assertCurrent();
  return { changed: plan.writeRequired, backupDirectory: backup, assertCurrent };
}
