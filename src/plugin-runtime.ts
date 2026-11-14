import { createHash } from "node:crypto";
import { z } from "zod";
import {
  pluginRuntimeDefinitions, type PluginCapabilityId, type PluginId, type PluginRuntimeActor,
} from "./plugin-runtime-contracts.js";

const teamsConfigSchema = z.strictObject({
  tenantId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  credentialRef: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
});
const notificationReadInput = z.strictObject({
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
const notificationReadOutput = z.strictObject({
  count: z.number().int().min(0).max(50),
  hasMore: z.boolean(),
});

export const PLUGIN_RUNTIME_LIMITS = Object.freeze({
  hookTimeoutMs: 10_000,
  disposeTimeoutMs: 2_000,
  maximumTimeoutMs: 30_000,
});

export type PluginCleanupStep = "not-needed" | "complete" | "failed" | "timed-out";
export type PluginCleanupState = "not-needed" | "not-created" | "complete" | "failed" | "timed-out";
export type PluginRuntimeState = "disabled" | "starting" | "enabled" | "stopping" | "faulted";

export type PluginRuntimeErrorCode =
  | "ACCESS_DENIED"
  | "NOT_AVAILABLE"
  | "CAPABILITY_DENIED"
  | "INVALID_ARGUMENT"
  | "PLUGIN_BUSY"
  | "PLUGIN_START_FAILED"
  | "PLUGIN_HOOK_FAILED"
  | "PLUGIN_CLEANUP_FAILED"
  | "NOT_FOUND";

export class PluginRuntimeError extends Error {
  constructor(
    readonly code: PluginRuntimeErrorCode,
    message: string,
    readonly cleanup?: Readonly<{ stop: PluginCleanupStep; dispose: PluginCleanupStep; state: PluginCleanupState }>,
  ) {
    super(message);
  }
}

export interface PluginHookContext {
  readonly pluginId: PluginId;
  readonly signal: AbortSignal;
}

export interface PluginInstance {
  start(context: PluginHookContext & { readonly config: Readonly<z.infer<typeof teamsConfigSchema>> }): void | Promise<void>;
  invoke(
    capability: PluginCapabilityId,
    input: unknown,
    context: PluginHookContext & { readonly actorId: string },
  ): unknown | Promise<unknown>;
  stop?(context: PluginHookContext): void | Promise<void>;
  dispose(context: PluginHookContext): void | Promise<void>;
}

export type PluginFactory = (config: Readonly<z.infer<typeof teamsConfigSchema>>) => PluginInstance;
export type PluginAuthorizationRequest = Readonly<{
  action: "enable" | "disable" | "invoke";
  pluginId: PluginId;
  actorId: string;
  capabilities: readonly PluginCapabilityId[];
  inputDigest?: string;
}>;
export type PluginAuthorizer = (
  actor: PluginRuntimeActor,
  request: PluginAuthorizationRequest,
) => boolean | Promise<boolean>;

export interface PluginRuntimeOptions {
  readonly factories?: Partial<Record<PluginId, PluginFactory>>;
  readonly configurations?: Partial<Record<PluginId, unknown>>;
  readonly authorize?: PluginAuthorizer;
  readonly hookTimeoutMs?: number;
  readonly disposeTimeoutMs?: number;
}

type PluginSummary = {
  id: PluginId;
  name: string;
  optional: true;
  available: boolean;
  unavailableReason: "implementation_not_injected" | "configuration_required" | null;
  state: PluginRuntimeState;
  capabilities: Array<{ id: PluginCapabilityId; available: boolean }>;
  cleanup: PluginCleanupState;
};
type State = {
  state: PluginRuntimeState;
  instance?: PluginInstance;
  grants: Map<string, Set<PluginCapabilityId>>;
  cleanup: PluginCleanupState;
};
type TimeoutError = Error & { timeout: true; phase: string };
const timeoutError = (phase: string): TimeoutError =>
  Object.assign(new Error("Plugin hook timed out."), { timeout: true as const, phase });
const catalog = [{
  id: "teams" as const,
  name: "Microsoft Teams",
  optional: true as const,
  capabilities: ["teams.notifications.read"] as const,
}];
const teamsCapabilitySet = new Set<PluginCapabilityId>(catalog[0].capabilities);
const emptySignalContext = (pluginId: PluginId, signal: AbortSignal): PluginHookContext =>
  Object.freeze({ pluginId, signal });

function assertPluginId(value: string): asserts value is PluginId {
  if (value !== "teams") throw new PluginRuntimeError("NOT_FOUND", "Plugin is not in the static allowlist.");
}

function trustedActor(actor: PluginRuntimeActor): void {
  if (!actor || actor.trusted !== true || typeof actor.id !== "string" || !/^[A-Za-z0-9._:@-]{1,256}$/.test(actor.id)) {
    throw new PluginRuntimeError("ACCESS_DENIED", "A trusted native actor is required.");
  }
}

function cleanupState(stop: PluginCleanupStep, dispose: PluginCleanupStep): PluginCleanupState {
  if (stop === "timed-out" || dispose === "timed-out") return "timed-out";
  if (stop === "failed" || dispose === "failed") return "failed";
  return "complete";
}

function reportCleanup(
  cleanup: { stop: PluginCleanupStep; dispose: PluginCleanupStep; state: PluginCleanupState },
  operationError: unknown,
) {
  return errorTimedOut(operationError) ? { ...cleanup, state: "timed-out" as const } : cleanup;
}

function errorTimedOut(error: unknown): boolean {
  return !!error && typeof error === "object" && "timeout" in error && error.timeout === true;
}

export class PluginRuntime {
  private readonly states = new Map<PluginId, State>();
  private readonly locks = new Map<PluginId, Promise<void>>();
  private readonly factories: Partial<Record<PluginId, PluginFactory>>;
  private readonly configurations: Partial<Record<PluginId, z.infer<typeof teamsConfigSchema>>>;
  private readonly hookTimeoutMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly catalogRevision: string;
  private closed = false;
  private closePromise?: Promise<readonly PluginSummary[]>;

  constructor(private readonly options: PluginRuntimeOptions = {}) {
    this.assertStaticKeys(options.factories, "factory");
    this.assertStaticKeys(options.configurations, "configuration");
    const factories = { ...(options.factories ?? {}) };
    for (const factory of Object.values(factories)) {
      if (factory !== undefined && typeof factory !== "function") {
        throw new TypeError("Plugin factories must be injected native functions.");
      }
    }
    this.factories = factories;
    this.configurations = {};
    for (const [id, value] of Object.entries(options.configurations ?? {})) {
      if (value === undefined) continue;
      const parsed = teamsConfigSchema.safeParse(value);
      if (!parsed.success) throw new TypeError("Plugin configuration must use non-secret, opaque identifiers.");
      this.configurations[id as PluginId] = Object.freeze({ ...parsed.data });
    }
    this.hookTimeoutMs = this.timeoutOption(options.hookTimeoutMs, PLUGIN_RUNTIME_LIMITS.hookTimeoutMs);
    this.disposeTimeoutMs = this.timeoutOption(options.disposeTimeoutMs, PLUGIN_RUNTIME_LIMITS.disposeTimeoutMs);
    this.catalogRevision = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
    this.states.set("teams", { state: "disabled", grants: new Map(), cleanup: "not-needed" });
  }

  private assertStaticKeys(values: object | undefined, label: string): void {
    for (const key of Object.keys(values ?? {})) {
      if (key !== "teams") throw new TypeError(`The ${label} registry accepts only statically allowlisted plugin IDs.`);
    }
  }

  private timeoutOption(value: number | undefined, fallback: number): number {
    const timeout = value ?? fallback;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > PLUGIN_RUNTIME_LIMITS.maximumTimeoutMs) {
      throw new TypeError("Plugin runtime timeout is outside the enforced host budget.");
    }
    return timeout;
  }

  async read(operation: string, input: unknown): Promise<unknown> {
    const definition = pluginRuntimeDefinitions.find(item => item.id === operation);
    if (!definition) throw new PluginRuntimeError("NOT_FOUND", "Only the schema-defined plugin discovery and status reads are public.");
    const parsedInput = definition.input.safeParse(input);
    if (!parsedInput.success) throw new PluginRuntimeError("INVALID_ARGUMENT", "Invalid plugin read arguments.");
    const result = operation === "plugin.runtime.discover"
      ? { revision: this.catalogRevision, items: catalog.map(item => this.summary(item.id)) }
      : this.summary(parsedInput.data.pluginId);
    const parsedOutput = definition.output.safeParse(result);
    if (!parsedOutput.success) throw new PluginRuntimeError("PLUGIN_HOOK_FAILED", "Plugin status failed its public response contract.");
    return parsedOutput.data;
  }

  async enable(
    actor: PluginRuntimeActor,
    pluginId: string,
    requestedCapabilities: readonly string[],
  ): Promise<PluginSummary> {
    trustedActor(actor);
    assertPluginId(pluginId);
    return this.exclusive(pluginId, async () => {
      this.assertOpen();
      const { factory, config } = this.requireAvailable(pluginId);
      const capabilities = this.validateCapabilities(requestedCapabilities);
      await this.authorize(actor, { action: "enable", pluginId, actorId: actor.id, capabilities });
      const state = this.states.get(pluginId)!;
      if (state.state === "faulted" && (state.cleanup === "failed" || state.cleanup === "timed-out")) {
        throw new PluginRuntimeError("NOT_AVAILABLE", "Plugin cleanup is incomplete; restart the isolated host before re-enabling it.");
      }
      if (state.state !== "enabled") {
        state.state = "starting";
        state.cleanup = "not-needed";
        let instance: PluginInstance | undefined;
        try {
          instance = factory(config);
          if (!instance || typeof instance.start !== "function" || typeof instance.invoke !== "function"
            || typeof instance.dispose !== "function") {
            throw new Error("Invalid injected plugin lifecycle implementation.");
          }
          await this.withTimeout("start", this.hookTimeoutMs, signal => instance!.start({
            ...emptySignalContext(pluginId, signal), config,
          }));
          state.instance = instance;
          state.state = "enabled";
        } catch (error) {
          const completedCleanup = instance ? await this.cleanup(pluginId, instance) : {
            stop: "not-needed" as const, dispose: "not-needed" as const, state: "not-created" as const,
          };
          const cleanup = reportCleanup(completedCleanup, error);
          state.instance = undefined;
          state.grants.clear();
          state.state = "faulted";
          state.cleanup = cleanup.state;
          throw new PluginRuntimeError(
            "PLUGIN_START_FAILED",
            `Plugin start failed; cleanup ${cleanup.state}${errorTimedOut(error) ? " after timeout" : ""}.`,
            cleanup,
          );
        }
      }
      const granted = state.grants.get(actor.id) ?? new Set<PluginCapabilityId>();
      for (const capability of capabilities) granted.add(capability);
      state.grants.set(actor.id, granted);
      return this.summary(pluginId);
    });
  }

  async disable(actor: PluginRuntimeActor, pluginId: string): Promise<PluginSummary> {
    trustedActor(actor);
    assertPluginId(pluginId);
    return this.exclusive(pluginId, async () => {
      this.assertOpen();
      const state = this.states.get(pluginId)!;
      const current = state.grants.get(actor.id) ?? new Set<PluginCapabilityId>();
      await this.authorize(actor, {
        action: "disable", pluginId, actorId: actor.id, capabilities: Object.freeze([...current].sort()),
      });
      state.grants.delete(actor.id);
      if (state.grants.size > 0) return this.summary(pluginId);
      if (!state.instance) {
        if (state.state !== "faulted") {
          state.state = "disabled";
          state.cleanup = "not-needed";
        }
        return this.summary(pluginId);
      }
      state.state = "stopping";
      const instance = state.instance;
      const cleanup = await this.cleanup(pluginId, instance);
      state.instance = undefined;
      state.state = cleanup.state === "complete" ? "disabled" : "faulted";
      state.cleanup = cleanup.state;
      if (cleanup.state !== "complete") {
        throw new PluginRuntimeError("PLUGIN_CLEANUP_FAILED", `Plugin cleanup ${cleanup.state}.`, cleanup);
      }
      return this.summary(pluginId);
    });
  }

  async invoke(
    actor: PluginRuntimeActor,
    pluginId: string,
    capability: string,
    input: unknown,
  ): Promise<unknown> {
    trustedActor(actor);
    assertPluginId(pluginId);
    if (capability !== "teams.notifications.read") {
      throw new PluginRuntimeError("CAPABILITY_DENIED", "Capability is not in the static safe allowlist.");
    }
    const parsedInput = notificationReadInput.safeParse(input);
    if (!parsedInput.success) throw new PluginRuntimeError("INVALID_ARGUMENT", "Invalid plugin capability arguments.");
    return this.exclusive(pluginId, async () => {
      this.assertOpen();
      const state = this.states.get(pluginId)!;
      if (state.state !== "enabled" || !state.instance) {
        throw new PluginRuntimeError("NOT_AVAILABLE", "Plugin is not enabled.");
      }
      if (!state.grants.get(actor.id)?.has(capability)) {
        throw new PluginRuntimeError("ACCESS_DENIED", "This trusted actor has not been granted the exact capability.");
      }
      await this.authorize(actor, {
        action: "invoke", pluginId, actorId: actor.id, capabilities: [capability],
        inputDigest: createHash("sha256").update(JSON.stringify(parsedInput.data)).digest("hex"),
      });
      let result: unknown;
      try {
        result = await this.withTimeout("hook", this.hookTimeoutMs, signal => state.instance!.invoke(
          capability, parsedInput.data,
          { ...emptySignalContext(pluginId, signal), actorId: actor.id },
        ));
        const parsed = notificationReadOutput.safeParse(result);
        if (!parsed.success) throw new Error("Plugin result did not match its static capability schema.");
        return parsed.data;
      } catch (error) {
        const cleanup = reportCleanup(await this.cleanup(pluginId, state.instance), error);
        state.instance = undefined;
        state.grants.clear();
        state.state = "faulted";
        state.cleanup = cleanup.state;
        throw new PluginRuntimeError(
          "PLUGIN_HOOK_FAILED",
          `Plugin hook failed; cleanup ${cleanup.state}${errorTimedOut(error) ? " after timeout" : ""}.`,
          cleanup,
        );
      }
    });
  }

  close(): Promise<readonly PluginSummary[]> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeAll();
    return this.closePromise;
  }

  private async closeAll(): Promise<readonly PluginSummary[]> {
    const results: PluginSummary[] = [];
    for (const item of catalog) {
      results.push(await this.exclusive(item.id, async () => {
        const state = this.states.get(item.id)!;
        if (state.instance) {
          state.state = "stopping";
          const cleanup = await this.cleanup(item.id, state.instance);
          state.instance = undefined;
          state.grants.clear();
          state.state = cleanup.state === "complete" ? "disabled" : "faulted";
          state.cleanup = cleanup.state;
          if (cleanup.state !== "complete") {
            throw new PluginRuntimeError("PLUGIN_CLEANUP_FAILED", `Plugin shutdown cleanup ${cleanup.state}.`, cleanup);
          }
        } else {
          state.grants.clear();
          if (state.state !== "faulted") state.state = "disabled";
        }
        return this.summary(item.id);
      }));
    }
    return Object.freeze(results);
  }

  private assertOpen(): void {
    if (this.closed) throw new PluginRuntimeError("NOT_AVAILABLE", "Plugin runtime has been closed.");
  }

  private async authorize(actor: PluginRuntimeActor, request: PluginAuthorizationRequest): Promise<void> {
    if (!this.options.authorize) throw new PluginRuntimeError("ACCESS_DENIED", "No trusted native plugin authorizer is configured.");
    let authorized = false;
    try {
      authorized = await this.options.authorize(Object.freeze({ id: actor.id, trusted: true }), Object.freeze({
        ...request, capabilities: Object.freeze([...request.capabilities]),
      }));
    } catch {
      authorized = false;
    }
    if (authorized !== true) throw new PluginRuntimeError("ACCESS_DENIED", "Trusted native authorizer did not approve this exact plugin action.");
  }

  private validateCapabilities(requested: readonly string[]): readonly PluginCapabilityId[] {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 16) {
      throw new PluginRuntimeError("CAPABILITY_DENIED", "Request one or more exact allowlisted capabilities.");
    }
    const unique = new Set<string>();
    for (const capability of requested) {
      if (typeof capability !== "string" || !teamsCapabilitySet.has(capability as PluginCapabilityId)) {
        throw new PluginRuntimeError("CAPABILITY_DENIED", "Requested capability is not in the static safe allowlist.");
      }
      unique.add(capability);
    }
    return Object.freeze([...unique].sort() as PluginCapabilityId[]);
  }

  private requireAvailable(pluginId: PluginId): {
    factory: PluginFactory;
    config: Readonly<z.infer<typeof teamsConfigSchema>>;
  } {
    const factory = this.factories[pluginId];
    if (!factory) throw new PluginRuntimeError("NOT_AVAILABLE", "No trusted native implementation is injected for this plugin.");
    const config = this.configurations[pluginId];
    if (!config) throw new PluginRuntimeError("NOT_AVAILABLE", "Required non-secret plugin configuration is unavailable.");
    return { factory, config };
  }

  private summary(pluginId: PluginId): PluginSummary {
    const item = catalog.find(candidate => candidate.id === pluginId)!;
    const state = this.states.get(pluginId)!;
    const factory = this.factories[pluginId];
    const config = this.configurations[pluginId];
    const unavailableReason = !factory ? "implementation_not_injected"
      : !config ? "configuration_required" : null;
    return {
      ...item,
      available: unavailableReason === null,
      unavailableReason,
      state: state.state,
      capabilities: item.capabilities.map(id => ({ id, available: unavailableReason === null })),
      cleanup: state.cleanup,
    };
  }

  private async cleanup(pluginId: PluginId, instance: PluginInstance): Promise<{
    stop: PluginCleanupStep;
    dispose: PluginCleanupStep;
    state: PluginCleanupState;
  }> {
    const stop = instance.stop
      ? await this.cleanupStep("stop", signal => instance.stop!(emptySignalContext(pluginId, signal)))
      : "not-needed";
    const dispose = await this.cleanupStep("dispose", signal => instance.dispose(emptySignalContext(pluginId, signal)));
    return { stop, dispose, state: cleanupState(stop, dispose) };
  }

  private async cleanupStep(phase: string, hook: (signal: AbortSignal) => void | Promise<void>): Promise<PluginCleanupStep> {
    try {
      await this.withTimeout(phase, this.disposeTimeoutMs, hook);
      return "complete";
    } catch (error) {
      return errorTimedOut(error) ? "timed-out" : "failed";
    }
  }

  private async withTimeout<T>(
    phase: string,
    timeoutMs: number,
    hook: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError(phase));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => hook(controller.signal)), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  private async exclusive<T>(pluginId: PluginId, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(pluginId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(pluginId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(pluginId) === queued) this.locks.delete(pluginId);
    }
  }
}
