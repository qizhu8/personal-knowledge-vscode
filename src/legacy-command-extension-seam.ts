/**
 * Batch10 integration handoff. This file registers no public operations.
 * The explicit native harness operates project-archive, recipe-create/update.
 *
 * Original source pins (SHA-256):
 * src/workflows/project-model.ts:
 *   505f56e2351a9f173268007990eaf02f1014abe0dc4f722b12a8f6aa81c94195
 * src/workflows/project-store.ts:
 *   a88568af85c6cbf714cc8c9efcfb641da12502df888b4c6dd9e4b7e24dacc010
 * src/workflows/project-cockpit.ts:
 *   1952d5b2f4c7969fbd8f27beef3a955b9f36d3af7dc608c5776a26c0c499d617
 * src/workflows/project-filesystem-store.ts:
 *   20c0f58161b3f82181e48049e3ad95f0091ec41e1a1fba61413514c97502e0f8
 * src/workflows/recipe-filesystem-store.ts:
 *   3ecfb22753d16455ff7427993fd4d017dc00c1d2ffd65be9414157e31421b6f5
 *
 * Separate native implementation pins:
 * next-server/src/project-mutations.ts:
 *   fee77b4ff41e503520b2e3919ad4000b3ebf60e42d9273114d65ca6c70c60b2c
 * next-server/src/legacy-control-import.ts:
 *   4a2a4af61185239813a306d4feb1654b0c27f3e8bf349887e3df571574b956bf
 * next-server/src/storage-worker.ts:
 *   b1b086f621fa76565d605c5c0d1c19b587fb9cfd3a57aa84d097628e5207a525
 *
 * Required host changes, owned by the shared integrator:
 * 1. Inside the sole host schema migration transaction, invoke
 *    initializeLegacyExtensionJournal(db). Its dedicated singleton table is
 *    legacy_command_extension_intent with operation_id, canonical effect_plan
 *    and effect_sha256; validateLegacyExtensionJournalSchema checks exact DDL.
 *    Admission stages this row and pending_project_mutation together.
 * 2. Route strict legacyExtensionInvocationSchema/legacyExtensionInputs to
 *    executeLegacyExtensionCommand(db, root, {envelope,args}, host, now).
 *    Envelope: workspaceId/operationId UUIDs, actorId (1..500), host-computed
 *    globalFingerprint lowercase SHA256, original opaque command.
 *    Command: commandId/fingerprint (1..4096), operation (1..512),
 *    expectedStoreVersion positive safe integer. Never trust caller actor,
 *    fingerprint, root or plans. Ordinary-mutator rejection remains mandatory.
 *    Replay precedes new-operation recognition and store-version checks.
 * 3. host.assertExclusive() is a trusted synchronous non-filesystem lease/fence
 *    assertion. Retain real exclusive ownership across all phases. The runtime
 *    owns short IMMEDIATE transactions; preflight, filesystem inspection,
 *    native application and current snapshot verification execute outside SQL.
 *    Native effects reuse applyProjectMutation, not a second store. Source
 *    serialization is retained: compact canonical Projects, prepared pretty
 *    Recipes. The native fixture instruments synchronous filesystem functions
 *    to reject any filesystem work performed during a SQL transaction.
 * 4. Startup: before generic Project/Recipe validation, obtain the envelope with
 *    readLegacyExtensionPendingEnvelope, call inspectLegacyExtensionPending,
 *    then resumeLegacyExtensionCommand under the same owner. Inspection checks
 *    root/marker/database binding, original control before-domain, native strict
 *    path/result identities, every before/after byte, unaffected files, portable
 *    collisions, runtime guards and every other pending journal. It recognizes
 *    before/after/mixed Recipe rename states, performs no writes, and preserves
 *    both journals on unknown state. Generic validateProjectRecipeExport rejects
 *    mixed rename duplicates; do not call it ahead of recognized preflight.
 *    Keep the current update-only shared startup gate unchanged until this
 *    explicit extension branch is installed by the sole integrator.
 * 5. Backup/quiescence retains both journal rows together, immutable original
 *    control bytes and rolling receipts. Finalization commits the global
 *    receipt, original receipt, version, current Project digest and deletion of
 *    both journals together. Recipe contents are authenticated by the effect
 *    manifest, never mislabeled as Project digest inputs. Runtime results and
 *    replays include current full original-shaped snapshots, Recipes and
 *    derived folders included, rather than saved stale results.
 * 6. Compatibility is bounded to normalized canonical active Recipes. Exports
 *    requiring unrelated alias repair fail explicitly with
 *    LEGACY_RECIPE_CANONICALIZATION_REQUIRED. Symlinks, trash, malformed paths,
 *    unknown bytes, exhausted versions, active Run guards and other journals
 *    fail closed. Limits: 2 MiB/file, 8 MiB before bytes, 4096 files/8192 entries,
 *    32 levels, 16 MiB serialized metadata, 256 original receipts.
 *
 * Archive and Recipe create/update are operational in the explicit native
 * fixture: real original ProjectStore loaded from current pinned TypeScript
 * supplies full-snapshot, affected-file exact-byte and opaque receipt oracles.
 * Each operation has before/after restart, pending SQLite backup and commit
 * rollback checks; mixed rename recovery is qualified. Original operations:
 * project-create,
 * project-overview, project-archive/restore/delete, thread-create/rename/
 * chatroom-link/move, recipe-create/update/trash-move/trash-restore. The
 * existing public host still recognizes only project.update plus historical
 * replay. No public capability, Portal or full-migration acceptance is claimed.
 * Project creation is unqualified: original marks every General Thread while
 * native read validation admits only the Default General, and native creation
 * omits the original marker. Thread mutation and Recipe trash/restore have no
 * reusable strict native plans; original trash fails current import validation.
 * Those operations remain explicit typed denials, never advertised support.
 */
export {};
