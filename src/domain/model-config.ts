import { z } from "zod";
import {
  modelConfigStringLimit,
  modelProfileLimit,
  modelProviderIdSchema,
  type ModelProviderId,
} from "../model-config-contracts.js";

export const modelConfigByteLimit = 256 * 1024;
export const modelConfigContextLimit = 2_000_000;
export const modelConfigMessageLimit = 256;
export const modelConfigMessageByteLimit = 100_000;
export const modelConfigInputByteLimit = 2_000_000;

const safePublicText = (value: string) => !/(?:https?:\/\/|(?:api[_-]?key|secret|token|password)\s*[:=]|(?:sk|rk)-[A-Za-z0-9_-]{16,})/i.test(value);
const boundedId = z.string().min(1).max(modelConfigStringLimit).refine(safePublicText);

const safeDate = z.string().max(64).refine(safePublicText);

const configuredProfileSchema = z.strictObject({
  id: boundedId,
  model: boundedId.optional(),
  label: boundedId.optional(),
  status: z.enum(["active", "deprecated"]),
  deprecatedAt: safeDate.optional(),
  contextWindow: z.number().int().min(256).max(modelConfigContextLimit),
  maxOutputTokens: z.number().int().min(1).max(modelConfigContextLimit).optional(),
  outputTokenParameter: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  includeUsage: z.boolean().optional(),
  inputPricePerMillion: z.number().finite().nonnegative().optional(),
  outputPricePerMillion: z.number().finite().nonnegative().optional(),
  currency: z.string().max(16).refine(safePublicText).optional(),
});

const modelConfigurationSchema = z.strictObject({
  apiChatProvider: modelProviderIdSchema.optional(),
  apiChatModels: z.array(boundedId).max(modelProfileLimit).optional(),
  apiChatModelProfiles: z.array(configuredProfileSchema).max(modelProfileLimit).optional(),
  aiModel: boundedId.optional(),
  aiEndpoint: z.string().max(2048).optional(),
  aiAzureApiVersion: z.string().max(128).optional(),
  rememberedModel: z.unknown().optional(),
});

const rememberedProfileSchema = z.strictObject({
  id: boundedId,
  model: boundedId,
  label: boundedId,
  status: z.enum(["active", "deprecated", "unknown"]),
  contextWindow: z.number().int().min(256).max(modelConfigContextLimit),
  maxOutputTokens: z.number().int().min(1).max(modelConfigContextLimit),
  deprecatedAt: safeDate.optional(),
  inputPricePerMillion: z.number().finite().nonnegative().optional(),
  outputPricePerMillion: z.number().finite().nonnegative().optional(),
  currency: z.string().max(16).refine(safePublicText).optional(),
  includeUsage: z.boolean().optional(),
  outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  imageInput: z.boolean().optional(),
});

const rememberedModelSchema = z.strictObject({
  provider: modelProviderIdSchema,
  profile: rememberedProfileSchema,
});

interface BoundedCopyState {
  nodes: number;
  bytes: number;
  ancestors: Set<object>;
}

function boundedCopy(value: unknown, state: BoundedCopyState, depth = 0): unknown {
  if (++state.nodes > 4096 || depth > 10) throw new Error("invalid-configuration");
  if (value === null || typeof value === "boolean") {
    state.bytes += 5;
    return value;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > modelConfigByteLimit || (state.bytes += bytes) > modelConfigByteLimit) throw new Error("invalid-configuration");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid-configuration");
    state.bytes += 16;
    return value;
  }
  if (typeof value !== "object") throw new Error("invalid-configuration");
  if (state.ancestors.has(value)) throw new Error("invalid-configuration");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > modelProfileLimit) throw new Error("invalid-configuration");
      return value.map(item => boundedCopy(item, state, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid-configuration");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string") || keys.length > 32) throw new Error("invalid-configuration");
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("invalid-configuration");
      state.bytes += Buffer.byteLength(key, "utf8");
      copy[key] = boundedCopy(descriptor.value, state, depth + 1);
    }
    if (state.bytes > modelConfigByteLimit) throw new Error("invalid-configuration");
    return copy;
  } finally {
    state.ancestors.delete(value);
  }
}

export interface ModelProfile {
  id: string;
  model: string;
  label: string;
  status: "active" | "deprecated" | "unknown";
  metadataSource: "configured-profile" | "remembered-profile" | "legacy-fallback";
  contextWindow: number;
  maxOutputTokens: number;
  deprecatedAt?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  currency: string;
  includeUsage: boolean;
  outputTokenParameter: "max_tokens" | "max_completion_tokens";
}

export interface RememberedModel {
  provider: ModelProviderId;
  profile: ModelProfile;
}

export interface ExplicitModelConfiguration {
  apiChatProvider?: ModelProviderId;
  apiChatModels?: string[];
  apiChatModelProfiles?: unknown[];
  aiModel?: string;
  aiEndpoint?: string;
  aiAzureApiVersion?: string;
  rememberedModel?: unknown;
}

export interface NormalizedModelConfiguration {
  valid: boolean;
  defaultProvider: ModelProviderId;
  defaultModel: string;
  modelIds: string[];
  profiles: ModelProfile[];
  endpoint?: string;
  endpointConfigured: boolean;
  apiVersion: string;
  rememberedModel?: RememberedModel;
}

function validEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint?.trim() || endpoint.length > 2048) return false;
  try {
    const parsed = new URL(endpoint);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return (parsed.protocol === "https:" || (parsed.protocol === "http:" && local))
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function profileFromConfigured(value: z.infer<typeof configuredProfileSchema>): ModelProfile {
  const maxOutputTokens = value.maxOutputTokens ?? Math.min(4096, Math.floor(value.contextWindow / 4));
  if (maxOutputTokens >= value.contextWindow) throw new Error("invalid-configuration");
  if (value.deprecatedAt !== undefined && !Number.isFinite(Date.parse(value.deprecatedAt))) throw new Error("invalid-configuration");
  return {
    id: value.id,
    model: value.model || value.id,
    label: value.label || value.id,
    status: value.status,
    metadataSource: "configured-profile",
    contextWindow: value.contextWindow,
    maxOutputTokens,
    ...(value.deprecatedAt === undefined ? {} : { deprecatedAt: value.deprecatedAt }),
    ...(value.inputPricePerMillion === undefined ? {} : { inputPricePerMillion: value.inputPricePerMillion }),
    ...(value.outputPricePerMillion === undefined ? {} : { outputPricePerMillion: value.outputPricePerMillion }),
    currency: value.currency || "USD",
    includeUsage: value.includeUsage === true,
    outputTokenParameter: value.outputTokenParameter === "max_tokens" ? "max_tokens" : "max_completion_tokens",
  };
}

function profileFromRemembered(value: z.infer<typeof rememberedProfileSchema>): ModelProfile {
  if (value.maxOutputTokens >= value.contextWindow
    || (value.deprecatedAt !== undefined && !Number.isFinite(Date.parse(value.deprecatedAt)))) throw new Error("invalid-configuration");
  return {
    id: value.id,
    model: value.model,
    label: value.label,
    status: value.status,
    metadataSource: "remembered-profile",
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    ...(value.deprecatedAt === undefined ? {} : { deprecatedAt: value.deprecatedAt }),
    ...(value.inputPricePerMillion === undefined ? {} : { inputPricePerMillion: value.inputPricePerMillion }),
    ...(value.outputPricePerMillion === undefined ? {} : { outputPricePerMillion: value.outputPricePerMillion }),
    currency: value.currency || "USD",
    includeUsage: value.includeUsage === true,
    outputTokenParameter: value.outputTokenParameter === "max_tokens" ? "max_tokens" : "max_completion_tokens",
  };
}

export function normalizeModelConfiguration(input: unknown): NormalizedModelConfiguration {
  const base: NormalizedModelConfiguration = {
    valid: false,
    defaultProvider: "openai-compatible",
    defaultModel: "gpt-4o-mini",
    modelIds: [],
    profiles: [],
    endpointConfigured: false,
    apiVersion: "2024-06-01",
  };
  try {
    const copied = boundedCopy(input, { nodes: 0, bytes: 0, ancestors: new Set() });
    const parsed = modelConfigurationSchema.safeParse(copied);
    if (!parsed.success) return base;
    const value = parsed.data;
    const profiles = (value.apiChatModelProfiles ?? []).map(profileFromConfigured);
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) return base;
    let rememberedModel: RememberedModel | undefined;
    if (value.rememberedModel !== undefined) {
      const remembered = rememberedModelSchema.safeParse(value.rememberedModel);
      if (remembered.success) rememberedModel = {
        provider: remembered.data.provider,
        profile: profileFromRemembered(remembered.data.profile),
      };
    }
    const catalogSize = new Set([
      ...profiles.map(profile => profile.id),
      ...(value.apiChatModels ?? []),
      value.aiModel ?? "gpt-4o-mini",
      ...(rememberedModel ? [rememberedModel.profile.id] : []),
    ]).size;
    if (catalogSize > modelProfileLimit) return base;
    return {
      valid: true,
      defaultProvider: value.apiChatProvider ?? "openai-compatible",
      defaultModel: value.aiModel ?? "gpt-4o-mini",
      modelIds: value.apiChatModels ?? [],
      profiles,
      endpoint: value.aiEndpoint,
      endpointConfigured: validEndpoint(value.aiEndpoint),
      apiVersion: value.aiAzureApiVersion || "2024-06-01",
      ...(rememberedModel ? { rememberedModel } : {}),
    };
  } catch {
    return base;
  }
}

export function legacyModelProfile(id: string): ModelProfile {
  return {
    id,
    model: id,
    label: id,
    status: "unknown",
    metadataSource: "legacy-fallback",
    contextWindow: 4096,
    maxOutputTokens: 1024,
    currency: "USD",
    includeUsage: false,
    outputTokenParameter: "max_tokens",
  };
}

export function modelProfilesFor(
  configuration: NormalizedModelConfiguration,
  provider: ModelProviderId,
  selectedProfileId?: string,
): ModelProfile[] {
  const result = [...configuration.profiles];
  const remembered = configuration.rememberedModel;
  const rememberedApplies = remembered?.provider === provider
    && (!selectedProfileId || selectedProfileId === remembered.profile.id);
  if (rememberedApplies && remembered && !result.some(profile => profile.id === remembered.profile.id)) {
    result.push(remembered.profile);
  }
  const legacyIds = [
    configuration.defaultModel,
    ...configuration.modelIds,
    ...(selectedProfileId ? [selectedProfileId] : []),
  ];
  for (const id of legacyIds) {
    if (id && !result.some(profile => profile.id === id) && result.length < modelProfileLimit) result.push(legacyModelProfile(id));
  }
  return result;
}

export function selectedModelProfileId(
  configuration: NormalizedModelConfiguration,
  provider: ModelProviderId,
  requestedProfileId?: string,
): { id: string; source: "request" | "remembered" | "configured-default" } {
  if (requestedProfileId) return { id: requestedProfileId, source: "request" };
  if (configuration.rememberedModel?.provider === provider) {
    return { id: configuration.rememberedModel.profile.id, source: "remembered" };
  }
  return { id: configuration.defaultModel, source: "configured-default" };
}

export function publicModelProfile(profile: ModelProfile): ModelProfile {
  return { ...profile };
}

export interface BudgetMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export function estimateModelInputTokens(messages: readonly BudgetMessage[]): number {
  if (!Array.isArray(messages) || messages.length > modelConfigMessageLimit) throw new Error("invalid-budget");
  let total = 32;
  for (const message of messages) {
    if (!message || typeof message.content !== "string" || Buffer.byteLength(message.content, "utf8") > modelConfigMessageByteLimit) {
      throw new Error("invalid-budget");
    }
    let text = message.content;
    if (message.tool_calls !== undefined) {
      let serialized: string;
      try { serialized = JSON.stringify(message.tool_calls); } catch { throw new Error("invalid-budget"); }
      if (Buffer.byteLength(serialized, "utf8") > modelConfigMessageByteLimit) throw new Error("invalid-budget");
      text += serialized;
    }
    total += Buffer.byteLength(text, "utf8") + 32;
    if (!Number.isSafeInteger(total) || total > modelConfigInputByteLimit) throw new Error("invalid-budget");
  }
  return total;
}

export interface ModelBudget {
  contextWindow: number;
  outputTokens: number;
  inputBudget: number;
  estimatedInputTokens: number | null;
  fits: boolean | null;
}

export function validateModelBudget(
  profile: ModelProfile,
  contextWindow: number,
  outputTokens: number,
  messages?: readonly BudgetMessage[],
  now = Date.now(),
): ModelBudget {
  if (profile.status === "deprecated" || (profile.deprecatedAt && Date.parse(profile.deprecatedAt) <= now)) {
    throw new Error("model-deprecated");
  }
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 256 || contextWindow > profile.contextWindow
    || contextWindow > modelConfigContextLimit
    || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > profile.maxOutputTokens
    || outputTokens > modelConfigContextLimit || outputTokens >= contextWindow) throw new Error("invalid-budget");
  const inputBudget = contextWindow - outputTokens;
  if (!Number.isSafeInteger(inputBudget) || inputBudget < 0) throw new Error("invalid-budget");
  if (messages === undefined) return { contextWindow, outputTokens, inputBudget, estimatedInputTokens: null, fits: null };
  const estimatedInputTokens = estimateModelInputTokens(messages);
  if (estimatedInputTokens > inputBudget) throw new Error("invalid-budget");
  return {
    contextWindow, outputTokens, inputBudget, estimatedInputTokens,
    fits: true,
  };
}

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return modelProviderIdSchema.safeParse(value).success;
}
