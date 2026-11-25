# MCP-only gateway: original business and storage

The option-A gateway changes the MCP boundary, **not** the business engine.
`src/compatibility-mcp.ts` runs one supervised original adapter per gateway,
captures its live contracts, and dispatches back to its original executors.
It does not create a v5 database, migrate the library, replace native authority,
or claim that discovering an operation proves its business behavior.

The current original runtime exposes 151 canonical `mcp.tool.*` operations.
The gateway exposes nine discovery/lifecycle/dispatch tools plus 18 module
aliases. An alias uses the canonical input schema, read/mutation classification,
and executor; it has no extra permission. In particular:

* `skill_write` preserves `add_skill` **create/upsert**, including overwriting an
  existing Skill. Use `skill_modify` for partial changes.
* Original business content, structured results, missing-object behavior and
  error results are retained. Boundary validation can reject before dispatch;
  its error text need not include FastMCP's original error prefix.
* `todo.*` and `memory.*` discovery and execution remain delegated to the actual
  canonical adapter. Their result envelopes are not replaced with guessed
  `mcp.tool.*` results.
* Worker tokens are forwarded, not reinterpreted. Conflicting tokens and
  unsupported leaf token arguments are refused. Discovery grants no worker,
  Memory confirmation, native model, or tool-effect authority.
* Original canonical metadata provides `readOnly`, not the complete legacy
  tool-annotation safety hints. Clients must not infer non-destructive approval
  scopes from missing hints; conservative additional prompts are appropriate.

In the native original-public bridge, `add_skill` also upserts an occupied
sanitized destination (for example, `Skill?` resolves to `Skill.md`). The exact
destination's knowledge identity, revision, bytes and scan are pinned for native
CAS; resources remain under their existing ownership. Ambiguous names, private
custody, competing edits and unapproved moves remain refused.

`skill_feedback` and `propose_skill_update` execute the existing native advisory
maintenance backend with exact current public actor/root approval and imported
maintenance genesis when present. Authority is rechecked after planning and
before committing immutable receipts. Feedback stores the task hash, not the
raw task; proposals record the real current Skill hash and mark stale bases as
conflicts. Neither operation edits formal Skills or contacts a collector.
Existing installation, activation and Skill routing semantics are unchanged.

The hybrid facade's `capabilities_list` / `capabilities_search` input schemas
declare the existing numeric discovery limits: `offset >= 0` and `limit` from
1 through 10. Clients can reject invalid pagination before a request instead of
learning these bounds from a runtime error. This refines the new hybrid
discovery boundary only; the captured compact/original schemas, 151 business
contracts and their authority are unchanged. Existing string-length guards
remain authoritative; no different Unicode-length rule is introduced.

## Staging and identity

`scripts/stage-compatibility-mcp.mjs` accepts an existing original extension,
library and managed runtime, a Python executable, and a **new private stage
outside the library**. It bundles privately rather than building shared `dist`.
It writes a pinned `target.json` and private `adapter.json` into that stage only.
A failed stage removes its own newly created partial directory, never an
existing destination. Staging does not select, deploy or rewrite a live target.

The CLI checks configuration ownership, permissions and SHA-256 using the opened
file descriptor. Node, supervisor and launcher files are pinned. A regenerated
original generation may be accepted only when the explicitly staged update
policy permits it and its **version and entire component-version set still
match exactly**. Its generation/build must be valid, its runtime accepting and
empty, and its identity unchanged throughout catalog capture. Incompatible
versions do not trigger a fallback.

`check_version.runtime` identifies the gateway. `check_version.backend`
truthfully identifies the original business runtime, reports
`storageEngine:"original"` / `storageMigrated:false`, and includes live
`health:{phase,inFlight,uncertainCalls,automaticReplay:false}`.

## Native, Chat and CLI selection

The native provider and PKM Chat use the reviewed target selected in the v4 host.
Copilot CLI has a separate user configuration at `~/.copilot/mcp-config.json`.
Selecting the native provider does not silently rewrite that file. After explicit
user approval and a private byte backup, its `pkm` command can use the target's
Node executable and `[entry.path, ...args]`; keep other server entries and the
existing `tools` policy unchanged.

New CLI/agent chats then discover the selected gateway. An already-running
conversation may still have its previous launch descriptor and private socket
cached; a native reload or editing the CLI file is not proof that this old
conversation refreshed. Verify `check_version`, backend identity and the tool
inventory through the actual new chat's MCP tools. Do not label a direct SDK
probe as proof of that conversation's inherited connection.

## Cancellation, failure and shutdown

Cancelling a caller's wait does not cancel/replay an admitted original write or
remove it from the gateway drain ledger. EOF and SIGINT/SIGTERM, including
signals during startup, request the same graceful close. The gateway waits for
the original lifecycle to prove drain, ends its input, and observes its
supervisor exit. It does not substitute a forced kill for that proof.

An adapter transport failure fences new work and quiesces gateway admission.
Unacknowledged writes retain an unknown outcome even after their process exits.
Close rejects rather than reporting a verified drain or replaying the write.
A malformed/unavailable drain control also refuses a clean-shutdown claim.

## Focused evidence

The native original-public facade implements `diagnostics_latest` from its
current native host's process-local metadata writer, not the legacy adapter or
archived diagnostic files. It retains the original response keys and default
100-row limit; reads accept integers from 1 through 1000. `directory` is the
opaque locator `native:current-process`, never a filesystem path. The bounded
100,000-row in-memory ring reports overwritten rows in `dropped_records` and
marks records `persisted:false`. Reloading or replacing the native host starts
a fresh writer; no old writer rows, transcripts, caller arguments, exception
messages, profile/owner identifiers, secrets or raw output are imported.

This is an intentional native privacy deviation from v4's filesystem locator,
not a promise that the marker names a directory or an openable URI. No shipped
MCP/UI caller opens the returned field. The legacy local JSONL exporter and
historical-writer tools operate on explicitly selected legacy disk directories;
they must not be used with this native marker or writer ID. For native export,
save the current MCP reply's `records` (at most 1,000 per read); there is no
filesystem/history export or persisted tail to open. Existing extension/Sync
log-opening UI continues to use its own independently owned logs.

Every read requires the same exact current native public approval, owner,
source-catalog and epoch checks as other original-public operations. Read-only
principals may read diagnostics but gain no mutation authority. Cancellation
or authority revocation before publication discards the response. This adds no
durable schema, migration, historical authority or logging-framework change.

Run:

```sh
node --experimental-transform-types --test --test-concurrency=1 tests/compatibility-mcp.test.mjs
npx --no-install tsc -p tsconfig.json --noEmit
```

Tests generate isolated original-managed fixtures under `.pkm-test-evidence/`,
with their own CommonJS package boundary, and remove their private stages and
libraries afterwards. They require the current original extension build
(`PKM_COMPATIBILITY_EXTENSION`, default `../personal-knowledge-vscode`) and its
configured test Python (`PKM_TEST_PYTHON` can override).

The focused suite verifies actual-original Note update/read; Skill
create/read/partial-update/upsert and alias/canonical results/errors; Action
capability read; canonical Todo board listing and Memory record search;
worker-token denial/forwarding; cancellation followed by EOF during a locked
real write; normal EOF; startup signals; compatible regeneration; incompatible
build/component refusal; and partial-stage cleanup. A separately labeled
synthetic protocol fault tests read/write disconnect accounting and no replay;
it is **not** evidence of original business execution. The 151 captured
contracts and 18 aliases are catalog evidence, not 151 executed business tests.

The suite also compares warm `capabilities_search(query:"get_skill",limit:1)`
over stdio against a direct supervised **current original service on the same
isolated fixture**: five warm-ups, 40 measured calls per side, alternating call
order, startup excluded, nearest-rank percentiles. One Linux run on 2026-11-20
measured gateway p50/p95 **0.655/1.151 ms**, direct original
**7.272/11.429 ms**. These are local warm discovery measurements, not provider
tokens, business-call parity, startup latency or a production performance SLA.
The test prints fresh metrics; no historical benchmark artifacts are required.
