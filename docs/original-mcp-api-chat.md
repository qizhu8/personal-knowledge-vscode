# Original API Chat: source admission and protocol work

The target remains all eight captured `mcp.tool.api_chat_*` operations, not the
older read-only compatibility projection. None is promoted to full original
readiness merely because its name is registered.

## Large preserved source

`src/original-mcp-api-chat-source.ts` introduces an explicitly versioned
`pkm.original-api-chat-source/v1` envelope:

```ts
planOriginalMcpApiChatSource(storage, nativeHost, {
  stagingDirectory, limits: {maxChats, maxMessagesPerChat, maxMessages},
})
admitOriginalMcpApiChatSource(storage, nativeHost, plan, sourcePolicy)
originalMcpApiChatSource(storage, nativeHost)
readOriginalMcpApiChatMessage(storage, nativeHost, chatId, sequence)
```

Planning uses `openOriginalMcpCustodyReader` on the actual sealed original
custody. One pinned inventory connection is retained; the entire inventory is
not hashed again for every message part. Source metadata, v1 inline messages,
v2 immutable CAS index pages and message parts are validated incrementally.
No whole-root history array is assembled. Previous unreferenced immutable
generations remain preserved; live locks/unknown files, corrupt parts and
duplicate/orphan identities are refused.

The independently private SQLite staging capsule stores metadata, ordered
message descriptors and hashes, group/Trash placement and historical request
identities. It does not duplicate all 20 GiB into RAM or activate historical
settings. Fresh source-domain consent is bound to the exact root, workspace,
custody, native profile/epoch and source index. Initial import requires the
actual parser's process-branded plan, not caller-created successful receipts.
Published native source tables are immutable. Old `host_id`, PID, bearer,
permission grants, queued commands, worker state and model settings remain
archival data, not current authority.

The old small archive inspector retains its original 128 MiB/4096-entity
semantics; this is a separate streaming source protocol. The new source
fixture uses actual old writers and more than 4096 CAS entities.

### Separate signed native source consent

`original-mcp-source-policy-contracts.ts` contains the existing Todo/Memory
policy request/decision and API Chat source plan/request schemas, without
loading Core or Storage into the native UI. Existing module exports remain
compatible. `original-mcp-native-source-contracts.ts` defines three independent
methods: `todo.source.approve`, `memory.source.approve`, `chat.source.approve`.
Each strict payload is `{binding, noExecution: true, request}` with the existing
exact domain request; each result is the existing
`{actorId: "mcp:external", decisionId, expiresAtMs}` or `null`. The authenticated
request/result frame binds the entire request digest and signed session/epoch;
identity, public approval and model selection are not source consent.

The extension-host producer `createOriginalMcpNativeSourceProducer` displays
each exact source separately and grants at most five minutes. Its revoke
commands and disposal close the **whole signed attachment**, not just the UI.
Granular signed revocation notifications are not implemented. The Node
`createOriginalMcpNativeSourcePolicies(storage, host, authenticatedSession)`
supplies independent `.todo`, `.memory`, `.chat` policies and brand-checked
same-owner authority. Accepted decisions retain session liveness through
schema parsing. Denial, replacement, adapter revocation or attachment close
invalidates cached Todo/Memory worker revocation resources and Chat source
sessions. Existing importer/custody checks and finite expiry still apply.
Old workers, Engine permissions and queued execution are never inherited.

`readOriginalMcpApiChatSourceSession(storage, host)` exposes read-only current
source evidence for a same-owner atomic worker gate:
`{actorId, decisionId, expiresAtMs, root, workspaceId, custodyPlanSha256,
profileSha256, planSha256, nativeHostReceiptSha256, epoch, revocation}`.
`revocation` is the actual four-byte `SharedArrayBuffer`, independently
invalidated before a source review await, on denial/replacement, signed-source
logical revoke, owner cleanup or host close. Re-admission creates a new buffer
and never clears an old one. The worker must compare the exact source/host/
epoch/decision binding, require a future expiry and `Atomics.load(..., 0) === 0`
at its commit boundary. A live socket or ordinary host signal is insufficient.
This getter neither activates a source nor authorizes an assignment effect.

Shared integration now registers all three methods/payload/result schemas.
The native attachment constructs the producer with its actual `closeTransport`,
advertises its methods, routes typed requests, and disposes it on close.
The cold component exposes only its retained same-owner branded policies.
The implementation must continue to register all three schemas
and dispatch `isOriginalNativeSourceMethod` through
`parseOriginalNativeSourcePayload`. Native attachment activation must construct
the producer with the actual `closeTransport` callback, advertise its methods,
dispatch `handle(method, payload, requestId, signal)`, and dispose it on close.
Owning source admission must consume the branded Node policies. Until those
shared methods are registered, source calls return `MISSING_NATIVE_METHOD`.
The existing 64 KiB **whole request frame** budget is unchanged: oversized
source selections report the required byte count and refuse, without a
truncated approval identity. Chunked source-consent transport does not exist.
Producer doubles and private signed-socket regressions are not installed
source-admission or full native-readiness qualification.

### Installed Todo source scenario: cold-component integration

`clients/vscode-host/installed-native-source.mjs` supplies a bounded companion
to the existing whole-editor-exit → cold capture → installed-editor-restart
workflow. It does not package a VSIX, edit a profile, or substitute fabricated
source requests/session descriptors for actual ownership. Its tests validate
fixture provenance/refusal only; an installed pass requires the parent-owned
hooks below and a controlled complete payload snapshot.

1. In `bootstrapOriginalMcpColdComponent`'s existing `prepareNative`, immediately
   after creating `host` from the actual authenticated `session`, retain
   `createOriginalMcpNativeSourcePolicies(storage, host, session)`. Add a
   no-argument `sourcePolicies()` accessor on the frozen component. It must
   reject closed/incomplete components, call `host.assertCurrent()` and the
   retained policies' `assertCurrent()`, then return those same policies.
   Do not accept supplied policies or reconstruct a session from a descriptor.
2. Add `--native-source` to the installed driver, requiring
   `--native-identity --cold-component` and excluding `--native-models`.
   Carry one trailing `native-source` marker into `--inside`, set
   `fixture.nativeTodoSource`, and condition only the new cold-component hooks
   on that flag; keep the existing `cold-component` experiment mode.
   Keep the unchanged
   assertion that the **whole actual editor exited** before bootstrap. The
   first installed enrollment's real profile SHA/public identity must be used
   by the subsequent sealed custody capture; never re-pin the sealed plan.
3. In `verifyInstalledColdComponent`, after creating its branded, disjoint
   disposable fixture and public/privacy files, but **before**
   `bootstrapOriginalMcpColdComponent`, call
   `prepareInstalledNativeTodoSourceFixture({installed, componentFixture,
   legacyWriter: {path, sha256}})`. Supply the independently pinned original
   compiled `knowledge/filestore.js` from the controlled fixture/release
   snapshot. It is not bundled in the minimal host payload. This creates
   actual original Board/Note/task/audit/worker bytes before B0/custody sealing;
   its old worker token stays private in memory. Retain the returned fixture
   object in the coordinator; reconstructing it from JSON is refused.
4. After the existing approved Skill writes and before component close/B1
   capture, call `verifyInstalledNativeTodoSource({root, installed, component,
   host: await component.complete(), sourceFixture, python, env,
   port: fixture.port, payloadBuildId})`. It starts its own bounded native CDP
   UI observer while the existing cold UI observer waits for restoration.
   No shared installed runner/UI branch is needed for the source stages.
   Stages are `native-source-todo-deny`, `native-source-todo-admit`,
   `native-source-todo-revoke`.
5. The helper verifies real exact source modals, signed branded policy
   hydration, the original task through the **same cached Core**, unchanged
   original bytes/owner lease, rejection of the old worker token, and actual
   status-bar revocation invalidating that Core's source resource while its
   owner remains alive. It writes `native-source-todo-passed.json` only after
   all assertions and native UI evidence pass. Include that result in the
   cold/installed evidence. Continue existing component close, B1 preservation
   and typed retirement; after fresh B0 restore, call
   `verifyInstalledNativeTodoSourceRestored(sourceFixture, restored.root)` to
   verify the original Todo bytes.

This scenario qualifies only the disposable installed **Todo source** path.
It does not qualify Memory/Chat source scope, worker assignment/execution,
full original readiness, the user's real profile/keyring, or production
cutover. The complete signed source request budget stays 64 KiB. Native source
indicators display their exact expiry and disappear when their decision
expires; visual expiry neither renews grants nor closes unrelated permissions.

## Original Host/request protocol

The original API is asynchronous: `models/list/create/get/send/cancel`
return a stable request receipt, and `api_chat_request_get` reads that
receipt without submitting/replaying it. `api_chat_capabilities` advertises
only the authenticated current native Host, never an old archived Host as
online. Historical queued/running requests must be presented as uncertain,
never scheduled by native startup or polling.

`src/original-mcp-api-chat.ts` now implements that request/Host layer on the
same actual RootOwner/Core and preserved source index. The public dispatcher
selects it only after actual fresh source admission. It creates no alternate
root, old file-based Host endpoint or legacy bearer. Submission precedes
dispatch; command collisions refuse, repeated commands return existing
receipts, and pending work becomes uncertain on restart rather than executing.

The six read/create protocol adapters are separate from the conditional
bounded send/cancel slice. A fresh explicit HTTP selection can use the actual
same-owner Core ChatTurnService; its exact config/transport object binding is
verified, so no wrong-default or VS Code-to-HTTP fallback is possible.
Bounded sends use the current session revision and server-owned atomic
input/terminal transcript writes. Archived history still requires the original
execution context port; the bounded transport refuses it before model dispatch
rather than dropping history or bypassing session authority with a raw turn.
Cancellation targets only an owned actual Core response and retains partial
output. Old requests, PIDs and worker slots are never cancellation targets.
The copied original public context/Copilot-credit projection is compared
against the existing original pure helpers, not replaced with empty results.

## Explicit live Memory checkpoint

Live recall is opt-in per request through the genuine optional
`resource.apiChat.memory.select` port. Archived `memory_enabled`/inline memory
never enables it. Without that port, the existing no-live-recall behavior
remains unchanged. The native producer offers **No live Memory recall
(default)** first; selecting live recall requires the exact independently
admitted same-owner scope, a well-formed literal query within 512 UTF-8 bytes
and at most three full current confirmed records. Missing admission, denied
selection, invalid queries, stale bindings and cancellation refuse explicitly;
failed requested recall never becomes empty or off fallback.

The implemented consumer calls `readOriginalMcpMemoryContext` on the actual
RootOwner/Core, then appends inert JSON-quoted full records/source references.
The manifest binds actual Chat/request, workspace, native epoch/host receipt,
Chat source plan, argument/model/draft digests, selected query/limit, Memory
scope and revision. Required records are not truncated or pruned. Successful
canonical no-match recall is distinct from unavailable/denied recall.

The actual snapshot guard survives catalogue/selection, history reads,
send authorization and tool preparation. The durable executor rechecks it
after native model approval and immediately before each inference ACK; native
tool review/approval and dispatch are guarded too. Chat revision/archive,
source/host/owner and draft-input identity are retained alongside Memory.
Revocation cannot undo an already sent prompt; physical erasure and automatic
re-query/goal replay are not claimed.

**Parent-owned shared integration is implemented:** optional
`chat.memory.select` travels through the authenticated native Chat RPC and a
frozen `apiChat.memory` exists only when that method is negotiated. Exact
request/epoch/scope/digest checks and cancelled-late-choice rejection have been
verified. The owned schemas are
`originalNativeChatMemoryRequest` and `originalNativeChatMemoryChoice`.
Request fields are `requestId`, `chatUrl`, `sourcePlanSha256`,
`argumentsSha256`, exact `selection`, nullable `draftSha256`, nullable admitted
`scope`, nullable bounded `proposedQuery`. Results bind `requestId`, current
`epoch`, `bindingSha256` and `mode`: `off`; `live` with exact `scope`, `query`,
`limit:1..3`; or `refused` with `source-not-admitted`, `denied`, `invalid-query`.
RPC result validation must check epoch, request digest and exact requested
scope. Source-only native admission remains a separate prerequisite.

Eight native producer/UI-double cases passed. Two actual same-owner Core
Memory cases passed: source revision changed during asynchronous model
approval blocks the first provider admission; revocation during canonical
tool approval stops the next request. The retained socket/Core
epoch/draft/round-loop case also passed with the updated executor. This is
not installed live-Memory or full native readiness; opt-in RPC/activation and
signed positive source qualification remain parent integration work.

Core selectors:
`explicit same-owner Memory|selected live Memory|authenticated native execution lane`.
The coherent owned production emit list is
`original-mcp-api-chat.ts`, `original-mcp-api-chat-contracts.ts`,
`original-mcp-api-chat-execution.ts`, `domain/original-api-chat-context.ts`;
the existing input-image helper remains a dependency. No shared `dist` was
emitted for this checkpoint.

## Read-only original Chat binding evidence

`readOriginalMcpApiChatBinding(owner, host, actor, locator)` in
`src/original-mcp-api-chat-binding.ts` returns a frozen process-branded
`OriginalMcpApiChatBindingSnapshot`. It requires a non-Trash original source,
the actual same-actor Core session, authenticated native API resource,
current-epoch successful native continuation/inference evidence and the
actual RootOwner lease recorded by the executor. A retained mapping, copied
snapshot, transport liveness or old request alone is insufficient.
`assertOriginalMcpApiChatBinding` checks the real registered object and
native/source/request pins; async `snapshot.assertCurrent()` additionally
checks current Core revision/archive state.

The snapshot carries the actual source approval DTO and independent
revocation buffer from `readOriginalMcpApiChatSourceSession`, not a fabricated
signal/grant. It is identity/read evidence only. Todo assignment remains
blocked until the parent validates source/Todo/worker revocation and Core
owner/revision in the worker transaction before receipt replay/publication.
The binding helper and updated executor must be emitted coherently.

`tests/original-mcp-api-chat-source.test.mjs` contains focused
source/protocol cases, including genuine old CAS writers beyond 4096 entities,
native Core create, bounded model/cancel behavior, pending-request restart,
managed historical identity/permission separation and non-replay. Model/native
UI callbacks in these isolated fixtures are **not production native proof**.
No eight-operation full-readiness promotion is made.

## Native high-level admission producer

`createOriginalMcpNativeChatSessionProducer` now implements exact native model
resolution, request-keyed create/send/cancel consent and a read-only native
Chat binding document in the extension host. It discovers genuine native
metadata, uses an explicit Quick Pick when no exact model was requested, and
never substitutes a default/profile/HTTP model. Root/profile/activation/source
and exact model/catalogue bindings are rechecked after consent; denied,
cancelled, stale or repeated requests cannot authorize Core work. Cancellation
uses a separate request with a null selection and does not depend on a live
model registry or tokenizer.

Create presentation consumes the same approved request/selection/source
binding. Its extension-owned text-document provider is read-only and is
disposed on attachment revocation. It is **not** the original editable Chat UI.
If canonical create succeeded but native presentation failed, the durable API
receipt retains the created Chat and reports `outcome_unknown`; polling or
resubmitting that command never creates another Chat.

The high-level wire contracts are `originalNativeChatResolve`,
`originalNativeChatRequest`, `originalNativeChatPresentation` and
`OriginalNativeChatSessionPort`. The producer supplies `apiChat` to the native
channel, and the owning API runtime prefers `apiChat` on the frozen,
authenticated native resource over the older trusted-embedding policy port.
**Shared RPC integration is implemented:** `chat.resolve`, `chat.authorize`,
`chat.present` are negotiated as an optional complete three-method set on the
existing authenticated channel. The frozen Node `resource.apiChat` binds
validated results to their exact request/session digests, native epoch and
model selection. A partial method set grants no high-level resource.

The parent verified **32/32 socket-RPC plus same-Core cases** and **29/29 host
producer cases** before the context milestone below. The socket/Core test
traverses create → resolve/authorize/present → send with ten tool rounds and
summary → cancel without the legacy policy callback fallback. Native
UI/model decisions in those fixtures are synthetic. The parent subsequently
passed the exact isolated installed high-level VSIX rerun: model resolution,
create consent, read-only binding, cancel/late-click handling, catalogue and
the 31-round native loop. Reported fixture counters were `nativeCalls=33` and
`tokenCalls=1154`. The Monaco assertion was corrected to normalized exact text;
attachment/heartbeat guards were unchanged. The earlier session-revoked
attempt at loop 23 under the two-second heartbeat remains recorded.
These installed tests use a deterministic fixture provider, not the user's
provider. They are not deployed native Core or full original-engine readiness.

The existing client-session tests exercise production admission handlers with
isolated native UI/model doubles (including late clicks, registry changes,
source/model mismatches and non-replay). They are not installed/native-provider
or actual-profile proof. The retained 1..1000-round/tool-free-summary engine
and same-Core durable tool approval path are unchanged.

The fixed authenticated native-model lane is now consumed through the actual
process-branded resource in nativeHost's optional third argument
`{nativeChat:rpcPort}`. Root/workspace/custody/catalog/profile and activation
must match the signed Host policy. A plain object/Socket/callback is not
accepted. The six-method approval policy still does not grant model transport
or source access by itself.

`src/original-mcp-api-chat-execution.ts` is the same-owner durable adapter,
not another model engine. Before each native inference it verifies the exact
native prompt/options/plan/source/selection digest, commits an intent, obtains
fresh native model approval and commits authorization before ACK. Native text,
attributed usage and actual canonical ToolGateway/ApprovalBridge results are
retained in Core SQLite. Tool receipt chains bind later inference IDs; unknown
effects stop. Request replay cannot schedule the model again.

The actual-socket Source/API/Core fixture now covers ten tool-capable native
rounds plus summary, real Core tool dispatch/approval receipts, public context/
credits, retained old bytes and zero HTTP fallback. That fixture's model and
domain/UI decisions remain synthetic, not installed LM or actual-root proof.
The installed high-level producer/RPC qualification is a separate parent task.

## Admitted inline context and historical evidence

`OriginalApiChatContextAssembler` consumes only metadata/messages already
read through the immutable, freshly admitted Chat custody reader. Inline
`context` and selected memory/PKM-Skill/external-Skill snapshots retain their
full text, labels, IDs, content digests and exact Chat/source-plan binding.
IDs that look like file or knowledge locators are reference labels: no live
file, Note, Skill or external permission is resolved or inherited.

Terminal historical tool records retain their call/message identities, source
sequence, arguments, result and evidence digest as explicitly untrusted
reference text. They are never converted into native tool invocations, cached
tool results or current Core success receipts. Historical PNG/JPEG message
bytes remain intact and require the exact model's image-input capability.
All assembled context shares a bounded native-frame envelope; required data
that does not fit is rejected, not pruned.

Managed Tasks/delegations still require their dedicated native authority.
Source **draft** images now have a native-only durable one-use path.
`original_api_chat_input_images` is an immutable supplemental canonical
transcript journal. It binds the preserved collection and source-plan digest
to one actual request/user-input identity and prompt hash, in the same SQLite
transaction as the owned response intent. Later dialogue restores those exact
image bytes onto that input; a later prompt does not consume the draft again.
The original Chat files and generic Core message schema are unchanged.
Explicit `includeHistory:false` excludes earlier native dialogue too.

Native dialogue continuation consumes the complete canonical transcript through
`chat.session.messages` cursors in both the full native and bounded HTTP paths.
A cursor is a sequence position, not a snapshot: the consumer pins the initial
Chat revision and transcript extent, verifies every page's identity, revision,
extent, contiguous sequence and advancing cursor, and rechecks the session
after paging and before admitting the input. Concurrent edits, archival or
inconsistent cursors refuse the request; they never trigger automatic retry or
history pruning. Host/source/owner authority remains checked around every read.
The full native path restores a consumed draft image on its exact owning input
across the complete transcript and retains its inference-time session guard.
The bounded path still submits only one user input to Core; Core owns the
actual model history and atomically checks the expected session revision.
Existing native-frame, bounded-context and model budgets are unchanged:
pagination removes a one-page admission restriction, not a context limit.

Missing or mismatched owning inputs, altered source/image digests, old native
history that previously lost its draft bytes, and incomplete/uncertain work
require reconciliation. A consumed or uncertain draft is never reassigned to
a new request. Unsupported image models fail before draft consumption or
send authorization; the native path never falls back to HTTP.

Three focused context cases passed, including actual socket/high-level RPC and
same-Core continuation with retained inline references, PNG bytes and old tool
evidence. Only the changed API module and new helper were privately transpiled;
shared `dist` was not emitted. The native model/UI fixture ports are synthetic,
not installed VS Code provider or real-user data. The next coordinated Core
build must include `src/domain/original-api-chat-context.ts`.

## Todo discovery from admitted Chat source

Original-root `todo.agent.list` now combines the exact admitted original Chat
directory with active same-actor native Core sessions. It preserves original
UUIDs/URLs, excludes Trash and foreign native sessions, and checks source,
library, lease and native/domain consent again before publishing a complete
paged result. Archive-only entries are explicitly nonassignable.

The original public route uses the existing canonical capability validator,
matching read channel, worker authentication and output envelope before
selecting this same-owner reader. Ordinary workspaces and all mutation routes
are unchanged. Invalid versions or entry points cannot invoke the reader.
Discovery does not restore old worker tokens or grant live Chat assignment;
`todo.workitem.assign` still requires a genuine native assignment binding.

The parent reran the Todo directory, original-domain and original-public
regressions: 16 cases passed, including the integrated canonical route.
These are isolated real RootOwner/Core fixtures with trusted embedding
decisions, not installed native source-approval or full readiness proof.

The subsequent atomic assignment slice is integrated through canonical
validation/authentication. Original-source Chat targets cannot fall back to
native session existence. A genuine prepared same-owner admission and its
actual source/Todo revocation resources reach the Storage worker; the worker
checks them before recovery, receipt replay, intent and publication and stores
the exact guard. Revoked or lost runtime authority cannot recover a pending
assignment after restart. Ordinary native targets retain their existing path.
The parent reran 20 coupled Todo/domain cases, including real canonical
assignment without any Chat/model execution. This does not qualify an installed
assignment UI or restore historical worker tokens.

### Installed source and cold recovery result

The exact coherent candidate passed this complete created-fixture scenario:

```sh
node clients/vscode-host/installed-test.mjs --native-identity \
  --cold-component --native-source --legacy-vsix <pinned-original-4.0.22.vsix> \
  --vsix <reviewed-native-candidate.vsix> --evidence <private-evidence.json>
```

Real native Todo source denial/admission/revocation reached the actual branded
policy and same cached Core. Original Board/Note bytes and the owner lease
remained unchanged; the old worker token was rejected. Revoking the actual
status item closed the signed attachment and denied subsequent cached-Core
reads while its RootOwner remained alive.

The cold fixture uses private PID/mount/network namespaces with namespace-local
procfs; no shared process is stopped or allowlisted, and the production global
writer guard is unchanged. The entire actual fixture editor exits before both
B0 capture and B1 preservation. The test verifies real Note/Skill writes, B1
retention, typed retirement and fresh disjoint B0 restore, including original
Todo bytes. An earlier harness ordering bug attempted B1 while the editor was
still alive; the guard refused it, and the harness now requires editor exit
before B1. Test source/profile identity is sealed only after actual enrollment.

This qualifies the created fixture and Todo source flow, not actual-root
takeover, production keyring, Memory/Chat source UI or installed assignment.

## Fresh-epoch rebinding and draft-input checkpoint

Native Chat records retain model **configuration**, not a live model handle or
permission. After restart, the expected configuration is labelled with the
current admitted host epoch only for a fresh resolve/consent request. Exact
model, provider, permission and budget matching still applies; actual selection,
inference and tool approvals are obtained again. The stored configuration is
updated only after fresh send authorization. Old pending/unknown requests
remain non-replayable.

Five focused cases passed for the epoch/image batch: inline context and
refusal, transactional one-use image custody, rollback/schema protection, and
actual socket/high-level RPC/same-Core continuation across a real owner/native
session restart. Fresh consent denial causes no inference; subsequent approval
restores prior image-bearing history while keeping one original draft claim.
Those socket/model/UI fixture ports are synthetic, not installed provider or
real-user qualification.

The exact Core-continuation selector is
`authenticated native execution lane drives original API hard-round callbacks through one actual Core`.
The combined selector is:

```sh
node --experimental-transform-types --test \
  --test-name-pattern='authenticated native execution lane|native admitted inline context|native source context|native draft image input custody|native draft input images' \
  tests/original-mcp-api-chat-source.test.mjs
```

Run that command through the existing isolated runner with the coherent
candidate modules. Only these three production modules were privately
transpiled for this checkpoint; shared `dist` and host/RPC files were untouched:
`src/original-mcp-api-chat.ts`,
`src/original-mcp-api-chat-input-images.ts`,
`src/domain/original-api-chat-context.ts`.

## Native authority and engine conditions

The new independently enrolled native identity authenticates the producer;
it does not grant model, tool, Chat or budget authority. Production execution
still requires the actual current-profile bridge:

* Actual callable VS Code LM catalog and exact model selection/default
  resolution, not configured profiles advertised as callable models.
* Fresh source/Chat/request/model/context/budget approval. Old Chat endpoint,
  credentials, permission mode, tools and worker grants are not inherited.
* Native provider streaming/cancellation and real canonical tool approval
  dispatch on the owning Core.
* An owned Chat presentation/notification port where required; no old UI
  writer may be restarted to implement it.

The implemented native provider contract is exported as
`OriginalVscodeChatModelPort` in
`src/original-mcp-api-chat-contracts.ts`:

1. `catalogue(signal)` returns actual `vscode.lm` descriptors and native epoch.
   `maxInputTokens` is reported native capacity; an unreported output limit is
   `null`, never invented from input size.
2. `select({modelId,catalogueSha256},signal)` returns a live, ephemeral
   `selectionId` bound to the exact native object/profile/epoch.
3. `count({selectionId,requestSha256,messages,tools},signal)` returns the same
   request/selection identities and actual native counting plus explicitly
   identified tool overhead.
4. `stream({selectionId,requestId,requestSha256,messages,tools,outputTokenCap},signal)`
   yields public `ModelProviderEvent`s with cancellation. Tool proposals return
   to canonical approval/dispatch; they are not executed by the transport.

The selected model object, native invocation context and credentials remain
inside actual VS Code. Output caps are explicit request policy, not fabricated
provider-reported usage. Unsupported or stale selection/native methods fail
closed. This interface is not itself a native producer or authority proof.
The six-method authenticated approval RPC does **not** implement these LM
operations. Generic ModelConfigService/HTTP model factories remain explicitly
unsupported for VS Code; their guards were not relaxed.

The existing managed Chat engine has an intentional eight-step/128-message
bounded protocol. It does not implement the original
`hard_tool_round_limit:1..1000` followed by one tool-free summary. Raising
constants or silently using eight steps would not be compatibility.
The explicit original execution/budget lane and same-Core callback adapter now
exist and have isolated business tests; the existing bounded engine retains
its protections. Full readiness still requires actual installed/native model
qualification, high-level native Chat/source approval/presentation binding,
and the managed-goal/context integrations listed below.

There is an existing full native loop to reuse rather than writing a new
model engine: `legacy/src/chat/api-chat-vscode.ts::streamVscodeChat(model,
request,onText,actualVscode)`. It already owns native token counting, original
tool-loop/round-limit/final-summary semantics and cancellation. The native
producer uses the verified retained function with a freshly selected model and tool callbacks
delegated to canonical Core approval/execution. It does not need ApiChatStore,
an old Host/bearer, old permissions or writes to old Chat files.

`OriginalNativeChatExecutionPlan`/`OriginalNativeChatExecutionPort` describe
the implemented fixed execution RPC boundary: exact source/request/selection,
durable before-inference admission, tool proposal/result receipts and streaming
text. The production host producer and authenticated RPC implement this
boundary; interfaces alone are not qualification. A
one-inference LM transport plus the current bounded driver alone would still
not implement original full-loop behavior.

The native original-loop path supports hard-round limits through the real
lane; the bounded HTTP path explicitly refuses them. Fresh native-owned Task
control uses the canonical Goal/Harness service. Ordinary original managed
Tasks can enter only the separately reviewed, negotiated model-11 adoption
profile described in [managed-chat-task-adoption.md](managed-chat-task-adoption.md):
original identities/history are preserved, old permissions/acceptance stay
historical, and new evidence comes from actual current Core receipts.
Worker/uncertain sources and unqualified checkpoints/Recipe/file-version/image
context still refuse before model dispatch. Large output stays in the
native execution journal; a failed transcript projection cannot silently
drop it from the next model prompt. Neither bounded mode nor partially
qualified native mode is an allowed final cutover.

This source work is not actual-profile qualification or permission to
publish an incomplete full-MCP endpoint. Full151 readiness remains false.
