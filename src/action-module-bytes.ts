import { z } from "zod";

export const nativeActionModuleSourceProtocol = "pkm.native-action-module-source/v2" as const;
export const nativeActionModuleByteFile = z.strictObject({
  schema: z.literal("pkm.action.module-bytes/v1"),
  base64: z.string().max(22_369_624),
});
export type ActionModuleFileContent = string | z.infer<typeof nativeActionModuleByteFile>;
export const nativeActionModuleSnapshot = z.strictObject({
  kind: z.literal("moduleSet"), fileEncoding: z.literal(nativeActionModuleSourceProtocol),
  manifest: z.json(), files: z.record(z.string(), z.union([z.string(), nativeActionModuleByteFile])),
  enabled: z.boolean().optional(),
});
export function actionModuleFileBytes(value: ActionModuleFileContent): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  const parsed = nativeActionModuleByteFile.parse(value), bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.length > 16_777_216 || bytes.toString("base64") !== parsed.base64)
    throw new TypeError("Invalid canonical bounded Action module byte source.");
  return bytes;
}
