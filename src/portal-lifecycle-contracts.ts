import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uuid = z.string().uuid();
const revision = z.number().int().safe().nonnegative();

export const portalLifecycleSessionId = uuid;
export const portalLifecycleMeetingId = uuid;

export const portalLifecycleConnections = z.strictObject({
  offset: z.number().int().safe().min(0).max(1000).default(0),
  limit: z.number().int().safe().min(1).max(100).default(20),
});

export const portalLifecycleStatus = z.strictObject({ sessionId: uuid });

export const portalLifecycleRead = z.strictObject({
  sessionId: uuid,
  afterSeq: revision.optional(),
  limit: z.number().int().safe().min(1).max(100).default(50),
});

export const portalLifecycleRoute = z.strictObject({
  operationId: uuid,
  sessionId: uuid,
  expectedRevision: revision,
  meetingId: uuid.optional(),
  recipientId: key,
  text: z.string().min(1).max(8192),
});

export const portalLifecycleDefinitions = [
  {
    id: "portal.lifecycle.connections",
    readOnly: true,
    description: "List durable native pairing projections visible to the trusted actor; no transport is restored.",
    input: portalLifecycleConnections,
    output: z.json(),
  },
  {
    id: "portal.lifecycle.status",
    readOnly: true,
    description: "Read a native pairing and its meeting lifecycle state without reconnecting or replaying effects.",
    input: portalLifecycleStatus,
    output: z.json(),
  },
  {
    id: "portal.lifecycle.read",
    readOnly: true,
    description: "Read a trusted participant's directed native Channel mailbox; no remote task receipt or history import.",
    input: portalLifecycleRead,
    output: z.json(),
  },
  {
    id: "portal.lifecycle.route",
    readOnly: false,
    description: "Send one directed message through an existing admitted Channel member; Channel identity and ACL remain authoritative.",
    input: portalLifecycleRoute,
    output: z.json(),
  },
] as const;

export type PortalLifecycleOperation = typeof portalLifecycleDefinitions[number]["id"];
