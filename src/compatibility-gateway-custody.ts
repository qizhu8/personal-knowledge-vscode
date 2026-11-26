import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
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

async function rootDirectory(root: string) {
  if (process.platform !== "linux" || await realpath(root) !== root) throw new Error("Canonical Linux Original root required.");
  const identity = await lstat(root, { bigint: true });
  if (!identity.isDirectory() || identity.uid !== BigInt(process.getuid!()) || (identity.mode & 0o022n) !== 0n)
    throw new Error("Original root must be owner-owned without group/other writes.");
  let directory = root;
  for (const component of [".pkm", "state", "compatibility-gateway"]) {
    directory = join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (await realpath(directory) !== directory) throw new Error("Original custody path changed.");
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid!()
      || (identity.mode & 0o077n) !== 0n && (stat.mode & 0o022) !== 0)
      throw new Error("Original custody ancestry is not owner-write-only.");
  }
  assertOriginalMcpBrokerDirectory(directory);
  return { directory, identity };
}

async function acquireRoute(root: string, mode: "live" | "cold", acquireLegacyFence?: (root: string) => LegacySharedFence) {
  let guard: Awaited<ReturnType<typeof acquireSharedManagerControlGuard>> | undefined;
  let fence: LegacySharedFence | undefined;
  try {
    const { directory, identity } = await rootDirectory(root);
    guard = await acquireSharedManagerControlGuard(join(directory, "owner.guard"), mode === "live" ? "exclusive" : "shared");
    const existing = await readdir(directory);
    if (existing.includes("owner-pending.json") || mode === "live"
      && existing.some(name => name.startsWith("cold-pending-") || name.startsWith("original-pending-")))
      throw new Error("Original compatibility custody requires explicit recovery; no adapter was started.");
    const owner = randomUUID();
    const launchGrant = mode === "live" ? randomBytes(32).toString("hex") : undefined;
    const marker = join(directory, mode === "live" ? "owner-pending.json" : `cold-pending-${owner}.json`);
    const bytes = JSON.stringify({ schema: "pkm.compatibility-gateway-custody/v1", owner,
      root, device: String(identity.dev), inode: String(identity.ino),
      ...(launchGrant ? { launchGrantSha256: createHash("sha256").update(launchGrant).digest("hex") } : {}) });
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        .catch(error => { if (error.code === "EEXIST") throw new Error("Original compatibility custody requires explicit recovery; no adapter was started."); throw error; });
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await dir.sync();
    } finally { await dir.close(); }
    // Publish restart inhibition before testing the old writers' lifetime fence.
    // A crash leaves the durable marker; an orderly admission refusal can undo it.
    try {
      if (mode === "live") {
        fence = acquireLegacyFence?.(root);
        if (fence?.mode !== "shared" || fence.root !== root) throw new Error("Original shared writer fence required.");
        fence.assertHeld();
      }
    } catch (error) {
      await unlink(marker);
      throw error;
    }
    const held = guard;
    return {
      launchGrant,
      assertHeld() {
        fence?.assertHeld(); held.assertHeld();
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
          try { await held.release(); } finally { fence?.release(); }
        }
      },
    };
  } catch (error) {
    try { await guard?.release(); } finally { fence?.release(); }
    throw error;
  }
}

/** Reuse Original's shared writer fence; exclusive here would deadlock Original's own writes. */
export function acquireCompatibilityGatewayCustody(root: string, acquireLegacyFence: (root: string) => LegacySharedFence) {
  return acquireRoute(root, "live", acquireLegacyFence);
}

/** Every packaged cold stdio process holds the same guard through its own Original drain. */
export function acquireColdCompatibilityGatewayCustody(root: string) {
  return acquireRoute(root, "cold");
}
