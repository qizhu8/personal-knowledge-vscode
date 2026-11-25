# Installed original local-program Action acceptance helper

The program scenario extends `clients/vscode-host/installed-native-action.mjs`;
it does not duplicate its native host, owner, engine, or recovery implementation.
Existing pure Action preparation/bootstrap/verification APIs retain their
behavior. No shared installed runner/UI, cold component, transport, Core,
package, or build files are changed by this helper.

**Status:** parent actual-installed acceptance passed on VSIX SHA-256
`573834d936c01a86c15627e4334ff27d1294408463f44971e97836f90ad3162d`,
payload `95699d1d46e8089b680f19ee405a3b60e21c00df9afb4195c9c8e0f12d00470d`.
The shared harness wires `--native-identity --cold-component --native-program
--legacy-vsix <original.vsix> --vsix <host.vsix>` as its own source scenario.
The deployment-v1 compiler/source, actual separate native approvals, three
canonical owned jobs, idempotency, cancellation/revocation uncertainty and
whole-editor-close/B1/fresh-B0 preservation all passed. The private installed
profile was removed. Helper guard/syntax tests remain separate evidence;
neither they nor this bounded scenario qualify full36 or an OS sandbox.

## Preparation and deployment identity

After actual native enrollment and whole-editor exit, before either B0:

```js
const sourceFixture = await prepareInstalledNativeActionProgramFixture({
  root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
});
```

Inputs and checks are the same as the proven pure helper:

* The actual branded, newly created cold fixture and private enrolled driver.
* The independently pinned original 4.0.22 VSIX
  `1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.
* Actual deployment `compiler-capture-v1`, with exact original writer source
  hashes. The helper does not opt into frozen-v2, repin a plan, or use a
  checkout writer fallback.
* The existing pinned-original writer oracle registers one real
  `fixture.installed.native-program` definition without invoking an old worker.
  Its harmless exact Node argv/stdin/stdout contract is independently compiled
  under the actual candidate, preserving original `knowledgeId` and content
  hash. Compiler rejection is `INSTALLED_ACTION_PROGRAM_COMPILER_BLOCKED` with
  its real diagnostics, never qualification under a different identity.

The definition uses the canonical current Node path and exact inline code.
JSON stdin is `{value:string}`. Normal execution returns
`{value:"installed-original-program",environmentKeys:[]}` for `"installed"`;
`wait-` inputs deliberately await a timer so the real owned child can be
cancelled/revoked. No shell, model/provider, credentials, network or descendants
are used. The result schema requires an empty environment-key list.

A private `action-sources/installed-native-program/capsule.txt` is created
before B0. The whole cwd membership and source definition are selected into the
actual Action capsule, together with independently hashed current Node
executable bytes. No program/cwd/argv can be supplied through MCP arguments.
A reused driver containing previous program observer evidence is refused.

## Parent wiring: reuse the existing Action bootstrap

The parent-owned top-level program flag/selection now uses:

```js
// New program preparation above, then the existing bootstrap:
component = await bootstrapInstalledNativeActionComponent({
  sourceFixture, operatorId, limits, attachment,
  python, env, port: fixture.port, payloadBuildId,
});

// Existing descriptor provisioning, editor restart, native attach, Note/Skill
// operations and complete() remain unchanged.

const programEvidence = await verifyInstalledNativeActionProgram({
  sourceFixture, component,
});
```

The preparation WeakMap, not a serialized flag, causes the existing bootstrap
to:

1. Capture the ordinary whole-root B0 and base custody under unchanged actual
   cold guards, pinned to the already enrolled profile.
2. Seal the separate exact Action definition/context/toolchain capsule under
   the same writer fence, before root open or editor restart.
3. Use the same signed session, native host and actual Storage.
4. Require the actual installed producer to advertise `action.program.approve`.
5. Explicitly enable Actions through the actual native command/modal.
6. Compose exactly one `localPrograms` target from the branded preparation
   before the owner's existing canonical Action/process services are created.

No separate program engine or generic process launcher is accepted. Using the
old pure verifier with a program fixture fails rather than reporting output41.
Models/Chat may remain deliberately unavailable.

Run program acceptance before any later Todo/Memory/Chat source revocation
which closes the entire signed session.

## Actual native UI stages

The helper owns a headlessly attached Python Playwright CDP observer. It uses
the actual workbench, signer, attachment, source producer and program approver;
there are no UI/signer/decision doubles. Shared `installed-ui.py` remains
unchanged.

Stages, in order:

1. `native-business-program-enable`: command palette →
   `Enable Separate Native Action Approvals` → real enable modal.
2. `native-business-program-source-deny`: exact source capsule → Deny.
3. `native-business-program-source-admit`: exact source capsule → approve.
4. `native-business-program-public-deny`: public `action_call` → Deny.
5. `native-business-program-consent-deny`: approve the public invocation,
   then Deny the separate exact local-program modal.
6. `native-business-program-run`: approve both layers; real child produces
   the original typed output.
7. `native-business-program-reuse`: public confirmation only; same key must
   reuse the same completed Run and sole ProcessJob.
8. `native-business-program-cancel-run`: approve a genuine waiting child.
9. `native-business-program-cancel`: approve `action_run_cancel` for its exact
   Run ID; existing canonical supervision terminates that owned child.
10. `native-business-program-cancel-reuse`: public confirmation only; same key
    retrieves the uncertain receipt without a new process or program decision.
11. `native-business-program-revoke-run`: approve another genuine waiting child.
12. `native-business-program-revoke`: inspect the real root/profile tooltip and
    click `PKM Action approvals`; the real native-status monitor must cancel
    the active owned child.
13. `native-business-program-revoked-call`: public confirmation may still pass,
    but no process decision/Run/ProcessJob may follow.
14. `native-business-program-complete`: close the observer normally.

The native program modal must show the exact root, profile, source/content/
capsule hashes, Node path/bytes hash, approved cwd, one-direct-child scope,
closed inherited-environment/credential/network flags and no automatic replay.
The source dialog must retain `noExecution:true`. Dialog text digests are
recorded without fabricating a native approval or changing source identities.

Evidence uses the separate `native-action-program-*` prefix, so it cannot be
mistaken for a prior pure `native-action-business-*` result.

## Canonical business assertions

The verifier requires the original real owner/host/Storage and same cached Core.
It checks:

* Denied source admission creates no domain admission.
* Public invocation denial and separate program denial each create no Run or
  ProcessJob.
* Exactly one new actor-owned canonical ProcessJob appears for each exact new
  Run, with the actual typed native program request/decision in the immutable
  invocation receipt. Toolchain, argv, input digest, cwd, profile and epoch
  match the sealed preparation.
* Normal completion has the actual original program stdout result, empty child
  environment, ephemeral raw stdout/stderr and one Run/Job after key reuse.
* Cancellation waits until the canonical ProcessJob has a real owned PID,
  then uses the existing Action cancel operation, never a PID signal.
* Both cancellation and native revocation terminate the owned child and retain
  `unknown` Action / `CANCELLED` ProcessJob / `unknown` effect receipts.
* Reusing the cancelled key does not replay; revocation blocks a fresh key.
* There are three actual program Runs and three ProcessJobs: one succeeded,
  one cancelled, one revoked. No extra jobs, old-worker adoption or fake
  successful result is accepted.
* Original definition/context bytes, owner lease, cached Core and independent
  signed public/model session remain unchanged/current.

The evidence's `records` list observes each Run's sole new ProcessJob and records
their canonical IDs/states. This is observation of existing canonical receipts,
not a new process store or native authority. The direct-child service is not an
OS filesystem/network sandbox; `osSandboxQualified` remains false.

## Close, B1 and fresh B0 restoration

The existing `component.close()` and
`preserveInstalledNativeActionB1(component)` work for either preparation. Close
removes the owned `.pkm-action-authority`; the parent must then wait for the
**entire actual editor** to exit before invoking unchanged B1 cold guards and
retirement/restoration APIs.

The parent cold wrapper additionally waits for three consecutive clean reports
from the unchanged Linux writer inventory before preparation, B0 and B1.
Editor main-process exit alone can race a remaining `code` child's shutdown.
This bounded read-only wait neither ignores nor terminates a process; the
actual snapshot still performs its own strict guard. The final cold receipt
retains and checks these observations in `coldQuiescence`. Actual installed
program/recovery requalification with this lifecycle also passes.

After fresh B0 restore:

```js
const programPreservation = await verifyInstalledNativeActionProgramRestored(
  sourceFixture, { restoredRoot: restored.root, archive: retirement.archive });
```

The common existing `verifyInstalledNativeActionRestored` also dispatches by the
private preparation state, but the explicit program name is preferable.

It verifies original source/context bytes in B0 and B1; all three canonical Run
states, ProcessJob ownership/finished states and typed program decision receipts
in B1; a closed process owner; retained independent executable capsule bytes;
and no canonical DB or native endpoint authority restored into the original B0
fixture. The external selected Action capsule must remain retained until this
check completes. Failed/changed controls are preserved for reconciliation.

Actual profile/keyring restoration, hostile-code containment, other runtimes,
general commands, builds, remote providers, credentials, Cosmos, and full native
engine/full36 qualification remain explicitly unqualified.

## Helper validation

```sh
node --check clients/vscode-host/installed-native-action.mjs
TMPDIR="$HOME/.cache/pkm-tests" node tests/framework/run.cjs --no-build \
  --file clients/vscode-host/installed-native-action.test.mjs \
  --jobs 1 --admit-native --admit-qualification
```

The three guard/syntax regressions cover both pure and program preparation,
copied/serialized source authority refusal, B1 refusal and independent parsing
of both CDP observers. They are not actual-installed program qualification.
