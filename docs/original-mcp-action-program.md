# Bounded original local-program Action execution

This is a real canonical local-program execution slice, not Cosmos, credentials,
remote execution, installed qualification, or full36 readiness. Its focused
fixtures create actual Action Runs and owned ProcessJobs and execute the genuine
original fixture program. Native operator RPC decisions are labelled fixture
stand-ins. Parent source now registers the fixed signed approval method and
routes it through the real Action producer's private source admission, enable
state and revocation lifetime (19 shared methods). Coherent shared emission,
the new signed-lane regression and actual installed deployment-v1 program
acceptance now pass independently. See
[installed program scope and evidence](./installed-native-action-program.md);
the old pure Action receipt is not used as a program receipt.

## Supported target and native composition

Opt in explicitly while composing the same owner's existing native Action
policy:

```ts
const action = await createOriginalMcpActionNativePolicy(storage, host, custody, {
  nativeAuthority,
  localPrograms: [{ actionId: selectedOriginalProgramId, cwd: "action-sources" }],
});
// Compose action.options before the owner's one canonical engine is created.
```

Default behavior is unchanged: backing/admitting a program source does not
enable program invocation. An MCP argument cannot configure `localPrograms`.

The bounded adapter accepts **one** explicitly selected target:

* The exact original definition/implementation must compile under the chosen
  original source identity and be in the independently sealed Action capsule.
* Only a dependency-free, cast-free program declaring exactly `["pure"]`.
* The independently byte/identity-pinned **current canonical Node executable**,
  not a shell or a runtime installed/resolved on demand.
* Exact inline Node `-e` code, optionally with `--input-type=module`, or one
  explicitly sealed script in the approved context directory. No freehand argv,
  `${...}` expansion, builds, resource projection or extra script arguments.
* A canonical private root-local cwd, with its complete file membership covered
  by the selected capsule. Linked, unselected, changed or missing context bytes
  deny dispatch.
* Bounded JSON stdin under the existing ProcessJob input ceiling; credential
  fields are rejected. No inherited environment, SecretStorage value, shell,
  network/credential/descendant permission or nested artifact bridge is supplied.

The program is independently reviewed harmless code. The existing direct-child
supervisor is **not an OS filesystem/network sandbox**. Its cancellation owns
one child handle, not arbitrary descendants. This slice does not claim that
arbitrary code cannot violate its declared pure/local contract, and does not
qualify general host-command execution or hostile-code containment.

## Real canonical execution and receipts

`src/original-mcp-action-program.ts` builds fixed native command policies for the
existing `HostServices.action.process` configuration. It creates no supervisor,
store, database, RootOwner, public process-launch method or replacement engine.
The existing host-created `createActionProcessBridge` and `RuntimeProcessService`
perform launch, stdout capture, cancellation and durable ProcessJob transitions.

The concrete bridge has additive native-only fields:

* `ActionProcessCommand.program?`: preserves the exact original compiler spelling
  while the native command retains its safe internal ID.
* `signal?` and `assertCurrent?`: current source/toolchain/context checks at the
  existing last synchronous pre-spawn fence, and cancellation of the owned child.
* `approve(...).runId?`: exact Run identity for the new mapped-program commands.
  Existing alias commands keep their previous approval shape.

`ActionAuthorizationBinding.runId?: string` is also additive. The existing
ActionRuntime populates it at create/import/result/dispatch sites. The new
program policy requires it; another active approved Run cannot lend authority
to a new direct-Core create.

Source admission retains `noExecution:true`. Before publishing a new Run,
`action_call` requires a **separate typed native local-process decision** binding:

* Actual root/workspace/profile/epoch and native host receipt.
* Exact source receipt, capsule, Action revision and implementation.
* Run ID, complete normalized original request, input digest and deadline.
* Runtime path/bytes/identity, exact argv, cwd path/device/inode and source closure.
* The explicit one-direct-child scope and closed shell/environment/credential/
  network/descendant/build/replay flags.

Only that approved Run may consume the grant. The existing immutable
`original_mcp_action_invocations` payload now optionally contains
`localProgram: {request, decision}`; its table/schema/ownership are unchanged.
The typed decision and complete request participate in the existing receipt
digest and are retained for audit/B1, **never restored as live grants**.

The existing ActionRuntime creates the Run, then the existing process bridge
creates exactly one ProcessJob and supplies canonical JSON through ephemeral
stdin. Raw child stdout/stderr are not persisted; the validated typed output is
owned by the Action result receipt. Reusing the same key returns the same Run
without another consent or child.

During active work a bounded current-native-status monitor checks source,
toolchain and context. Revocation/expiry/source changes abort the command signal;
the existing process service signals only its live owned child handle. Started
cancellation is `unknown`/`outcome_unknown`, not rollback or retry. Completion,
uncertainty and one-use consent receipts survive clean owner restart without
replay. Existing unclean process-owner CAS/recovery rules remain unchanged.

## Parent-owned signed method integration

New executable leaf/contracts:

* `src/original-mcp-action-program-contracts.ts`
* `clients/vscode-host/original-mcp-native-action-program.ts`

Add **one** fixed method to the existing signed request lane:

```ts
method: originalActionProgramMethod // "action.program.approve"
input: originalActionProgramPayload // { binding, request }
result: originalActionProgramDecision.nullable()
```

Use `parseOriginalActionProgramPayload(payload, session)` in addition to the
existing envelope/session/request-digest checks. Expand the existing method and
support limits by one; do not introduce a generic method proxy or boolean result.

In the existing native Action producer, construct the new leaf with the
producer's actual private source-admission view:

```ts
const programs = await createOriginalMcpNativeActionProgramApprover(context, {
  session: options.session,
  signal: AbortSignal.any([options.signal, lifetime.signal]),
  assertCurrent: () => current(options.signal),
  sourceAdmission: () => admitted, // existing private { decision, sources: Map }
});
```

Advertise its one method and route the parsed envelope to
`programs.handle(payload, requestId, controller.signal)`. It uses the actual
installed signer and VS Code modal itself; no approval callback is accepted.
Retain the existing explicit Action-enable/source decisions, and bind the leaf
to the Action producer's local revocation signal so late approval is discarded.
No new command or model/provider channel is required.

`src/original-mcp-native-action-authority.ts` already implements the Core-owned
`program_consent` loopback branch. It rechecks current exact source receipt,
selected executable/argv/bytes, context identity and native host before and after
the signed request. The concrete `createVscodeActionTrustBridge.authorizeProgram`
requires the exact typed decision. A source/model/public grant, ordinary
`consented:true`, absent shared method, mismatch, cancellation or late reply
cannot manufacture process permission.

The executable leaf did not edit shared native-request/attachment schemas.
Parent source integration now supplies the fixed method above; old installed
producers that do not advertise it still fail closed with
`MISSING_NATIVE_METHOD`. No generic proxy or boolean approval was added.
The composed native producer/pure/program UI group passed nine focused cases,
including actual parent-producer source/revoke composition. The signed RPC
file subsequently passed 11 cases; actual installed program acceptance is
qualified only for the exact artifact and bounded deployment-v1 scope linked
above. The existing pure Action route is preserved.

## Focused evidence

`tests/original-mcp-action-program.test.mjs` reuses the real original
`ModuleRuntime` writer/custody fixture (explicit frozen-v2 fixture semantics,
not deployment identity qualification). Through the real RootOwner/Core,
Action services and canonical process bridge it verifies:

* Actual program output, one ProcessJob per invocation and empty child environment.
* Exact typed consent/toolchain/input receipts in canonical SQL, and idempotency.
* Separate process denial/wrong-toolchain decision/source mutation before
  acceptance create neither a native Run nor ProcessJob.
* A concurrent direct-Core create cannot borrow an active approved program Run.
* Started cancellation and native revocation terminate owned children and retain
  uncertain receipts, never synthetic success or rollback.
* Clean real-owner restart preserves successful/uncertain results without
  restoring process grants or replaying children; original source/settings stay
  unchanged.

The two new native-leaf tests use explicitly labelled UI/signer doubles to test
separate modal denial/approval, exact decisions, replay, input/epoch mismatch,
revocation and late source-change rejection. They are not installed proof.

Validation used private transpilation of only the eight changed Core modules
and the existing Linux framework, never a shared `dist` build:

```sh
npm test -- --no-build \
  --file tests/original-mcp-action-program.test.mjs \
  --file tests/action-runtime.test.mjs \
  --file tests/original-mcp-action-runtime.test.mjs \
  --file tests/original-mcp-action-domain.test.mjs \
  --file tests/original-mcp-native-action-authority.test.mjs \
  --file clients/vscode-host/original-mcp-native-action-program.test.mjs \
  --jobs 2 --admit-native --admit-qualification
```

The first combined checkpoint passed **40/40** cases. The new leaf also has an
independent strict client typecheck. Shared Goal/Harness source diagnostics,
when present, are reported separately rather than edited by this slice.

Remaining gates: complete OS/runtime dependency qualification, native
Workbench/general authored-code review, unclean owner recovery where needed,
other runtimes, builds, nested programs/artifacts, and every credential,
network/remote/Cosmos capability. None is promoted by these fixtures.
