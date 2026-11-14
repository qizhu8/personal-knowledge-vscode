import { z } from "zod";

const pluginId = z.enum(["teams"]);
const capabilityId = z.enum(["teams.notifications.read"]);
const revision = z.string().regex(/^[a-f0-9]{64}$/);

const pluginSummary = z.strictObject({
  id: pluginId,
  name: z.string().min(1).max(100),
  optional: z.literal(true),
  available: z.boolean(),
  unavailableReason: z.enum(["implementation_not_injected", "configuration_required"]).nullable(),
  state: z.enum(["disabled", "starting", "enabled", "stopping", "faulted"]),
  capabilities: z.array(z.strictObject({
    id: capabilityId,
    available: z.boolean(),
  })).max(16),
  cleanup: z.enum(["not-needed", "not-created", "complete", "failed", "timed-out"]),
});

export const pluginRuntimeDefinitions = [
  {
    id: "plugin.runtime.discover",
    readOnly: true,
    description: "Discover the statically allowlisted optional plugins and their bounded capabilities. Discovery never initializes a plugin or calls its hooks.",
    input: z.strictObject({}),
    output: z.strictObject({
      revision,
      items: z.array(pluginSummary).max(16),
    }),
  },
  {
    id: "plugin.runtime.status",
    readOnly: true,
    description: "Read a redacted status snapshot for one statically allowlisted optional plugin. Does not expose actors, configuration, credentials or provider errors.",
    input: z.strictObject({ pluginId }),
    output: pluginSummary,
  },
] as const;

export const pluginRuntimeControlDefinitions = [
  {
    id: "plugin.runtime.enable",
    readOnly: false,
    description: "Enable an explicitly admitted native plugin for this authenticated actor. Requires current VS Code workspace authority and exact implementation/configuration consent; never imports archived grants.",
    input: z.strictObject({ pluginId, capabilities: z.array(capabilityId).min(1).max(16) }),
    output: pluginSummary,
  },
  {
    id: "plugin.runtime.disable",
    readOnly: false,
    description: "Disable this actor's plugin grant and clean up the instance when no grants remain. Does not grant another actor access.",
    input: z.strictObject({ pluginId }),
    output: pluginSummary,
  },
  {
    id: "plugin.runtime.invoke",
    readOnly: false,
    description: "Invoke the exact enabled capability with fresh native effect consent. No automatic retry or outbound send capability is admitted. Returns only bounded notification counts.",
    input: z.strictObject({
      pluginId, capability: capabilityId,
      input: z.strictObject({
        offset: z.number().int().min(0).max(10_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    }),
    output: z.strictObject({ count: z.number().int().min(0).max(50), hasMore: z.boolean() }),
  },
] as const;

export type PluginId = z.infer<typeof pluginId>;
export type PluginCapabilityId = z.infer<typeof capabilityId>;
export type PluginRuntimePublicDefinition = typeof pluginRuntimeDefinitions[number];
export type PluginRuntimeActor = Readonly<{ id: string; trusted: boolean }>;
