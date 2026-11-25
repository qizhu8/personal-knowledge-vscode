import { z } from "zod";
import { originalDigest } from "./domain/action-compiler-validation.js";
import { originalActionCall } from "./original-mcp-action-call-contracts.js";
import { originalNativeActionPayloadSchemas, originalNativeActionSession } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
function credentialFields(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const name = key.replace(/[^A-Za-z]/g, "").toLowerCase();
    return name.includes("credential") || name.includes("secret")
      || ["password", "authorization", "apikey", "token", "accesstoken", "refreshtoken", "privatekey"].includes(name)
      || credentialFields(child);
  });
}
export const originalActionProgramMethod = "action.program.approve" as const;
export const originalActionProgramRequest = z.strictObject({
  schema: z.literal("pkm.original-mcp-local-program-request/v1"),
  root: z.string().min(1).max(4096), workspaceId: uuid, actorId: z.literal("mcp:external"),
  profileSha256: digest, epoch: uuid, capsuleSha256: digest, sourceReceiptSha256: digest, nativeHostReceiptSha256: digest,
  runId: z.string().regex(/^action_run_[a-f0-9]{32}$/), request: originalActionCall,
  implementationSha256: digest, inputSha256: digest, deadline: z.number().safe().int().positive(),
  executable: z.strictObject({ path: z.string().min(1).max(4096), sha256: digest,
    bytes: z.number().safe().int().positive(), identity: z.string().min(1).max(1024) }),
  cwd: z.strictObject({ path: z.string().min(1).max(4096), device: z.string(), inode: z.string() }),
  arguments: z.array(z.string().max(32768)).max(128),
  sources: z.array(z.strictObject({ path: z.string().min(1).max(4096), sha256: digest,
    bytes: z.number().safe().int().nonnegative() })).max(4096),
  effects: z.tuple([z.literal("pure")]),
  authority: z.strictObject({
    scope: z.literal("exact-local-direct-child/v1"), shell: z.literal(false), inheritedEnvironment: z.literal(false),
    credentials: z.literal(false), network: z.literal(false), descendants: z.literal(false), build: z.literal(false),
    automaticReplay: z.literal(false),
  }),
}).refine(value => originalDigest(value.request.inputs) === value.inputSha256
  && value.request.trigger === null && value.request.project_id === null && !credentialFields(value.request.inputs));
export const originalActionProgramDecision = z.strictObject({
  schema: z.literal("pkm.original-mcp-local-program-decision/v1"), scope: z.literal("exact-local-direct-child/v1"),
  root: z.string(), workspaceId: uuid, actorId: z.literal("mcp:external"), profileSha256: digest, epoch: uuid,
  capsuleSha256: digest, runId: z.string().regex(/^action_run_[a-f0-9]{32}$/),
  requestSha256: digest, executableSha256: digest, decisionId: uuid, expiresAtMs: z.number().safe().int().positive(),
  automaticReplay: z.literal(false),
});
export const originalActionProgramPayload = z.strictObject({
  binding: originalNativeActionPayloadSchemas["action.status"].shape.binding, request: originalActionProgramRequest,
});
export type OriginalActionProgramRequest = z.infer<typeof originalActionProgramRequest>;
export type OriginalActionProgramDecision = z.infer<typeof originalActionProgramDecision>;
function fail(): never { throw Object.assign(new Error("NATIVE_ACTION_PROGRAM_BINDING_MISMATCH"), { code: "NATIVE_ACTION_PROGRAM_BINDING_MISMATCH" }); }
export function parseOriginalActionProgramPayload(value: unknown, inputSession: unknown) {
  const session = originalNativeActionSession.parse(inputSession), payload = originalActionProgramPayload.parse(value);
  const { binding, request } = payload, signed = session.binding;
  if (binding.root !== signed.root || binding.workspaceId !== signed.workspaceId || binding.planSha256 !== signed.planSha256
    || binding.profileSha256 !== signed.profileSha256 || binding.sourceCatalogSha256 !== signed.catalogSha256
    || binding.epoch !== session.activationId || binding.authorityId !== `native-rpc:${session.brokerId}`
    || request.root !== signed.root || request.workspaceId !== signed.workspaceId || request.profileSha256 !== signed.profileSha256
    || request.epoch !== session.activationId || session.epoch !== session.activationId) fail();
  return payload;
}
export function assertOriginalActionProgramDecision(input: unknown, request: OriginalActionProgramRequest): OriginalActionProgramDecision {
  const decision = originalActionProgramDecision.parse(input);
  if (decision.root !== request.root || decision.workspaceId !== request.workspaceId || decision.actorId !== request.actorId
    || decision.profileSha256 !== request.profileSha256 || decision.epoch !== request.epoch
    || decision.capsuleSha256 !== request.capsuleSha256 || decision.runId !== request.runId
    || decision.requestSha256 !== originalDigest(request) || decision.executableSha256 !== request.executable.sha256
    || decision.expiresAtMs <= Date.now() || decision.expiresAtMs > request.deadline
    || decision.expiresAtMs > Date.now() + 300000) fail();
  return decision;
}
