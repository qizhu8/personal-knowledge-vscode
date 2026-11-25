# Regular in-place Knowledge updates: private-reference closure

The independently SHA-pinned original 4.0.22 writer does **not** copy/migrate
stored private legacy `_assets` resources during same-path Note/Skill/Paper
updates. Content and metadata changes leave those links, files/referrers and
existing paired resources in place. Original Upsert preserves the ID and
increments revision; the raw shared Markdown writer retains caller-supplied
revision fields. V5 canonical updates retain their own ID/revision+1 semantics,
not the raw-writer revision behavior.

## Proven failure and narrow Source fix

`tests/legacy-knowledge-private-inplace.test.mjs` originally produced seven
passing cases and three failing cases. Existing stored-reference updates and
fresh public denial behaved correctly, with zero private-publication requests.
However, all three update tools accepted a newly submitted private resource
URI and persisted it with a canonical receipt. This was reference adoption,
**not a private-byte copy**.

The fix adds `assertNoNewPrivateResourceReferences` in
`src/document-legacy-assets.ts`. It uses existing `markdownReferences` and
`localAssetReference` parsing, resolves references relative to the stored
owner's directory, and classifies the normalized root-relative target using
the actual bound `knowledgeReadPrivateTopLevels` policy. Targets in any
configured private Knowledge area must already be logically referenced by the
stored owner. Query/fragment changes, percent encoding and relative spelling
of the same logical resource do not create a new source.

Denial is repository-standard typed `ACCESS_DENIED`, with a generic message
that exposes no private path or bytes. Path comparison never opens private
resource bytes, requires file existence, creates a grant or treats prior
references as publication permission. Plain Private words and ignored
inline/fenced examples are not references; external URLs remain outside this
private-root path check.

## Same-writer binding, not preview authority

The original adapter invokes the check under its existing Storage exclusive
lease before dispatch/resource-review collection. Canonical Knowledge
planning checks the complete derived after-image, covering body and supported
`file:` metadata, before any intent persistence. Request-plan binding checks
the reconstructed immutable request image; application and recovery inspection
also revalidate against the actual root privacy policy. Direct canonical
create/update and move call sites therefore cannot bypass the rule.

This adds no public argument, grant, protocol/version, SQL table or private
folder access. The beforePath/afterPath publication restriction remains.
Existing permitted private-resource **moves** still require their separate
fresh native approvals and always retain private sources. Regular in-place
updates issue public request approval only and perform no resource publication.
Exact historical receipt replay remains historical/no-effect behavior.

## Verification boundary

The parent completed normal Core/host typechecks, coherent emission, bootstrap
profile regeneration and guarded builds. The focused tests import that normal
`dist`; no override loader, fake isolation, patched compiled candidate or
old-dist passing result is used as new-guard proof.

The five directly related selectors passed **56/56 without skips**, including
all fourteen in-place cases and the three originally failing new-private-target
refusals. There are still 436 sources/124 tables with unchanged schema; the
new source hash is
`e8afd398e8647e850d302f1d308c5b455428a26a9c0df750ed78f9ceca8a2059`.

The focused file now contains fourteen cases: the original ten, normalized
stored-source/parser/ignored-text preservation, HTML/definition/YAML/cross-area/
unknown-private rejection, canonical create/update bypass refusal, and Paper
`file:` normalization/refusal. The original twelve no-publication oracle
cases remain unchanged.

After parent coherent build, run the focused and directly dependent selectors:

```sh
PKM_LEGACY_VSIX=/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/personal-knowledge-4.0.22.vsix \
TMPDIR=/home/yuwang8/.local/state/pkm-v5-recovery \
NODE_OPTIONS=--experimental-transform-types \
node tests/framework/run.cjs \
  --file tests/legacy-knowledge-private-inplace.test.mjs \
  --file tests/original-private-assets-inplace.test.mjs \
  --file tests/legacy-knowledge-private-move.test.mjs \
  --file tests/legacy-knowledge-legacy-assets-move.test.mjs \
  --file tests/private-resource-publication.test.mjs \
  --no-build --jobs 1 --json
```

The new sealed candidate has VSIX SHA256
`48927d48dcdb76509458bf41835391941c3c71395e0607cee9dbc82da0370be1`
and payload `9ca9b1c963877b5583b3d16b6ec2ba3d7974b313f777277a90bf0cfab06de393`.
It independently passed the existing installed private-publication 21-choice
profile, real ENOSPC three-epoch recovery/B1/fresh-B0, and 31-round native-model/
Chat/Action controls, with normal exit and actual profile removal.

Those regressions did not substitute for actual new-reference refusal in-place.
The parent subsequently qualified the dedicated `--native-private-inplace`
profile on that exact sealed candidate: **11 actual public choices, six unique
canonical update receipts, three generic new-private-URI refusals and two public
denials**. Refusals leave no intent, success receipt or owner/resource change.

The six Note/Skill/Paper content/metadata updates preserve stored private link
text (including normalized percent/query variants), ignored examples and exact
private bytes/referrers/folders/pairs/policy. They match original Upsert's ID and
revision increment. No private resource dialog, publication plan or resource
copy occurred. These observations are not a global RPC/provider-call counter.
The installed source-only model channel was unavailable.

Independent B1 preserves all six nonpublication receipts and private controls;
fresh B0 restores every original byte without native DB/grants. The editor and
coordinator exit normally and the private profile is removed. The leaf's
pre-recovery `b1AndB0Qualified:false` is not rewritten or mistaken for the later
parent preservation proof. The helper/renderer suite passes **5/5 without skips**.
The earlier 21-choice publication/old-parser/B1/fresh-B0 profile was independently
rerun after final coordinator integration and passed.

This closes the specific installed reference-admission defect. Full readiness,
arbitrary private publication, shared-user-root takeover and production release
remain separate. Production option A and the older qualified candidate are unchanged.
