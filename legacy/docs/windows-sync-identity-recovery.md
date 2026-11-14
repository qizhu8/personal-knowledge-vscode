# Windows Script identity and historical Trash recovery

The current diagnostic in `next-step/bug_report_windows.md` concerns PKM 3.2.38:
114 stable Script identities moved locally (seven also edited), eight identities
in historical folder Trash, and Remote identity-sidecar publication migrations.
It is not the earlier CRLF conflict report.

## Production reconciliation

- The catalog carries the Script primary `knowledgeId`, aliases and legacy path
  locators. Legacy selection items remain compatible within their original
  privacy scope; aliases do not grant another privacy scope or bypass ignores.
- Validated adjacent `pkm.script/v1` sidecars establish canonical identities
  before absence decisions. A unique validated path alias can align body-only
  Base metadata. Names and content hashes never establish Script identity.
  Copied primary identities, malformed aliases and contradictory manifest IDs
  fail explicitly before publication.
- Body and `identity-sidecar` are stable member roles. Their paths remain actual
  source/destination paths. A move retains one body and one adjacent sidecar;
  sidecar merging preserves a validated alias union and the primary identity.
  Package and Markdown asset members retain their existing semantics.
- A reused old path with a different primary identity is a different entity.
  The generic path-layout migration must not overwrite that identity.
- An excluded member or unselected local Script destination protects the entire
  entity, including its existing Remote copy. Fallback ingestion must not
  restore an old path for a private or ignored moved Script.
- Historical Script Trash is read-only evidence. Metadata, original path,
  timestamp, payload type, sidecar identity and symbolic links are checked.
  Matching evidence appears in entity absence review; it does **not** become a
  journal record, tombstone or approval. Active restored identities do not
  acquire deletion intent. Invalid Trash requires repair/review, not guessing.
- An explicitly approved deletion may treat a narrowly validated addition of
  one identity sidecar as publication metadata, not a business edit: Base must
  contain only the Script body and Remote exactly that unchanged body plus its
  valid adjacent identity sidecar with matching category/privacy/primary ID.
  A real Remote body edit still requires delete/edit review.
- Missing Local plus a valid Remote tombstone converges to deleted. A live
  Local edit, unknown absence without a tombstone, and an active Local identity
  with stale pending deletion remain protected. A Remote live entity and
  tombstone for the same identity is rejected.

The raw source snapshot, true common Base, pending-plan provenance, guarded
apply and lease-based push remain intact. Final staged blobs must match the
validated plan's comparison content and pass content contracts before their
actual staged digest is recorded; unexpected staged bytes cannot become a new
approved manifest merely by recomputing its digest. The
comparison representation is never substituted for the raw write guard.

## Old conflict workspaces

Rebuild review from fresh catalog and Remote HEAD rather than migrating old
path-keyed choices into approval. The production acceptance handler invokes
`validateGitHubSyncConflictScriptIdentity` with the store root, conflict record
and the full prepared candidate array before any apply intent or file writes.
It rejects restoring a second active copy, changing primary identity, and
deleting an active identity absent from the reviewed Local snapshot. Existing approval provenance
and candidate-digest checks remain mandatory.

## Isolated end-to-end validation

After **full `npm run build`** (not standalone `tsc`), run:

```sh
node tests/test-github-sync-script-recovery-e2e.js
mkdir -p .sync-regression-fixtures
TMPDIR="$PWD/.sync-regression-fixtures" node tests/test-github-sync-acceptance-recovery.js
rmdir .sync-regression-fixtures
```

The suite creates synthetic stores, machine Git repositories, seed repositories
and bare remotes **under the project**, commits/pushes only fixture refs, and
removes them in `finally`. It executes the production fetch/reconcile/staged
verification/commit/lease push/guarded apply path. Successful calls rebuild the
catalog through the production worker as the refresh boundary, avoiding cached
catalog counts.

The suite contains 22 scenarios, 68 assertions and 41 fresh-worker refresh
callbacks. Coverage includes the 114-move/eight-Trash/seven-tombstone fixture; moved edits;
Remote edits during Local moves; alias union and URI encoding; divergent moves;
copied identities; same hash/name with distinct IDs; old-path reuse; old item
selection; privacy and ignore boundaries; historical review/manual deletion;
restored and invalid Trash; stale/live deletions; unknown absence; tombstone
delete/edit protection; old-workspace duplicate guards; raw concurrent-edit
CAS failure/retry; partial deletion with failed baseline advancement; staged
blob corruption; rejected push recovery; schema-2 Base compatibility without
hash-based Script ancestry; and no-change repetition.

The 11-scenario acceptance recovery suite executes the actual production handler with
isolated host boundaries. It verifies primary-identity and duplicate-copy
rejections before any writes, successful selected-plan body/sidecar updates
and explicitly selected Remote body/sidecar moves,
alongside six interrupted-apply recovery boundaries and mixed-entity safety.

## Validation boundary

These are Linux-hosted fixture tests against local bare remotes, not proof of
native Windows filesystem behavior, GitHub branch rules, Windows GCM or VS Code
SecretStorage authentication. The worker refresh is real, but the test's host
callback is synthetic; interactive Webview approval and installed VS Code
runtime index refresh still require native host acceptance. No production
store, target, baseline, installed extension or real remote is changed.
The Windows experimental artifacts referenced by the report were not available
in this checkout and are not claimed as validation of these source changes.
