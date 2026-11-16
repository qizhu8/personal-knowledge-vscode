import { createHash } from "node:crypto";
import type { Storage } from "./storage.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { originalDefinitionValue } from "./domain/action-compiler-validation.js";
import { createVscodeActionTrustBridge } from "./vscode-action-trust-bridge.js";
import { ACTION_SOURCE_IDENTITY } from "./domain/action-source-identity.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Explicit native opt-in. The actor is fixed by the host, never by MCP input. */
export async function createTrustedActionHostOptions(storage: Storage): Promise<NativeRuntimeOptions["hostServices"]> {
  if (ACTION_SOURCE_IDENTITY.qualification === "fixture-only") {
    throw new Error("This Action source identity has fixture agreement only; independent qualification is required before trusted host admission.");
  }
  const workspaceId = await storage.workspaceId();
  const actorId = "mcp:external";
  const authority = createVscodeActionTrustBridge({ workspaceRoot: storage.workspaceRoot(), workspaceId, actorId, nativeEndpoint: true });
  return {
    action: {
      automaticTrusted: authority,
      async approvePurePipeline(binding, artifact) {
        const current = authority.current();
        const steps = binding.implementation.steps;
        if (!current.trustedWorkspace || binding.actorId !== actorId || binding.workspaceId !== workspaceId
          || binding.implementation.kind !== "pipeline" || !Array.isArray(steps)
          || !Array.isArray(binding.definition.effects)
          || !binding.definition.effects.every(value => typeof value === "string")) {
          throw new Error("Trusted pipeline consent binding is invalid.");
        }
        const contentHash = originalDefinitionValue(binding.definition).content_hash;
        if (typeof contentHash !== "string") throw new Error("Trusted Action revision is invalid.");
        const input = canonical(binding.inputs);
        return authority.authorizeEffects(binding.actionId, contentHash, current.epoch, {
          kind: "pipeline", components: [...new Set(steps.map(step => String(step.component)))],
          stepCount: steps.length, effects: binding.definition.effects as string[],
          ...(artifact ? { artifact } : {}),
          inputDigest: createHash("sha256").update(input).digest("hex"),
          inputPreview: input.length > 512 ? `${input.slice(0, 509)}...` : input,
        });
      },
      async approveManagedArtifact(binding, source) {
        const current = authority.current();
        if (!current.trustedWorkspace || binding.actorId !== actorId || binding.workspaceId !== workspaceId
          || binding.actionId !== "core.artifact.copy" || binding.implementation.kind !== "builtin"
          || !Array.isArray(binding.definition.effects)
          || !binding.definition.effects.every(value => typeof value === "string")) {
          throw new Error("Trusted artifact copy consent binding is invalid.");
        }
        const contentHash = originalDefinitionValue(binding.definition).content_hash;
        if (typeof contentHash !== "string") throw new Error("Trusted Action revision is invalid.");
        const input = canonical(binding.inputs);
        return authority.authorizeEffects(binding.actionId, contentHash, current.epoch, {
          kind: "artifact-copy", artifact: source, effects: binding.definition.effects as string[],
          inputDigest: createHash("sha256").update(input).digest("hex"),
          inputPreview: input.length > 512 ? `${input.slice(0, 509)}...` : input,
        });
      },
      process: {
        commands: [],
        trustedPrograms: {
          async approve(binding, build, artifact) {
            const current = authority.current();
            const args = binding.implementation.args ?? [];
            if (!current.trustedWorkspace || binding.actorId !== actorId || binding.workspaceId !== workspaceId
              || typeof binding.implementation.program !== "string" || !Array.isArray(args)
              || !args.every(value => typeof value === "string")
              || !Array.isArray(binding.definition.effects) || !binding.definition.effects.every(value => typeof value === "string")) {
              throw new Error("Trusted Action consent binding is invalid.");
            }
            const contentHash = originalDefinitionValue(binding.definition).content_hash;
            if (typeof contentHash !== "string") throw new Error("Trusted Action revision is invalid.");
            const input = canonical(binding.inputs);
            return authority.authorizeEffects(binding.actionId, contentHash, current.epoch, {
              program: binding.implementation.program,
              args: args as string[],
              ...(build ? { build } : {}),
              ...(artifact ? { artifact, childAction: { actionId: "core.artifact.copy",
                contentHash: String((binding.definition.dependencies as Record<string, unknown>)["core.artifact.copy"]) } } : {}),
              effects: binding.definition.effects as string[],
              inputDigest: createHash("sha256").update(input).digest("hex"),
              inputPreview: input.length > 512 ? `${input.slice(0, 509)}...` : input,
            });
          },
        },
      },
    },
  };
}
