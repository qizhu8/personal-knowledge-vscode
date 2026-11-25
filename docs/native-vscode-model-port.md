# Exact native VS Code LM port handoff

Source contract:
[`OriginalVscodeChatModelPort`](../src/original-mcp-api-chat-contracts.ts).
This is the native provider interface needed by original API Chat. Its local
producer is implemented in
[`clients/vscode-host/original-mcp-native-chat.ts`](../clients/vscode-host/original-mcp-native-chat.ts),
using actual VS Code/signing context and the verified retained native-loop
bundle. It is fixture-tested, including more than 30 rounds, summary, images,
counting, cancellation and uncertain outcomes. That is **not actual installed
LM/RPC/Root qualification**. The authenticated approval RPC's six methods do
not implement this transport. A native-supports advertisement must never claim
these operations before actual handlers exist.

The port is permanently bound to the current authenticated native session:
broker/activation/identity, canonical root/workspace/custody/catalog/profile,
payload build and host entry. Every method rechecks that binding. Native
`LanguageModelChat`, cancellation/tool invocation context and credentials stay
inside actual VS Code. No HTTP endpoint, fake model profile or opaque object
serialized over JSON substitutes for them.

## 1. catalogue

```ts
catalogue(signal): Promise<{
  source: "vscode.lm";
  epoch: string; // authenticated activation ID
  models: Array<{
    id: string;             // stable original public vscode:<vendor>:<encoded-id>
    nativeModelId: string;  // actual LanguageModelChat.id, not a configured alias
    label: string;
    vendor: string; family: string; version: string;
    maxInputTokens: number; // native reported capacity
    maxOutputTokens: number | null; // null when native API does not report it
  }>;
}>
```

Use actual `vscode.lm.selectChatModels`, with the existing callable-model
exclusions (notably catalog-only `copilotcli`). Do not fabricate an empty list
for an unsupported API or failed permission. An actual successful empty
catalogue is distinguishable from `MISSING_NATIVE_METHOD`/access failure.
No provider request is made by discovery.

## 2. select

```ts
select({modelId, catalogueSha256}, signal): Promise<{
  selectionId: string; modelId: string; epoch: string; maxInputTokens: number;
}>
```

`modelId` is the exact public ID returned by catalogue; the producer keeps its
actual model object in an ephemeral selection registry. Pin the catalogue's
`originalMcpRequestDigest` and actual activation. Fresh native permission and
selection are required. No silent default, HTTP or other-model fallback.
Revocation/reload/model replacement invalidates the handle.

## 3. count

```ts
count({
  selectionId, requestId, requestSha256, outputTokenCap,
  messages: readonly ModelProviderMessage[],
  tools: readonly ModelProviderTool[],
}, signal): Promise<{
  selectionId: string;
  requestSha256: string;
  inputTokens: number;
  countingMethod: "vscode-countTokens-plus-tool-overhead";
}>
```

Use actual selected-model `countTokens`, and the **same native message
conversion** as dispatch. System/tool message conversion cannot differ
between counting and sending. Tools require explicitly accounted conservative
schema overhead; do not describe that overhead as provider-reported usage.
The count is request/selection-bound admission evidence, not billing.
Nonfinite/negative/unavailable counts fail closed.

## 4. stream

```ts
stream({
  selectionId, requestId, requestSha256,
  messages: readonly ModelProviderMessage[],
  tools: readonly ModelProviderTool[],
  outputTokenCap: number, // explicit request policy, never invented model capacity
}, signal): AsyncIterable<ModelProviderEvent>
```

This is one inference using the actual selected `sendRequest`. Require a
fresh exact model/request permission, usable native context and valid count/
budget before dispatch. Honour signal cancellation with native cancellation;
ignore late parts. Output is public text/tool proposals and genuine reported
usage only; never hidden thinking or fabricated zero/token/credit reports.
Tools are proposals sent back to canonical Core approval/execution, not
executed by the model transport. Finish is emitted only after normal native
stream completion; errors/cancellation must not become successful finish.
Native errors should be code-only/redacted and distinguish not-dispatched
from potentially dispatched outcomes.

## Full original loop, not an eight-step fallback

The current broker-native `ChatTurnService` protocol is intentionally bounded
to eight steps. The four-method one-inference port above does not by itself
provide original `hard_tool_round_limit:1..1000`, one tool-free summary or Task
goal continuation.

Reuse the existing actual native engine:
`legacy/src/chat/api-chat-vscode.ts::streamVscodeChat(model, request, onText,
actualVscode)`. It accepts fresh messages/tools/cancellation and does not
need ApiChatStore, old Host files/bearers, original permissions or old queued
work. Its `beforeRound`/`beforeWork`/tool callbacks can cross the authenticated
channel to persist native admission and execute tools on canonical Core.
`OriginalNativeChatExecutionPlan`/`OriginalNativeChatExecutionPort` describe
that additional full-execution boundary, implemented locally by that native
producer. Broker transport/current-Root integration and actual native LM
qualification remain separate; neither interfaces nor fixture mocks establish
permission or full availability.

The full execution plan requires an explicit budget
`{maxInputTokens,maxTotalOutputTokens,deadlineMs}` in addition to the per-
inference `outputTokenCap`. Host ceilings are native policy, never invented
model capabilities. `beforeInference` includes plan/source/selection hashes,
inference/round, actual portable native prompt/options and the counted input;
it must await broker durable admission. `usage` records whether numbers are
native-counted or provider-reported.

Stable digest helpers are exported alongside the interfaces:
`originalNativeChatDigest(catalogueOrPlanOrArguments)`,
`originalVscodeModelRequestDigest({selectionId,requestId,messages,tools,outputTokenCap})`
and `originalNativeChatInferenceDigest(beforeInferenceWithoutRequestSha256)`.
They use canonical sorted-key JSON and SHA-256 without ToolGateway's unrelated
small structural limit. Authentication `epoch` remains activationId;
optional `catalogue.registryRevision` invalidates native selections without
silently changing the authenticated grant epoch.

Pre-dispatch cancellation is cancelled. Cancellation/deadline after native
dispatch is uncertain/unknown, because token cancellation cannot prove no
billing or effects; late parts are ignored and work is never replayed.

API Chat source/identity/request code, explicit HTTP/Core execution, and the
authenticated native-lane/durable same-Core callback integration are
fixture-tested. The Source/API/Core test performs ten tool-capable native
rounds plus summary, real canonical tool approval/read receipts and no HTTP
fallback. Full original eight-operation readiness remains false until actual
installed native LM, source/Chat/budget and high-level UI bindings are
qualified and remaining managed-goal/context semantics are implemented.
