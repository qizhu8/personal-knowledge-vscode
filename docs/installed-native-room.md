# Installed bounded native Room status leaf

`clients/vscode-host/installed-native-room.mjs` is a fixture-only installed-test
leaf. It is not imported by the production extension and does not patch
production APIs, installed bytes, platform APIs or Core modules. The parent's
shared harness wiring is described below.

**The bounded actual installed journey now passes**, on VSIX SHA-256
`1742bef581248d84cf9de0f25de8a49d736103d8654b3f59501b9fa8dfc19044`,
payload `8da899663d0021ce5f18796b90de63d5b019bf996bf87edfc769a9fe62c1b4a9`.
The parent wires `--native-identity --cold-component --native-room
--legacy-vsix <original.vsix> --vsix <host.vsix>` as a separate source scenario.
Real activation observation, native-only synthetic credential creation, actual
source/Host/status UI and revoke, B1 and fresh B0 all passed; the final cold
report retains the separate successful `roomPreservation` proof. The private
profile was removed. Actual user keyring, old ownership migration, networking,
rehost, joined clients and the full ten-operation contract remain unqualified.

The focused tests intentionally cannot create native credentials in
ordinary Node. They validate guards, original Room/Meeting writers, original
status output and Python driver syntax; they are not installed evidence.

## Why the first actual activation is needed

The original `ChatRoomCredentialStore` must receive the **same real Production
`ExtensionContext.secrets`** later used by the installed native Room producer.
A separate extension's SecretStorage, coordinator Map, copied keyring or
public-only hash file cannot satisfy that requirement.

The early observer:

- Requires an owned private `.installed-host-<uuid>` driver, a CLI-style installed
  `pkm-nonproduction.pkm-v5-*` directory, its unchanged actual entrypoint, and
  explicit `PKM_HOST_INSTALLED_FIXTURE.nativeRoom` configuration.
- Uses the actual `vscode` module and actual registered installed extension.
  An already activated target is rejected, never forcibly reactivated.
- Temporarily wraps only the CJS entry's `require.cache[entry].exports` with a
  Proxy observing `activate`. It restores the exact previous cache exports at
  the call, forwards the original arguments/receiver and **returns the original
  activation result unchanged**. Other module exports pass through.
- Privately checks the real activation's returned exports, Production mode,
  live `assertActiveMigrationContext(context)`, exact installed path, trusted
  workspace and fixture-local profile. The context and SecretStorage object
  are never returned or written to evidence.
- Shows a fixture-only native confirmation. Only after its explicit approval
  does it execute the credential class extracted from the SHA-pinned original
  4.0.22 VSIX to create **one NEW synthetic Room's** keys in that real context.
- The credential record and observer result contain **exactly** Room ID,
  Host hash and join hash. Public provenance/profile scalars are in the
  separate `native-room-credential-observation.json`, never a serialized context.
  Raw credentials remain inside the activation. The original store
  refuses existing/partial credentials; there is no overwrite/reseed fallback.
- On native reload, observes/validates the new actual Production activation
  again, but does not recreate or read the existing Room keys. Later native
  Host/status proof is what demonstrates current real credential custody.

The original archive is SHA-pinned to
`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.
The original credential source is extracted from those verified in-memory
archive bytes, not a second unpinned read of a mutable path.

If the actual loader is not observable, the target activated too early, another
observer replaces this cache slot, or the real Production context cannot be
validated, this leaf fails with an `INSTALLED_ROOM_*` blocker. **Do not substitute
a context, patch platform APIs, expose a production test hook, change installed
bytes, reload to obtain a different context, or fabricate an observer receipt.**
The observer must be disposed on failure; retain private evidence/profile if
creation failed midway. Never delete/recreate a key to make the experiment pass.

## Exact parent wiring

The parent owns all shared runner/UI/cold code and editor lifecycle. These are
the only additions needed there; the leaf itself never launches an editor.

### 1. Before launching the first actual editor

After CLI installation, validation and port allocation, in the coordinator
process:

```js
const room = await import(new URL("./installed-native-room.mjs", import.meta.url));
const roomCredentialIntent = await room.prepareInstalledNativeRoomCredentials({
  root, installed, legacyVsix: fixture.legacyVsix,
});
const roomCredentialUi = room.startInstalledNativeRoomCredentialUi({
  root, installed, python, env, port: fixture.port,
});
```

Keep the **actual returned intent object** in this process and pass it to the
cold-component wrapper later. A serialized/copied intent is not accepted.
Set `nativeRoom: true` and `legacyVsix` in the fixture JSON used by both editor
launches/reloads. This should be its own cold component scenario, not combined
with a leaf that revokes the signed attachment before Room verification.

### 2. Arm the observer before target activation

In the fixture driver extension's `activate`, before loading/running the
installed test runner or otherwise activating the target:

```js
const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
const room = await import(absoluteLeafFileUrl);
const observer = room.observeInstalledNativeRoomActivation({
  root: fixture.root, installed: fixture.installed, legacyVsix: fixture.legacyVsix,
});
require(installedRunnerPath).run({ roomActivationReady: observer.ready }).then(
  existingRunnerSuccessHandler, existingRunnerFailureHandler,
).finally(() => {
  observer.dispose();
  return vscode.commands.executeCommand("workbench.action.quit");
});
```

Do not await `observer.ready` **before** activating the target: that would
deadlock. In the parent-owned runner, immediately after its existing
`await extension.activate()` and before any other native UI scenario:

```js
if (fixture.nativeRoom) await options.roomActivationReady;
```

Keep the ordinary runner completion/quit evidence handling around that call;
do not make the driver's own activation wait for the full runner/reload journey.
Apply the same early hook on native identity reload and on the cold launch;
the existing hash-only creation receipt prevents duplicate key creation.
The early UI driver uses its own `native-room-credential-modal.json` signal,
not the shared progress stages, so it does not replace the ordinary UI driver.
Await `roomCredentialUi.done`, and always stop that owned UI child in parent
cleanup.

This CJS observation is deliberately test-driver-only. It is not an exported
activation/context API and is not part of the production returned exports.

### 3. After the whole first editor closes, before B0/custody

Use the existing parent whole-editor shutdown check. In the genuine branded
cold fixture, initialize the original privacy policy with:

```json
{"schema":1,"private":{"notes":["Chatroom Meetings"]}}
```

Then call:

```js
const roomFixture = await room.prepareInstalledNativeRoomFixture({
  root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
  credentialIntent: roomCredentialIntent, python,
});
```

The helper additionally requires the creating extension host to be gone and
runs the unchanged actual Linux legacy-writer quiescence guard. No ignore flag,
PID restoration, process kill or caller `cold: true` can bypass it.

Only the Room ID/Host/join hashes from actual creation enter the pinned original
`ChatPersistence` fixture writer. The pinned original `MeetingStateStore`
creates/adjourns the Meeting, and a private manual annotation is retained.
All this happens **before** original-root B0/custody. No original file is mutated
under the adopted NativeRoot. This is newly created synthetic source, never
historical user ownership or `PKM_PRIVATE_ROOM_BASELINE_FIXTURE` evidence.

`prepareInstalledNativeRoomOriginalWriters` is separately exported for focused
writer/oracle probes. Its result explicitly says `installedProof: false`; it
cannot substitute for the installed preparation/credential observation.

### 4. Actual cold installed verification, run last

After the existing cold attachment/`component.complete()` and ordinary
Note/Skill checks, before closing the component/editor:

```js
const roomEvidence = await room.verifyInstalledNativeRoom({
  root, installed, component, sourceFixture: roomFixture,
  python, env, port: fixture.port, payloadBuildId,
});
```

The leaf uses the already integrated **actual**
`component.selectRoom(roomId)` and `component.invoke("chat_status", args)`.
It verifies real identity/profile/build/custody binding and same RootOwner,
Storage, Core and lease, then drives its own bounded actual-renderer modals:

1. No source selection → public status fails closed.
2. Denied Room source → no selection.
3. Approved exact private Room source.
4. Denied current Host proof → no status.
5. Approved Host proof, denied exact status read → no result.
6. Separately approved Host/status for empty and Unicode named status, compared
   byte-for-byte with the actual original `chat_status` producer oracle.
7. Click the actual private Room status control to revoke the signed session.
   Both the actual public route and cached port must fail closed afterwards.

Each modal's full source and signed session binding is checked. Status arguments
and their digest, current Host challenge, native-only secret boundary and
no-network/rehost/participant-change flags are checked before clicking.
No joined client is invented; named historical participants stay unjoined.
Original Room/Meeting/manual Note/privacy bytes must remain unchanged.

Room revocation closes the complete signed session, so this leaf must be the
last operation that needs that session. Its proof remains B1/B0-unqualified
until the parent completes the next step.

### 5. Existing genuine B1/retire/B0 recovery

Use the existing parent component close, **complete editor exit**, actual B1
preservation, typed retirement and fresh B0 restoration. Then:

```js
const roomPreservation = await room.verifyInstalledNativeRoomRestored(
  roomFixture, { retirement, restored },
);
```

This checks receipt hashes/linkage/B0 identity, exact original private files in
B1 and restored B0, the actual native Host admission in B1's checked SQLite,
and absence of native state/grants in the fresh B0. Profiles/keys are neither
captured nor restored. The helper does not perform recovery on the parent's
behalf or certify editor shutdown from a boolean.

## Focused validation and remaining hold

```sh
python3 -I -B tests/framework/isolate.py node --test clients/vscode-host/installed-native-room.test.mjs
node --check clients/vscode-host/installed-native-room.mjs
```

The four focused cases use the pinned original writer and status producer
without a fake SecretStorage, real editor launch or manufactured installed
receipt. The separate parent run identified above supplies actual loader
observation, native-only synthetic credential creation/modal behavior,
bounded installed status and B1/B0 acceptance; these are not inferred from
the four focused cases.

No network, rehost, joined-client/history/cursor continuity, full-ten Room,
production keyring restoration, historical private source or full-cutover
qualification is claimed.
