export async function withAsyncDeadline<T>(pending: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Async deadline must be positive.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.then(resolve, reject);
      cancel = () => reject(new Error("Request cancelled."));
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
