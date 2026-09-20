import { ChatMessage } from "./chatroom-protocol";
import { MeetingRecord, MeetingRoomSnapshot, MeetingStateStore } from "./meeting-state";

export class ChatMeetingLifecycle {
  constructor(private readonly store: MeetingStateStore) {}

  async adjournRoom(roomId: string, actor?: string): Promise<MeetingRecord | null> {
    for (let attempt = 0; ; attempt++) {
      const current = this.store.snapshot(roomId).current;
      if (!current) return null;
      try {
        return await this.store.adjournMeeting({
          roomId,
          meetingId: current.id,
          actor: actor || current.host,
          requestId: `room-deactivate:${current.id}`,
          expectedRevision: current.revision,
        });
      } catch (error) {
        if (!String((error as Error).message || error).includes("revision conflict") || attempt >= 2) throw error;
      }
    }
  }

  latestDiscussAfterLastMeeting(roomId: string, messages: ChatMessage[]): ChatMessage | undefined {
    return latestDiscussAfterCompletedMeeting(this.store.snapshot(roomId), messages);
  }
}

export function latestDiscussAfterCompletedMeeting(snapshot: MeetingRoomSnapshot, messages: ChatMessage[]): ChatMessage | undefined {
  const latestEndedAt = snapshot.history
    .map(meeting => Date.parse(meeting.endedAt || ""))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0] || 0;
  return [...messages].reverse().find(message =>
    !message.system && message.mode === "discuss" && Number(message.ts || 0) > latestEndedAt);
}

export function isFinalLeadSummary(message: ChatMessage, lead: string): boolean {
  return message.finalTopicSummary === true && message.from.toLocaleLowerCase() === lead.toLocaleLowerCase();
}