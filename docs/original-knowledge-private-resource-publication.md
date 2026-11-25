# Private resource publication: closed SOURCE integration checkpoint

**Update:** parent reports genuine method-24 integration and normal coherent
emission/guards (436 sources, 124 tables, unchanged schema), private 7/7 without
skips plus legacy/signed regressions, and native producer default-Deny/binding/
late-cancel tests. The original missing-method checkpoint below is historical,
not the current SOURCE blocker. The parent subsequently qualified the bounded
[installed synthetic move-only profile](./installed-native-private-resource-publication.md),
including actual per-resource/default-Enter consent and independent B1/fresh-B0.
This protocol does not support
same-path owner updates or general private-resource publication.

The product decision is **default denial, with a separate native approval for
each exact resource and operation**. That decision is not permission to publish
real user private data. Tests use disposable synthetic original-writer roots.
This bounded installed qualification does not promote full production readiness.

## Parent protocol/producer integration

The parent now registers `knowledge.asset.publish` as the 24th fixed signed
approval method, with the strict payload/result/session-aware parser below.
The genuine native handler supplies **Deny as the first/default option** and accepts only
“Publish this exact resource once”; generic approval text or a prior resource
choice cannot approve publication. Native model/Group allow-all settings do not
skip this separate dialog.

The actual same-Storage/host/session port is coalesced in an internal registry;
`getNativePrivateResourcePublicationPort` only retrieves that genuine current
resource and never mints authority. The public dispatcher uses its context
around the existing public request. Private resource reviews still occur only
after the exact public request is approved and active. Cold and native bootstrap
create the port only for negotiated support and collect the opaque recovery
scope before runtime initialization. Missing old-producer support preserves
default denial.

Normal coherent Core/bootstrap/native-host builds and bundle guards pass:
436 sources, 124 tables, unchanged schema. All seven private Core/signed cases
now execute and pass without skips, plus 12 public legacy and 12 transport cases.
Four native consent-handler tests cover Deny-first, generic/prior-approval
non-inheritance, exact bounded decision, changed binding and late cancellation.
44 ordinary move/root/lifecycle ownership regressions pass.

The same candidate passed actual installed shared-public copying with private
Markdown referrers, old-parser proof and clean B1/fresh-B0. That is **not** private
byte publication. The separate private profile then passed 21 actual native
choices and four immutable receipts; its sealed old shared-public-capable parser
accepted the real PUBLIC-v2 baseline and refused the real PRIVATE-v1 plan.
Private sources/folders/referrers remained unchanged, including through B1 and
fresh B0; the coordinator exited normally. The separate installed 11-dialog
lifecycle profile also qualified current-request cancellation/late action,
actual grant expiry and fresh three-resource publication with B1/fresh-B0.
The separate real-ENOSPC installed profile also qualified one genuine pending
intent across three native epochs: completed-copy readonly reconciliation,
fresh missing-resource denial/approval, one recovered receipt and B1/fresh-B0.
This is bounded environment-fault recovery, not arbitrary interruption parity.
No private user data or production configuration/package was changed.

## Original author checkpoint evidence and blocker

The figures below describe the original closed checkpoint before the parent's
method/producer integration above; they are not the current passing totals.

Typechecking passes. The selective source overlay preserves the actual
RootOwner/Storage/Core identities and executes the real signed native attachment
protocol, not a caller approval callback. Three private-boundary cases pass:

* an approved public update still cannot publish without the separate resource
  method; copied producer/recovery objects are not authority;
* the SHA-pinned original writer copies private legacy bytes, retains a source
  with a private Markdown referrer, and leaves that referrer unchanged;
* stored owner references produce metadata-only, exact bound review subjects;
  new submitted private paths, changed sources and missing sources refuse,
  without filesystem/private-source details in errors.

The existing twelve public legacy retain/remove oracle/Core regressions and
eleven ordinary private-referrer move regressions pass.
Four approval/denial/recovery-path cases are explicitly **skipped**, not passed:
the parent-owned native request registry does not yet contain
`knowledge.asset.publish`. Missing support raises `MISSING_NATIVE_METHOD`.
There is no alternate approval transport or success fallback. The implementation
of positive publication and renewal therefore remains unqualified.

## Exact parent-owned integration

`src/private-resource-publication-contracts.ts` exports:

```ts
privateResourcePublicationMethod; // "knowledge.asset.publish"
privateResourcePublicationPayloadSchema;
privateResourcePublicationResultSchema;
parsePrivateResourcePublicationPayload(payload, signedSession);
```

The native request registry must add the method, its payload schema, its result
schema and its session-aware payload parser. The genuine native producer must
always show a fresh, default-**Deny** resource dialog, including under existing
Model/Group allow-all settings. Cancellation/denial returns `null`; approval
returns only:

```ts
{
  decision: "approve", actorId: "mcp:external", decisionId: UUID,
  requestSha256: SHA256, operationId: UUID, epoch: string, expiresAtMs: number
}
```

The decision is accepted only for its exact request/actor/operation/current
epoch and a future expiry no more than 120 seconds away. The native descriptor
contains no private plaintext. It binds the checked private file path,
identity/hash/size, exact public paired target, stored owner ID/path/revision/
SHA, original public tool/argument digest, canonical operation/argument digest,
root/workspace/custody/privacy/catalog/current profile, host receipt and epoch.
Its invariants include `preservePrivateSource:true` and
`oneResourceOneOperation:true`. No public MCP argument or JSON grant is added.

`src/private-resource-publication-native.ts` exports the host/policy boundary:

```ts
const port = createNativePrivateResourcePublicationPort(storage, host, session);
withNativePrivateResourcePublicationContext(port, work, signal?);
const recovery = await approvePendingPrivateResourcePublications(port, signal?);
```

Create the port from the actual same Storage, admitted native host and
authenticated attachment session. Wrap the existing original public dispatcher
inside its fresh public approval with `withNativePrivateResourcePublicationContext`.
The original Knowledge adapter then derives private requirements from the
checked **stored public owner** and obtains every resource approval before
Core dispatch, intent persistence, folder/tree creation or publication.

Parent `prepareNative` calls the pending-review function before runtime
recovery and passes its opaque result as
`NativeRuntimeOptions.privateResourcePublicationRecovery`. The runtime consumes
that scope once around actual main-thread initialization/recovery. Workers
receive no JSON grant: existing MigrationRuntime owns canonical Knowledge
effects under the same Storage exclusive writer. Unreviewed pending private
publication fails closed even when generic native admission is available.

## Operation, CAS and recovery

Private publication only supports existing ordinary public-owner legacy
`_assets` references. Arbitrary submitted private paths, private owner/destination
endpoints, foreign/linked files, resources inside another paired tree,
unsupported extensions and incomplete reference closures remain closed.
The current subject requires an actual owner path move. Same-path content
updates or general private-file publication are not qualified by this increment;
the product's default-deny/per-resource policy is broader than this first
implementation profile.
Original parser forms, query/fragment rebasing, digest-first16/lowercase-extension
targets, existing pair preservation, stable ID and actual revision increment
use the existing compound Knowledge move plan.

Private sources are always readonly **retain**, including sole-owner sources.
This is deliberately stronger than the pinned original writer: it can remove
an unshared private legacy source. The new publication policy never deletes
or rewrites the private file, folder, policy or Markdown referrers. Existing
public-unshared/remove and shared-public/retain semantics are unchanged.

`LegacyAssetCopy` adds internal optional `visibility:"private"` and publication
provenance. Private plans require
`pkm.document-private-resource-publication/v1`; provenance binds the immutable
request/source/target/actor. Older strict parsers must refuse that protocol and
new copy fields rather than recover them as ordinary remove operations.
No old-parser acceptance evidence for an actual private intent is claimed yet.

Actual copying requires a current one-use branded attempt, not a serialized
decision. Source identity/bytes, complete public/private reference proof,
unexpected target/staging states and current native authority are checked
before staging and immediately before no-replace publication. Private source
hashing is internal custody/CAS evidence, not plaintext publication permission.
The file-write boundary callback checks integrity/current branded authority;
it cannot mint an approval.

All reviews precede effects: partial denial, cancellation, stale/expired or
wrong decisions cannot create an operation intent or successful copy.
If interruption happens after an already authorized durable copy, the existing
forward journal retains the exact phase; it does not falsely undo publication
or emit success. Every still-incomplete private copy requires new current
resource review. Completed exact copies are readonly recovery witnesses, not
renewable grants. The same existing intent is refreshed with new decision
provenance under CAS before effects; no second store/engine/table is used.

The exact committed actor/request receipt can be replayed historically with
no new effects or approvals. Historical native decisions alone never authorize
another copy, actor, target, epoch or incomplete recovery. Source/reference
drift leaves the intent and competing state intact. Atomic filesystem exclusion
of an uncooperative external writer is not claimed.

## Parent verification selectors

After coherent emission and genuine method registration:

```sh
PKM_LEGACY_VSIX=/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/personal-knowledge-4.0.22.vsix \
TMPDIR=/home/yuwang8/.local/state/pkm-v5-recovery \
NODE_OPTIONS=--experimental-transform-types \
node tests/framework/run.cjs \
  --file tests/private-resource-publication.test.mjs \
  --file tests/legacy-knowledge-legacy-assets-move.test.mjs \
  --no-build --jobs 1 --json
```

At the original author checkpoint, the required next result was **7/7, no skips**,
plus unchanged public regressions. Its synthetic signed responder is Core/
protocol fixture evidence only, never a claim of real native UI consent.
Partial interruption is Core-only fault injection.

Parent still owns real default-Deny renderer choices, public/prepareNative
wiring, old-runtime private-plan refusal proof, coherent build/packaging,
actual installed effects, clean reader/editor/coordinator shutdown, B1 and
fresh-B0 original restoration without native DB/grants. Passed installed
ordinary/unshared/shared-public helper expectations are not relabelled.
