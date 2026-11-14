export interface LegacyApiChatLibrary {
  version: 1;
  groups: Array<{ id: string; name: string }>;
  placements: Record<string, { groupId: string; trashedAt?: string }>;
}
const receipt = { operationId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
const groupId = z.string().regex(/^chat_group_[a-f0-9]{32}$/);
export const nativeApiChatLibraryInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...receipt, kind: z.literal("create"), name: z.string().max(120) }),
  z.strictObject({ ...receipt, kind: z.literal("rename"), groupId, name: z.string().max(120) }),
  z.strictObject({ ...receipt, kind: z.literal("delete-group"), groupId }),
  z.strictObject({ ...receipt, kind: z.literal("move"), chatId: z.string().uuid(),
    groupId: z.union([groupId, z.literal("ungroup")]) }),
  z.strictObject({ ...receipt, kind: z.literal("move-named"), chatId: z.string().uuid(), name: z.string().max(120) }),
  z.strictObject({ ...receipt, kind: z.literal("trash"), chatId: z.string().uuid() }),
  z.strictObject({ ...receipt, kind: z.literal("restore"), chatId: z.string().uuid() }),
]);
export type NativeApiChatLibraryInput = z.infer<typeof nativeApiChatLibraryInput>;

export function validateLegacyApiChatLibrary(value: unknown, owners: ReadonlySet<string>): LegacyApiChatLibrary {
  const fail = (): never => { throw Object.assign(
    new Error("LEGACY_API_CHAT_BLOCKED: Unsupported or unowned original Chat Library state."),
    { code: "LEGACY_API_CHAT_BLOCKED" }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as LegacyApiChatLibrary;
  if (Object.keys(state).some(key => !["version", "groups", "placements"].includes(key))
    || state.version !== 1 || !Array.isArray(state.groups) || state.groups.length > 1024
    || !state.placements || typeof state.placements !== "object" || Array.isArray(state.placements)) return fail();
  const groups = new Set<string>(), names = new Set<string>();
  for (const group of state.groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)
      || Object.keys(group).some(key => !["id", "name"].includes(key))
      || typeof group.id !== "string" || !/^chat_group_[a-f0-9]{32}$/.test(group.id)
      || typeof group.name !== "string" || !group.name.trim() || group.name.length > 120
      || /[\u0000-\u001f\u007f]/.test(group.name)
      || ["ungroup", "trash"].includes(group.name.toLowerCase())
      || groups.has(group.id) || names.has(group.name.toLowerCase())) return fail();
    groups.add(group.id); names.add(group.name.toLowerCase());
  }
  for (const [id, placement] of Object.entries(state.placements)) {
    if (!owners.has(id) || !placement || typeof placement !== "object" || Array.isArray(placement)
      || Object.keys(placement).some(key => !["groupId", "trashedAt"].includes(key))
      || placement.groupId !== "ungroup" && !groups.has(placement.groupId)
      || placement.trashedAt !== undefined && (typeof placement.trashedAt !== "string"
        || !Number.isFinite(Date.parse(placement.trashedAt)))) return fail();
  }
  return state;
}
import { z } from "zod";

