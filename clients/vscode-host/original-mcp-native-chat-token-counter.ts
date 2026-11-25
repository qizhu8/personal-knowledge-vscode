import { setImmediate as yieldTurn } from "node:timers/promises";

export function createOriginalNativeChatTokenCounter(check: () => void) {
  let completed = 0;
  return async function<T>(count: () => PromiseLike<T>): Promise<T> {
    check();
    const value = await count();
    check();
    // Immediate native completions otherwise stay in the microtask queue.
    if (++completed >= 16) {
      completed = 0;
      await yieldTurn();
      check();
    }
    return value;
  };
}
