# Installed original-Chat Todo assignment leaf

The new assignment leaf is separate from worker enrollment and uses a separate
disposable cold component/source selection. It does not edit the installed
runner, source/native producers, transports, Core, or the atomic assignment
gate. It starts only its own bounded renderer helper, never an editor.

Parent wiring now provides `--native-assignment` with `--native-identity
--cold-component --legacy-vsix <original.vsix> --vsix <host.vsix>`. It is a
standalone source scenario. The actual existing canonical dispatcher, native
fixture provider registration/model enable, and separate preservation verifier
are connected; no extra native authority method was added.

Parent actual-installed acceptance passed on VSIX SHA-256
`1742bef581248d84cf9de0f25de8a49d736103d8654b3f59501b9fa8dfc19044`,
payload `8da899663d0021ce5f18796b90de63d5b019bf996bf87edfc769a9fe62c1b4a9`.
The final cold report retains `assignmentPreservation` proving B1/fresh-B0
separately from the pre-close leaf evidence. The private installed profile was
removed. This does not qualify a separate assignment modal, full Todo parity,
commercial inference or an actual user profile/keyring.

## Parent composition

Before B0/custody, with the whole editor stopped:

```js
const assignmentFixture = await prepareInstalledNativeTodoAssignmentFixture({
  installed, componentFixture,
  legacyWriter: { path: pinnedOriginalFilestorePath, sha256: originalFilestoreSha256 },
  legacyChatStore: { path: pinnedOriginalApiChatStorePath, sha256: originalApiChatStoreSha256 },
});
```

Both writer modules must be independently pinned members of the verified
original package. Preparation uses the actual old writers to create
`Team/AssignmentBoard`, historical task audit, and one ordinary original Chat
under its original UUID/URL. It creates no current Core session, worker token,
native permission, or replacement owner UUID. Existing Chat/source selections
and post-custody preparation are refused.

The parent must:

* Register the existing deterministic `pkm-native-fixture` provider in the actual
  development driver and enable the native model channel during this cold
  attachment, using the existing real native enable consent. Its exact label is
  **Synthetic native protocol fixture**, with ordinary reply
  **synthetic native streaming response**. This is not a commercial provider.
* Bootstrap `nativeModels` using
  `installedNativeTodoAssignmentModelFixture.toolCatalog`. The current runtime
  needs the existing bounded `get_document → knowledge.document.get` catalog
  and real reviewer bundle; an empty catalog would fail startup. The provider
  requests no tool and the leaf requires zero tool-intent effects.
* Expose `component.invokeCanonical(name, input, signal?)` as an explicit
  delegation to the cold component's **existing actual public dispatcher**,
  with normal closed/completed/native-host checks. Do not construct a success
  callback, synthesize a principal, or invoke ordinary Core as an assignment
  fallback. The component retains its authenticated manager principal.

The exact missing component method follows its existing bounded `invoke`
tracking; `backend` below is the already retained original public dispatcher:

```ts
async invokeCanonical(
  name: "legacy_capability_read" | "legacy_capability_call",
  input: unknown,
  signal?: AbortSignal,
) {
  if (closed || !completed || !backend || !host)
    fail("COMPONENT_NATIVE_CANONICAL_UNAVAILABLE");
  host.assertCurrent();
  const request = backend.invokeCanonical(name, input, signal);
  inflight.add(request);
  try { return await request; } finally { inflight.delete(request); }
}
```

Cold driver registration/enable must include this scenario, not only the
Memory flag. The existing actual model-channel enable confirmation remains
parent-owned cold-attachment UI, before `component.complete()` resolves.

The API Chat continuation itself uses the existing real
`createOriginalMcpApiChatRuntime` on the same retained owner/host, as the
installed Memory leaf does. No extra API-tool whitelist or native request
method is required. Run this separate leaf before any code closes its signed
attachment:

```js
const assignmentEvidence = await verifyInstalledNativeTodoAssignment({
  root, installed, component, assignmentFixture,
  python, env, port, payloadBuildId,
});
```

## Exact real UI stages

The leaf renderer child owns these choices. Shared UI code should not compete
for their modals.

| Stage | Native choices |
|---|---|
| `native-todo-assignment-todo-source` | **Admit this exact source only** |
| `native-todo-assignment-chat-source` | **Admit this exact source only** |
| `native-todo-assignment-chat-deny` | Public send **Approve this request**; exact model Quick Pick; binding **Deny** |
| `native-todo-assignment-chat-bind` | Public send approve; exact model; binding allow; **No live Memory recall (default)**; exact model selection allow; exact Chat send allow; bounded execution allow; inference approve |
| `native-todo-assignment-complete` | Observe completion with no unexpected new modal |

Model/Chat decisions use **Allow this native model request**; the final
inference uses **Approve this request**. The renderer parses structured modal
details and checks the exact profile/root/workspace, original UUID/URL, source
plan, command/request hashes, native model and epoch, no live Memory, bounded
round/output budget, and the sole declared tool catalog.

There is **no separate Todo-assignment approval modal in the current API**.
The deny proof is genuine native model-binding denial: it creates neither a
current Core Chat nor a Todo assignment intent. The actual assignment authority
is the retained authenticated canonical principal plus independent Todo/Chat
source grants and the atomic assignment guard. The evidence does not
misrepresent binding consent as a distinct assignment UI decision.

## Actual effects and refusals

The scenario first rejects archive-only assignment. After native binding
denial it again proves no assignment guard/pending intent/receipt. One approved
ordinary continuation must produce a current, same-actor Core session under
the **same original UUID**, and a branded native binding with the exact current
Core revision and completed current-lease execution evidence.

The success path calls the actual public `todo.workitem.assign` canonical
entrypoint, not ordinary Core after a read-only preparation. It checks the
typed result, persisted private guard, lease, source decisions, original owner
UUID/URL, native request/epoch and target revision. Repeating the old public CAS
request is refused with no second assignment. Model calls, worker grants,
native requests and job/tool effects must not increase during assignment.

For stale-target testing the private fixture performs one actual same-actor
Core Chat archive mutation. This is a canonical lifecycle test action, not an
invented native binding or a claim of original Chat Trash UI parity. A previously
branded prepared assignment and the public canonical route must both refuse
the stale/archived target. Logical revocation of the **actual Chat source**
then refuses assignment without ordinary-session fallback while preserving the
independent signed channel. No old worker role is promoted to manager.

Original Board/Note/Chat/group/history bytes remain immutable throughout.
Native history and the final archived Core session are separate B1 state.

## B1 and fresh B0

After parent-confirmed whole-editor exit, component close, actual B1
preservation, typed retirement and disjoint B0 restore:

```js
const assignmentPreservation = await verifyInstalledNativeTodoAssignmentRestored(
  assignmentFixture, { restoredRoot: restored.root, archive: retirement.archive },
);
```

The verifier checks the retirement/restore receipt hash chain, B0/B1 manifest
pins, exact original source bytes, fresh disjoint restored-root identity and
unchanged original-root identity, preserved native Board/assignment receipt and
guard, exact original/native Chat mapping, completed native execution/request
and inference, final Core revision/archive state, zero worker enrollment and
zero pending Todo. Native state is absent from B0.

Keep its return value alongside `native-todo-assignment-passed.json`; that
file leaves B1/B0 claims false until preservation is separately verified.
Leaf regressions are not actual installed acceptance. Neither this leaf nor
its deterministic provider qualifies commercial inference, full 34-operation
Todo parity, original Chat Trash UI parity, production data/profile cutover,
or production keyring restoration.
