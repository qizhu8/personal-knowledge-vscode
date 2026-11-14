import { execFile } from "node:child_process";
import { HostWriterAdmission } from "./host-writer-admission";
import { legacyLinuxRootWriterChild, withLegacyLinuxRootWriterAsync } from "./linux-root-writer-fence";
import { supervisedLegacyGit } from "./linux-git-supervisor";

function runGit(root: string, args: string[], owner?: HostWriterAdmission): Promise<void> {
  const supervised = supervisedLegacyGit(args, {
    cwd: root, env: process.env, timeout: 2_147_483_647, maxBuffer: 1024 * 1024, awaitDescendants: true,
  });
  if (supervised) return supervised.then(() => {});
  if (process.platform === "linux") owner?.markUncertain("Git descendant supervision is unavailable.");
  const wrapped = legacyLinuxRootWriterChild("git", args);
  return new Promise((resolve, reject) => {
    execFile(wrapped.command, wrapped.args, { windowsHide: process.platform === "win32" }, error => error ? reject(error) : resolve());
  });
}

/** The queue retains the legacy best-effort commit behavior. */
export class HostGitQueue {
  private pending = Promise.resolve();

  constructor(private readonly owner: () => HostWriterAdmission | undefined) {}

  enqueue(root: string, message: string): void {
    const previous = this.pending;
    const owner = this.owner();
    const commit = () => previous.then(() => withLegacyLinuxRootWriterAsync(root, async () => {
      await runGit(root, ["-C", root, "add", "-A"], owner);
      await runGit(root, ["-C", root, "commit", "-m", message], owner);
    }));
    this.pending = (owner ? owner.observe("git", commit) : commit()).catch(() => {});
  }
}
