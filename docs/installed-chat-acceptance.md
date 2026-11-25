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
