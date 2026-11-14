import { createHash } from "node:crypto";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import type { LegacyRecipeHostPolicy } from "./legacy-recipe-host.js";

type Review = NonNullable<LegacyRecipeHostPolicy["authorize"]>;
export function managedRecipePolicy(root: string, workspaceId: string, review: Review): LegacyRecipeHostPolicy {
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const scope = { root, workspaceId, actorId: "local:owner", policy: "pkm.managed-interactive-recipe/v1" };
  const binding = { root, workspaceId, actorId: scope.actorId, namespace: hash(scope).slice(0, 16),
    chatId: workspaceId, sourceFingerprint: hash({ ...scope, execution: "caller-reported-only" }) };
  return {
    ...binding,
    authorize: async (candidate, operation, approval) => canonicalJson(candidate) === canonicalJson(binding)
      && (operation === "read" || await review(candidate, operation, approval) === true),
    externalReports: {
      id: scope.policy, authorizationDigest: hash(binding), portedNoops: true, staticBranches: true, humanGates: true,
      authorizeDefinition: candidate => candidate.actorId === binding.actorId
        && !!candidate.source && typeof candidate.source === "object"
        && (candidate.source as { kind?: unknown }).kind === "recipe",
    },
  };
}
