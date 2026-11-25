import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import {
  assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  type OriginalMcpNativeHost,
} from "./original-mcp-native-host.js";
import { readLegacySkillMaintenanceGenesis } from "./host-composition-legacy-state.js";
import { legacySkillMaintenance, legacySkillMaintenanceRequest } from "./legacy-skill-maintenance.js";

export async function dispatchOriginalMcpSkillMaintenance(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Actor, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull();
  const request = legacySkillMaintenanceRequest.parse({ tool, arguments: args });
  const approved = {
    operation: `mcp.tool.${request.tool}`, version: 1 as const, tool: request.tool, readOnly: false,
    arguments: request.arguments, argumentsDigest: originalMcpRequestDigest(request.arguments),
  };
  const assertCurrent = () => {
    signal?.throwIfAborted(); host.signal.throwIfAborted();
    owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    if (actor.id !== "mcp:external" || !actor.canWrite || !originalMcpPublicRequestMatches(storage, host, approved))
      throw new CoreError("ACCESS_DENIED", "Skill maintenance requires this exact actor-owned native public mutation approval.");
  };
  assertCurrent();
  const database = storage.connectNative();
  let genesis;
  try { genesis = readLegacySkillMaintenanceGenesis(database, await storage.workspaceId()); }
  finally { database.close(); }
  assertCurrent();
  return legacySkillMaintenance(storage, actor, request, { genesis, assertCurrent });
}
