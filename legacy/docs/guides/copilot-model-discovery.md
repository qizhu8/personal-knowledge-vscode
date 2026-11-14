# Copilot model discovery and startup

The Chat model picker separates **Copilot Models (Raw Model)**, called through
VS Code's Language Model API, from **Copilot SDK (Agent mode)**. An SDK Auto entry
is a real service-routed model from the SDK catalog, not a local fallback model.
Catalog-only Copilot CLI entries are not callable raw models.

The picker can display its loading state while the two catalogs are requested
concurrently. Passive SDK discovery does not request GitHub consent. Use
**Connect Copilot SDK** to explicitly sign in or grant access. SDK discovery uses
the runtime bundled with the running VS Code installation, including the remote
server installation when applicable; it does not install a CLI or substitute a
hard-coded catalog. Failed SDK discovery does not remove available raw models.

Runtime selection checks installed platform packages, without generating a
`process.report` in the extension host. PKM's runtime path checks, private storage
creation, and removal of interrupted session transcripts use asynchronous I/O.
Concurrent callers share one bootstrap, and failed startup is cleaned up before
a later connection retries. Shutdown during bootstrap prevents an orphan runtime.

Cancellation interrupts catalog discovery even while GitHub permission access,
runtime startup, or the catalog RPC is pending. A cancelled discovery does not
update the model cache or issue a late catalog RPC after startup. Cancellation
does not forcibly close VS Code's sign-in dialog or kill a shared runtime that
other Chats may use.

## Remaining startup limitations

- The bundled SDK is still imported using CommonJS `require`, synchronously in
  the extension host. PKM yields before importing it, but this is not worker
  isolation: the import and SDK-internal synchronous work can briefly delay the
  host. Runtime process startup and network/model-catalog latency also remain.
- The picker may stay in its cancellable loading state while a provider or
  sign-in service is unresponsive. There is no fabricated catalog or implicit
  permission bypass to make discovery appear successful.
- VS Code normally ships one matching Linux libc runtime package. Installed
  glibc packages are checked before musl packages; PKM does not diagnose libc
  compatibility by collecting a process report.

Focused regression test (requires an existing `dist` build for unchanged shared
dependencies; the changed modules are compiled in memory):

```sh
node --test tests/test-copilot-sdk-responsiveness.js
```
