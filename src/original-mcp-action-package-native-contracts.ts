import { z } from "zod";
import { isAbsolute, resolve, dirname } from "node:path";
import { nativeActionModuleSourceProtocol } from "./action-module-bytes.js";
import { originalMcpNativeSignedHostBinding } from "./original-mcp-native-signed-host-contracts.js";
import type { OriginalNativeActionSession } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value);
const pin = z.string().min(1).max(256);
const size = z.number().safe().int().min(0).max(32 * 1024 * 1024);
const common = {
  root: path, workspaceId: z.string().uuid(), profileSha256: digest, epoch: z.string().uuid(),
  actorId: z.literal("mcp:external"), decisionId: z.string().uuid(),
  requestSha256: digest, expiresAtMs: z.number().safe().int().positive(),
};
export const nativeActionPackageSourceDecision = z.strictObject({
  ...common, schema: z.literal("pkm.native-action-package-source-decision/v1"),
  scope: z.literal("native-action-package-source/v2"), noExecution: z.literal(true),
  sourcePath: path, sourceRoot: path, sourceFilePin: pin, sourceRootPin: pin, sourceParentPin: pin,
  packageSha256: digest, size, sourceProtocol: z.literal(nativeActionModuleSourceProtocol),
}).refine(value => dirname(value.sourcePath) === value.sourceRoot);
export const nativeActionPackageDestinationDecision = z.strictObject({
  ...common, schema: z.literal("pkm.native-action-package-destination-decision/v1"),
  scope: z.literal("native-action-package-destination/v1"),
  destination: path, selectedRoot: path, parentPin: pin, packageSha256: digest, size,
}).refine(value => dirname(value.destination) === value.selectedRoot);
export const nativeActionPackageRequestSchemas = Object.freeze({
  "action.package.source.approve": z.strictObject({
    binding: originalMcpNativeSignedHostBinding, sourcePath: path,
  }),
  "action.package.destination.approve": z.strictObject({
    binding: originalMcpNativeSignedHostBinding, destination: path,
    moduleSetId: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/),
    version: z.number().safe().int().positive(), actionIds: z.array(z.string()).min(1).max(100),
    packageSha256: digest, size,
  }),
  "action.package.decision.current": z.strictObject({
    binding: originalMcpNativeSignedHostBinding, decisionId: z.string().uuid(), requestSha256: digest,
    purpose: z.enum(["source", "destination"]),
  }),
});
export const nativeActionPackageResultSchemas = Object.freeze({
  "action.package.source.approve": nativeActionPackageSourceDecision.nullable(),
  "action.package.destination.approve": nativeActionPackageDestinationDecision.nullable(),
  "action.package.decision.current": z.strictObject({ current: z.boolean() }),
});
export const nativeActionPackageMethods = Object.freeze([
  "action.package.source.approve", "action.package.destination.approve",
  "action.package.decision.current",
] as const);
export type NativeActionPackageMethod = typeof nativeActionPackageMethods[number];
export function isNativeActionPackageMethod(value: unknown): value is NativeActionPackageMethod {
  return typeof value === "string" && nativeActionPackageMethods.some(method => method === value);
}
export function parseNativeActionPackagePayload<M extends NativeActionPackageMethod>(method: M, input: unknown,
  session: OriginalNativeActionSession): z.infer<typeof nativeActionPackageRequestSchemas[M]> {
  const payload = nativeActionPackageRequestSchemas[method].parse(input), binding = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || binding.epoch !== session.epoch || binding.root !== expected.root
    || binding.workspaceId !== expected.workspaceId || binding.planSha256 !== expected.planSha256
    || binding.profileSha256 !== expected.profileSha256 || binding.sourceCatalogSha256 !== expected.catalogSha256
    || binding.authorityId !== `native-rpc:${session.brokerId}` || !binding.domains.includes("mcp-public"))
    throw Object.assign(new Error("NATIVE_PACKAGE_BINDING_MISMATCH"), { code: "NATIVE_PACKAGE_BINDING_MISMATCH" });
  return payload as z.infer<typeof nativeActionPackageRequestSchemas[M]>;
}
export function actionPackageSourcePin(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
export function actionPackageParentPin(stat: { dev: number; ino: number; uid: number; mode: number }): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
