import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import type { ActionAuthorizationBinding, ActionInvocation, ActionNativeAdapter } from "./action-runtime.js";
import { exactRunnableArtifactBuiltin, originalDigest, runnablePureBuiltinSourceHash } from "./domain/action-compiler-validation.js";
import { copyActionArtifact, inspectActionArtifact } from "./legacy-action-artifacts.js";

export function artifactAdapter(key: string, outputContractDigest: string, database: DatabaseSync,
  root: string, workspaceId: string, assertOwner: () => void,
  assertAdmission: (binding: ActionAuthorizationBinding) => boolean,
  authorizePicked: (authorityId: string) => boolean,
  assertNestedParent: (invocation: ActionInvocation) => boolean,
  refreshNestedParent: (invocation: ActionInvocation) => Promise<boolean>): ActionNativeAdapter | undefined {
  if (key !== "action:core.artifact.copy") return undefined;
  const authorized = (binding: ActionAuthorizationBinding) =>
    binding.actorId === "mcp:external" && binding.workspaceId === workspaceId
    && binding.actionId === "core.artifact.copy" && binding.implementation.kind === "builtin"
    && exactRunnableArtifactBuiltin(binding.definition);
  return {
    id: "original-native-core.artifact.copy", version: 1, outputContractDigest,
    authorizationDigest: originalDigest({ builtin: runnablePureBuiltinSourceHash("core.artifact.copy"),
      storage: "legacy-action-artifact-store/copy-v1" }),
    authorizeDefinition: authorized,
    authorizeData(binding) {
      if (!authorized(binding) || !binding.inputs.source || typeof binding.inputs.source !== "object"
        || Array.isArray(binding.inputs.source) || Object.keys(binding.inputs.source).length !== 1
        || typeof (binding.inputs.source as Record<string, unknown>).artifact_id !== "string") return false;
      inspectActionArtifact(database, root, workspaceId, { id: binding.actorId, canWrite: true },
        String((binding.inputs.source as Record<string, unknown>).artifact_id), authorizePicked);
      return true;
    },
    async execute(invocation, { signal }) {
      if (signal.aborted) return { status: "unknown" };
      try {
        if (!await refreshNestedParent(invocation))
          throw new CoreError("ACCESS_DENIED", "The parent Action invocation is unavailable.");
        const source = invocation.inputs.source as { artifact_id: string };
        const outputs = copyActionArtifact(database, root, workspaceId, { id: invocation.actorId, canWrite: true },
          invocation.runId, invocation.executableDigest, source.artifact_id, () => {
            assertOwner();
            if (signal.aborted || !authorized(invocation) || !assertAdmission(invocation) || !assertNestedParent(invocation))
              throw new CoreError("ACCESS_DENIED", "Action artifact invocation was revoked.");
          }, authorizePicked);
        return { status: "succeeded", outputs };
      } catch (error) {
        if (error instanceof CoreError && error.code === "RESOURCE_LIMIT")
          return { status: "failed", reason: "ACTION_ARTIFACT_QUOTA_EXCEEDED" };
        if (error instanceof CoreError && ["SOURCE_CHANGED", "NOT_FOUND", "ACCESS_DENIED"].includes(error.code))
          return { status: "failed", reason: "ACTION_ARTIFACT_INPUT_UNAVAILABLE" };
        throw error;
      }
    },
  };
}
