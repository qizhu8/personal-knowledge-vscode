import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { originalMcpProfileBinding } from "../../src/original-mcp-profile-binding.js";

export const originalMcpEnrollmentName = "original-mcp-enrollment.json";
export const originalMcpNativeBootstrapName = "original-mcp-native-bootstrap.json";
interface ProfilePointer<Schema extends string> {
  readonly schema: Schema;
  readonly descriptorPath: string;
  readonly descriptorSha256: string;
  readonly profileSha256: string;
}
export type OriginalMcpEnrollment = ProfilePointer<"pkm.original-mcp-enrollment/v1">;
export type OriginalMcpNativeBootstrap = ProfilePointer<"pkm.original-mcp-native-bootstrap/v1">;
const fail = (): never => {
  throw new Error("ORIGINAL_MCP_ENROLLMENT_UNAVAILABLE: Reload after verifying the exact private profile enrollment.");
};

/** Offline opt-in is frozen for this activation; it never grants ownership or keyring access. */
export function bindOriginalMcpEnrollment(storageDirectory: string) {
  return bindProfilePointer(storageDirectory, originalMcpEnrollmentName, "pkm.original-mcp-enrollment/v1");
}

export function bindOriginalMcpNativeBootstrap(storageDirectory: string) {
  return bindProfilePointer(storageDirectory, originalMcpNativeBootstrapName, "pkm.original-mcp-native-bootstrap/v1");
}

function bindProfilePointer<Schema extends string>(storageDirectory: string, name: string, schema: Schema) {
  const filename = join(storageDirectory, name);
  const read = (): { value: Readonly<ProfilePointer<Schema>>; sha256: string } | undefined => {
    let before;
    try { before = lstatSync(filename, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const profile = originalMcpProfileBinding(storageDirectory);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 8192n
      || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7077n) !== 0n) fail();
    const pin = (stat: typeof before) => [
      stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
    ].map(String).join(":");
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (pin(fstatSync(fd, { bigint: true })) !== pin(before)) fail();
      bytes = readFileSync(fd);
      if (pin(fstatSync(fd, { bigint: true })) !== pin(before)
        || pin(lstatSync(filename, { bigint: true })) !== pin(before) || BigInt(bytes.length) !== before.size) fail();
    } finally { closeSync(fd); }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return fail(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "descriptorPath,descriptorSha256,profileSha256,schema"
      || record.schema !== schema
      || typeof record.descriptorPath !== "string" || !isAbsolute(record.descriptorPath)
      || resolve(record.descriptorPath) !== record.descriptorPath
      || typeof record.descriptorSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.descriptorSha256)
      || record.profileSha256 !== profile.sha256) return fail();
    const enrollment: ProfilePointer<Schema> = {
      schema, descriptorPath: record.descriptorPath,
      descriptorSha256: record.descriptorSha256, profileSha256: profile.sha256,
    };
    return { value: Object.freeze(enrollment), sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const initial = read();
  return Object.freeze({
    current(): Readonly<ProfilePointer<Schema>> | undefined {
      const current = read();
      if (current?.sha256 !== initial?.sha256) fail();
      return current?.value;
    },
  });
}
