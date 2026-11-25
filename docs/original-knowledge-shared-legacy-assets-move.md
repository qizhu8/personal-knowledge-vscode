# Shared PUBLIC legacy assets: derived COPY-and-RETAIN source checkpoint

The parent accepted the existing exact fresh native public owner-update approval
for copying checked public legacy files into an independently owned pair.
Exclusive source deletion permission is not inferred: another authoritative
referrer makes that source **retain**, not remove. Private resource publication,
private destinations, foreign/linked files and shared paired-tree ownership
remain closed. No native method, public argument, SQL table or second engine is
introduced.

## Private resource publication policy

Private resource publication defaults to denial. The agreed next increment
requires a separate native decision for each exact resource, binding its source
identity/bytes hash/size, public destination, operation and current owner/profile/
epoch. Public document approval or a Chat Group's allow-all setting does not
grant that publication. All required choices must succeed before any effect;
denial/cancellation/source drift leaves the operation closed.

An approved copy must not delete/rewrite the private source or unlock a private
directory. Approval is operation-scoped, not a durable model permission; audit
or historical receipts do not mint a fresh recovery/publication grant. This is
the agreed product design, **not an installed qualification**. A
[closed SOURCE integration checkpoint](./original-knowledge-private-resource-publication.md)
now defines the bound private-resource scopes and recovery interface. Its
positive approval/recovery paths remain unqualified while the separate native
method/producer is missing; ordinary public approval still cannot publish
private bytes.

## Shared-public checkpoint qualification

Parent coherent emission/bootstrap and native bundle guards pass: 433 source
files, 124 tables, unchanged schema. The normally emitted shared-asset,
ordinary move/root/lifecycle and cold-owner selection passes 88 cases without
overlays/skips. The exact shared-retention candidate also passes actual installed
ordinary private moves, still-refused shared paired-tree ownership, reader
shutdown and B1/fresh-B0. The explicit new shared-legacy helper has now passed
its own [actual installed qualification](./installed-native-shared-legacy-assets-move.md):
eight native choices, four real receipts, exact retained source/referrers/v2
provenance, sealed-old-parser refusal and full clean B1/fresh-B0. The earlier
ordinary regression alone was not used as that proof.

## Exact internal interface

`src/document-legacy-assets.ts`:

```ts
type LegacyAssetCopy = {
  source: string; target: string; sha256: string; size: number;
  sourceIdentity: string;
  disposition?: "remove" | "retain"; // omitted preserves existing remove behavior
};
legacyAssetDisposition(copy): "remove" | "retain";
assertLegacyAssetDispositions(root, area, owner, copies, completeDocuments);
```

`planLegacyAssetCopies` derives disposition from the complete three-area public
and private Markdown proof. Only exact references to a checked public regular
file cause retention. Unsupported descendant/dangling references remain closed.
The caller cannot supply a disposition through any original public schema.
Private resource bytes still fail the existing public-source check before open.

`DocumentLifecyclePlan.legacyAssets` additionally has:

```ts
protocol?: "pkm.document-legacy-assets.dispositions/v2";
```

The v2 marker is required if and only if a copy retains its source. Newly derived
unshared copies omit both disposition and marker, preserving the previous wire
shape and remove behavior. Older strict legacy-asset parsers reject the new
marker/field rather than silently recovering a retain plan as delete-all.
Removing just the marker fails pure validation; stripping marker/dispositions
together still fails complete live-reference derivation before effects.

Only `document-legacy-assets.ts` / `document-lifecycle.ts`, original fixture
exports, directly coupled source tests and domain documentation change.
The current native approval/write adapter, mutation/public result schemas,
passed installed helpers and shared cold/backend lifetime remain unchanged.

## Exact operation and recovery proof

The same compound intent owns copy publication, canonical owner update/move,
old owner removal, derived source removals, reindex and the immutable receipt.
Every phase checks:

* all public/private Markdown reference pins, without publishing private data;
* public safe-area paths, owned single-link regular files and existing
  16 MiB/file, 64 MiB/2048 combined-pair limits;
* source SHA/size plus device/inode/mode/owner/link-count/mtime/ctime;
* exact paired before/final/partial-tree states and no-replace destinations;
* retained sources remain **present** with their exact pinned identity/bytes;
* only derived-remove sources may disappear, after the exact final owner and
  copied pair are durable.

Final completion requires all removals finished and all retained-source CAS
checks satisfied. The source/reference graph is re-derived before mutation and
recovery; no source/referrer rewrite or unlink is performed for retention.
Existing ordinary paired-tree shared-reference protection is unchanged.
Source drift or missing retained bytes preserves the durable intent and
unknown competing state, never emits a success receipt or retries new effects.

The existing immutable `migration_runtime_knowledge_commits` binds the exact
request, versioned plan, result and operation/actor to the global receipt.
It is the retained-source provenance witness; no new public receipt fields are
added. Replaying the actual recorded operation/actor returns its historical
receipt without repeating effects. A foreign actor/different immutable request
must fail before pending recovery or replay.

Retention is readonly **for this operation**, not a permanent freeze of a public
legacy source. A later independently approved owner's operation may derive
removal when no legacy referrer remains. Historical receipts are historical
facts, not claims that all current source bytes still equal every old snapshot
or an additional read/delete grant.

## Original oracle and source tests

`tests/original-knowledge-writer-fixture.mjs` continues to execute only the
independently SHA-pinned original 4.0.22 writer
(`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`).
The legacy seed now supports `publicReferrer:true`; existing `shared:true`
supplies a private Markdown referrer to a PUBLIC `_assets/a.PNG`.
Neither option grants private asset publication.

`tests/legacy-knowledge-legacy-assets-move.test.mjs` covers:

* original/Core copy-retain parity with public referrers in all three areas;
* public shared files with private Markdown referrers, unchanged source
  identity/bytes and unchanged referrer/private Markdown;
* actual commit-plan disposition/provenance and actor-bound historical replay;
* v2 marker stripping and live-proof downgrade refusal before effects;
* partial removal recovery with retained files intact;
* retained-source drift refusing recovery/foreign replay, preserving new bytes;
* existing unshared remove/default behavior, query/parser forms, private
  resource denial and unreviewed-reference refusal.

When the actual pre-retention emitted parser remains available, the protocol
case also invokes that held parser without the source overlay and verifies it
rejects this real v2 retain plan before effects. This is a pure parser probe,
not a second owner, engine or serving-code readiness claim.

```sh
PKM_LEGACY_VSIX=/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/personal-knowledge-4.0.22.vsix \
TMPDIR=/home/yuwang8/.local/state/pkm-v5-recovery \
NODE_OPTIONS=--experimental-transform-types \
node tests/framework/run.cjs \
  --file tests/legacy-knowledge-legacy-assets-move.test.mjs \
  --no-build --jobs 1 --json
```

Source-only execution overlays the changed domain modules at their canonical
dist URLs, retaining real RootOwner/Storage/Core brands. The disposable loader
is removed at the checkpoint. Parent runs the command after coherent emit.

## Parent qualification boundary

No passed installed helper is edited. Its former shared-refusal expectation
must not be relabelled as copy-retain acceptance. After coherent build and source
proof, the parent can explicitly qualify the existing public Shared/Referrer
fixture through fresh native approval, original parity, unchanged retained
source/referrer bytes/identities, exact commit-plan/receipt witness, clean
reader/editor/coordinator exit and B1/fresh-B0.

B1 should prove the retained-source state at this qualified operation's
completion alongside owned paired copies and immutable native provenance.
Fresh B0 remains all-original byte restoration with no inherited native DB or
grants. Full readiness/cutover promotion, actual installed execution, packaging
and recovery execution remain parent-owned.
