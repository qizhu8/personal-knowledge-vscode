import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { verifyOriginalMcpBrokerDescriptor } from "./original-mcp-broker-descriptor.js";
import { assertOriginalMcpBrokerDirectory } from "./original-mcp-relay.js";

/** Publishes a token-free v4 hot-switch locator for a separately admitted live v5 broker. */
export async function writeOriginalMcpHotSwitchTarget(input: {
  descriptorPath: string; descriptorSha256: string;
  profileSha256: string; knowledgeRoot: string; targetPath: string;
}) {
  if (typeof input.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.profileSha256))
    throw new Error("NATIVE_HOT_SWITCH_TARGET_PROFILE_REQUIRED");
  const verified = await verifyOriginalMcpBrokerDescriptor(input.descriptorPath, input.descriptorSha256, input.profileSha256);
  if (!verified.writable || verified.scope !== "native-dogfood/v1" || verified.root !== input.knowledgeRoot)
    throw new Error("NATIVE_HOT_SWITCH_TARGET_UNQUALIFIED: An admitted writable native dogfood broker for this exact root is required.");
  if (!isAbsolute(input.targetPath) || resolve(input.targetPath) !== input.targetPath)
    throw new Error("NATIVE_HOT_SWITCH_TARGET_PATH_REQUIRED");
  assertOriginalMcpBrokerDirectory(dirname(input.targetPath));
  const within = relative(verified.root, input.targetPath);
  if (within === "" || within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
    throw new Error("NATIVE_HOT_SWITCH_TARGET_OUTSIDE_ROOT_REQUIRED");
  const target = {
    schema: "pkm.mcp-runtime-target/v1" as const, knowledgeRoot: verified.root,
    command: { path: verified.nodePath, sha256: verified.nodeSha256 },
    entry: { path: verified.relayPath, sha256: verified.relaySha256 },
    args: ["relay", "--descriptor", input.descriptorPath, "--pin", input.descriptorSha256],
    cwd: dirname(input.descriptorPath), expectedVersion: "0.1.0", runtimeBuild: verified.runtimeBuildSha256,
  };
  const bytes = Buffer.from(JSON.stringify(target));
  const fd = await open(input.targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  const directory = await open(dirname(input.targetPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  await verifyOriginalMcpBrokerDescriptor(input.descriptorPath, input.descriptorSha256, input.profileSha256);
  return { path: input.targetPath, sha256: createHash("sha256").update(bytes).digest("hex"),
    root: verified.root, expectedVersion: target.expectedVersion, runtimeBuild: target.runtimeBuild,
    scope: verified.scope, connectionVerified: false as const };
}
