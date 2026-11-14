import { z } from "zod";

export const collaborationId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const collaborationMutation = z.strictObject({
  operationId: z.string().uuid(), roomId: collaborationId, expectedRevision: revision,
});
export const collaborationMemberSchema = z.strictObject({
  participantId: collaborationId, actorId: collaborationId, alias: z.string().min(1).max(60),
  kind: z.enum(["human", "agent", "browser"]), present: z.boolean(), muted: z.boolean(),
});
export const collaborationRoomSummary = z.strictObject({
  roomId: collaborationId, name: z.string().min(1).max(200), revision,
  ownerParticipantId: collaborationId, status: z.enum(["active", "closed"]),
});
// Schema-only: never import the durable store or shared contracts registry here.
export const collaborationStateDefinitions = [
  {
    id: "collaboration.state.list", readOnly: true,
    description: "List actor-member local room summaries only; durable state does not reconnect or send.",
    input: z.strictObject({ offset: z.number().int().min(0).max(1000).default(0), limit: z.number().int().min(1).max(100).default(20) }),
    output: z.strictObject({ items: z.array(collaborationRoomSummary), total: z.number().int().nonnegative() }),
  },
  {
    id: "collaboration.state.read", readOnly: true,
    description: "Read a local room's bounded membership/history snapshot as a recorded participant; no transport or Portal grants.",
    input: z.strictObject({ roomId: collaborationId }),
    output: collaborationRoomSummary.extend({
      members: z.array(collaborationMemberSchema).max(64),
      messages: z.array(z.strictObject({
        id: collaborationId, fromId: collaborationId, from: z.string(), kind: z.enum(["human", "agent", "browser"]),
        text: z.string().max(8000), ts: z.number(), recipients: z.array(z.string()).max(64),
        replyPolicy: z.enum(["none", "required", "optional"]), mode: z.enum(["announce", "ask", "discuss"]).optional(),
      })).max(5000),
      tasks: z.array(z.record(z.string(), z.json())).max(64),
      meeting: z.strictObject({
        id: collaborationId, host: collaborationId, lead: collaborationId, triggerMessageId: collaborationId,
        status: z.enum(["active", "adjourned"]), phase: z.enum(["discussion", "adjourned"]),
        revision, startedAt: z.string(), endedAt: z.string().optional(),
      }).nullable(),
    }),
  },
  {
    id: "collaboration.state.leave", readOnly: false,
    description: "Mark only the trusted actor's membership absent using room revision CAS. Last owner departure closes this local room and adjourns its meeting.",
    input: collaborationMutation, output: collaborationRoomSummary,
  },
] as const;
