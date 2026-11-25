# Installed bounded Room live-session acceptance

New fixture-only files:

- `clients/vscode-host/installed-native-room-live.mjs`
- `clients/vscode-host/installed-native-room-live-ui.mjs`
- `clients/vscode-host/installed-native-room-live.test.mjs`

They reuse the existing actual Production activation observer, pinned original
Room/Meeting writers, same-Core live-session owner and parent component
B0/B1 framework. They do not introduce a database, credential authority, Hub,
original-client implementation or business process supervisor.

The parent completed coherent emission/bootstrap/package and actual installed
execution with B1/fresh-B0 preservation. The original source-only checkpoint did
not modify shared files; the parent integrations below are now present.

The parent has now added the requested-input observer contract/hash checks,
the cold/public hooks, and independent `--native-room-live` coordinator
wiring. Caller input reaches only the actual editor environment, not serialized
fixture/evidence files.

The accepted candidate SHA-256 is
`4e05dd2ed7345c322a52ff675714517dd6344d2c4937bf4a7af7e5df53ab05c5`,
with payload
`3bffefd5f9782db843d4981c76c5070c92e664e6e7716d3bc5eecec1ac0ca9b3`.
The real private Production editor completed 21 native modal decisions,
three distinct explicit effects (normal close, actual expiry, actual UI
revocation), public join/post receipt replay, unchanged original
Room/Meeting/manual-Note bytes, canonical B1 receipts and fresh B0 without
native grants. The installed extension was uninstalled and its private profile
removed. This candidate was not deployed to production.

## Required small existing Room-owned observer extension

The status helper creates a random native-only join secret today. A public
user-link case cannot discover that value by reading/exporting SecretStorage.
Instead, the **caller** must generate a new synthetic requested join secret
and submit it through the original credential class's supported input.

In `installed-native-room.mjs`, parent needs these small additive changes:

1. Export an explicit feature contract:

   ```js
   export const installedNativeRoomRequestedCredentialProtocol =
     "pkm.installed-native-room-requested-credential/v1";
   ```

2. Extend `prepareInstalledNativeRoomCredentials` with optional
   `requestedJoinSecretSha256`. Validate it as lowercase SHA-256 if supplied,
   and include only that hash in the immutable credential intent. Return the
   actual branded intent as before. Existing status-only behavior is unchanged.
3. Extend `observeInstalledNativeRoomActivation` with optional transient
   `requestedJoinSecret`. For a new requested-input intent, require its hash
   to match `intent.requestedJoinSecretSha256` before any creation.
4. In its actual Production native confirmation detail, add only:

   ```js
   {
     requestedJoinSecretSha256: intent.requestedJoinSecretSha256,
     joinSecretOrigin: "caller-generated-synthetic-requested-input"
   }
   ```

5. In that same actual real context, call the unchanged pinned original:

   ```js
   const created = await store.create(intent.roomId, requestedJoinSecret);
   ```

   When a requested hash exists, verify
   `created.joinSecretHash === intent.requestedJoinSecretSha256`.
   Do not add a credential getter, fake SecretStorage, environment-based
   production authority, alternate key writer or a returned-context API.
6. Preserve the existing exactly-three-field credential record and separate
   observation metadata. No extra field is required in that credential
   record/observation. On reload, validate the actual Production context as
   before and do not recreate/read keys for evidence.

Without both the feature contract and hash acknowledgement, the new helper
throws `INSTALLED_ROOM_LIVE_REQUESTED_SECRET_OBSERVER_UPGRADE_REQUIRED`.
It does not attempt another keyring path or manufacture installed proof.

This is a fixture-only input to the original API, not a weaker/hardcoded key.
The new caller input is generated with 24 random bytes; the Host credential
continues to be generated only by the original native credential store.

## Exact parent hooks

The leaf requires the actual cold component to expose:

```ts
component.selectRoom(roomId) // source consent only; called once before effects
component.openRoomLive(roomId, selection, { directory, signal? }) // real owner orchestrator
component.roomLive() // synchronous exact same-Storage/host registry getter
component.invoke(tool, args, signal?, callId?) // actual public dispatcher, stable ID preserved
```

`openRoomLive` must use the existing private actual authenticated session and
Room authority with `openOriginalMcpRoomLiveSession`; it must not accept a
supplied policy/transport/success callback.

`roomLive()` must return the actual installed
`getOriginalMcpRoomLiveSession(component.storage, host)` object. The helper
independently imports that installed module and checks identity.
It is a lookup/cleanup hook, not a new grant: keep it usable to locate
expired/revoked/closed selections without calling `proveHost`, `selectRoom`
or a fresh host-authority assertion.

The fourth optional stable UUID on `invoke` must propagate to the actual live
owner public route. The replay check will fail if the wrapper drops it. Do not
put that ID into the original public tool arguments.

Keep the existing principal/original-schema gates and route live Room tools
before generic durable public/Chat/usage argument capture. The owner performs
the actual native approval itself, redacting user-link input.

## Preparation and actual activation

In the coordinator, after CLI install and before the first actual editor:

```js
const live = await import(roomLiveLeafSourceUrl);
const credentialPreparation =
  await live.prepareInstalledNativeRoomLiveCredentials({
    root, installed, legacyVsix: fixture.legacyVsix,
  });
const callerInputEnv =
  live.installedNativeRoomLiveCallerEnvironment(credentialPreparation);
const credentialUi =
  await live.startInstalledNativeRoomLiveCredentialUi({
    root, installed, python, env, port: fixture.port,
  });
```

`callerInputEnv` contains a caller-originated transient input. Apply it only
to the actual editor launch environment; **never serialize it** into fixture
JSON, evidence, command arguments, process-environment snapshots or errors.
Do not treat it as data retrieved from native storage.

Set the existing `nativeRoom:true` fixture marker, and the parent's new
`nativeRoomLive:true` selection if desired. Keep this experiment independent
from leaves that revoke the attachment first.
In the cold wrapper, branch `nativeRoomLive` **instead of** the old status
preparation/verification branch; do not prepare the same Room twice or run
`verifyInstalledNativeRoom` first (its final status-bar revocation closes the
attachment).

In the fixture driver, before running/activating the actual target:

```js
const observer = live.observeInstalledNativeRoomLiveActivation({
  root: fixture.root,
  installed: fixture.installed,
  legacyVsix: fixture.legacyVsix,
});
```

This wrapper consumes/deletes the transient environment field and delegates to
the **existing actual** Production observer. It exports no context or
SecretStorage. Keep the existing runner wiring that awaits `observer.ready`
immediately after the actual `extension.activate()`; do not await it before
activation. Dispose it using the existing driver completion handling.
The caller environment can be supplied again to native reload/cold launch;
the existing observer must still not recreate previously created keys.

The owned credential UI checks the new hash/origin in the real native modal
and writes the existing status helper's `native-room-credential-ui-passed.json`
plus live-specific metadata. Only hashes and public provenance are persisted.

Use the same canonical source leaf URL in the coordinator/driver imports.
Do not copy this fixture helper into production exports or an alternate
installed activation API.

## Original writers, B0 and custody

After parent-confirmed **whole first editor exit**, create the existing
genuinely branded cold component fixture and original privacy policy:

```json
{"schema":1,"private":{"notes":["Chatroom Meetings"]}}
```

Then:

```js
const roomFixture = await live.prepareInstalledNativeRoomLiveFixture({
  root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
  credentialPreparation, python,
});
```

This calls the existing `prepareInstalledNativeRoomFixture` unchanged, preserving
its real-context evidence, Linux quiescence, pinned writer, Meeting and manual
private Note checks. It requires the observed native join hash to match the
caller's original requested-input hash. No key is read from SecretStorage to
construct a link.

Only then use the existing B0/custody/bootstrap and actual cold editor flow.
Do not change original Room/Meeting files under the adopted NativeRoot.

## Verify the actual installed live leaf

Run last, after ordinary Note/Skill effects and before component/editor close:

```js
const roomEvidence = await live.verifyInstalledNativeRoomLive({
  root, installed, component, sourceFixture: roomFixture,
  python, env, port: fixture.port, roomPort,
  directory: dedicatedShortEmptyPrivateDirectory,
  payloadBuildId,
});
```

`port` is renderer CDP; `roomPort` is the separately selected explicit loopback
Room port (1024–65535). The parent must choose it in the private fixture.
There is no automatic bind or fallback port. The directory is owned 0700,
canonical, empty, disjoint from the Root and short enough for three subdirectory
Unix endpoints. Parent owns removal of that directory.

The helper uses only genuine installed RootOwner/Storage/host/modules, the
actual owner resource registry and the actual public `component.invoke`.
It checks profile/identity/Host/catalog/build/custody binding and same Core/lease.
It does not start a second Hub/store/client supervisor.

### Three explicitly separate effects, never renewal

1. **Flow:** source consent; an effect denial with no live selection; a newly
   approved Host + exact tool effect + actual native network/participant/client
   confirmation; denied then approved public user-link join and same-ID replay; baseline/progress
   reads; denied then one exact original progress post; same-call-ID replay;
   actual leave/empty status; complete explicit close.
2. **Expiry:** a distinct new explicit Host/effect/network confirmation and
   public join; wait for its **real** effect deadline; verify actual listener
   cleanup, expired no-fallback refusal with the base host still live; explicitly
   close the expired tombstone before proceeding.
3. **Revoke:** a distinct new explicit Host/effect/network confirmation and
   public join; click the actual native Room source status control; require
   attachment/effect/listener cleanup and actual/cached public refusal.

There is one temporary client and at most one exact progress post **per effect**.
No effect is extended automatically. The UI driver permits Host proof only at
the explicit `open-*` stages. The helper never calls select/prove Host again
inside a current effect. Each invocation checks the current resource/digest
and fails if the 30-second window is exhausted instead of renewing it.

The final/default `chat_post` is intentionally refused as unsupported by this
bounded effect, with no new modal or mutation. It is not converted into a
progress post and no standby/final response is invented.

The caller constructs each public Magic Link only from its own original random
requested input plus the approved endpoint/Room metadata. No native key getter
exists. Raw links stay in local request memory; UI contracts, evidence, Core
calls/history and errors contain only digests/redacted metadata. The helper
checks actual Core journals for link/payload/input leakage.

The owned Playwright helper checks every real modal: source/custody is
no-execution; exact current effect/endpoint/profile/epoch/new temporary role;
native network confirmation matches the owner effect digest; public calls
retain original arguments/digests; join approval has only redacted input binding.
It records text hashes, not modal plaintext or secret environment values.

## Existing B1/fresh-B0 framework

After successful leaf verification, keep the parent sequence unchanged:
close component, require the **complete actual editor to exit**, preserve real
B1, perform typed retirement and restore B0 into its fresh Root. Then:

```js
const roomPreservation =
  await live.verifyInstalledNativeRoomLiveRestored(roomFixture, {
    retirement, restored,
  });
```

The verifier checks real receipt hashes/linkage/B0 identity, exact original
Room/Meeting/private manual Note bytes in B1 and B0, B1 SQLite integrity and
the exact actual canonical session/client/post/read receipts, native Host
admission, and no native DB/grant in fresh B0. Profiles/keys are not captured
or restored.

`native-room-live-passed.json` explicitly remains `b1AndB0Qualified:false`
until the parent combines the successful preservation result. No helper boolean
can substitute for the parent-built exact VSIX/editor/recovery run.

## Source checks and hold

```sh
python3 -I -B tests/framework/isolate.py node --test clients/vscode-host/installed-native-room-live.test.mjs
node --check clients/vscode-host/installed-native-room-live.mjs
node --check clients/vscode-host/installed-native-room-live-ui.mjs
```

Four focused checks pass for observer-prerequisite fail-closed behavior, copied
DTO/fake-callback rejection, explicit-effect/no-reproof UI planning, and Python
driver syntax/unsafe-start refusal. They do not fake a Production context or
SecretStorage and do not launch an editor.

Actual installed execution exposed a fixture function named `join` shadowing
the filesystem path helper. Renaming it, handling optional UI step kinds and
waiting for each actual modal title fixed the fixture; the same unchanged VSIX
then passed. No provider/engine approval or timeout was bypassed.

The installed pass qualifies this bounded loopback slice only, not full-ten/
full-151, remote/intranet bind, old identity/profile adoption or full cutover.
