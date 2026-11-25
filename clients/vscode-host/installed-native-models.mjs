import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { finalizeNativeModelExecution, validateNativeModelTokenPersistence } from "./installed-native-model-counter-flush.mjs";

/** Real VS Code API/IPC with a synthetic local provider; no external model or canonical business effects. */
export async function verifyInstalledNativeModels({ root, installed, session, waitJson, toolRoundLimit = 31, signal, counterFlushConfig }) {
  assert([31, 48].includes(toolRoundLimit), "Only the declared isolated fixture round limits are supported.");
  validateNativeModelTokenPersistence(counterFlushConfig?.mode, true, toolRoundLimit);
  const rpc = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-native-chat-rpc.js")).href);
  const { originalNativeChatDigest, originalVscodeModelRequestDigest } = await import(
    pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-api-chat-contracts.js")).href);
  const progress = async stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }));
  await progress("native-model-enable");
  await writeFile(join(root, "native-model-enable-requested.json"), '{"requested":true}');
  const supported = await rpc.waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 120000 });
  assert(supported.includes("execution.run") && supported.includes("models.stream"));
  const port = rpc.createOriginalMcpNativeChatRpcPort(session), lifetime = new AbortController();
  const abortFromOwner = () => lifetime.abort(signal.reason);
  if (signal?.aborted) abortFromOwner();
  else signal?.addEventListener("abort", abortFromOwner, { once: true });
  try {
    const catalogue = await port.models.catalogue(lifetime.signal);
    assert.equal(catalogue.source, "vscode.lm");
    const model = catalogue.models.find(model => model.vendor === "pkm-native-fixture");
    assert(model, "The real registered synthetic native model must be discovered.");
    await progress("native-model-select");
    const selected = await port.models.select({
      modelId: model.id, catalogueSha256: originalNativeChatDigest(catalogue),
    }, lifetime.signal);
    const input = {
      selectionId: selected.selectionId, requestId: randomUUID(),
      messages: [{ role: "user", content: "rpc-stream-fixture" }], tools: [], outputTokenCap: 512,
    };
    const request = { ...input, requestSha256: originalVscodeModelRequestDigest(input) };
    const counted = await port.models.count(request, lifetime.signal);
    assert.equal(counted.countingMethod, "vscode-countTokens-plus-tool-overhead");
    assert(counted.inputTokens > 0);
    await progress("native-model-stream");
    let text = "";
    for await (const event of port.models.stream(request, lifetime.signal))
      if (event.type === "text") text += event.text;
    assert.equal(text, "synthetic native streaming response");
    const executionCatalogue = await port.models.catalogue(lifetime.signal);
    assert(executionCatalogue.models.some(candidate => candidate.id === model.id));
    await progress("native-model-select-execution");
    const executionSelection = await port.models.select({
      modelId: model.id, catalogueSha256: originalNativeChatDigest(executionCatalogue),
    }, lifetime.signal);
    const calls = [], inferences = [];
    let summary = "";
    await progress("native-model-execution");
    const plan = {
      schema: "pkm.original-api-chat-execution/v1", requestId: randomUUID(), chatUrl: "api-chat://isolated-native-fixture",
      selectionId: executionSelection.selectionId, sourcePlanSha256: originalNativeChatDigest({ scope: "synthetic fixture only" }),
      messages: [{ role: "user", content: "rpc-full-loop-fixture" }],
      tools: [{ name: "fixture_read", description: "Synthetic read callback with no business effects",
        parameters: { type: "object", properties: { round: { type: "integer" } }, required: ["round"], additionalProperties: false } }],
      hardToolRoundLimit: toolRoundLimit, outputTokenCap: 512,
      budget: { maxInputTokens: 200000, maxTotalOutputTokens: 32768, deadlineMs: 120000 },
    };
    const executionStartedAt = performance.now(), executionStartedEpochMs = Date.now();
    const executionDeadline = toolRoundLimit === 48 ? setTimeout(() => lifetime.abort(
      Object.assign(new Error("The owned 48-round execution exceeded its 95-second fixture budget."),
        { code: "FIXTURE_EXECUTION_BUDGET" })), 95000) : undefined;
    let result, executionError;
    try { result = await port.execution.run(plan, {
      async beforeInference(request) { inferences.push(request); },
      async tool(request) {
        assert.equal(request.name, "fixture_read");
        calls.push(request);
        return { receiptSha256: createHash("sha256").update(`synthetic-fixture-${request.callId}`).digest("hex"),
          content: "synthetic read callback result", effect: "not-committed" };
      },
      async text(request) { summary += request.text; },
      async usage() {},
    }, lifetime.signal); }
    catch (error) { executionError = error; }
    finally { clearTimeout(executionDeadline); }
    const executionEndedEpochMs = Date.now(), executionDurationMs = performance.now() - executionStartedAt;
    const { counterFlush } = await finalizeNativeModelExecution({
      root, result, executionError, config: counterFlushConfig, waitJson,
      observedCounts: { observedToolCalls: calls.length, observedInferenceCalls: inferences.length },
      timing: { executionStartedEpochMs, executionEndedEpochMs, executionDurationMs },
    });
    if (toolRoundLimit === 48) assert(executionDurationMs <= 95000);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.toolRoundLimit, { limit: toolRoundLimit, rounds: toolRoundLimit, reached: true });
    assert.equal(calls.length, toolRoundLimit);
    assert.equal(inferences.length, toolRoundLimit + 1);
    assert.equal(summary, "synthetic tool-free final summary");
    const provider = JSON.parse(await readFile(join(root, "native-fixture-provider.json"), "utf8"));
    assert.equal(provider.nativeCalls, toolRoundLimit + 2);
    assert.equal(provider.loopCalls, toolRoundLimit);
    if (toolRoundLimit === 48) assert(provider.tokenCalls > 1154 && provider.tokenCalls <= 6000);
    assert(provider.tokenCalls > 0);
    assert(port.apiChat, "The high-level native Chat lane must be independently advertised.");
    const chatRequestId = originalNativeChatDigest({ scope: "installed synthetic Chat binding only" });
    const sourcePlanSha256 = originalNativeChatDigest({ scope: "synthetic source, not original-library admission" });
    await progress("native-chat-resolve");
    const chatSelection = await port.apiChat.resolve({
      requestId: chatRequestId, requestedModelId: model.id, chatUrl: null,
      sourcePlanSha256, expectedSelection: null,
    }, lifetime.signal);
    assert.equal(chatSelection.modelId, model.id);
    assert.equal(chatSelection.wireModelId, model.nativeModelId);
    await progress("native-chat-authorize");
    assert.equal(await port.apiChat.authorize({
      operation: "create", requestId: chatRequestId, commandId: "installed-native-chat-binding",
      chatUrl: null, sourcePlanSha256, sourceUncertain: false,
      argumentsSha256: originalNativeChatDigest({ fixture: "create binding only" }), selection: chatSelection,
    }, lifetime.signal), true);
    const chatUrl = `pkm://chats/0123456789abcdef/${randomUUID()}`;
    await port.apiChat.present({ requestId: chatRequestId, chatUrl, sourcePlanSha256, selection: chatSelection }, lifetime.signal);
    await progress("native-chat-presentation");
    await waitJson(join(root, "native-chat-binding-ui-passed.json"));
    const cancel = new AbortController();
    await progress("native-chat-cancel");
    const pendingCancel = port.apiChat.authorize({
      operation: "cancel", requestId: originalNativeChatDigest({ fixture: "cancel-binding-only" }),
      commandId: "installed-native-chat-cancel", chatUrl, sourcePlanSha256, sourceUncertain: false,
      argumentsSha256: originalNativeChatDigest({ fixture: "cancel fields" }), selection: null,
    }, cancel.signal);
    await waitJson(join(root, "native-chat-cancel-visible.json"));
    cancel.abort();
    await assert.rejects(pendingCancel, error => error.code === "NATIVE_CHAT_CANCELLED");
    await writeFile(join(root, "native-chat-cancelled.json"), '{"cancelled":true}');
    await waitJson(join(root, "native-chat-late-click.json"));
    assert.equal((await port.models.catalogue(lifetime.signal)).source, "vscode.lm");
    const nativeRequests = await import(pathToFileURL(join(installed,
      "next-runtime/server/dist/original-mcp-native-request.js")).href);
    const { originalDigest } = await import(pathToFileURL(join(installed,
      "next-runtime/server/dist/domain/action-compiler-validation.js")).href);
    const binding = {
      schema: "pkm.original-mcp-native-host-admission/v1",
      root: session.binding.root, workspaceId: session.binding.workspaceId,
      planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
      sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
      epoch: session.activationId, actorId: "mcp:external", domains: ["mcp-public"],
      configurationSha256: originalNativeChatDigest({ fixture: "control-only; no Core Action authority" }),
    };
    const capsuleSha256 = originalNativeChatDigest({ fixture: "synthetic Action control capsule; no source import" });
    const actionId = "installed.native.action.control", contentHash = originalNativeChatDigest({ fixture: "source" });
    const implementationSha256 = originalNativeChatDigest({ fixture: "pure implementation descriptor" });
    const common = { binding, capsuleSha256 };
    const actionRequest = (method, payload, signal = lifetime.signal) =>
      nativeRequests.requestOriginalMcpNative(session, method, payload, { signal, timeoutMs: 120000 });
    assert.equal((await actionRequest("action.status", common)).trusted, false,
      "Model/public/native identity admission cannot enable separate Action approval.");
    await progress("native-action-enable");
    await writeFile(join(root, "native-action-enable-requested.json"), '{"requested":true}');
    await waitJson(join(root, "native-action-enabled.json"));
    assert.equal((await actionRequest("action.status", common)).trusted, true);
    assert.equal((await actionRequest("action.authorize", {
      ...common, actionId, contentHash, trustEpoch: session.activationId,
    })).decision, "approve");
    const sourceRequest = {
      schema: "pkm.native-action-source-request/v1", root: binding.root, workspaceId: binding.workspaceId,
      actorId: "mcp:external", profileSha256: binding.profileSha256, epoch: session.activationId, capsuleSha256,
      requestSha256: originalNativeChatDigest({ fixture: "synthetic no-execution source review" }),
      operation: "installed-control-only-source-review",
      sources: [{ actionId, contentHash, implementationSha256, effects: ["pure"] }], noExecution: true,
    };
    await progress("native-action-source");
    const sourceDecision = await actionRequest("action.source.approve", { binding, request: sourceRequest });
    assert.equal(sourceDecision?.noExecution, true);
    assert.equal(sourceDecision?.scope, "original-action-source-state/v1");
    assert.equal(sourceDecision?.requestSha256, sourceRequest.requestSha256);
    const consent = {
      schema: "pkm.original-action-invocation-consent/v1", operation: "action_call",
      run_id: `action_run_${randomUUID().replaceAll("-", "")}`,
      request: { action_id: actionId, content_hash: contentHash, inputs: { value: "not executed by this installed fixture" },
        idempotency_key: "installed-control-only", trigger: null, project_id: null },
      sourceReceiptSha256: originalNativeChatDigest({ fixture: "synthetic control receipt; not a Core receipt" }),
      capsuleSha256, implementationSha256, deadline: Date.now() + 120000, automaticReplay: false,
    };
    const invocation = {
      ...common, actionId, contentHash, trustEpoch: session.activationId,
      effectContext: { kind: "pipeline", components: ["core.constant"], stepCount: 1, effects: ["pure"],
        inputDigest: originalDigest(consent), inputPreview: JSON.stringify(consent) },
    };
    await progress("native-action-invocation");
    assert.equal((await actionRequest("action.invocation.approve", invocation)).decision, "approve");
    await progress("native-action-cancel");
    const cancelAction = new AbortController();
    const pendingAction = actionRequest("action.invocation.approve", invocation, cancelAction.signal);
    await waitJson(join(root, "native-action-cancel-visible.json"));
    cancelAction.abort();
    await assert.rejects(pendingAction, error => error.code === "NATIVE_REQUEST_CANCELLED");
    await writeFile(join(root, "native-action-cancelled.json"), '{"cancelled":true}');
    await waitJson(join(root, "native-action-late-click.json"));
    await progress("native-action-revoke");
    await waitJson(join(root, "native-action-revoked-ui.json"));
    assert.equal((await actionRequest("action.status", common)).trusted, false);
    assert.equal(await actionRequest("action.source.approve", { binding, request: sourceRequest }), null);
    assert.equal((await port.models.catalogue(lifetime.signal)).source, "vscode.lm",
      "Revoking Action approvals must not revoke the independent native model channel.");
    const evidence = {
      passed: true, source: "actual installed vscode.lm API with synthetic local test provider",
      remoteModelOrCurrentProfileQualified: false, canonicalCoreBusinessEffectsQualified: false,
      catalogue: true, exactSelection: true, nativeTokenCalls: provider.tokenCalls,
      stream: true, nativeModelCalls: provider.nativeCalls, toolRounds: calls.length,
      executionStartedEpochMs, executionEndedEpochMs, executionDurationMs,
      ...(counterFlush ? { counterPersistence: { mode: counterFlushConfig.mode, runId: counterFlushConfig.runId,
        generation: counterFlushConfig.generation, acknowledgement: counterFlush } } : {}),
      awaitedInferenceCallbacks: inferences.length, finalToolFreeSummary: true, businessReady: false,
      highLevelChat: { exactResolve: true, createConsent: true, readonlyPresentation: true,
        lateCancelledConsentRejected: true, originalLibrarySourceAdmitted: false },
      nativeActionControls: { signedRpc: true, separateEnable: true, sourceNoExecutionConsent: true,
        exactInvocationConsent: true, lateCancelledConsentRejected: true, statusBarRevocation: true,
        independentModelChannelPreserved: true, syntheticSourceDescriptors: true,
        canonicalStorageAuthorityWriterQualified: false, actualActionExecutionQualified: false },
    };
    await writeFile(join(root, "native-model-rpc-passed.json"), JSON.stringify(evidence));
    await progress("native-model-complete");
    await waitJson(join(root, "native-model-ui-passed.json"));
    return evidence;
  } finally {
    signal?.removeEventListener("abort", abortFromOwner);
    lifetime.abort(); await port.dispose();
  }
}
