export interface RestoredWebviewRecoveryOptions {
  restored: boolean;
  isReady: () => boolean;
  isCurrent: () => boolean;
  recover: () => void;
  delayMs?: number;
  schedule?: typeof setTimeout;
}

export function scheduleRestoredWebviewRecovery(
  options: RestoredWebviewRecoveryOptions,
): ReturnType<typeof setTimeout> | undefined {
  if (!options.restored) return undefined;
  const schedule = options.schedule || setTimeout;
  return schedule(() => {
    if (options.isReady() || !options.isCurrent()) return;
    options.recover();
  }, options.delayMs ?? 10_000);
}
