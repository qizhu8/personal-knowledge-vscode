# Selected original Action source/state admission

This slice implements selected source custody and real native-engine state
import. It is **not** full151 readiness, a whole-root importer, a credential
bridge, or a production Action approval producer. The bounded new-invocation
milestone below executes real admitted native pipelines; it does not qualify
the installed platform or the complete Action contract.

## Custody and native composition

`src/original-mcp-action-domain.ts` exports:

```ts
captureOriginalMcpActionCustody(plan, { backup, selection }, { writerFence? })
declareOriginalMcpActionNativeFootprint(storage, custody)
verifyOriginalMcpActionNativeFootprint(root, database?)
createOriginalMcpActionNativePolicy(storage, host, custody)
admitOriginalMcpActionDomain(owner, actor, host, nativeActionPolicy)
verifyOriginalMcpActionDomain(storage, database?)
assertOriginalMcpActionDomainSession(storage, host)
```

`selection` explicitly lists independently pinned registry definitions,
installed ModuleSet manifests, assets, runtime/compiler executable pins,
implementation selections, old Run IDs and qualification state files. A
missing implementation ID can be selected as `index:N`; the original
definition is not rewritten to invent an ID. Stable original `knowledgeId`
values are retained using the existing compiler's explicit ModuleSet snapshot
representation, not registration under a new Action identity.

The base OriginalMcp v1 custody **does not back auxiliary `actions`,
`action-sources`, or `action-module-sets` bytes**. The separate versioned Action
capsule copies and seals their selected bytes, including actual independently
hashed runtime/compiler executable bytes. It binds root device/inode,
base-plan/inventory, operator, profile, source identity and selected targets.
It is a new private backup disjoint from both the original root and the base
backup; it does not modify the existing base seal.

Capture holds the actual branded writer fence and cold process gate.
Historical `.pkm` bytes are read through one pinned streaming
`openOriginalMcpCustodyReader`, not the small whole-workspace importer.
Selected source payloads are bounded to 256 MiB/4096 files, independently of
unrelated root size. Toolchain files are bounded to 128 MiB each. The fixture
includes an unrelated sparse 25-GiB auxiliary file which is neither read nor
misrepresented as backed.

Old cancellation files, pending launch journals, their absence at B0, and
selected Run evidence-directory membership are pinned. A new cancel/control
file, changed source, changed toolchain identity, linked file, conflicting
capsule or modified checkpoint receipt denies admission/continuation.

The only new root directory is the **optional** `.pkm-action-authority`
endpoint namespace. Its exact immutable SQL footprint must be declared before
the native producer starts. Its required Git exclusion is `/.pkm-*`, its
`executionGrant` is false and its `b1Qualification` remains
`B1_UNQUALIFIED`. The fixed read-only verifier accepts only the bounded owned
private `host-authority.json` in that directory. The coordinator must retain
this namespace, the Action backup and canonical SQL in its eventual B1
closure. No `.pkm-next-action` directory or old-state overwrite is introduced.

## Separate current Action authority—not a boolean/model grant

The native policy factory constructs the existing concrete native-only
`createVscodeActionTrustBridge`. It accepts no caller permission callback,
old worker token, generic `trusted:true`, or serialized native handle.
The live Action epoch must equal the current branded profile host's epoch;
the old `.pkm/state/actions/host-authority.json` endpoint is not consulted.

Source/state review uses a dedicated typed `source_admission` RPC:

* Request: `pkm.native-action-source-request/v1`, binding root/workspace/actor,
  profile/epoch, capsule digest, exact import/reconciliation request digest,
  selected source/implementation hashes and effects, with `noExecution:true`.
* Decision: `pkm.native-action-source-decision/v1`,
  scope `original-action-source-state/v1`, with all the exact bindings,
  decision identity and a bounded expiry.

An ordinary model/public grant or even an Action `consented:true` boolean is
**not** that decision. The existing legacy Action producer does not implement
this new RPC and therefore fails explicitly with
`ACTION_SOURCE_ADMISSION_RPC_REQUIRED`; it is not silently made permissive.
Source for the signed current-profile UI/Action producer and its Core-owned
endpoint now exists as described below. The parent integrated the shared
request lane and explicit enable command. Genuine isolated installed
control-plane qualification passed; Core-owned endpoint/business execution
qualification remains pending.
The original domain tests use a separate authenticated native-RPC fixture;
they do not qualify the installed producer.

Compose `nativeActionPolicy.options` through the real owner's
`prepareNative(actualStorage)` before its one canonical runtime is created.
The policy creates no second Core or Action engine. Only exact supported
pure/interaction component bindings are installed; source custody does not
install an OS/Cosmos/program effect adapter or grant a new invocation.

## Real state admission and reconciliation

An immutable intent is committed before the existing `ActionRuntime`
imports the batch through its own real transaction and durable receipts.
Queue import and domain publication commit follow. If interrupted after
engine import, reactivation requires a new native decision and uses the
identical import receipts; no new run is submitted. Publication never creates
a successful business Run or successful qualification by hand.

* Exact successful program outputs and fully evidenced pipeline outputs are
  validated against their source and imported completion receipts.
* Abandoned running/dispatched work becomes `outcome_unknown`, without
  signalling old PIDs or replaying effects.
* Supported flat pure/interaction checkpoints preserve the original Run and
  checkpoint IDs, verify the exact implementation observation and every
  preceding step receipt, and rotate resume tokens. Resolved checkpoint
  history is retained. The pending proposal/answer schema/trigger must match
  the exact source continuation.
* Old cancellation intents remain denials. Pending launch journals and
  unsupported continuations require review rather than automatic dispatch.
* Old qualification evidence remains historical. Active/previously passed
  jobs become uncertain; old queued nonbuiltin work requires fresh native
  code review. Old grants and `allow_effects` values never establish current
  readiness. The real typed native queue reports these states.
* Retained original monitor notifications keep their original sequence and
  payload, with native events appended after the old cursor and explicit
  retention gaps.
* Manual reconciliation requires a fresh exact native Action decision and
  current Run revision. Its reason/output evidence is persisted by the
  existing engine; it never re-executes the original operation.

Native source sessions are process-branded, current-profile-bound, revocable
and expiring. SQL receipts alone never restore a live grant after owner
restart. Unsupported old nested/checkpoint forms fail explicitly instead of
returning empty history; global recovery refuses unselected old work.

The original adapter now also implements these **conditional admitted-source**
IDs, without changing full-readiness classification:

* `mcp.tool.action_get`
* `mcp.tool.action_module_sets`
* `mcp.tool.action_run_get`
* `mcp.tool.action_run_reconcile`

ModuleSets are reported disabled until their separate activation protocol;
an original source definition remains blocked for a **new invocation** until
its exact native approval/host handler is present.

## Native producer implementation checkpoint and parent integration

Implemented source files:

* `clients/vscode-host/original-mcp-native-action.ts`: concrete installed VS
  Code signer/trust checks, explicit enable/source/invocation UI, exact
  root/profile/epoch/capsule bindings, abortable decisions, bounded replay
  ledger, and status-bar revocation. Revocation permanently retires the
  producer; old decisions cannot re-enable it.
* `src/original-mcp-native-action-contracts.ts`: strict signed-session Action
  payload/result schemas and complete exact invocation-preview validation.
* `src/original-mcp-native-action-authority.ts`: branded same-Storage/host/
  authenticated-session locator and Core-owned writer for the optional
  `.pkm-action-authority/host-authority.json`. It creates a fresh token and
  rejects existing endpoints instead of inheriting or overwriting them.
  The concrete `createVscodeActionTrustBridge` is retained.
* `src/original-mcp-action-call-contracts.ts`: shared pure request schema,
  separated from the SQL invocation ledger so the native UI imports no
  ledger/SQLite implementation.
* `src/original-mcp-action-domain.ts`: read-only sealed source descriptors
  and mandatory branded producer-locator checks for signed `native-rpc:`
  hosts. Generic callbacks or JSON locator copies fail closed.

The parent applied shared integration steps 1 and 2 and verified the exact
experimental VSIX in a private installed profile. Step 3 still requires
selected same-owner composition and business/authority lifecycle qualification:

1. Merge `originalNativeActionMethods` and
   `originalNativeActionPayloadSchemas` into the existing native-request
   method/input tables, with a ten-method support bound. Use
   `originalNativeActionResultSchemas` for results and
   `parseOriginalNativeActionPayload(method, payload, session)` for the
   additional exact Action checks. `isOriginalNativeActionMethod` supplies a
   typed discriminator. Keep the existing authenticated request/result,
   cancellation, session and digest envelope; no new transport or caller
   approval callback is accepted.
2. In the actual native attachment, create one
   `createOriginalMcpNativeActionProducer(context, { session,
   signal: lifetime.signal, assertCurrent: current })` before advertising
   support. Advertise its four methods alongside the existing methods and
   route each parsed Action request to
   `actions.handle(method, payload, requestId, controller.signal)`.
   Expose explicit `enableActions()` calling `actions.enable()` and dispose
   it with the attachment. Creating/advertising the producer leaves it
   disabled; public/model admission never enables it. Do not recreate a
   revoked producer inside the same attachment.
3. After actual signed native host admission, compose the selected Action
   custody on the *same* `prepareNative(actualStorage)`:

   ```ts
   await declareOriginalMcpActionNativeFootprint(storage, custody);
   const authority = await startOriginalMcpNativeActionAuthority(
     storage, host, authenticatedSession, custody);
   const action = await createOriginalMcpActionNativePolicy(
     storage, host, custody, { nativeAuthority: authority });
   // Merge action.options into the same owner's existing runtime composition.
   ```

   The native attachment's `enableActions()` must be explicitly approved
   before source-policy construction. The UI does not write root state.
   The writer validates the signed session, exact selected B0 descriptors
   and current canonical source/invocation receipts before forwarding.

The four signed methods are:

| Method | Payload beyond the fixed native host binding | Result |
| --- | --- | --- |
| `action.status` | `capsuleSha256` | `{trusted, trustEpoch}` |
| `action.authorize` | `capsuleSha256, actionId, contentHash, trustEpoch` | `{decision, trustEpoch}` |
| `action.source.approve` | `request: NativeActionSourceRequest` | typed source decision or `null` |
| `action.invocation.approve` | `capsuleSha256, actionId, contentHash, trustEpoch, effectContext` | `{decision, trustEpoch}` |

The three-second existing bridge `authorize` probe only acknowledges an exact
sealed source *candidate* on the enabled signed lane. It grants no execution;
the typed aggregate source-review dialog owns admission. Each invocation or
continuation then receives a separate exact native dialog. Incomplete/truncated
input previews are denied rather than approved using a digest alone.

The installed candidate exercised separate Action enable, typed no-execution
source review, exact invocation review, cancellation/late-click rejection and
actual status-bar revocation through the signed socket. Revoking Action
approval did not revoke the independent native model channel. Its descriptors
and receipts are synthetic control fixtures: it did not import a real Action
capsule, exercise the Core-owned writer or run a business Action.

The shared checkpoint-response schema now lives in the existing pure
`action-runtime-contracts.ts` and is re-exported for existing runtime callers.
Importing it from the checkpoint implementation had indirectly bundled
Core/storage and active-host brands into the UI; the existing build guard
correctly refused that package. The dependency was removed, not allowlisted.
Corrected Core/host builds and 34 coupled Action/RPC cases passed.

`clients/vscode-host/original-mcp-native-action.test.mjs` covers six concrete
producer behavior cases using native UI/signer doubles: disabled admission,
separate source/effect decisions, exact binding denials, revocation/late
approval, replay prevention and exact continuation responses. These are
producer regressions, **not installed native-platform qualification**.
The existing Core source/admission test additionally rejects a forged
producer locator. Genuine signed endpoint forwarding and installed activation
must be tested after the parent integrates the four shared methods.

## New selected-source native invocation

`mcp.tool.action_call` now accepts the exact original contract and creates a
real Run through the owner's existing `ActionRuntime.create`, not a metadata
success or a replacement worker. Supported calls are explicitly selected,
admitted flat native pipelines containing the packaged pure components and
intrinsic checkpoints/waits. A single-member ModuleSet snapshot can be invoked
without changing its global enabled setting. Program execution, authored
casts, ambiguous id-less implementation choices, multi-member create
selection, planned triggers and project binding fail explicitly before
consent; unsupported context is never silently discarded.

Source/state admission has `noExecution:true`. A new call additionally requires
the current native-only Action endpoint's `authorize` and `effect_consent`,
separate from the model/public tool approval. Consent binds the complete
request, run identity, deadline, capsule/source receipt and implementation
digest. Inputs are schema checked, snapshotted and checked against the exact
source again after the asynchronous decision. Denial, cancellation during
consent, trust/profile revocation and source changes publish no new Run.

Creation is synchronously scoped to the exact approved source/input binding.
The adapters deny a direct Core create outside that scope, even when the
source was admitted or another Run was approved. Actual dispatch checks the
current Run against its immutable request/source/implementation receipt and
live run-specific consent. Parallel bindings cannot borrow another Run's
grant. All code still runs through the canonical engine and its normal
checkpoint, cancellation, output and event transactions.

`original_mcp_action_invocations` is an immutable canonical-SQL intent ledger,
not an execution-grant store. The actor/key maps to the complete original
request and exactly one native Run. Identical calls return that Run with
`launch_reused:true`; a changed request conflicts. Intent is durable **before**
engine creation. If publication is interrupted, retry preserves the consumed
intent and returns `ACTION_INVOCATION_RECONCILIATION_REQUIRED`, never creating
or replaying a Run. This ledger must be included in canonical-SQL B1 closure.

After restart, waiting Runs and completed/uncertain receipts remain, but no
invocation grant is restored. Repeating `action_call` retrieves the same Run;
it does not authorize or restart work. Safety scans explicitly report blocked
continuations rather than dispatching them. A genuine waiting human answer or
event wake can obtain new exact native continuation consent, binding the
current Run revision and checkpoint response. Cancellation while dispatch is
already started remains `outcome_unknown` unless the canonical engine proves
completion; it is never converted into remote rollback or replay.

## Remaining genuine gaps

* Shared-lane/native activation integration and installed qualification of
  the implemented signed Action producer, separate from model/public approvals.
* Qualification of the exact source identity used by the actual deployment.
  The tests explicitly select frozen-v2 fixture semantics; this does not
  promote its fixture-only qualification or change production source pins.
* Complete original source/run-tree coverage, nested/loop/choice/dependency
  continuation rebinding and pending launch-journal completion where not
  supported. A selected capsule is not a full-library admission.
* Native Workbench code-review/qualification, global ModuleSet activation,
  multi-member/id-less create selection, authored casts, planned-trigger and
  project authority, and executable/build/resource projection outside the
  supported selected intrinsic/pure invocation slice.
* Native reconciliation for consumed-but-unpublished invocation intents and
  newly created uncertain Runs; renewed timer/dependency continuation consent
  after an invocation grant is lost. These states remain blocked, not replayed.
* Exact OS/toolchain dependency closure, credentials/Cosmos, remote
  reconcilers, process/effect authority and artifact/GC ownership where
  required. Backing executable bytes is not permission to execute them.
* Independent optional-footprint/B1 backup/restore qualification and the full
  canonical/hybrid original-root business probe.

## Tests

`tests/original-mcp-action-domain.test.mjs` produces real old Run,
checkpoint/history, step/implementation receipts, successful output,
qualification and queue files using the original Python `ModuleRuntime`,
then imports them into a genuine synthetic OriginalMcp root with the actual
writer fence, canonical owner/Core and SQL lease. It also checks native RPC
denials, old-token rejection, immutable receipts, source-byte mutation,
current-profile mismatch, restart/no replay, explicit manual reconciliation,
retained notifications, cancellation denials and large-root selection.
The new invocation tests compute actual selected-source outputs, answer real
native checkpoints, deny direct-Core grant borrowing, exercise separate
effect-consent denial/abort/revocation, and retain interrupted publication and
started-cancellation uncertainty across real owner restart without replay.
All fixture roots, sockets and capsules are cleaned up.

```sh
npx tsc -p tsconfig.json --noEmit
# Run against a coordinated build (or isolated private compiled output).
npm test -- --no-build --file tests/original-mcp-action-domain.test.mjs \
  --jobs 2 --admit-native --admit-qualification
```
