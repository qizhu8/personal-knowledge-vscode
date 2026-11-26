import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertOriginalMcpBrokerDirectory } from "./original-mcp-relay.js";
import { originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { acquireSharedManagerControlGuard } from "./shared-manager-control.js";

export interface LegacySharedFence {
  readonly root: string;
  readonly mode: "shared";
  assertHeld(): void;
  release(): void;
}

/** Reuse Original's shared writer fence; exclusive here would deadlock Original's own writes. */
export async function acquireCompatibilityGatewayCustody(root: string, acquireLegacyFence: (root: string) => LegacySharedFence) {
  if (process.platform !== "linux" || await realpath(root) !== root) throw new Error("Canonical Linux Original root required.");
  const identity = await lstat(root, { bigint: true });
  if (!identity.isDirectory()) throw new Error("Original root must be a directory.");
  const fence = acquireLegacyFence(root);
  let guard: Awaited<ReturnType<typeof acquireSharedManagerControlGuard>> | undefined;
  try {
    if (fence.mode !== "shared" || fence.root !== root) throw new Error("Original shared writer fence required.");
    fence.assertHeld();
    let directory = root;
    for (const component of [".pkm", "state", "compatibility-gateway"]) {
      directory = join(directory, component);
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (await realpath(directory) !== directory) throw new Error("Original custody path changed.");
    }
    assertOriginalMcpBrokerDirectory(directory);
    guard = await acquireSharedManagerControlGuard(join(directory, "owner.guard"));
    const marker = join(directory, "owner-pending.json");
    const bytes = JSON.stringify({ schema: "pkm.compatibility-gateway-custody/v1", owner: randomUUID(),
      root, device: String(identity.dev), inode: String(identity.ino) });
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        .catch(error => { if (error.code === "EEXIST") throw new Error("Original compatibility custody requires explicit recovery; no adapter was started."); throw error; });
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await dir.sync();
    } finally { await dir.close(); }
    const held = guard;
    return {
      assertHeld() {
        fence.assertHeld(); held.assertHeld();
        if (originalMcpPrivateBytes(marker, 4096).toString() !== bytes) throw new Error("Original compatibility custody changed.");
      },
      async release(confirmedClean: boolean) {
        try {
          if (confirmedClean) {
            this.assertHeld();
            const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { await unlink(marker); await dir.sync(); } finally { await dir.close(); }
          }
        } finally {
          try { await held.release(); } finally { fence.release(); }
        }
      },
    };
  } catch (error) {
    try { await guard?.release(); } finally { fence.release(); }
    throw error;
  }
}
