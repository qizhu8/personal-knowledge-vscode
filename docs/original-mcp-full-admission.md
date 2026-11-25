# Preserve-existing-MCP admission: implementation status and native host ports

The required final scope is **`preserve-existing-mcp/v1`**. The user rejected
finishing with `knowledge-content-only/v1`. That earlier broker remains an
explicit experimental foundation, not a production completion or automatic
enrollment path.

The target is the actual original 4.0.22/runtime 2.19.0 inventory: **151**
canonical operations, plus its `todo.*` and `memory.*` compatibility channels.
The historical 105-operation compatibility capture is not this target.

* Actual managed metadata SHA:
  `2108d78ba7b666f1087ad8d84dd0d345971b3d07b05e53e65ac6b0e20bc2cc12`
* Independently pinned exact-contract SHA:
  `696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21`
* Catalog revision:
  `8f4de8526bc2b4a043cfb493c180709292ed245bbf97bef8b7e9e4b4891a76a5`

Full metadata/discovery, including the hybrid direct aliases, does not prove
business implementation or authority. No readiness override or generic
“trust imported state” flag is provided.

## Fixed offline implementation gate

`src/original-mcp-public.ts` exports:

```ts
verifyOriginalMcpImplementationReadiness({
  acceptedScope: "preserve-existing-mcp/v1",
  catalogSha256: string,
  catalogRevision: string,
})
```

It rejects a different scope/target pin and returns:

```text
schema: "pkm.original-mcp-implementation-readiness/v1"
acceptedScope, catalogSha256, catalogRevision
requiredOperationIds
implementedOperationIds
missingImplementations: [{operationId, code, adapter, reason}]
authorityRequirements: [{id, operationIds, requiredAction}]
canonicalCompatibilityOperations: ["todo.*", "memory.*"]
canonicalCompatibilityMissing
ready
qualification
```

This is a non-callback inspection of the shipped implementation registry and
the independently pinned actual catalog. **It currently returns `ready:false`.**
An offline coordinator must refuse before original-root writes while this
gate is false or the required actual native-profile authority is unavailable.
Do not derive readiness from the number of registered names or schemas.

## Actual same-owner public dispatcher

`createOriginalMcpPublicDispatcher(owner, actor, nativeHost, canonicalBackend)`
requires the real `RootOwner`, its actual full `Storage`/Core, the exact
canonical legacy-adapter backend binding and a live native-host admission for
the pinned target catalog. A backend or receipt from another owner is rejected.

`createNativePublicOwnerBackend(..., {originalMcpHost})` lazily creates it.
The parent facade calls:

```ts
backend.invoke("original_mcp_public", {
  tool: originalTransportName,
  arguments: normalizedOriginalArguments,
}, abortSignal);
```

The dispatcher validates the exact actual-live input schema, fixes the actor,
obtains a fresh request-specific native approval, then calls the existing
typed native adapter on the same canonical owner. Results are converted from
the internal adapter envelope to the original public `CallToolResult`.
Module aliases therefore use the same fixed capability/version/approval/CAS
path, not another writer.

Public Note/Skill/Paper content and native unified retrieval use the shipped
typed implementations. Script publication now honors original private
top-level denials. Validated Recipe filesystem linkage is available only in
this request's approved native scope; ordinary experimental archive-only
startup does not activate it. Private Recipe publication filtering does not
remove private entities from internal complete validation/collision proofs.

The six already-composed native lazy Recipe operations dispatch through the
actual Core `recipeApi`, including its separate per-request mutation approval
and durable workflow receipts. This does **not** make adhoc/from-Skill/
autonomous/script-environment behavior fully compatible. The full gate still
reports those limitations.

Unimplemented/partial families return an explicit
`ORIGINAL_MCP_ADAPTER_REQUIRED` or `NATIVE_AUTHORITY_REQUIRED` reason, rather
than returning a successful limited capability projection, inventing empty
old state, replaying an old request or proxying the entire old Python MCP.
Discovery of `todo.*`/`memory.*` grants nothing. Their existing compatibility
engines now accept qualified original sources through the domain APIs below;
unhydrated or expired original-root domains still refuse business calls.

## Fresh native model/approval port

`src/original-mcp-native-host.ts` exports:

```ts
createOriginalMcpNativeHost(storage, policy)
verifyOriginalMcpNativeHostReceipt(storage, receiptSha256)
assertOriginalMcpNativeHost(host, storage)
originalMcpRequestDigest(json)
```

The returned host is process-branded against the actual Storage and cannot be
recreated from JSON/a persisted receipt. The immutable SQL admission is
`pkm.original-mcp-native-host-admission/v1`, binding root/workspace/plan,
profile digest, exact source-catalog digest, fixed `mcp:external` actor,
native authority ID/epoch, selected domains and non-secret configuration hash.
Old receipts never recreate a live grant.

The trusted native producer supplies this policy, **not an MCP client**:

```ts
{
  profileSha256, sourceCatalogSha256, authorityId, epoch,
  signal: AbortSignal,
  assertCurrent(binding): void, // synchronous actual profile/epoch check
  authorizeAdmission(binding): Promise<boolean>,
  models: {
    configuration,             // ExplicitModelConfiguration, no key values
    registryAvailability,
    credentialAvailable(bindingWithSecretId): Promise<boolean>,
    authorizeRequest(bindingWithProviderModelAndRequestSha256): Promise<boolean>,
    transport: ModelProviderTransport,
  },
  approveTool?(bindingWithExactToolApproval, signal): Promise<boolean>,
  toolCatalog?: readonly ToolGatewayBinding[],
  reviewTool?(bindingWithExactApprovalBridgeReview): Promise<NativeDecision|null>,
  authorizePublic?(bindingWithExactOriginalMcpRequest, signal): Promise<boolean>,
  authorizeMemoryDecision?(exactRecordAndReplacement): Promise<NativeDecision|null>,
}
```

The exact underlying types are exported in `OriginalMcpNativeHostPolicy`.
`authorizePublic` receives operation/version/tool, arguments, their digest and
read/mutation classification. Request scope is async-local, so one client's
grant cannot authorize another concurrent request. Public/model request
digests use canonical sorted-key JSON; model transcripts do not inherit an
unrelated small tool-argument structural limit. Native ToolGateway argument
digests retain that gateway's existing validation.

`models.credentialAvailable` receives the logical slot
`personalKnowledge.aiApiKey` and returns **only a boolean**. The broker creates
its own empty opaque presence handle. Actual keys never enter this API,
SQLite receipts, descriptor, argv, environment or logs.
`ModelProviderTransport.open({provider,payload,signal})` executes in/through the
authenticated native producer. It streams SSE bytes and honors cancellation;
there is no HTTP fallback, guessed endpoint or copied raw keyring data.

Every model dispatch requires current ownership/profile plus exact request
approval. Revocation cancels only owned streams, not the shared owner. Tool
review and effect approval validate the actor/workspace/argument binding again.
This model/public-request grant does not grant old Action, worker, Room,
subscription, private snapshot or process authority.

`openOriginalMcpRoot(plan, {prepareNative})` can compose these returned
`host.options` on its actual Storage **before the one canonical runtime is
created**. With this trusted factory, Storage recovery is deferred to that
runtime's typed preflight; workspace validation, worker schema checks and both
real ownership leases are not skipped. This permits an editor attachment to
arrive after cold storage bootstrap without replaying native effects before
their host is present. The root adoption commit is not a business activation
receipt, and no MCP-ready endpoint may be published merely because it exists.
The native-runtime test exercises that path and the real native
model service; it is not a fake Storage or old-MCP backend.

### Actual native producer/approval still required

The generic trusted-port constructor is not itself a proof that a process is
VS Code, owns the original profile or can read its old SecretStorage namespace.
Source enrollment/challenge primitives are implemented in
[`src/original-mcp-native-identity.ts`](../src/original-mcp-native-identity.ts)
and the genuine VS Code producer
[`clients/vscode-host/original-mcp-native-identity.ts`](../clients/vscode-host/original-mcp-native-identity.ts).
They provide profile-bound separate enrollment and a pinned, expiring,
one-use Ed25519 challenge bound to broker/root/workspace/plan/catalog/profile/
payload-build/host-entry identity. Successful verification authenticates an
activation identity only: **no model/tool/state permission is granted**.
Genuine isolated Production VS Code enrollment/reload has been exercised,
but used a test-only basic password store. That is not actual current-profile/
OS-keyring qualification or model/tool/business authority. Unit/mock producer
tests remain distinct evidence.

[`src/original-mcp-native-attachment.ts`](../src/original-mcp-native-attachment.ts)
now supplies an identity-only private Unix challenge/attestation session with
disconnect revocation/heartbeat and a pinned descriptor. It opens no owner or
business route and always reports `businessReady:false`. Actual current-profile
attachment integration, per-request native RPC policies and complete business
qualification remain unfinished.

`uone.personal-knowledge` and `pkm-nonproduction.pkm-v5` are different
SecretStorage namespaces. The latter cannot simply request the former's
secrets. The user selected **independent v5 identity with genuine native UI
re-enrollment**. Retain the old namespace unchanged; do not read/copy its
keys or ask the operator to choose a same-ID strategy again.

The new enrollment must verify the actual package/profile/epoch and obtain
fresh model, tool and effect approvals. It must not be a raw keyring-file copy, a
generic caller callback accepted as production proof, a same-PID cold
exemption or a hidden empty-model fallback. Room host credentials and worker
rebinding need their own exact native approvals, not this model grant.

### Staged native authority: editor closes, then reconnects to the same owner

The coordinator must not invent an “offline native-human/model grant”.
The viable stages are distinct:

1. **Before mutation:** require complete implementation readiness, a qualified
   native-bridge package/protocol, independently pinned actual profile/
   enrollment identity, approved bootstrap/write footprint, verified restart
   control, and complete B0 recovery evidence. These are deployment facts,
   **not** permission to send models, execute tools or impersonate the old host.
2. **Cold bootstrap:** while the actual editor/legacy writers are closed,
   retain the real fence and initialize only the canonical owner/validated
   storage and a private native-host attachment endpoint. Do not publish a
   business-ready MCP descriptor or activate new profile enrollment yet.
3. **Native attachment:** the newly started actual extension authenticates to
   that already-running owner. It proves the actual profile/package identity,
   broker challenge, root/workspace/plan/catalog binding and a fresh activation
   epoch. The owner is not reopened and the editor PID receives no cold-gate
   exemption.
4. **Native approvals and state admission:** obtain current LM selection,
   credential availability, tool invocation context and native approval
   responses; run the exact domain hydration/permission-rebind/recovery
   protocols. Unknown old work is never replayed. A persisted old receipt is
   not a current native approval.
5. **Activation:** only after authenticated native attachment, all domain/
   business gates and the full canonical/approved hybrid-surface probe pass
   may the coordinator publish the new business endpoint/enrollment receipt.

The remaining native integration is an authenticated attachment of the
implemented current-VS-Code/profile/activation identity, including any genuine
`vscode.lm`/tool invocation authorization context. The broker cannot derive
that from a supplied profile string, token file or PID. A signed transport
uses an independently enrolled profile identity (for example a signing key
kept in the extension's SecretStorage, with the public identity pinned in the
offline plan) to answer a fresh broker challenge. Such enrollment authenticates
the native producer; it does not preapprove future human/model/tool decisions.
An inherited authenticated native launch channel is another possible
primitive. The source signing primitive exists; its attachment and qualification must
run in the actual native host, never be emulated by
`assertCurrent: () => {}` in production.

The existing callback policy is the **broker-side adapter for that trusted
producer**, not this missing identity proof. Its `assertCurrent` must be a
synchronous check of an already authenticated connection/epoch and revoke its
AbortSignal on disconnect/staleness. Asynchronous RPC belongs in
`authorizeAdmission`, `credentialAvailable`, `authorizeRequest`, `reviewTool`,
`approveTool`, `authorizePublic` and the model transport, not in that assertion.
Native public/model approvals must bind the supplied canonical request digest;
model `open` must consume only the matching approved provider/model/payload
under the same session and must forward cancellation.

The pending offline-authority API therefore may attest **bootstrap deployment
facts** only; a separate post-attachment activation proof must attest the live
native epoch/domain receipts. Neither API is implemented/qualified by the
current model-port constructor. An implementation which requires all live LM/
human authority to exist while the editor is closed has an impossible stage
ordering, not a reason to synthesize authority or loosen the cold boundary.

## Bounded original Todo and Memory hydration

`src/original-mcp-domains.ts` exports these trusted-native embedding APIs:

```ts
hydrateOriginalMcpTodo(storage, nativeHost, originalBoardSlugs, domainPolicy)
hydrateOriginalMcpMemory(storage, nativeHost, {
  sourceSnapshot, sourceScopeSha256, stagingDirectory,
}, domainPolicy)
activateOriginalMcpDomain(storage, nativeHost, "todo" | "memory", domainPolicy)
enrollOriginalMcpTodoWorker(storage, nativeHost, {boardSlug, actorId}, workerPolicy)
assertOriginalMcpDomainSession(storage, nativeHost, "todo" | "memory")
```

These are not MCP endpoints and do not accept caller booleans as approval.
They require the actual branded Storage, current SQL lease, same-owner native
host and a fresh exact domain decision. Callback policies are trusted native
ports, **fixture-only as identity proof** until the signed native attachment
producer is connected. They cannot qualify or auto-enroll the actual profile.

The domain policy's `authorize(request)` returns
`{actorId:"mcp:external",decisionId,expiresAtMs}` or `null`. Expiry is at most
30 minutes. The versioned request binds root/workspace/custody/profile,
current native-host receipt, domain, phase, complete selected-file hashes and
source digest. Memory additionally identifies its source engine/database,
selected immutable scope, import-plan/receipt hashes and record/history counts.
The optional synchronous `checkpoint` is a failure-observation hook, not
permission or cold authority.

Todo reads selected exact `notes/<slug>.md` and
`notes/<slug>.assets/pkm-todo-board.json` from the sealed streaming custody.
It validates selected source hashes/ancestors again after native review,
without scanning/importing unrelated Chat history or changing child modes.
Source JSON, task IDs, ownership labels and audit history remain intact.
New native backing lives at **`.pkm-next-todo/<slug>/pkm-todo-board.json`**.
Actual canonical compatibility reads/mutations use the existing Todo engine
on that same original RootOwner/Storage, not a second root or fake Storage.
Historical WIP is data only: no old task is scheduled or worker resumed.

Memory reuses the bounded genuine `planLegacyMemoryImport`,
`stageLegacyMemoryImport`, `persistLegacyMemoryImport` and v2 scope-continuity
helpers on a closed private external snapshot. It validates complete original
revision/event/operation receipts and preserves the selected scope and IDs.
The explicit `source-derived/v1` document-identity option makes original-domain
staging/recovery reproducible; ordinary small imports keep their previous
default identity behavior and all existing limits.
This is a selected Memory-domain bound, **not** a larger global fixture-import
limit. Its additional external source snapshot must be independently captured
and qualified for the actual profile; this API does not magically prove that
an arbitrary source belongs to a production backup.

Authoritative private Memory Markdown lives at
**`.pkm-next-memory/explicit-<sha256>.md`**, not public `notes/System/Memory`.
Logical document IDs/paths and the canonical Memory planner remain unchanged.
Generic Note/Skill/search scanners and Git-synced public Notes therefore do
not acquire private imported facts. Both namespaces are covered by the
parent's reserved `/.pkm-*` Git guard; original files remain unchanged.
Native continuity uses a WAL-aware read-only view of the actual live original
Core DB, not an immutable-main snapshot that could miss newly committed
same-owner receipts.

Immutable `pkm.original-mcp-domain-intent/v1` SQL rows precede publication.
Commit rows appear only after exact fsynced publication and real importer
receipts. A known journal-owned staging prefix can resume; conflicting or
unknown staging bytes are preserved/refused. Pending hydration blocks ordinary
recovery/business work until its typed, freshly approved continuation.
Committed restart requires fresh domain activation; SQL receipts alone grant
nothing. Revocation reaches actual worker sessions through an in-process
shared revocation resource, including direct canonical calls.

Old Board token hashes stay historical and never authenticate. Worker
re-enrollment separately approves the exact Board digest/principal/new-token
hash/current native session, persists an immutable receipt and returns a newly
generated token only to that trusted caller. No plaintext token is persisted.
The grant expires no later than its parent Todo session and does not survive
native attachment replacement/restart.

External Memory compatibility still excludes confirm/revise/revoke, exactly
as before. Those transitions require the existing Core's exact-record native
human decision port; hydration is not human confirmation.

Remaining Todo integration includes original Note/work-item linkage,
new-Board/genesis publication and freshly composed live Chat directory/
assignment authority. Full151 readiness remains false. The private directory
footprints also require explicit coordinator optional-directory/B1 closure;
unchanged-source rollback refuses to discard them.

## Semantic model custody on an original root

Existing `admitLegacyRetrievalModel`/selection/frozen-corpus/learning verifiers
are reused. On an adopted original root their new artifacts are stored under
**`.pkm-next-retrieval-models`**, not the old
`packages/retrieval-models`. Unreceipted original packages therefore remain
untouched/untrusted rather than being adopted by presence or overwritten.

The original workspace validator accepts that private namespace only through
the actual native database and existing model receipt/inventory verifier.
Unknown/unreceipted packages still fail closed. The focused test admits a real
offline BERT package and performs actual semantic retrieval with
`model_invoked:true`, then restarts the same original root and verifies the
receipt. It does not silently substitute lexical search.

This private directory is reserved native B1 state and must be included in
later native write plans/B1 captures. Current unchanged-source rollback
**refuses** it rather than discarding it or pretending SQLite-only rollback
preserves the model artifacts. Post-write retirement is still unqualified.

## Git protection is a live denial boundary

Git-bearing original roots now require the parent's backed `gitProtection`
resource before prepare/open writes any managed state. Custody must be
captured **after** the approved root-only hardening/Git-policy changes.
The guard is retained by the actual RootOwner and checked before DB creation/
access, attachment, workspace lease acquisition/renewal and effect ownership
assertions, not only on a broker polling interval.

It is denial-only and cannot establish cold/human authority. A policy change
fences native writes. If a failed native shutdown cannot confirm release, the
real fence is retained and the error is surfaced; no cleanup code forcibly
releases an unconfirmed live owner or restores old ignore rules over B1.
The regression uses an owned crash fixture to verify that case without
weakening the shutdown rule.

## Remaining implementation/receipt families

The machine-readable readiness result is authoritative. Current substantive
gaps include:

* Archived original Action source/runs/queue/checkpoint history admission,
  native review/effect/credential producers and remaining full runtime/Cosmos
  qualification. The intrinsic local native engine/control slice in
  [original-mcp-action-runtime.md](original-mcp-action-runtime.md) is integrated
  without pretending it hydrates old Action authority.
* Eight original API Chat Host/command/request APIs, paged large-custody
  history, original identity/request continuity, fresh model/permission/budget
  integration and no replay of unknown old work.
* The original Room MCP client session API over qualified native ownership/
  credential/participant rebinding, not merely a join secret or client ID.
* Full Recipe adhoc/from-Skill/autonomous/script-environment behavior and
  protocol qualification beyond the existing typed lazy subset.
* Large-root private snapshot/recovery/classification domains, protected
  subscription profile/state/key receipts, original diagnostics/Agent/Skill/
  Recipe-history source scopes and nonempty original Trash coexistence.
* Original Note/work-item linkage/new-Board lifecycle and actual live Chat
  directory/assignment admission beyond the implemented canonical Board
  source hydration, fresh worker re-enrollment and Memory scope continuity.
  Production use still needs the actual independently captured Memory source
  and genuine native domain approval transport.
* Safe rename/category changes when private reference subtrees must be
  preserved without omitting validation or inheriting private write authority.

These are not solved by metadata equality, Native Host presence or an
operator boolean. The current native broker/full switch must remain blocked
until the required engines/receipts and actual native-profile authority are
implemented and qualified.

### Why the report does not mean “rewrite 126 engines”

Its per-operation blockers are deliberately conservative full-root admission
results, not a count of engines missing from v5:

| Category | Reusable implementation | Actual remaining work |
|---|---|---|
| Merely unwired protocol | `createLegacyNoteBackend`, native Core, fixed facade routing/result adapters | `original_mcp_public` now reaches those same bound handlers. Preserve the actual 151 input contracts, original result shape and cancellation; do not wrap the whole old Python MCP. |
| Old-state hydration | Todo projection/Note-pair receipts, typed Project/Recipe readers, Legacy state/Memory/history/model import and Trash modules | Bind selected source domains to the new large custody inventory; populate genuine native receipts and reconcile native paths. The old small importer's global preflight cannot admit a 20 GiB/76k-file Chat root. |
| Write footprint/ownership | Existing durable native mutation journals | Declare/validate new native directories and states, keep private artifacts Git-protected, preserve B1, and teach original-root validation the **typed** ownership/disposition proof. Do not ignore new directories just because their name is known. |
| Fresh native authority | Existing model, approval, Action trust, Room credential and worker APIs | Supply the authenticated current-profile producer and explicit rebind/approval. Archived settings, old tokens and credential bytes do not grant current authority. |
| Genuine engine/protocol gaps | Native Action intrinsic controls plus existing Recipe/Chat/Room engines | Local Action control/checkpoint behavior is implemented, but original source/history/effect admission and the full runtime remain incomplete. Recipe excludes parts of original lifecycle/control. Chat/Room engines lack the exact original Host/client control adapter plus large-state/identity continuity. |

Consequently many blocked operations can reuse existing executors once their
state/ownership/native profile proof is correctly admitted. Other gaps are
real behavior differences and cannot be fixed by calling the same method
name or approving a permission. The verifier keeps both kinds explicit until
the corresponding root protocol and business tests exist.

## Focused tests

* `tests/original-mcp-native-host.test.mjs`: same-owner native runtime
  composition, immutable receipts, opaque credentials, exact tool/model
  approvals, profile revocation, cancellation and tamper refusal.
* `tests/original-mcp-public.test.mjs`: exact live target gate, full-protocol
  public calls/direct alias, same lease, denied unsupported families/Memory,
  private Script filtering and real semantic model admission/restart.
* `tests/original-mcp-private-state.test.mjs`: actual Git protection before
  native writes, Core mutation refusal on policy changes and real fence
  retention on unconfirmed shutdown.
* `tests/original-mcp-domains.test.mjs`: nonempty old FileStore Board/worker/WIP
  and real Python Memory histories, 4100 preserved Chat files, same-owner
  canonical reads/mutations, private Memory publication, fresh worker
  re-enrollment, restart/continuity, foreign-actor denial, revocation and
  journal-prefix recovery/conflict refusal.

All are isolated source-controlled fixtures, not a claim that the actual
library/profile has been switched or that the full business parity gate passed.
