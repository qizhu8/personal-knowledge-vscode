import { rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const retryable = new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const delays = [50, 100, 200, 400, 800, 800, 800];

/** Call only with an exact preflighted Trash bucket under the workspace writer. */
export async function removeTrashBucket(
  path: string,
  operations: {
    remove?: (path: string) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  // Node's rm handles Windows read-only attributes and platform-specific unlink/rmdir.
  const remove = operations.remove ?? (target => rm(target, { recursive: true, force: true, maxRetries: 0 }));
  const sleep = operations.sleep ?? setTimeout;
  for (let attempt = 0; ; attempt++) {
    try { await remove(path); return; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      if (!(error instanceof Error) || !("code" in error) || !retryable.has(String(error.code))
        || attempt >= delays.length) throw error;
      await sleep(delays[attempt]!);
    }
  }
}
