import { ClientError, type ChatEvent, type ManagerEvent, type VscodeClient } from "./client.ts";

export interface ActivityPage<T> {
  events: T[]; cursor: number; gap: boolean; hasMore: boolean;
}

// Each tracker is scoped to one immutable turn/run. Disposing only stops observation.
export class ChatActivity {
  private cursor = 0;
  private gap = false;
  constructor(private readonly client: VscodeClient, private readonly id: string) {}
  async next(signal?: AbortSignal): Promise<ActivityPage<ChatEvent>> {
    const page = await this.client.chatEvents({ id: this.id, after: this.cursor, limit: 100 }, signal);
    if (!Array.isArray(page.events)) throw new ClientError("INVALID_CURSOR");
    const events: ChatEvent[] = [];
    let cursor = this.cursor;
    let gap = this.gap;
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor || typeof event.type !== "string")
        throw new ClientError("INVALID_CURSOR");
      if (event.sequence !== cursor + 1) gap = true;
      cursor = event.sequence; events.push(event);
    }
    if (page.next !== null && (!Number.isSafeInteger(page.next) || page.next < cursor)) throw new ClientError("INVALID_CURSOR");
    this.cursor = cursor; this.gap = gap;
    return { events, cursor: this.cursor, gap: this.gap, hasMore: page.next !== null };
  }
}

export class ManagerActivity {
  private cursor = 0;
  private opaqueCursor: string | undefined;
  private gap = false;
  constructor(private readonly client: VscodeClient, private readonly runId: string) {}
  async next(signal?: AbortSignal): Promise<ActivityPage<ManagerEvent>> {
    const page = await this.client.managerEvents({ runId: this.runId,
      ...(this.opaqueCursor ? { cursor: this.opaqueCursor } : { afterSeq: this.cursor }), limit: 100 }, signal);
    if (page.schema !== "pkm.manager.progress.events/v1" || page.runId !== this.runId || !Array.isArray(page.events) ||
        !Array.isArray(page.gaps) || !Number.isSafeInteger(page.nextSeq) || page.nextSeq < this.cursor ||
        typeof page.nextCursor !== "string" || typeof page.hasMore !== "boolean") throw new ClientError("INVALID_CURSOR");
    let gap = this.gap || page.gaps.length > 0;
    let cursor = this.cursor;
    const events: ManagerEvent[] = [];
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor || event.sequence > page.nextSeq ||
          typeof event.kind !== "string") throw new ClientError("INVALID_CURSOR");
      if (event.sequence !== cursor + 1) gap = true;
      cursor = event.sequence; events.push(event);
    }
    if (page.nextSeq > cursor) gap = true;
    this.cursor = page.nextSeq; this.opaqueCursor = page.nextCursor; this.gap = gap;
    return { events, cursor: this.cursor, gap: this.gap, hasMore: page.hasMore };
  }
}
