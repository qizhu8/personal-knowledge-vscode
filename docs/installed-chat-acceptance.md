# Installed PKM Chat / selected v5 gateway acceptance

Run only this bounded Linux acceptance:

```sh
node tests/installed-compatibility-chat.mjs
```

It installs the unchanged `personal-knowledge-4.0.27.vsix` through the VS Code
CLI and checks SHA-256
`d9deb3f1664496342ee1397c78748cb020fdf65aac0978bbbb43b880d5d2f1be`.
The installed extension activates in **Production** mode; the separate fixture
driver does not replace VS Code APIs or the Chat controller.

The one scenario uses the real Electron/Chromium webviews and IPC:

1. Start native managed MCP, approve the native switch dialog, and verify the
   selected v5 compatibility gateway's connected version/build.
2. Start a Chat Task with Ask permission mode.
3. Approve **Run PKM add_note?** in the installed Chat.
4. Write and read `InstalledGatewayNote` through the original business adapter.
5. Open the installed Visualization Harness; verify recorded Check,
   complete End, and the validation linked to `installed-call-4`.
6. Send a held inference request; click actual Stop and verify HTTP abortion
   and the persisted cancellation.

**Real:** installed host, native MCP connection, browser UI, Chat executor,
approval, original Markdown effect/readback, native Session storage, Harness.
**Deterministic:** the loopback OpenAI-compatible SSE provider and synthetic
SecretStorage token. This does not qualify a commercial model/provider.
The existing configuration facade is used only to preprovision the managed MCP
manifest, not as the acceptance host.

Every run has a private, newly created user/network namespace with loopback
only, isolated HOME, user-data, extension installation and synthetic library.
The shipped retrieval wheel is installed offline with `--no-index --no-deps`
into fixture-local `offline-deps`; the existing test Python environment is not
modified. No live profile/library, credentials, provider network, Core/DB
migration, shared `dist` build, repackaging or repository commit is involved.
The fixture's CommonJS package boundary preserves the generated original
Markdown mutation helper's module format inside this ESM repository.

Prerequisites: Linux `unshare -Urn`, `ip`, `xauth`, `xdpyinfo`, cached VS Code
and Xvfb, Python Playwright and the existing business test Python dependencies.
Override editor/Xvfb with `PKM_PROFILE_CODE` / `PKM_PROFILE_XVFB` and business
Python with `PKM_TEST_PYTHON` if necessary.

Evidence is retained under `.pkm-test-evidence/installed-chat-<uuid>/`:
`accepted.json`, `native.json`, `host-evidence.json`,
`provider-evidence.json`, `browser-done.json` and two installed-workbench
screenshots. Successful runs remove the private installed package/profile,
staged gateway and dependency overlay after stopping their processes.
`chat-gateway-process.json` captures the actual running pinned gateway argv
and its `pkm-chat` attribution after the approved write; native fallback is not
accepted. Shipped 4.0.27 reports that attribution's scope as `unknown` without a
Chat ID, so the evidence does not claim a verified per-Chat attribution binding.
The persisted native Session independently identifies the owning Chat.
Failures produce `blocked.json`, editor logs and browser diagnostics without
claiming acceptance or silently retrying business writes.

Verified on 2026-11-20: the complete scenario passed using VS Code 1.143.0,
shipped extension 4.0.27 and selected gateway 0.1.0. This closes this installed
Chat/Harness acceptance gap only; it is not full migration or production cutover.

## Same-profile compatibility candidate

### Installed Settings live-switch qualification

Add `--bundled-gateway --settings-switch` to the same-profile command below.
The harness enables `PKM_COMPATIBILITY_LIVE_SWITCH=1` only in the isolated
candidate host. It opens Settings → MCP, cancels once, then approves Original
→ bundled v5 → Original in the real workbench modal. It verifies both live
relay instance IDs and the same Original library without reloading. Repair
probes are intentionally separate. In the same window, the fixture opens the
bundled Webview in Chromium, signs in, and searches for and opens the retained
Note on both backends. It verifies that the previous browser grant can no
longer read after each switch. The fixture then starts a second real
VS Code window under the same isolated account and root, with the flag
unset. That window must report custody unavailable and refuse native MCP
startup without replacing the owner's marker.

The diagnostic archive `f310657f…` passed this combined test, including
the visible draining phase in both directions. The browser check here
covers Note reads and grant revocation, not Chat Send/Stop; the separate
installed browser scenario passed those actions on the same archive.

The experimental switch requires a local, private root with an exact native
account binding. Settings status is passive: refreshing neither enrolls
the window nor changes the selected backend. During an approved switch,
Settings receives the authority's draining phase with the previously active
backend; the new backend is shown only after verification and selection.
Packaged cold stdio and live
relays arbitrate on the same root guard. A cold client cannot start while
a live owner holds custody, and a live owner cannot start over a running
cold client or its unconfirmed shutdown marker.

On clean host shutdown the live gateway stops accepting new work, waits
for admitted calls to finish, and confirms Original adapter exit before
releasing custody. A drain timeout leaves custody pending, with no replay.

There is no flag-free enrollment yet. A second window cannot attach, and
previous packages and direct Original clients do not participate in this
guard. The guard does not show that those clients have drained. Automatic
handoff and crash recovery are not qualified. Changing protocol dispatch
does not revert writes or migrate storage.

```sh
node tests/installed-compatibility-chat.mjs --same-profile-upgrade \
  --candidate-vsix=/absolute/personal-knowledge-5.0.0.vsix \
  --candidate-sha256=<exact-reviewed-vsix-sha256>
```

This mode runs the genuine 4.0.27 Chat/gateway workflow first. It closes the
predecessor normally and refuses to install while a fixture gateway or its
Original MCP is still visible. It then installs the same-ID candidate into
the *same* private profile, without editing the settings or reseeding
SecretStorage. The candidate must report its actual managed build through
live `pkm.check_version`, read the predecessor's Note through canonical
`pkm.capability_read`, and open the retained Note and Chat surfaces. Its
rejected repair must remove its own maintenance markers while keeping the
same reader available. This last assertion concerns scoped runtime
maintenance, not rollback of the Knowledge Root or an installed VSIX.

On 2026-11-25 the `bf99ea52…` candidate passed this fixture. Connected
`check_version` reported Original `2.19.0` with build `73f4be37…`, distinct
from the predecessor's Original and v5-gateway builds. The rejected repair
left the same connection instance accepting and able to reread the Note;
an independent wrong-component gateway test also left its Original reader
available. Post-upgrade Chat evidence is reopening the predecessor Chat,
not replaying the predecessor model/tool sequence in the candidate.

The 4.0.27 gateway switch and the 5.0.0 managed generation are different
milestones. The latter remains on Original storage and does not carry the
selected predecessor gateway forward: the candidate's standard
`registerNativeMcpProvider` uses `mcpServerDefinitionData(true)` and its Chat
constructs the Original runtime independently. Reusing the gateway in the
candidate requires a single verified target authority shared by these two
launch paths, an owned drain/rejection path, and an installed compatible
candidate. A separately staged gateway or `_personalKnowledge.legacyRootUpgradeStatus`
is not that authority. Settings must not offer a production switch until it
exists. Original-root adoption additionally needs independent qualification
of all writers, custody, recovery and rollback.

### Bundled compatibility gateway candidate

Use the same command with `--bundled-gateway` to qualify the default
Linux route. This mode starts genuine 4.0.27 on its Original managed MCP,
creates a Note through its installed Chat and approval UI, then closes it
before installing the same-ID candidate. It does not repeat the separate
4.0.27 hot-switch/Harness/Stop scenario above. The candidate must expose
the existing `mcp_pkm_check_version` tool, identify the bundled v5 gateway
with an Original backend, and read the earlier Note from both native MCP
and the reopened Chat. The fixture requires unchanged settings and root
identity and the same pinned selection for the two stdio clients.

The `44e31ace…` candidate passed VSIX verification and the native half
of this acceptance: live `mcp_pkm_check_version` reported gateway build
`e70e96a1…` with Original storage, native `capability_read` read the
predecessor Note, and rejected runtime repair preserved the same reader
and released both scoped markers. The preceding `e278b3f1…` build
initialized, but VS Code registered its tools as `mcp_pkm-v5_*` because
its MCP initialize response used `pkm-v5`; the corrected bundled route
explicitly uses the `pkm` wire name. The separately launched facade
keeps its existing identity.

The same `44e31ace…` VSIX subsequently passed both clients and restart
(`installed-chat-a887e165…`). The test separates native Note read from
sidebar focus, discovers the owning workspace Host through
`api_chat_capabilities`, and calls the shipped same-user Chat IPC client
once. The installed Host admitted the request, executed a model turn,
read the original Note via Chat's `pkm` connection, and returned a
terminal `succeeded` receipt. The two stdio clients used the same pinned
gateway generation and build. After normal editor closure and confirmed
exit of old stdio clients, the same profile reopened, reported the same
build in a fresh generation and instance, and read the Note through
native `pkm` again.

A separate incompatible Original-component start was rejected while the
same Original reader stayed accepting and could still read its Note.
Neither test qualifies installed rollback, production hot switching,
the native VS Code mutation path for Chat submission, or storage
migration. The full legacy package test suite was not green in the
shared build environment.

For the owner-side transcript probe add `--browser-transcript` to the bundled
gateway fixture. It binds the installed Original Chat Shell directly through
`bindBrowserChatTranscript(grant, assertCurrent)`; production browser
activation is separate. The trusted route supplies the same authenticated
actor, root, generation and live Chat Host ID for each call. The owner asks
for native consent before releasing the exact Chat's stored text, then pages
in chronological order, 1–20 entries and at most 512 KiB of serialized
messages per page. It refuses oversized single messages rather than clipping
them; PKM Chat still displays those locally. Only `id`, `role`, `content`,
`status` and optional `recordedAt` are returned. Continuation cursors expire
after two minutes and cannot cross a Chat, bound reader or transcript change.
This callback is not advertised as an MCP operation and grants no remote writes.

The transcript probe passed in isolated Linux VS Code 1.143.0 fixture
`installed-chat-28420905-e61c-4427-83e4-afcf986ea114` with candidate VSIX
SHA-256 `5e87c958f097b8f6b6aafbf2fc109d12bda02b98e36a4a77b9cc915809441cce`.
After upgrading from the genuine 4.0.27 predecessor in the same profile,
the live owner rejected an arbitrary host ID and unrelated Chat ID, then
returned both predecessor messages in order across two pages after the actual
VS Code **Share transcript** modal was accepted. The fixture adds a capture-only
hook to the disposable installed shell module to obtain the in-process callback;
it does not alter transcript authority, consent, or storage. This is not a test
of a production browser endpoint. Native MCP and Chat still passed against the
bundled gateway, and native MCP read the predecessor Note after restart.

The candidate's `_personalKnowledge.pkmCompatibilityRouteStatus` reports
`pending`, `selected`, or `unavailable`, with the selected generation,
gateway version/build, and Original build when known. `selected` is a
cold launch selection, not evidence that either client is connected.
There are no switch candidates or switch command in this slice. Manual
registrations and managed-writer sessions are out of scope. Original still
owns storage; this neither authorizes cutover nor qualifies Next writer
adoption.

## Separate native high-level Chat candidate

The experimental host has a separate bounded installed acceptance:

```sh
node clients/vscode-host/installed-test.mjs --native-identity --native-models \
  --vsix <reviewed-native-candidate.vsix> --evidence <private-evidence.json>
```

On 2026-11-20 an isolated candidate passed genuine native model RPC execution
through 31 tool rounds, exact high-level model resolution, create consent,
read-only Chat binding presentation, cancellation and rejection of a late
approval. Rendered Monaco text is checked using an exact normalized Playwright
text locator, rather than raw DOM whitespace.

The registered native provider remains deterministic and SecretStorage uses a
test-only basic password store. This does not qualify production providers,
keyring, a restored editable Chat UI, source-context migration or full native
storage ownership. The candidate was not installed into the user's profile.

An earlier run lost its attachment during round 23 under the fixture's
two-second heartbeat deadline. A later complete pass does not resolve that
stability failure. Heartbeat deadlines and fail-closed behavior are unchanged;
attachment abort reasons distinguish heartbeat expiration from generic
revocation, and local native Chat RPC errors preserve the cause without
replaying work. Both stability investigation and combined-package
qualification remain required before production deployment.

A subsequent transport-only correction uses monotonic heartbeat deadlines, so
wall-clock adjustments cannot falsely revoke a live attachment. Expiration
retains the configured threshold and reports elapsed time and owner-timer
overshoot as the RPC abort cause. The coupled transport suite passed 26 cases.
This change is newer than the installed candidate described here and requires
the next coherent package qualification; it does not explain the initial
two-second installed stall.

The subsequent coherent native candidate also passed separate installed Action
enable, no-execution source review, exact invocation review, cancellation with
a rejected late click, and actual status-bar revocation over the same signed
request lane. The independent native model channel remained usable. Source
descriptors and invocation receipts were synthetic: this is control-plane
qualification, not Core-owned Action endpoint, source import or business
execution qualification. Both the signed Action methods and experimental
enable command are shipped only in the reviewed candidate, not the live 4.0.27
profile.

## Installed Todo source plus cold recovery

The coherent native candidate also passed `--native-identity --cold-component
--native-source --legacy-vsix <pinned-original-4.0.22.vsix>`. It uses real
original-writer Board/task bytes, independently sealed enrolled profile
identity, native source denial/approval/status-bar revoke and the actual
same-owner cached Core. Revocation denied cached access without losing the
RootOwner lease; no old worker token was accepted.

Only newly created disposable fixtures enter this workflow. Its private
PID/mount/network namespaces and local procfs keep the test process inventory
contained, without modifying the production global writer check. The actual
editor must exit before both initial capture and B1 preservation. Real
Note/Skill changes, complete B1 retention, typed retirement and fresh disjoint
B0 restore passed; original Todo bytes were verified after restoration.
The initial B1-before-editor-exit harness ordering was rejected by the unchanged
guard and fixed in the driver rather than bypassed.

Candidate SHA-256:
`1d3b50ade853f5b1bb65d4e057b7d152a8e0953b9817da65a7483d0789ea2804`.
This is not production-root takeover, actual keyring restore, installed live
Memory/Chat source selection, Recipe execution or installed Todo assignment.

The subsequent independent `--native-memory` cold scenario does qualify the
bounded installed live Memory/Chat path: actual original Engine/ChatStore
preparation, signed source decisions, explicit scope/query, real native
deterministic provider and canonical `get_document`, transcript/readback, and
revocation across a pending native model approval. The late approval reaches
neither provider nor tool. Host/Chat source/RootOwner remain live; B1/fresh B0
restoration passes after whole-editor exit. Its separate candidate SHA is
`b93c12581836afe2f63375b3db1c2ead266edabc796fec6956673869aab1e924`.
See [installed-native-memory.md](./installed-native-memory.md) for precise
scope and inputs. It does not qualify production providers, physical Memory
erasure, managed-goal/delegation parity or full storage takeover.
