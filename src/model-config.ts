import {
  modelConfigDefinitions,
  modelConfigResolveInput,
  modelProviderIds,
  type ModelConfigCatalog,
  type ModelConfigResolution,
  type ModelProviderId,
} from "./model-config-contracts.js";
import {
  estimateModelInputTokens,
  modelProfilesFor,
  normalizeModelConfiguration,
  publicModelProfile,
  selectedModelProfileId,
  validateModelBudget,
  type ExplicitModelConfiguration,
  type ModelProfile,
} from "./domain/model-config.js";

export const modelApiKeySecretId = "personalKnowledge.aiApiKey" as const;

export interface NativeSecretResolver {
  resolveSecret(secretId: typeof modelApiKeySecretId): Promise<object | undefined>;
}

export interface ModelConfigDependencies {
  configuration: ExplicitModelConfiguration;
  secretResolver: NativeSecretResolver;
  registryAvailability: Readonly<Partial<Record<ModelProviderId, boolean>>>;
  now?: () => number;
}

type CatalogProviderStatus = ModelConfigCatalog["providers"][number]["status"];
type CredentialStatus = ModelConfigResolution["credentialStatus"];

function isDeprecated(profile: ModelProfile, now: number): boolean {
  return profile.status === "deprecated" || (profile.deprecatedAt !== undefined && Date.parse(profile.deprecatedAt) <= now);
}

function connectionStatus(
  registryAvailable: boolean,
  endpointConfigured: boolean,
  credentialStatus: CredentialStatus,
): "configured" | "provider-unavailable" | "endpoint-missing" | "credentials-missing" | "credential-status-unavailable" {
  if (!registryAvailable) return "provider-unavailable";
  if (!endpointConfigured) return "endpoint-missing";
  if (credentialStatus === "missing") return "credentials-missing";
  if (credentialStatus === "unavailable" || credentialStatus === "not-checked") return "credential-status-unavailable";
  return "configured";
}

export class ModelConfigService {
  private readonly configuration;
  private readonly registryAvailability: Readonly<Partial<Record<ModelProviderId, boolean>>>;
  private readonly now: () => number;

  constructor(private readonly dependencies: ModelConfigDependencies) {
    this.configuration = normalizeModelConfiguration(dependencies.configuration);
    this.registryAvailability = dependencies.registryAvailability ?? {};
    this.now = dependencies.now ?? Date.now;
  }

  async catalog(): Promise<ModelConfigCatalog> {
    if (!this.configuration.valid) {
      return {
        schema: "pkm.model-config.catalog/v1",
        providers: modelProviderIds.map(provider => ({
          provider,
          registryAvailable: this.registryAvailability[provider] === true,
          discovery: provider === "vscode" ? "unsupported" : "configured-profiles",
          status: "invalid-configuration",
          endpointConfigured: false,
          credentialStatus: provider === "vscode" ? "not-required" : "missing",
          profiles: [],
        })),
      };
    }

    const shouldCheckCredentials = this.configuration.endpointConfigured
      && (this.registryAvailability["openai-compatible"] === true || this.registryAvailability["azure-openai"] === true);
    const credentialStatus = shouldCheckCredentials ? await this.credentialStatus() : "not-checked";
    return {
      schema: "pkm.model-config.catalog/v1",
      providers: modelProviderIds.map(provider => this.catalogProvider(provider, credentialStatus)),
    };
  }

  async resolve(input: unknown): Promise<ModelConfigResolution> {
    const parsedInput = modelConfigResolveInput.safeParse(input);
    if (!parsedInput.success) throw new Error("Invalid model configuration request.");
    const request = parsedInput.data;
    const provider = request.provider ?? this.configuration.rememberedModel?.provider ?? this.configuration.defaultProvider;
    const registryAvailable = this.registryAvailability[provider] === true;
    if (!this.configuration.valid) {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: "invalid-configuration",
        registryAvailable,
        endpointConfigured: false,
        credentialStatus: provider === "vscode" ? "not-required" : "missing",
        profile: null,
        budget: null,
      };
    }

    if (provider === "vscode") {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: "provider-discovery-unsupported",
        registryAvailable,
        endpointConfigured: false,
        credentialStatus: "not-required",
        profile: null,
        budget: null,
      };
    }

    const candidates = modelProfilesFor(this.configuration, provider, request.profileId);
    const selection = selectedModelProfileId(this.configuration, provider, request.profileId);
    const selected = candidates.find(profile => profile.id === selection.id);
    if (!selected) {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: "invalid-configuration",
        registryAvailable,
        endpointConfigured: this.configuration.endpointConfigured,
        credentialStatus: "unavailable",
        profile: null,
        budget: null,
      };
    }

    if (candidates.some(profile => profile.model === selected.model && isDeprecated(profile, this.now()))) {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: "model-deprecated",
        registryAvailable,
        endpointConfigured: this.configuration.endpointConfigured,
        credentialStatus: "not-checked",
        profile: publicModelProfile(selected),
        budget: null,
      };
    }

    let budget: ModelConfigResolution["budget"] = null;
    try {
      budget = validateModelBudget(
        selected,
        request.contextWindow ?? selected.contextWindow,
        request.outputTokens ?? selected.maxOutputTokens,
        request.messages,
        this.now(),
      );
    } catch (error) {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: error instanceof Error && error.message === "model-deprecated" ? "model-deprecated" : "invalid-budget",
        registryAvailable,
        endpointConfigured: this.configuration.endpointConfigured,
        credentialStatus: "not-checked",
        profile: publicModelProfile(selected),
        budget: null,
      };
    }

    if (!registryAvailable || !this.configuration.endpointConfigured) {
      return {
        schema: "pkm.model-config.resolution/v1",
        provider,
        status: connectionStatus(registryAvailable, this.configuration.endpointConfigured, "not-checked"),
        registryAvailable,
        endpointConfigured: this.configuration.endpointConfigured,
        credentialStatus: "not-checked",
        profile: publicModelProfile(selected),
        budget,
      };
    }

    const credentials = await this.credentialStatus();
    const status = isDeprecated(selected, this.now())
      ? "model-deprecated"
      : connectionStatus(registryAvailable, this.configuration.endpointConfigured, credentials) !== "configured"
        ? connectionStatus(registryAvailable, this.configuration.endpointConfigured, credentials)
        : selected.status === "unknown" ? "model-unverified" : "configured";

    return {
      schema: "pkm.model-config.resolution/v1",
      provider,
      status,
      registryAvailable,
      endpointConfigured: this.configuration.endpointConfigured,
      credentialStatus: credentials,
      profile: publicModelProfile(selected),
      budget,
    };
  }

  private async credentialStatus(): Promise<CredentialStatus> {
    try {
      const handle = await this.dependencies.secretResolver.resolveSecret(modelApiKeySecretId);
      return handle !== undefined && handle !== null && typeof handle === "object" ? "available" : "missing";
    } catch {
      return "unavailable";
    }
  }

  private catalogProvider(
    provider: ModelProviderId,
    credentialStatus: CredentialStatus,
  ): ModelConfigCatalog["providers"][number] {
    const registryAvailable = this.registryAvailability[provider] === true;
    if (provider === "vscode") {
      return {
        provider,
        registryAvailable,
        discovery: "unsupported",
        status: "provider-discovery-unsupported",
        endpointConfigured: false,
        credentialStatus: "not-required",
        profiles: [],
      };
    }

    const status: CatalogProviderStatus = connectionStatus(
      registryAvailable,
      this.configuration.endpointConfigured,
      credentialStatus,
    );
    return {
      provider,
      registryAvailable,
      discovery: "configured-profiles",
      status,
      endpointConfigured: this.configuration.endpointConfigured,
      credentialStatus,
      profiles: modelProfilesFor(this.configuration, provider).map(publicModelProfile),
    };
  }
}

export { modelConfigDefinitions, estimateModelInputTokens };
