# Installed Action business fixture: held integration helper

`clients/vscode-host/installed-native-action.mjs` provides an Action-specific
disposable cold-component wrapper and native CDP observer. It consumes the
already built installed candidate. It changes no shared Core, attachment,
activation, driver, UI script, package, or production guard.

**Status:** the parent wired the cold driver and completed genuine installed
business verification with the pinned original VSIX and exact reviewed native
candidate. Source/invocation denial and approval, actual pipeline output
`{value:41}`, one-Run idempotency, native status-bar revocation, subsequent
invocation refusal and zero process jobs passed. The entire editor exited
before B1 preservation; typed retirement and fresh B0 restoration verified
original source bytes and retained B1 Run output. The private installed profile
was uninstalled and cleaned. This does not qualify program/credential/Cosmos
effects, installed checkpoints or the full original Action contract.

Run the bounded scenario with:

```sh
node clients/vscode-host/installed-test.mjs --native-identity --cold-component \
  --native-action --legacy-vsix <pinned-original-4.0.22.vsix> \
  --vsix <reviewed-native-candidate.vsix> --evidence <private-evidence.json>
```

Accepted candidate SHA-256:
`1d3b50ade853f5b1bb65d4e057b7d152a8e0953b9817da65a7483d0789ea2804`.
The helper's three guard/observer regressions are separate from that actual
installed receipt.

## Required inputs

* The actual already enrolled isolated profile, with the original
  `native-identity-first.json` and successful real installed
  `native-identity-passed.json` in the same private `.installed-host-UUID`
  driver directory. The enrolled profile is selected **before** custody.
* The independently pinned original 4.0.22 VSIX:
  `1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.
  The helper reuses `tests/legacy-action-original-fixture.mjs`, including its
  process/network-denying Python audit hook. It does not use a checkout-writer
  fallback or change the candidate's Action source identity.
* The actual candidate's `compiler-capture-v1` source identity must match all
  original writer source hashes. A mismatch fails rather than re-hashing a
  sealed plan or opting into fixture-v2 semantics.
* The current candidate must already contain the signed Action methods,
  explicit `pkm.nextHost.enableNativeActions` command, native producer,
  `original-mcp-native-action-authority`, and Action runtime/domain modules.
  Models may remain unavailable. This helper needs neither a model channel
  nor any external provider.

The original writer registers one real flat pure pipeline using
`core.constant`, with expected output `{value:41}`. It creates genuine
registry/admission files, not invented native Run, source-decision, validation,
or success receipts. Selected toolchains are explicitly empty: this packaged
pure pipeline has no external runtime/compiler or process to authorize.

## Exact parent wiring

The parent only needs to select these helpers in its disposable cold driver.
No new candidate build/package or shared Core composition hook is required.

### 1. Whole editor exited; prepare before either B0

Use the existing branded `createOriginalMcpColdComponentFixture`, initial
Note/Skill/privacy setup, already enrolled profile, and original VSIX path:

```js
const actionFixture = await prepareInstalledNativeActionFixture({
  root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
});
```

Do this after any other original source preparation and before the existing
component B0/base custody capture. Registration preserves the original
`knowledgeId`; compilation checks use the existing explicit ModuleSet snapshot
representation, without rewriting the source definition.

### 2. Replace only the bootstrap selection for this fixture

Instead of calling `bootstrapOriginalMcpColdComponent`, select:

```js
component = await bootstrapInstalledNativeActionComponent({
  sourceFixture: actionFixture,
  operatorId: "isolated-genuine-native-action-component",
  limits,
  attachment: {
    directory: endpoint,
    identity: JSON.parse(first.publicRecord),
    identitySha256: first.result.sha256,
    payloadBuildId,
    hostEntrySha256,
  },
  python, env, port: fixture.port, payloadBuildId,
});
```

The wrapper itself performs, in order:

1. Actual original-root writer fence and unchanged cold writer guard.
2. `captureOriginalMcpComponentB0` for the whole root.
3. Base `captureOriginalMcpCustody`, pinned to the already enrolled profile.
4. Separate `captureInstalledNativeActionCustody` under that **same fence**,
   copying exact selected source bytes into `componentFixture.directory/
   action-custody`.
5. Same-owner `openOriginalMcpRoot` and actual signed private attachment.
6. During the owner's real `prepareNative(actualStorage)`: authenticated
   session → native host → optional Action footprint → Core-owned branded
   authority → explicit installed Action-enable UI → exact Action policy
   composition, before that owner's one Action engine is constructed.

The wrapper retains the existing Note/Skill `invoke`, `complete`,
`sourcePolicies`, descriptor, owner, storage, and custody interfaces. Native
Chat/model execution remains deliberately unavailable. Source policies are
the existing concrete same-session policies, not caller callbacks.

Publish `component.attachmentDescriptorPath` and its independently retained
digest through the existing private bootstrap pointer. Restart the actual
editor and existing cold UI/driver exactly as before. Start
`component.complete()` as before; the helper's CDP observer invokes the actual
existing Action-enable command and handles its real native modal while the
shared cold UI waits for the next Note phase.

### 3. After host completion and existing Note/Skill effects

```js
const actionEvidence = await verifyInstalledNativeAction({
  sourceFixture: actionFixture, component,
});
```

Call this **before** a Todo/Memory/Chat source-revocation scenario which closes
the entire signed session. Action-only revocation is independent and leaves
the signed public/model session alive, so later source scenarios can still
run.

The helper requires genuine branded owner/storage/host/session objects and
the same cached Core. It executes:

* Native identity/public admission alone cannot read unadmitted Action source.
* Denied exact source review creates no domain admission.
* A fresh typed source decision admits the exact sealed original definition.
* Denied per-invocation consent creates no Run.
* Approved `action_call` runs the real native pipeline and returns `{value:41}`.
* The same idempotency key returns the same completed Run without re-execution.
* Native status-bar revocation makes the real concrete bridge untrusted and
  denies a new invocation, while retaining one Run and zero process jobs.
* Original source bytes, exact lease, owner, cached Core, receipt/profile/
  epoch/capsule bindings and independent signed session remain intact.

The helper does not qualify checkpoint execution; that remains covered by the
separate signed Core tests, not claimed as installed evidence here.

### 4. Close, then exit complete editor, then B1

`await component.close()` calls the Action close hook, confirms removal of its
owned `.pkm-action-authority`, closes the actual attachment and same owner,
and retains failed/changed controls for reconciliation rather than deleting
unknown state.

Then wait for **the entire actual editor process to exit** as in the corrected
cold driver. Replace only the B1 wrapper call:

```js
ticket = await preserveInstalledNativeActionB1(component);
```

This calls the unchanged `preserveOriginalMcpComponentB1` on the same branded
fixture, with the unchanged actual cold guard. It does not bypass
`COMPONENT_ACTION_RETIREMENT_UNQUALIFIED`: the live authority directory must
really be gone before preservation. A copied wrapper or unverified/unclosed
fixture cannot enter this helper.

Retire and restore using the existing recovery ticket APIs. After fresh B0
restore:

```js
const actionPreservation = await verifyInstalledNativeActionRestored(
  actionFixture, { restoredRoot: restored.root, archive: retirement.archive });
```

This verifies exact original source bytes in both images, the real succeeded
native Run output and exact source-receipt-linked invocation in B1 canonical
SQLite, and absence of native endpoint authority in restored B0.

## Native observer stages and evidence

The helper's own Python Playwright CDP observer connects headlessly to the
actual workbench renderer. No native UI or signer doubles are supplied.
It owns:

1. `native-business-action-enable`: command palette → explicit Action enable.
2. `native-business-action-source-deny`: exact source dialog → Deny.
3. `native-business-action-source-admit`: exact source dialog → approve.
4. `native-business-action-call-deny`: public call approval, then Action denial.
5. `native-business-action-call-admit`: public approval, then exact Action approval.
6. `native-business-action-call-reuse`: public approval only.
7. `native-business-action-revoke`: inspect exact root/profile tooltip and click
   the real `PKM Action approvals` status indicator.
8. `native-business-action-revoked-call`: public approval; no Action effect
   dialog or new effect may follow.
9. `native-business-action-complete`: close the observer normally.

It records native dialog text digests and asserts visible root/profile/source/
capsule/content-hash/no-execution/no-replay identities. Passing business
evidence is written only after actual Core effects, revocation and UI checks;
`b1RootClosureQualified` remains false until the independent parent
preservation/restore result is reported. Actual keyring/profile restore and
full cutover qualification always remain false.

## Focused validation performed

```sh
node --check clients/vscode-host/installed-native-action.mjs
TMPDIR="$HOME/.cache/pkm-tests" \
  node tests/framework/run.cjs --no-build \
  --file clients/vscode-host/installed-native-action.test.mjs \
  --jobs 1 --admit-native --admit-qualification
```

Three tests pass: original-root preservation on bad/copied writer identity,
serialized preparation/composition/B1 refusal, and independent Python parsing
of the CDP observer. They do **not** substitute for running the parent wiring
above against the actual installed candidate.
