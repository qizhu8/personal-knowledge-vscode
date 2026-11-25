import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export const originalMcpExtensionId = "pkm-nonproduction.pkm-v5";
export interface OriginalMcpProfileBinding {
  readonly schema: "pkm.original-mcp-profile/v1";
  readonly extensionId: typeof originalMcpExtensionId;
  readonly storageDirectory: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: string;
  readonly sha256: string;
}

export function originalMcpProfileBinding(storageDirectory: string): OriginalMcpProfileBinding {
  if (process.platform !== "linux" || process.getuid === undefined
    || !isAbsolute(storageDirectory) || resolve(storageDirectory) !== storageDirectory || storageDirectory === sep)
    throw new Error("ORIGINAL_MCP_PROFILE_UNAVAILABLE: A canonical Linux extension storage directory is required.");
  let current: string = sep;
  for (const part of storageDirectory.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("ORIGINAL_MCP_PROFILE_UNAVAILABLE: Profile storage must not resolve through aliases.");
  }
  const stat = lstatSync(storageDirectory, { bigint: true });
  if (realpathSync(storageDirectory) !== storageDirectory || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o7077n) !== 0n)
    throw new Error("ORIGINAL_MCP_PROFILE_UNAVAILABLE: Profile storage must be private and owned.");
  const value: Omit<OriginalMcpProfileBinding, "sha256"> = {
    schema: "pkm.original-mcp-profile/v1", extensionId: originalMcpExtensionId,
    storageDirectory, device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid),
  };
  return Object.freeze({ ...value, sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
}
