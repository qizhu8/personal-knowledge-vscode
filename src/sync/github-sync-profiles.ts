import { createHash } from "crypto";
import type { GitHubSyncTarget } from "./github-sync";

export function githubSyncProfileScope(target: GitHubSyncTarget): string {
  const selection = target.selection.private.profiles;
  return createHash("sha256").update(JSON.stringify({
    repository:target.repository, branch:target.branch,
    items:[...selection.items].sort(), folders:[...selection.folders].sort(),
  })).digest("hex");
}

export function githubSyncProfilesSelected(target: GitHubSyncTarget): boolean {
  return !!(target.selection.private.profiles.items.length || target.selection.private.profiles.folders.length);
}

export function githubSyncProfilesAuthorized(target: GitHubSyncTarget): boolean {
  return !!target.profileSyncConsent && target.profileSyncConsent.scope === githubSyncProfileScope(target)
    && Number.isFinite(Date.parse(target.profileSyncConsent.authorizedAt));
}

export async function authorizeGitHubSyncProfiles(
  target: GitHubSyncTarget, previous: GitHubSyncTarget | undefined, root: string, localEnabled: boolean,
  approve: () => Promise<boolean>,
): Promise<void> {
  // Webview-provided consent is never authoritative.
  delete target.profileSyncConsent;
  if (target.selection.public.profiles.items.length || target.selection.public.profiles.folders.length) {
    throw new Error("Profiles are private content. Select them only in the Private section.");
  }
  if (!githubSyncProfilesSelected(target)) return;
  if (!localEnabled) throw new Error("First enable repository Profiles in User / Agent Profiles → Profile storage / GitHub Sync. No Profiles were authorized.");
  if (previous?.profileSyncConsent?.root === root && githubSyncProfilesAuthorized(previous)
    && githubSyncProfileScope(previous) === githubSyncProfileScope(target)) {
    target.profileSyncConsent = previous.profileSyncConsent;
    return;
  }
  if (!await approve()) throw new Error("Profile Sync disclosure was not approved. The target was not saved.");
  target.profileSyncConsent = {root, scope:githubSyncProfileScope(target),authorizedAt:new Date().toISOString()};
}
