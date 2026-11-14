import { createHash, createPublicKey } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const actor = { id: "local:subscription-fixture", canWrite: false };
export const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function durableJson(path, value, exclusive = false) {
  const file = await open(path, exclusive ? "wx" : "w", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
const json = async path => JSON.parse(await readFile(path, "utf8"));

// Native-owned durable authority fixture. It never sources approvals from a
// workspace/backup, and neither restart nor restore requires an in-memory key.
export function nativePolicy(vault) {
  const policyPath = join(vault, "policy.json");
  const authority = {
    async approve(binding) {
      const policy = await json(policyPath);
      return !policy.revoked && sha(binding) === policy.bindingSha256;
    },
    async inspect(binding) {
      const policy = await json(policyPath);
      if (policy.inspectUnknown) return "unknown";
      let secret;
      try { secret = await json(join(vault, "secret.json")); }
      catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
      const publicKey = createPublicKey(secret.privateKey).export({ type: "spki", format: "pem" }).toString();
      return secret.bindingSha256 === sha(binding) && publicKey === binding.publicKey ? "committed" : "unknown";
    },
    async store(binding, privateKey) {
      const policy = await json(policyPath);
      if (!await authority.approve(binding)) return "unknown";
      await durableJson(join(vault, "secret.json"), { bindingSha256: sha(binding), privateKey }, true);
      await durableJson(join(vault, "store-call.json"), { calls: 1 }, true);
      if (policy.mutateSource) {
        const source = join(binding.subscriptionRoot, "subscriptions.json");
        const file = await open(source, "a");
        try { await file.writeFile("\n"); await file.sync(); } finally { await file.close(); }
      }
      if (policy.revokeDuringStore) await durableJson(policyPath, { ...policy, revoked: true });
      if (policy.unknownAfterStore) throw new Error(privateKey);
      return "committed";
    },
  };
  return {
    actorId: actor.id, ownerEpoch: "native-owner-1", authority,
    async authorize(request) {
      const policy = await json(policyPath);
      if (policy.revoked || request.actorId !== actor.id || request.ownerEpoch !== policy.ownerEpoch
        || request.workspaceId !== policy.workspaceId || sha(request.binding) !== policy.bindingSha256) return false;
      const stat = await lstat(request.root, { bigint: true });
      if (request.rootPin.device !== String(stat.dev) || request.rootPin.inode !== String(stat.ino)) return false;
      const read = request.purpose === "read" && policy.readRoots.includes(request.root);
      const backup = request.purpose === "backup" && request.destination === policy.backup
        && (request.root === policy.target || request.root.startsWith(join(policy.fixtureRoot, ".pkm-backup.")));
      const restore = request.purpose === "restore" && request.destination === policy.restored
        && (request.root === policy.backup || request.root.startsWith(join(policy.fixtureRoot, ".pkm-restore.")));
      if (!read && !backup && !restore) return false;
      if (policy.denyRestore && restore) return false;
      // Native approval persists the exact physical root/request, not just the
      // fixture scope. These approval records are outside every workspace tree.
      const approval = join(vault, `approval-${sha(request)}.json`);
      try { await durableJson(approval, request, true); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      return sha(await json(approval)) === sha(request);
    },
  };
}
export async function initializeVault(vault, policy) {
  await mkdir(vault, { mode: 0o700 });
  await durableJson(join(vault, "policy.json"), policy, true);
}
export async function changePolicy(vault, changes) {
  const path = join(vault, "policy.json");
  await durableJson(path, { ...await json(path), ...changes });
}
