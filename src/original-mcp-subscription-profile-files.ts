import { createHash, createPublicKey } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { originalMcpProfileBinding } from "./original-mcp-profile-binding.js";
import { originalNativeSourceRequestDigest } from "./original-mcp-native-source-contracts.js";
import { currentSubscriptionProfileFile, verifyCurrentSubscriptionManifest,
  type CurrentSubscriptionManifest } from "./original-mcp-subscription-profile-contracts.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const originalCurrentSubscriptionDirectory = "native-subscriptions";
const fail = (): never => { throw Object.assign(new Error("NATIVE_SUBSCRIPTION_PROFILE_INVALID"), { code: "NATIVE_SUBSCRIPTION_PROFILE_INVALID" }); };
/** Reads only explicitly pinned current public source paths, never a legacy profile tree or unknown fields. */
export function readCurrentSubscriptionFile(profile: string, path: string, maximum: number): Buffer | undefined {
  if (/[\0\\]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) return fail();
  const binding = originalMcpProfileBinding(profile), descriptors: number[] = [];
  const root = openSync(profile, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  descriptors.push(root);
  try {
    const rootStat = fstatSync(root, { bigint: true });
    if (String(rootStat.dev) !== binding.device || String(rootStat.ino) !== binding.inode) return fail();
    let parent = root;
    const parts = path.split("/");
    // Pin each ancestor before opening its child; a swapped ancestor cannot redirect a read outside this profile.
    for (const part of parts.slice(0, -1)) {
      const child = `/proc/self/fd/${parent}/${part}`;
      const before = lstatSync(child, { bigint: true, throwIfNoEntry: false });
      if (!before) return undefined;
      if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n)) return fail();
      const fd = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(fd);
      const after = fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino) return fail();
      parent = fd;
    }
    const file = `/proc/self/fd/${parent}/${parts.at(-1)!}`, before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before) return undefined;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)
      || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n)) return fail();
    const pin = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    descriptors.push(fd);
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), named = lstatSync(join(profile, path), { bigint: true });
    if (pin(before) !== pin(after) || pin(before) !== pin(named) || BigInt(bytes.length) !== before.size
      || originalMcpProfileBinding(profile).sha256 !== binding.sha256) return fail();
    return bytes;
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
export function captureCurrentSubscriptionManifest(input: {
  profile: string; root: string; workspaceId: string; profileSha256: string; identitySha256: string;
  nativeEpoch: string; nativePublicKey: string;
}): CurrentSubscriptionManifest {
  const profile = originalMcpProfileBinding(input.profile);
  if (profile.sha256 !== input.profileSha256) return fail();
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || !path.startsWith("..") && !isAbsolute(path);
  };
  if (overlaps(input.root, input.profile) || overlaps(input.profile, input.root)) return fail();
  const publicKey = createPublicKey({ key: Buffer.from(input.nativePublicKey, "base64"), format: "der", type: "spki" })
    .export({ type: "spki", format: "pem" }).toString();
  const raw = readCurrentSubscriptionFile(input.profile, `${originalCurrentSubscriptionDirectory}/current.json`, 65536);
  let file: ReturnType<typeof currentSubscriptionProfileFile.parse>;
  if (raw) {
    try { file = currentSubscriptionProfileFile.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
    catch { return fail(); }
    if (file.root !== input.root || file.workspaceId !== input.workspaceId || file.profileSha256 !== profile.sha256
      || file.identitySha256 !== input.identitySha256) return fail();
  } else {
    file = { schema: "pkm.original-native-subscription-profile/v1", root: input.root, workspaceId: input.workspaceId,
      profileSha256: input.profileSha256, identitySha256: input.identitySha256, sourceEpoch: input.nativeEpoch, revision: 0,
      state: { schema: 1, nodeId: hash(publicKey), publicKey, shares: [], subscriptions: [] }, files: [] };
  }
  if (file.state.publicKey !== publicKey || file.state.nodeId !== hash(publicKey)) return fail();
  for (const member of file.state.subscriptions) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(member.endpoint)) {
      let endpoint: URL;
      try { endpoint = new URL(member.endpoint); } catch { return fail(); }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return fail();
    }
  }
  const body = { ...file, schema: "pkm.original-native-subscription-current/v1" as const, profile: input.profile,
    nativeEpoch: input.nativeEpoch, defaultEmpty: !raw, stateFileSha256: raw ? hash(raw) : null };
  const result = verifyCurrentSubscriptionManifest({ ...body, head: originalNativeSourceRequestDigest(body) });
  const known = new Set(result.state.subscriptions.map(member => `${member.nodeId}/${member.shareId}`));
  for (const file of result.files) {
    const parts = file.path.split("/");
    if (!known.has(parts.slice(1, 3).join("/"))
      || !(parts.length === 4 && ["_subscription.json", "summary.json", "bundle.json", "bundle.encrypted.json"].includes(parts[3]!)
        || parts[3] === "content" && /^(skills|notes|papers|prompts|scripts|packages|servers|recipes)$/.test(parts[4] ?? ""))) return fail();
    const bytes = readCurrentSubscriptionFile(input.profile, `${originalCurrentSubscriptionDirectory}/${file.path}`, file.size);
    if (!bytes || bytes.length !== file.size || hash(bytes) !== file.sha256) return fail();
  }
  const after = readCurrentSubscriptionFile(input.profile, `${originalCurrentSubscriptionDirectory}/current.json`, 65536);
  if ((after ? hash(after) : null) !== result.stateFileSha256 || originalMcpProfileBinding(input.profile).sha256 !== profile.sha256) return fail();
  return result;
}
