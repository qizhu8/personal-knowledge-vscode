# Tests

## Standard entrypoint and lifecycle

Use `npm test` for the bounded unit group (framework checks and Markdown core
regressions). Build first with `npm run build`; missing prerequisites are
failures, not skipped or successful tests.

```sh
npm run test:list
npm test -- --suite framework
npm test -- --group integration
npm test -- --suite test:smoke
npm test -- --file tests/markdown.test.mjs --timeout 120
```

The registry reuses existing npm wrappers and their prerequisites rather than
rediscovering every file or executing fixtures/controllers as tests. Curated
groups are `unit`, `integration`, `browser` and `e2e` when their suites exist;
remaining wrappers are explicitly labelled `legacy` until reviewed. Suites run
sequentially with deadlines (`--timeout 1..3600` seconds). No full release gate
is implicit. JavaScript uses Node's built-in runner. Selected Python files use
`PKM_TEST_PYTHON`, `PYTHON`, or `python3`, with bytecode generation disabled.

The normalized entrypoint currently requires Linux x86-64/AArch64, a non-admin
user, Python 3.8+, kernel pidfd support, user/PID/mount/network namespaces, and
unprivileged OverlayFS. Missing isolation fails explicitly with no uncontained
fallback. Its UID-preserving namespace implementation is shared with private
host runners.

Each suite has a private, repository-external scratch directory and a writable
copy-on-write checkout. Original sources and installed dependencies are read
without a full duplicate checkout. Hardcoded `.migration-test-work/`,
`tests/.fixture-*`, build and cache writes stay in the disposable layer, unseen
by host Git/file watchers. Builds inside a suite do not update the host `dist/`.
Temporary directories follow per-run `TMPDIR`/`TMP`/`TEMP`. Shared development
tool caches remain separate; never use production data or credentials as fixtures.

Private namespace processes, including detached fixture daemons, stop before
cleanup. Success, assertion failure, timeout and cancellation reclaim owned
scratch data. Permission-denied fixtures are unlocked only after assertions
and shutdown. Ownership changes or cleanup errors fail the run and explicitly
identify the retained directory; there is no unrelated process termination or
blanket stale-directory sweep.

Passing runs retain no logs or scratch data. Failures overwrite one
`last-failure.json` per checkout under `~/.cache/pkm-tests/`, with output tails
and a total size of at most 64 KiB. `PKM_TEST_REPORTS` can select a different
repository-external report directory. Full environment archives and successful
transcripts are not retained.

The former default `node scripts/verify.mjs` is preserved as
`npm run test:qualification`, outside the grouped fixture runner. Its provenance
and capture gates are unchanged; it is not run automatically and must not be
used to refresh historical pins merely to make a test green. Direct legacy
commands retain their specialized workflows, but only the normalized entrypoint
provides this lifecycle.

Isolated fixture results **do not qualify production takeover, real shared-host
exclusion, native installed upgrades, live-provider behavior, or Windows
acceptance**. Keep those gates separate. The immutable `legacy/` compatibility
snapshot remains unchanged and is not the active test framework.
