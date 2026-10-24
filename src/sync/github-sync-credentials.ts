import type { GitHubSyncCredentials, GitHubSyncTarget } from "./github-sync";

export class GitHubSyncCredentialError extends Error {
  readonly phase = "authenticating";

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitHubSyncCredentialError";
  }
}

export async function readStoredGitHubSyncCredentials(
  readSecret: () => PromiseLike<string | undefined>,
  target: GitHubSyncTarget,
  timeoutMs = 10_000,
): Promise<GitHubSyncCredentials | undefined> {
  if (target.authentication?.method !== "vscode") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: string | undefined;
  try {
    raw = await new Promise<string | undefined>((resolve, reject) => {
      timer = setTimeout(() => reject(new GitHubSyncCredentialError("CREDENTIAL_READ_TIMEOUT",
        "VS Code credential storage did not respond within 10 seconds. Reload this window, then retry Sync. GitHub was not contacted.")), timeoutMs);
      // A late RPC result must not resume a timed-out synchronization.
      Promise.resolve().then(readSecret).then(resolve, reject);
    });
  } catch (error) {
    if (error instanceof GitHubSyncCredentialError) throw error;
    const canceled = error instanceof Error && /^(Canceled|Cancelled|CancellationError)$/i.test(error.name)
      || error instanceof Error && /^(Canceled|Cancelled)$/i.test(error.message);
    throw new GitHubSyncCredentialError(canceled ? "CREDENTIAL_READ_CANCELED" : "CREDENTIAL_READ_FAILED",
      canceled
        ? "VS Code canceled credential access. Reload this window, then retry Sync. GitHub was not contacted."
        : "Could not read VS Code credential storage. Reload this window, then retry Sync. GitHub was not contacted.");
  } finally { clearTimeout(timer); }
  if (!raw) throw new GitHubSyncCredentialError("CREDENTIAL_MISSING",
    `No saved GitHub credential. Use Test Account to reconnect ${target.authentication.expectedLogin}.`);
  let stored: unknown;
  try { stored = JSON.parse(raw); }
  catch { throw new GitHubSyncCredentialError("CREDENTIAL_INVALID", "The saved GitHub credential is invalid. Reconnect using Test Account."); }
  if (!stored || typeof stored !== "object" || !("accessToken" in stored) || typeof stored.accessToken !== "string" || !stored.accessToken
    || !("accountLabel" in stored) || typeof stored.accountLabel !== "string") {
    throw new GitHubSyncCredentialError("CREDENTIAL_INVALID", "The saved GitHub credential is invalid. Reconnect using Test Account.");
  }
  if (stored.accountLabel.toLowerCase() !== target.authentication.expectedLogin.toLowerCase()) {
    throw new GitHubSyncCredentialError("CREDENTIAL_ACCOUNT_MISMATCH",
      `The saved GitHub account does not match ${target.authentication.expectedLogin}. Reconnect using Test Account.`);
  }
  return { accessToken: stored.accessToken };
}
