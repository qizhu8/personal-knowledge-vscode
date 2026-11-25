import { z } from "zod";
import { isAbsolute, resolve, relative, sep, basename } from "node:path";
import type { Storage } from "./storage.js";
import type { HostServicesOptions } from "./host-services.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpNativeHost } from "./original-mcp-native-host.js";
import type { AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { originalDigest, originalDefinitionValue } from "./domain/action-compiler-validation.js";
import { verifyLegacyActionProposals } from "./legacy-action-mcp.js";
import { resolveActionExecutable } from "./action-program-build.js";
import { pinRecipeEffectFile } from "./original-mcp-recipe-effect-files.js";
import { registeredActionReview, registeredActionDecision } from "./original-mcp-registered-action-contracts.js";
import { originalCosmosAction, nativeCosmosDefinition, prepareNativeCosmos } from "./original-mcp-cosmos.js";
import { readNativePrivateCosmosConfiguration } from "./original-mcp-action-maintenance.js";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pinRegisteredActionPath } from "./original-mcp-registered-action-path.js";
import { pinRegisteredActionExecutable } from "./original-mcp-registered-action-executable.js";
import type { ActionObservedCompletion } from "./action-runtime-process.js";

/** Source review and per-invocation process review over the current signed host; no archived grant revival. */
export async function createOriginalMcpRegisteredActionHost(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): Promise<NonNullable<HostServicesOptions["action"]>> {
  const root = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
  const { receiptSha256: _receipt, ...binding } = host.receipt;
  const sources = new Map<string, { expiresAtMs: number; definition: Record<string, any> }>();
  const effects = new Map<string, { expiresAtMs: number; files: Array<{ path: string; sha256: string }>;
    configurationSha256: string | null; localPath: ReturnType<typeof prepareNativeCosmos>["local"] }>();
  let trusted = false, closed = false;
  const epoch = host.receipt.epoch;
  function current() {
    if (closed) throw new Error("REGISTERED_ACTION_HOST_CLOSED");
    session.assertCurrent(); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    return { workspaceId, actorId: "mcp:external", trustedWorkspace: trusted, epoch };
  }
  async function refresh() {
    current();
    const status = z.strictObject({ trusted: z.boolean(), trustEpoch: z.string().uuid() }).parse(
      await requestOriginalMcpNative(session, "action.registered.status", { binding },
        { timeoutMs: 3000, signal: session.signal }));
    trusted = status.trusted && status.trustEpoch === epoch;
    return current();
  }
  const timer = setInterval(() => { void refresh().catch(() => { trusted = false; }); }, 1000);
  timer.unref();
  storage.retainNativeCleanup({ release: async () => { closed = true; trusted = false; clearInterval(timer); } });
  function definition(actionId: string, contentHash: string) {
    const db = storage.connectNative();
    try {
      const proposals = verifyLegacyActionProposals(db, workspaceId);
      return proposals.find(item => item.action_id === actionId && item.content_hash === contentHash)?.definition as Record<string, any> | undefined;
    } finally { db.close(); }
  }
  async function review(purpose: "source" | "effect" | "reconcile", value: Record<string, any>, inputs: Record<string, any>,
    executable: { path: string; sha256: string } | null, args: string[], files: Array<{ path: string; sha256: string }>,
    prepared?: ReturnType<typeof prepareNativeCosmos>, runId?: string,
    reconciliation?: z.infer<typeof registeredActionReview>["reconciliation"], configurationSha256?: string) {
    await refresh();
    if (!trusted) return undefined;
    const request = registeredActionReview.parse({ binding, purpose, definition: value,
      contentHash: originalDefinitionValue(value).content_hash, runId: runId ?? null, inputs, executable, arguments: args,
      sourceFiles: files, configurationSha256: prepared?.configurationSha256 ?? configurationSha256 ?? null,
      ...(reconciliation ? { reconciliation } : {}),
      localPath: prepared?.local ?? null, deadline: Date.now() + 120000, automaticReplay: false });
    const decision = registeredActionDecision.nullable().parse(await requestOriginalMcpNative(session,
      "action.registered.review", request, { timeoutMs: 120000, signal: session.signal }));
    await refresh();
    if (!trusted || !decision || decision.decision !== "approve" || decision.requestSha256 !== originalDigest(request)
      || decision.expiresAtMs <= Date.now() || decision.expiresAtMs > request.deadline) return undefined;
    return decision;
  }
  function checkFiles(files: Array<{ path: string; sha256: string }>) {
    for (const file of files) if (pinRecipeEffectFile(file.path).sha256 !== file.sha256)
      throw new Error("REGISTERED_ACTION_SOURCE_CHANGED");
  }
  const automaticTrusted = {
    current, refresh,
    revoke() { trusted = false; sources.clear(); effects.clear(); closed = true; clearInterval(timer); },
    async authorize(actionId: string, contentHash: string, expectedEpoch: string) {
      current();
      if (!trusted || expectedEpoch !== epoch) return false;
      const key = `${actionId}:${contentHash}`, prior = sources.get(key);
      if (originalCosmosAction(actionId)
        && nativeCosmosDefinition(storage, host, actionId).content_hash !== contentHash) return false;
      if (prior && prior.expiresAtMs > Date.now()) {
        return true;
      }
      const value = definition(actionId, contentHash);
      if (!value) return false;
      const decision = await review("source", value, {}, null, [], []);
      if (!decision) return false;
      sources.set(key, { definition: value, expiresAtMs: decision.expiresAtMs });
      return true;
    },
  };
  function observedEffect(observed: ActionObservedCompletion) {
    current();
    if (!trusted) throw new Error("REGISTERED_ACTION_HOST_REVOKED");
    const bound = observed.binding;
    const effect = effects.get(`${bound.runId}:${bound.actionId}:${originalDefinitionValue(bound.definition).content_hash}:${originalDigest(bound.inputs)}`);
    if (!effect) throw new Error("REGISTERED_ACTION_OBSERVATION_UNAVAILABLE");
    checkFiles(effect.files);
    const closure = pinRegisteredActionExecutable(effect.files[0]!.path);
    if (closure.some(file => !effect.files.some(expected => expected.path === file.path && expected.sha256 === file.sha256)))
      throw new Error("REGISTERED_ACTION_INTERPRETER_CHANGED");
    if (effect.configurationSha256 && readNativePrivateCosmosConfiguration(storage, host).sha256 !== effect.configurationSha256)
      throw new Error("COSMOS_CONFIGURATION_CHANGED");
    return effect;
  }
  await refresh();
  storage.retainNativeCleanup({ release: async () => { automaticTrusted.revoke(); } });
  return {
    automaticTrusted,
    assertObservedReconciliationCurrent(observed) { observedEffect(observed); },
    async approveObservedReconciliation(observed, expectedVersion, reason) {
      const bound = observed.binding;
      const effect = observedEffect(observed);
      const decision = await review("reconcile", bound.definition, bound.inputs, effect.files[0]!,
        [...observed.arguments], effect.files, undefined, bound.runId, {
          expectedVersion, processJobId: observed.processJobId, processOperationId: observed.processOperationId,
          processReceiptSha256: observed.processReceiptSha256, outputSha256: originalDigest(observed.outputs), reason,
          output: z.record(z.string(), z.json()).parse(observed.outputs),
        }, effect.configurationSha256 ?? undefined);
      observedEffect(observed);
      return !!decision;
    },
    async approvePurePipeline(binding) {
      if (!binding.runId) return false;
      const decision = await review("effect", binding.definition, binding.inputs, null, [], [], undefined, binding.runId);
      return !!decision;
    },
    process: { commands: [], trustedPrograms: {
      arguments(binding) {
        return originalCosmosAction(binding.actionId) && binding.inputs
          ? prepareNativeCosmos(storage, host, binding.actionId, binding.inputs).args
          : binding.implementation.args as string[] ?? [];
      },
      timeoutMs(binding) {
        return originalCosmosAction(binding.actionId)
          ? Number(binding.inputs?.timeout_seconds ?? 300) * 1000 : undefined;
      },
      assertCurrent(binding) {
        current();
        if (!binding.inputs) throw new Error("REGISTERED_ACTION_EXACT_INPUTS_REQUIRED");
        const key = `${binding.runId}:${binding.actionId}:${originalDefinitionValue(binding.definition).content_hash}:${originalDigest(binding.inputs)}`;
        const effect = effects.get(key);
        if (!effect || effect.expiresAtMs <= Date.now()) throw new Error("REGISTERED_ACTION_EFFECT_EXPIRED");
        checkFiles(effect.files);
        const closure = pinRegisteredActionExecutable(effect.files[0]!.path);
        if (closure.some(file => !effect.files.some(expected => expected.path === file.path && expected.sha256 === file.sha256)))
          throw new Error("REGISTERED_ACTION_INTERPRETER_CHANGED");
        if (effect.configurationSha256 && readNativePrivateCosmosConfiguration(storage, host).sha256 !== effect.configurationSha256)
          throw new Error("COSMOS_CONFIGURATION_CHANGED");
        if (effect.localPath) {
          const parent = lstatSync(dirname(effect.localPath.path));
          if ([parent.dev, parent.ino, parent.uid, parent.mode].join(":") !== effect.localPath.parentPin)
            throw new Error("COSMOS_LOCAL_PARENT_CHANGED");
          if (effect.localPath.kind === "source"
            && pinRegisteredActionPath(effect.localPath.path).sha256 !== effect.localPath.sha256)
            throw new Error("COSMOS_UPLOAD_SOURCE_CHANGED");
        }
      },
      output(binding, value) { return originalCosmosAction(binding.actionId) ? { result: value } : value; },
      async approve(binding, build, artifact) {
        current();
        if (build || artifact || binding.implementation.kind !== "program"
          || Object.keys(binding.definition.dependencies ?? {}).length)
          throw new Error("REGISTERED_ACTION_DIRECT_PROGRAM_REQUIRED");
        const cosmos = originalCosmosAction(binding.actionId)
          ? prepareNativeCosmos(storage, host, binding.actionId, binding.inputs) : undefined;
        const args = cosmos?.args ?? binding.implementation.args ?? [];
        if (!Array.isArray(args) || !args.every(value => typeof value === "string" && !value.includes("${"))
          || typeof binding.implementation.program !== "string") return false;
        const executable = resolveActionExecutable(binding.implementation.program);
        if (!executable || /^(sh|bash|dash|zsh|fish|cmd|powershell|pwsh)(\.exe)?$/i.test(basename(executable)))
          return false;
        const files = pinRegisteredActionExecutable(executable);
        if (cosmos) {
          if (nativeCosmosDefinition(storage, host, binding.actionId).content_hash
            !== originalDefinitionValue(binding.definition).content_hash) return false;
        } else if (/^(node(?:js)?|python(?:\d+(?:\.\d+)*)?)(\.exe)?$/i.test(basename(executable))) {
          const first = args[0] as string | undefined;
          const inline = /python/i.test(basename(executable)) ? "-c" : "-e";
          if (!first || first.startsWith("-") && first !== inline) return false;
          if (first !== inline) {
            const script = isAbsolute(first) ? first : resolve(root, first), member = relative(root, script);
            const shippedAzureQuery = fileURLToPath(new URL("../compat/legacy-action-azuredevops-query.py", import.meta.url));
            if (script !== shippedAzureQuery
              && (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member))) return false;
            files.push(pinRecipeEffectFile(script));
          } else if (args.length !== 2) return false;
        }
        const pins = files.map(file => ({ path: file.path, sha256: file.sha256 }));
        const decision = await review("effect", binding.definition, binding.inputs, pins[0]!, args as string[], pins, cosmos, binding.runId);
        if (!decision) return false;
        checkFiles(pins);
        const contentHash = originalDefinitionValue(binding.definition).content_hash;
        if (!binding.runId) throw new Error("REGISTERED_ACTION_RUN_BINDING_REQUIRED");
        effects.set(`${binding.runId}:${binding.actionId}:${contentHash}:${originalDigest(binding.inputs)}`,
          { expiresAtMs: decision.expiresAtMs, files: pins,
            configurationSha256: cosmos?.configurationSha256 ?? null, localPath: cosmos?.local ?? null });
        return true;
      },
    } },
  };
}
