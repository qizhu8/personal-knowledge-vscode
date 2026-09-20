import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { withCrossProcessLock } from "./cross-process-lock";

export type MeetingStatus = "active" | "adjourned" | "trashed";

export interface MeetingRound {
  id: string;
  number: number;
  status: "active" | "completed";
  opinions: Array<{ participant: string; text: string; sourceMessageId?: string }>;
  conclusion?: string;
  next?: string;
}

export interface MeetingTopic {
  id: string;
  title: string;
  problemStatement: string;
  owner: string;
  decisionOwner: string;
  status: "discussing" | "completed" | "blocked";
  round: number;
  rounds: MeetingRound[];
  workItems: unknown[];
  subtopics: MeetingTopic[];
}

export interface MeetingEvent {
  sequence: number;
  type: "MeetingStarted" | "MeetingSummaryUpdated" | "MeetingAdjourned" | "MeetingTrashed" | "MeetingRestored";
  recordedAt: string;
  actor: string;
  requestId: string;
  data: Record<string, unknown>;
}

export interface MeetingRecord {
  schema: 1;
  id: string;
  roomId: string;
  roomName: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  endedAt?: string;
  deletedAt?: string;
  lead: string;
  recorder: string;
  participants: string[];
  host: string;
  triggerMessageId: string;
  revision: number;
  activeTopicId?: string;
  topicEpoch: number;
  phase: "discussion" | "adjourned";
  topics: MeetingTopic[];
  events: MeetingEvent[];
  handledRequestIds: string[];
  markdownPath: string;
}

export interface MeetingRoomSnapshot {
  current: MeetingRecord | null;
  history: MeetingRecord[];
  trash: MeetingRecord[];
}

interface StartMeetingInput {
  roomId: string;
  roomName: string;
  title: string;
  problemStatement: string;
  owner: string;
  lead: string;
  recorder: string;
  participants: string[];
  host: string;
  triggerMessageId: string;
  requestId: string;
  expectedRevision: number;
  startedAt?: string;
}

interface AdjournMeetingInput {
  roomId: string;
  meetingId: string;
  actor: string;
  requestId: string;
  expectedRevision: number;
  endedAt?: string;
}

interface RecordMeetingMessageInput {
  roomId: string;
  participant: string;
  text: string;
  sourceMessageId: string;
  finalLeadSummary?: boolean;
  recordedAt?: string;
}

interface MeetingMutationInput {
  roomId: string;
  meetingId: string;
  actor: string;
  requestId: string;
  expectedRevision: number;
}

interface MeetingIndex { schema: 1; meetings: MeetingRecord[]; deletedRequestIds?: string[]; }

function safeSegment(value: string): string {
  const cleaned = String(value || "room").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "room";
}

function utcFileStem(iso: string): string { return iso.replace(/[:.]/g, "-"); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function discussionIdea(text: string): string {
  const cleaned = text.trim()
    .replace(/^(?:@(?:"[^"\n]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})\s*)+/u, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 220) return cleaned;
  const sentence = cleaned.slice(0, 220).match(/^.*?[。！？.!?](?:\s|$)/u)?.[0]?.trim();
  return sentence && sentence.length >= 40 ? sentence : `${cleaned.slice(0, 217).trimEnd()}...`;
}

export class MeetingStateStore {
  constructor(private readonly chatroomsRoot: string, private readonly notesRoot: string) {}

  private roomDir(roomId: string): string { return path.join(this.chatroomsRoot, safeSegment(roomId), "meetings"); }
  private statePath(roomId: string): string { return path.join(this.roomDir(roomId), "canonical.json"); }
  private lockPath(roomId: string): string { return path.join(this.roomDir(roomId), ".canonical.lock"); }

  private read(roomId: string): MeetingIndex {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(roomId), "utf8"));
      if (parsed?.schema !== 1 || !Array.isArray(parsed.meetings)) throw new Error("unsupported Meeting state schema");
      for (const meeting of parsed.meetings as MeetingRecord[]) {
        meeting.recorder ||= meeting.lead;
        if (!Array.isArray(meeting.participants)) meeting.participants = [...new Set([meeting.host, meeting.lead].filter(Boolean))];
        if (!Array.isArray(meeting.handledRequestIds)) meeting.handledRequestIds = [];
      }
      if (!Array.isArray(parsed.deletedRequestIds)) parsed.deletedRequestIds = [];
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schema: 1, meetings: [] };
      throw new Error(`Cannot read Meeting state: ${error?.message || String(error)}`);
    }
  }

  private write(roomId: string, state: MeetingIndex): void {
    const target = this.statePath(roomId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  snapshot(roomId: string): MeetingRoomSnapshot {
    if (!roomId) return { current: null, history: [], trash: [] };
    const meetings = this.read(roomId).meetings.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return {
      current: clone(meetings.find(meeting => meeting.status === "active") || null),
      history: clone(meetings.filter(meeting => meeting.status === "adjourned")),
      trash: clone(meetings.filter(meeting => meeting.status === "trashed")
        .sort((left, right) => String(right.deletedAt || "").localeCompare(String(left.deletedAt || "")))),
    };
  }

  async startMeeting(input: StartMeetingInput): Promise<MeetingRecord> {
    return withCrossProcessLock(this.lockPath(input.roomId), "Meeting state", 5_000, async () => {
      const state = this.read(input.roomId);
      const duplicate = state.meetings.find(meeting => meeting.handledRequestIds.includes(input.requestId));
      if (duplicate) return clone(duplicate);
      if (state.meetings.some(meeting => meeting.status === "active")) throw new Error("This Room already has an active Meeting.");
      if (input.expectedRevision !== 0) throw new Error(`Meeting revision conflict: expected 0, received ${input.expectedRevision}.`);
      if (!input.triggerMessageId.trim()) throw new Error("A Discuss trigger message is required.");
      const startedAt = input.startedAt || new Date().toISOString();
      const meetingId = randomUUID();
      const topicId = randomUUID();
      const roundId = randomUUID();
      const markdownPath = path.join("Chatroom Meetings", safeSegment(input.roomName), `${utcFileStem(startedAt)}.md`);
      const meeting: MeetingRecord = {
        schema: 1, id: meetingId, roomId: input.roomId, roomName: input.roomName,
        title: input.title.trim() || "Untitled Meeting", status: "active", startedAt,
        lead: input.lead, recorder: input.recorder, participants: [...new Set(input.participants.map(value => value.trim()).filter(Boolean))],
        host: input.host, triggerMessageId: input.triggerMessageId,
        revision: 1, activeTopicId: topicId, topicEpoch: 1, phase: "discussion",
        topics: [{
          id: topicId, title: input.title.trim() || "Initial Topic", problemStatement: input.problemStatement.trim(),
          owner: input.owner, decisionOwner: input.host, status: "discussing", round: 1,
          rounds: [{ id: roundId, number: 1, status: "active", opinions: [] }], workItems: [], subtopics: [],
        }],
        events: [{ sequence: 1, type: "MeetingStarted", recordedAt: startedAt, actor: input.lead, requestId: input.requestId,
          data: { triggerMessageId: input.triggerMessageId, topicId, roundId } }],
        handledRequestIds: [input.requestId], markdownPath,
      };
      state.meetings.push(meeting);
      this.write(input.roomId, state);
      this.writeMarkdown(meeting);
      return clone(meeting);
    });
  }

  async adjournMeeting(input: AdjournMeetingInput): Promise<MeetingRecord> {
    return withCrossProcessLock(this.lockPath(input.roomId), "Meeting state", 5_000, async () => {
      const state = this.read(input.roomId);
      const meeting = state.meetings.find(candidate => candidate.id === input.meetingId);
      if (!meeting) throw new Error("Meeting was not found.");
      if (meeting.handledRequestIds.includes(input.requestId)) return clone(meeting);
      if (meeting.status !== "active") throw new Error("Meeting is already adjourned.");
      if (meeting.revision !== input.expectedRevision) throw new Error(`Meeting revision conflict: expected ${meeting.revision}, received ${input.expectedRevision}.`);
      const recordedAt = input.endedAt || new Date().toISOString();
      meeting.status = "adjourned";
      meeting.endedAt = recordedAt;
      meeting.phase = "adjourned";
      meeting.activeTopicId = undefined;
      meeting.revision++;
      meeting.handledRequestIds.push(input.requestId);
      meeting.events.push({ sequence: meeting.events.length + 1, type: "MeetingAdjourned", recordedAt, actor: input.actor, requestId: input.requestId, data: {} });
      this.write(input.roomId, state);
      this.writeMarkdown(meeting);
      return clone(meeting);
    });
  }

  async recordDiscussionMessage(input: RecordMeetingMessageInput): Promise<MeetingRecord | null> {
    return withCrossProcessLock(this.lockPath(input.roomId), "Meeting state", 5_000, async () => {
      const state = this.read(input.roomId);
      const meeting = state.meetings.find(candidate => candidate.status === "active");
      if (!meeting) return null;
      const topic = meeting.topics.find(candidate => candidate.id === meeting.activeTopicId);
      const round = topic?.rounds.find(candidate => candidate.status === "active");
      const participant = input.participant.trim();
      const text = discussionIdea(input.text);
      if (!topic || !round || !participant || !text || !input.sourceMessageId.trim()) return clone(meeting);
      const requestId = `message:${input.sourceMessageId}`;
      if (input.sourceMessageId === meeting.triggerMessageId || meeting.handledRequestIds.includes(requestId)) {
        return clone(meeting);
      }
      const isLeadSummary = input.finalLeadSummary === true && participant.toLocaleLowerCase() === meeting.lead.toLocaleLowerCase();
      if (isLeadSummary) {
        round.conclusion = text;
      } else {
        const existing = round.opinions.find(opinion => opinion.participant.toLocaleLowerCase() === participant.toLocaleLowerCase());
        if (existing) Object.assign(existing, { text, sourceMessageId: input.sourceMessageId });
        else round.opinions.push({ participant, text, sourceMessageId: input.sourceMessageId });
      }
      if (!meeting.participants.some(value => value.toLocaleLowerCase() === participant.toLocaleLowerCase())) meeting.participants.push(participant);
      const recordedAt = input.recordedAt || new Date().toISOString();
      meeting.revision++;
      meeting.handledRequestIds.push(requestId);
      meeting.events.push({
        sequence: meeting.events.length + 1,
        type: "MeetingSummaryUpdated",
        recordedAt,
        actor: participant,
        requestId,
        data: { sourceMessageId: input.sourceMessageId, topicId: topic.id, roundId: round.id, leadSummary: isLeadSummary },
      });
      this.write(input.roomId, state);
      this.writeMarkdown(meeting);
      return clone(meeting);
    });
  }

  async moveToTrash(input: MeetingMutationInput): Promise<MeetingRecord> {
    return this.mutateHistoricalMeeting(input, "trash");
  }

  async restoreFromTrash(input: MeetingMutationInput): Promise<MeetingRecord> {
    return this.mutateHistoricalMeeting(input, "restore");
  }

  async permanentlyDelete(input: MeetingMutationInput): Promise<{ id: string }> {
    return withCrossProcessLock(this.lockPath(input.roomId), "Meeting state", 5_000, async () => {
      const state = this.read(input.roomId);
      if (state.deletedRequestIds?.includes(input.requestId)) return { id: input.meetingId };
      const index = state.meetings.findIndex(candidate => candidate.id === input.meetingId);
      if (index < 0) throw new Error("Meeting was not found.");
      const meeting = state.meetings[index];
      if (meeting.status !== "trashed") throw new Error("Only a Meeting in Trash can be permanently deleted.");
      if (meeting.revision !== input.expectedRevision) throw new Error(`Meeting revision conflict: expected ${meeting.revision}, received ${input.expectedRevision}.`);
      state.meetings.splice(index, 1);
      state.deletedRequestIds = [...(state.deletedRequestIds || []), input.requestId].slice(-256);
      this.write(input.roomId, state);
      this.removeMarkdown(meeting);
      return { id: meeting.id };
    });
  }

  private async mutateHistoricalMeeting(input: MeetingMutationInput, action: "trash" | "restore"): Promise<MeetingRecord> {
    return withCrossProcessLock(this.lockPath(input.roomId), "Meeting state", 5_000, async () => {
      const state = this.read(input.roomId);
      const meeting = state.meetings.find(candidate => candidate.id === input.meetingId);
      if (!meeting) throw new Error("Meeting was not found.");
      if (meeting.handledRequestIds.includes(input.requestId)) return clone(meeting);
      const expectedStatus = action === "trash" ? "adjourned" : "trashed";
      if (meeting.status !== expectedStatus) throw new Error(action === "trash" ? "Only an adjourned Meeting can be moved to Trash." : "Only a Meeting in Trash can be restored.");
      if (meeting.revision !== input.expectedRevision) throw new Error(`Meeting revision conflict: expected ${meeting.revision}, received ${input.expectedRevision}.`);
      const recordedAt = new Date().toISOString();
      meeting.status = action === "trash" ? "trashed" : "adjourned";
      meeting.deletedAt = action === "trash" ? recordedAt : undefined;
      meeting.revision++;
      meeting.handledRequestIds.push(input.requestId);
      meeting.events.push({ sequence: meeting.events.length + 1, type: action === "trash" ? "MeetingTrashed" : "MeetingRestored", recordedAt, actor: input.actor, requestId: input.requestId, data: {} });
      this.write(input.roomId, state);
      if (action === "trash") this.removeMarkdown(meeting); else this.writeMarkdown(meeting);
      return clone(meeting);
    });
  }

  private removeMarkdown(meeting: MeetingRecord): void {
    try { fs.unlinkSync(path.join(this.notesRoot, meeting.markdownPath)); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }

  private writeMarkdown(meeting: MeetingRecord): void {
    const target = path.join(this.notesRoot, meeting.markdownPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = this.markdown(meeting);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  markdown(meeting: MeetingRecord): string {
    const lines = [
      "---", `title: ${JSON.stringify(meeting.title)}`, "type: meeting", `meeting_id: ${meeting.id}`,
      `room_id: ${meeting.roomId}`, `started_at: ${meeting.startedAt}`, `status: ${meeting.status}`, "---", "",
      `# ${meeting.title}`, "", `- Room: ${meeting.roomName}`, `- Participants: ${meeting.participants.join(", ") || "None recorded"}`,
      `- Recorder: ${meeting.recorder}`, `- Host: ${meeting.host}`, `- Started: ${meeting.startedAt}`, `- Ended: ${meeting.endedAt || "In progress"}`,
      `- Revision: ${meeting.revision}`, `- Trigger message: ${meeting.triggerMessageId}`, "",
    ];
    const renderTopic = (topic: MeetingTopic, depth: number): void => {
      lines.push(`${"#".repeat(Math.min(6, depth + 1))} ${topic.title}`, "", `**Problem Statement:** ${topic.problemStatement}`, "", `**Owner:** ${topic.owner}  `, `**Status:** ${topic.status}`, "", "### Discussion Result", "");
      for (const round of topic.rounds) {
        lines.push(`#### Round ${round.number}`, "");
        for (const opinion of round.opinions) lines.push(`- **${opinion.participant}:** ${opinion.text}`);
        lines.push("", `**Conclusion:** ${round.conclusion || "Pending"}`, "", `**Next:** ${round.next || "Continue discussion"}`, "");
      }
      lines.push("### WorkItems", "", topic.workItems.length ? JSON.stringify(topic.workItems) : "None", "");
      for (const subtopic of topic.subtopics) renderTopic(subtopic, depth + 1);
    };
    for (const topic of meeting.topics) renderTopic(topic, 1);
    return lines.join("\n") + "\n";
  }
}
