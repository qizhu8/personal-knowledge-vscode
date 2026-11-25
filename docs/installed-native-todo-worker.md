# Installed Worker leaf

`clients/vscode-host/installed-native-todo-worker.mjs` is a cold-component leaf,
not an installed runner or a production enrollment command. It launches only its
own bounded Python/CDP modal helper. Parent-owned code must select/install the
exact artifact, enroll the real profile, stop/restart the editor, and perform
the existing branded B0/B1 retirement/restore operations.

The parent now wires this leaf through `installed-test.mjs --native-identity
--cold-component --native-worker --legacy-vsix <original.vsix> --vsix <host.vsix>`.
It requires a separate cold scenario from Source, Action, Memory and Recipe.
The actual retained-session `revokeTodoWorkers()` is implemented in the cold
component; no caller policy or substitute revocation signal is accepted.

Parent actual-installed acceptance passed on VSIX SHA-256
`ee8fd7df3acc61efc4ad0b7e9b09131f4288bf4630a751e566d476c215dbcd8e`,
payload `e92c2be64da08ee1966e92fabdffb032d32d0ad214ce7ea46bbb8d56d22e09c5`.
The final cold report retains both pre-shutdown Worker/UI evidence and the
separate successful `workerPreservation` B1/B0 proof. These do not qualify an
actual user profile/keyring, native revoke-button action, or original-Chat
assignment. The private installed profile was removed.

## Preparation and parent wiring

After the whole editor exits and **before B0/custody**, call:

```js
const workerFixture = await prepareInstalledNativeTodoWorkerFixture({
  installed, componentFixture,
  legacyWriter: { path: pinnedOriginalFilestorePath, sha256: independentlyPinnedWriterSha256 },
});
```

The actual original writer creates `Team/WorkerBoard`, an original task/history,
and a historical grant for `external:copilot:installed-board-worker`. The old
token remains private to the helper's WeakMap; no token or successful native
approval is fabricated in a preparation descriptor. Copied fixtures, changed
writer bytes, existing source paths, and post-custody preparation are refused.

The retained actual cold component must expose:

```ts
enrollTodoWorker({ boardSlug, actorId }) // existing real retained-session entrypoint
revokeTodoWorkers()                    // actual retained-session policy revoke
```

The narrow implementation for the second parent-owned method is:

```ts
// Inside the existing cold component closure, with its normal closed/completed checks.
host.assertCurrent();
createOriginalMcpNativeTodoWorkerPolicy(actual.storage, host, nativeSession).revoke();
```

Do not pass a callback, copied session, fabricated policy, or equivalent new SAB
to the leaf. Its verifier uses the actual owner/Storage/Core and existing
`component.enrollTodoWorker`, which obtains independent signed native consent.

After the actual native host completes, before another domain closes the signed
attachment, call:

```js
const workerEvidence = await verifyInstalledNativeTodoWorker({
  root, installed, component, host: await component.complete(), workerFixture,
  python, env, port, payloadBuildId,
});
```

The verifier independently checks the installed profile/identity, descriptor,
host entry and payload pins. Its own renderer child handles these exact stages:

| Progress stage | Real renderer action |
|---|---|
| `native-todo-worker-source-admit` | **Admit this exact source only** |
| `native-todo-worker-deny` | **Deny** |
| `native-todo-worker-enroll` | **Enroll this exact Board worker** |
| `native-todo-worker-revoke` | Inspect/hover **PKM Board worker**, **do not click** |
| `native-todo-worker-revoked` | Observe parent-retained Node logical revocation completion |

No shared `installed-ui.py` changes are required. Do not have a second browser
driver click these dialogs. All driver evidence filenames are prefixed
`native-todo-worker-`; stale evidence is refused and each renderer proof is
bound to a new run ID.

## Effects, revocation, and scope

The scenario admits its exact Todo source, proves worker denial writes no
enrollment, enrolls through the real native UI, authenticates the returned new
token, publishes a canonical `todo.workitem.comment`, and reads it back through
that token. It checks the immutable worker receipt, token **hash**, canonical
operation receipt, original-source immutability, and absence of pending writes.
Raw worker tokens are never written to evidence files.

The cached Board-worker principal cannot call `chat.session.list`; enrollment
does not expand its rights into manager Chat. After the actual Node worker
policy revoke, both token and cached-principal access fail, a new mutation
creates no receipt, and the published Board remains unchanged. The same owner,
cached Core, native host and signed channel remain usable.

This is **not granular per-worker revocation**: current Core revokes the actual
Todo-session SAB/all its workers. The native worker status-bar command closes
the entire signed attachment, so the leaf inspects rather than clicks it. It
does not claim native revoke-UI qualification or installed original-Chat
assignment qualification.

### Combined Source scenarios

Todo source selection is immutable after hydration. The Worker leaf's distinct
Board selection cannot silently coexist with a different first-hydration
selection in the same component. Use a separate cold component, or have the
parent explicitly coordinate one exact prepared Board/source selection and an
activation-aware Source scenario.

In particular, after Worker hydration/logical revoke, a Source verifier cannot
truthfully assert that denial leaves “no Todo intent”: the committed intent
must remain, but there must be **no active source grant**. Source's final real
status-bar revoke must run last, against a freshly active source session; do
not reuse an already-revoked Worker SAB as its UI revocation proof. This leaf
does not edit the existing Source verifier or broaden source admission.

## B1/B0 verification

After the parent closes the component and the **whole editor**, preserves real
B1, retires with its typed ticket and restores fresh B0, call:

```js
const preservation = await verifyInstalledNativeTodoWorkerRestored(workerFixture, {
  restoredRoot: restored.root, archive: retirement.archive,
});
```

This checks the actual retirement/restore receipt hash chain and B0/B1 manifest
pins, original-root preservation versus fresh disjoint restored-root identity,
unchanged original Note/Board bytes, B1 native Board bytes, SQLite integrity,
the exact worker and canonical comment receipts, and no pending Todo. Native
worker/Core state must be absent from restored B0.

`native-todo-worker-passed.json` explicitly leaves B1/B0 qualification false
until that separate verifier succeeds. Parent evidence should retain its return
value alongside the UI/effect evidence. Leaf regressions and signed Core
fixtures are not actual installed acceptance; the parent must run this leaf
against its exact candidate artifact before claiming that result.
