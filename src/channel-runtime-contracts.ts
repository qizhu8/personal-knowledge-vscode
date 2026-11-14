import { z } from "zod";

export const channelKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sequence = z.number().int().safe().nonnegative();
const mutation = z.strictObject({
  operationId: z.string().uuid(), channelId: channelKey, expectedRevision: sequence,
});
export const channelTaskPin = z.strictObject({
  authority: z.enum(["manager", "board"]), runId: channelKey, taskId: channelKey,
  attemptId: channelKey, definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVersion: sequence.positive(),
});
export type ChannelTaskPin = z.infer<typeof channelTaskPin>;
export const channelRead = z.strictObject({
  channelId: channelKey, afterSeq: sequence.optional(), limit: sequence.min(1).max(100).default(50),
});
export const channelWait = channelRead.extend({
  timeoutMs: sequence.min(1).max(30_000).default(30_000),
});
export const channelSend = mutation.extend({
  recipientId: channelKey, text: z.string().min(1).max(8192),
});
export const channelAssign = channelSend.extend({ task: channelTaskPin });
export const channelUpdate = mutation.extend({
  assignmentId: z.string().uuid(), task: channelTaskPin, text: z.string().min(1).max(8192),
});
export const channelReply = channelUpdate.extend({ afterSeq: sequence });
export const channelAck = mutation.extend({ throughSeq: sequence });
export const channelAccept = mutation.extend({
  invitationId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const channelReconnect = z.strictObject({ channelId: channelKey });

/** Inventory only. Identity, generation, human consent and host task authority are not request fields. */
export const channelRuntimeDefinitions = [
  { id: "channel.runtime.accept", readOnly: false, input: channelAccept, output: z.json(),
    description: "Accept an exact identity-bound, host-approved invitation. No role override." },
  { id: "channel.runtime.reconnect", readOnly: true, input: channelReconnect, output: z.json(),
    description: "Reconnect an existing unexpired membership; never recreates a room or agent." },
  { id: "channel.runtime.read", readOnly: true, input: channelRead, output: z.json(),
    description: "Read only the trusted participant's directed mailbox with durable exclusive cursor." },
  { id: "channel.runtime.wait", readOnly: true, input: channelWait, output: z.json(),
    description: "Bounded cancellable native wait outside SQLite; no unrelated recipient wake." },
  { id: "channel.runtime.send", readOnly: false, input: channelSend, output: z.json(),
    description: "Send to one explicitly authorized current participant; sender is host-derived." },
  { id: "channel.runtime.assign", readOnly: false, input: channelAssign, output: z.json(),
    description: "Deliver an exact host-pinned Manager/Board task; Channel is not task authority." },
  { id: "channel.runtime.update", readOnly: false, input: channelUpdate, output: z.json(),
    description: "Commit a worker update through the parent task authority transaction." },
  { id: "channel.runtime.reply", readOnly: false, input: channelReply, output: z.json(),
    description: "Commit reply, task update, cursor and return-to-wait together." },
  { id: "channel.runtime.ack", readOnly: false, input: channelAck, output: z.json(),
    description: "Advance only an owned delivered mailbox cursor using Channel revision CAS." },
] as const;
