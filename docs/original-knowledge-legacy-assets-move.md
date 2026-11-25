# Original `_assets` moves: bounded source checkpoint

This increment extends only the existing canonical Knowledge update/move
composition. It does not normalize bootstrap/read admission, add a second
owner/store/engine, modify native approvals or claim installed/B1/B0 readiness.
The parent's already-qualified ordinary private-reference move harness remains
unchanged.

The subsequent shared PUBLIC copy-retain source increment is documented in
[the derived-disposition checkpoint](original-knowledge-shared-legacy-assets-move.md).
The source implementation now retains checked public files with other public
or private Markdown referrers; the former installed unshared/refusal profile is
not thereby promoted to shared acceptance.

The parent has now completed normal coherent emission/bootstrap/host bundle
validation: 433 source files, 124 tables, unchanged schema. Eight new legacy
cases and 64 coupled ordinary move/Core/lifecycle cases passed without the
author's disposable overlay. The exact packaged candidate also passed actual
installed ordinary private-move/reader-shutdown/B1/fresh-B0 regression.
The new public-unshared legacy-asset helper has subsequently passed its own
[actual installed effect/recovery qualification](./installed-native-legacy-assets-move.md).
The earlier ordinary regression alone was not treated as that proof.

## Independently pinned original behavior

Original 4.0.22 VSIX SHA-256:
`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.

Its `dist/knowledge/markdown-assets.js`,
`previewMarkdownAssetMigration` / `migrateMarkdownAssetsForLifecycleUnlocked`,
derive migration from references in the **stored owner Markdown**, not from an
unreviewed new resource list. For each existing `_assets` source:

1. Hash source bytes; target the owner's paired directory with
   `sha256.slice(0,16) + lowercase(original extension)`.
2. Copy exact bytes; refuse a differing destination collision.
3. Rewrite stored/updated owner references to those planned destinations.
   The existing original reference parser preserves query/fragment suffixes,
   inline/HTML/definition/`file:` forms and ignores code examples.
4. Remove the old legacy source only when the original same-area referrer walk
   finds no other owner. The original can **copy and retain** shared legacy
   files; it does not rewrite private referrers.
5. Move/rebase the owner and its paired tree to the requested new path.

The complete native referrer/CAS proof includes all three areas and retained
private Markdown. Shared public files are copied into independently owned pairs
and retained through the new typed disposition; no shared old-source ownership
or shared paired-tree ownership is adopted. Private **resource bytes** cannot be
published by an ordinary public move approval, even when a public owner
references them; that case requires a separately designed source/publication
review and remains `ACCESS_DENIED`.

## Domain interfaces and parent wiring

Changed domain files:

* `src/document-legacy-assets.ts`: checked public legacy-source planning,
  source byte/identity CAS, ownership/referrer proof and original rewrites.
* `src/document-lifecycle.ts`: optional `DocumentLifecyclePlan.legacyAssets`,
  exact ordered migration phases, staging guards and recovery.
* `src/knowledge-mutations.ts`: uses
  `documentLifecycleUpdatedBytes(root, plan, updatedSource)` for both final
  receipt bytes and immutable request/plan validation.
* `src/legacy-knowledge-write.ts`: legacy moves require the exact active
  `originalMcpPublicRequestActive(storage, tool, arguments)` even without
  retained private referrers.

There is no new public argument/result signature, SQL table/schema version,
native method or approval callback. Parent public wiring is the existing
`withOriginalMcpPublicRequest` path. Generic document moves and Board moves do
not acquire legacy migration through an advertised tool name: only the existing
journaled canonical Knowledge update composition can execute it.

The optional serialized move section contains:

```ts
legacyAssets?: {
  copies: Array<{
    source: string; target: string; sha256: string; size: number;
    sourceIdentity: string; // dev/inode/mode/owner/link-count/size/mtime/ctime
  }>;
  finalDigest: string;
  finalEntries: TreeEntry[];
}
```

It retains no private bytes. The same `migration_runtime_intents` and immutable
Knowledge commit/receipt path own all effects and completion. Old intents
without this section retain the normal move path. Older executors must not be
presented as able to recover a new legacy intent.

Parent owns coherent emit/bootstrap-profile regeneration, packaging and genuine
installed approval, clean-process shutdown, B1 and fresh-B0 qualification.
Neither existing readiness gate nor installed runner is changed here.

## Exact bounded effects and recovery

Supported Linux profile: nonempty owned, single-link regular public legacy
files, at most 16 MiB each; combined paired/legacy tree at most 64 MiB and 2048
entries. Sources can use an `_assets` directory segment within the checked
content area, but cannot be inside another paired tree. Portable ordinary
extensions are lowercase-normalized exactly as the original.

The durable compound intent precedes all effects:

1. Move an existing unshared paired tree, if any.
2. No-replace-publish the pinned legacy copies into the destination pair.
3. Publish the exact migrated/rebased canonical owner after-image.
4. Remove the old owner Markdown.
5. Remove each still-exact derived-unshared public legacy source; keep every
   derived-retained public source present with exact identity/byte CAS.
6. Reindex/commit the single actor-bound Knowledge receipt and remove the
   existing durable intent together through the same Core journal.

Partial copy/source-removal phases reconcile only exact planned bytes.
Complete private/public reference pins and source identities are rechecked.
Unknown staging, links, unsafe modes, foreign ownership, changed sources or
unexpected files refuse without overwriting them or issuing a success receipt.
Empty `_assets` directories remain; unrelated sources are not normalized.
No filesystem interruption injection belongs to an installed qualification.

Unsupported descendant/dangling references, private asset sources, missing-source overrides,
new submitted legacy references absent from the stored owner proof, nested
paired-tree sources, unsupported/malformed paths, protected descriptors and
other unqualified cases remain closed. No archived asset/worker permission is
imported.

## Original-writer fixtures and targeted source checks

`tests/original-knowledge-writer-fixture.mjs` exports
`seedOriginalLegacyKnowledge`. It uses unmodified original upsert/bundle APIs
to seed each area with `Old/Before.md`, public `_assets/a.PNG` and
`_assets/b.BIN`, and retained `Private/Secret.md`. Options:

* `paired:true`: an existing Note paired resource joins the migration;
* `shared:true`: the private referrer shares the public legacy source;
* `publicReferrer:true`: a public referrer shares the public legacy source;
* `privateSource:true`: sources are private `Private/_assets/...` and must deny;
* `configurePrivacy:false`: preserve independently configured privacy bytes
  when a future parent-owned installed fixture reuses the seed.

`tests/legacy-knowledge-legacy-assets-move.test.mjs` exercises actual original
oracle/Core Note/Skill/Paper success and shared public-source copy retention,
private-byte denial, unreviewed new-reference refusal, exact partial-phase
recoveries, version downgrade refusal and competing retained-source drift. Recovery replay uses the
actual recorded operation/actor request, not blind repeated MCP mutations.

```sh
PKM_LEGACY_VSIX=/home/yuwang8/uone-knowledge/packages/personal-knowledge-vscode/personal-knowledge-4.0.22.vsix \
TMPDIR=/home/yuwang8/.local/state/pkm-v5-recovery \
NODE_OPTIONS=--experimental-transform-types \
node tests/framework/run.cjs \
  --file tests/legacy-knowledge-legacy-assets-move.test.mjs \
  --no-build --jobs 1 --json
```

During source-only validation the agent overlays only the four changed/new
domain modules at their canonical `dist` URLs, retaining actual owner/Storage/
Core brands and compatibility paths. That disposable loader is removed at the
stable checkpoint. Parent reruns the command above after coherent emit.
