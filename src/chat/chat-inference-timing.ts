export interface ChatInferenceTiming {
  schema: "pkm.chat.inference-timing/v1";
  provider: "http" | "vscode";
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  maxInactivityMs: number;
  firstActivityMs?: number;
  firstPublicOutputMs?: number;
  outcome: "stream-ended" | "interrupted";
}

export class ChatInferenceClock {
  private current?: { startedAt: number; lastActivityAt: number; maxInactivityMs: number; firstActivityMs?: number; firstPublicOutputMs?: number };
  constructor(private readonly provider: ChatInferenceTiming["provider"],
    private readonly report?: (timing: ChatInferenceTiming) => void, private readonly now = Date.now) {}

  start(): void {
    if (this.current) throw new Error("An inference timing observation is already active.");
    const startedAt = this.now();
    this.current = { startedAt, lastActivityAt: startedAt, maxInactivityMs: 0 };
  }

  activity(): void {
    const current = this.current;
    if (!current) return;
    const at = this.now();
    current.maxInactivityMs = Math.max(current.maxInactivityMs, at - current.lastActivityAt);
    current.firstActivityMs ??= Math.max(0, at - current.startedAt);
    current.lastActivityAt = at;
  }

  publicOutput(): void {
    if (this.current) this.current.firstPublicOutputMs ??= Math.max(0, this.now() - this.current.startedAt);
  }

  finish(outcome: ChatInferenceTiming["outcome"]): void {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    const finishedAt = this.now();
    this.report?.({ schema: "pkm.chat.inference-timing/v1", provider: this.provider,
      startedAt: current.startedAt, finishedAt, elapsedMs: Math.max(0, finishedAt - current.startedAt),
      maxInactivityMs: Math.max(current.maxInactivityMs, finishedAt - current.lastActivityAt, 0),
      ...(current.firstActivityMs === undefined ? {} : { firstActivityMs: current.firstActivityMs }),
      ...(current.firstPublicOutputMs === undefined ? {} : { firstPublicOutputMs: current.firstPublicOutputMs }), outcome });
  }
}
