/** VS Code stores these credentials separately from github-sync/targets.json. */
const secretPrefix = "personalKnowledge.githubSync.vscode.";

export function legacyVscodeSyncCredentialReader(options: {
  targetId: string;
  expectedLogin: string;
  secretRef: string;
  readSecret(key: string, signal: AbortSignal): PromiseLike<string | undefined>;
}): (secretRef: string, signal: AbortSignal) => Promise<{ login: string; accessToken: string }> {
  const { targetId, expectedLogin, secretRef, readSecret } = options;
  if (!/^[A-Za-z0-9._-]+$/.test(targetId) || !/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(expectedLogin)
    || !secretRef || typeof readSecret !== "function") {
    throw new Error("Invalid legacy Sync credential binding.");
  }
  const key = `${secretPrefix}${targetId}`;
  return async (requested, signal) => {
    if (requested !== secretRef || signal.aborted) throw new Error("Legacy Sync credential unavailable.");
    let removeAbort = () => {};
    let raw: string | undefined;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error("Legacy Sync credential unavailable.");
          return readSecret(key, signal);
        }),
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("Legacy Sync credential unavailable."));
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
        }),
      ]);
    } catch {
      throw new Error("Legacy Sync credential unavailable.");
    } finally { removeAbort(); }
    if (signal.aborted || !raw) throw new Error("Legacy Sync credential unavailable.");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Legacy Sync credential unavailable."); }
    if (!value || typeof value !== "object"
      || !("accessToken" in value) || typeof value.accessToken !== "string" || !value.accessToken
      || !("accountLabel" in value) || typeof value.accountLabel !== "string"
      || value.accountLabel.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw new Error("Legacy Sync credential unavailable.");
    }
    return { login: value.accountLabel, accessToken: value.accessToken };
  };
}
