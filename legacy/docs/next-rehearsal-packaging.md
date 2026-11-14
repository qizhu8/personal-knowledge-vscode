# Experimental next-server packaging rehearsal

The opt-in VSIX has the separate identity
`pkm-experimental.pkm-next-rehearsal`, not `Uone.personal-knowledge`.
Its manifest has **no extension entry point, activation events, commands,
configuration, MCP provider or extension dependencies**. It cannot replace or
activate the production extension. The production VSIX keeps its stable identity
and now includes a fixed `next-runtime/` payload, but excludes `next-server/`
sources. Inclusion does not switch the existing service or authorize migration.

This is **not a production installer or migration/cutover mechanism**. It
contains a pinned payload for a narrow offline-import and read-only HTTP
rehearsal, not a feature-complete host. Do not use real Knowledge Roots.
The SHA-256 manifest detects accidental changes but is not a signature and does
not authenticate an attacker-controlled manifest.

## Packaging and validation

With existing TypeScript and next-server production dependencies, Python 3 and
VSCE already available, run the focused test from the repository root:

```sh
node --test tests/test-package-extension-routing.js tests/test-next-rehearsal-package.js
node --test tests/test-next-production-payload.js
```

The test builds in a project-local isolated directory, uses the actual VSCE
packaging path, validates both VSIX identities and every runtime file, rejects
missing/extra/modified payloads and a production identity, and tests explicit
errors for missing Python and Node dependencies. It executes an import plan from
the installed runtime; an independently extracted payload also imports a synthetic
copy and runs Note inventory and HTTP. Node module guards reject repository
fallback. If an existing cached VS Code or `PKM_VSCODE_EXECUTABLE` is available,
the VSIX is installed, listed and uninstalled using fresh project-local user-data,
extension, home, cache and temp directories. No user profile or installed
extensions are used. Without a usable CLI, the installation subtest is skipped.

To produce the distinct archive without running the shared production build:

```sh
node scripts/package-next-rehearsal.js
```

This produces `pkm-next-rehearsal-<version>.vsix`. Alternatively,
`PKM_PACKAGE_NEXT_REHEARSAL=1 node scripts/package-extension.js` uses the
same path. `npm run package` still runs the existing full production build and
test gate first; coordinate it with other work before using it. The isolated
builder refuses missing dependencies; it never installs packages.

The production `scripts/package-extension.js` stages a freshly compiled payload
at `next-runtime/`, checks installed production package versions against the
next-server lockfile, builds the VSIX, and requires archive inventory, content
hash and extension/server version agreement before success. Direct VSCE runs
without a staged payload fail in prepublish; use the package gate. The host can
call `verifyNextPayload` before starting `server/dist/managed-client-child.js`.
The manifest is an integrity/consistency check, **not an authenticity signature**.
The host must select a compatible local Node, and missing dependencies must
disable only the opt-in next path; no runtime download is performed here.

The production payload includes `server/dist/cli.js` and the legacy import
implementation and dependencies. The production-payload test extracts an actual
VSIX built from a synthetic production-identity fixture, validates its payload,
then executes `import-plan`, digest-pinned `import`, and `import-status` against
a disposable Linux source with Node module-resolution guards. It is not a test
of a production VSIX install or a real user's data. The production extension's
opt-in trial can initialize an empty workspace or import an explicitly selected
static legacy copy using the displayed plan digest, then attach the audited copy
read-only through private IPC. This does not authorize production cutover.

### Read-only Prompt and Script access

After importing a dedicated static copy, use **PKM: Browse Isolated Prompts
Read-Only** or **PKM: Browse Isolated Scripts Read-Only**. The paginated inventory
retains original paths, Prompt project/task/version coordinates, file modes,
empty directories, Script identity sidecars and aliases. Aliases are not an event
log; Prompt version folders do not reconstruct edit history. A Script without a
sidecar remains explicitly `unassigned`: browsing does not generate identity.

Details bind the selected entry, snapshot revision and SHA-256 digest; files are
read in 64 KiB chunks, verified completely and shown in an untitled **plaintext**
document. Binary files use hex. The preview refuses files larger than 1 MiB
without requesting their contents. Templates are not rendered, scripts and
Actions are not executed, and the preview neither saves source files nor grants
execution authority. Read failures are not automatically retried.

The real Linux Electron acceptance uses a project-local synthetic legacy root,
fresh VS Code profile, independently compiled extension and production payload,
and a private network Xvfb display:

```sh
npm run test:next-trial:electron
```

It requires the existing cached VS Code and Xvfb (or the explicit
`PKM_VSCODE_EXECUTABLE` and `PKM_TRIAL_XVFB` paths), `unshare`, `ip`, `xauth` and
`xdpyinfo`; it does not download tools. It exercises Prompt pagination and
versions, original-storage metadata/alias projections, Script assigned and
unassigned identities, binary/chunked bytes, read-only IPC, clean close/resume,
and unchanged source/target library bytes. Existing Board, Research, Skill,
Recipe, resource, CAS, tamper-refusal and drain checks also run. A saved
`isolated_experiment` credential enables restart only for synthetic data or a
dedicated copy; external writers remain **unknown**. This acceptance is not a
real-root migration, production installer qualification or production cutover.

### Inert Packages, Actions and Components

**PKM: Inspect Isolated Inert Code Archive Read-Only** uses the same pinned
library inventory and chunked preview for Packages, Actions, Components and
Action module sets. Logical paths retain their original names; preserved bytes,
modes, hidden files and empty directories live under private
`legacy-code-archive/`, never active runtime roots. Files are shown as plaintext
or hex, not loaded as modules. Manifests and specifications remain opaque data.

The **Action state history (archive_only; not current runtime state)** option
also exposes original `.pkm/state/actions/**` bytes under logical
`action-state/**`, physically `legacy-code-archive/action-state/**`. Original
authority, grants, approvals and run records are historical evidence only:
none are inherited or interpreted as current runtime state. The preview shows
the original source coordinate and explicitly labels authorization
`not-inherited`. No native `.pkm/state/actions` authority is restored.

This is **not installed / execution not authorized / runtime not verified**.
No catalog registration, installation, trust grant, effect grant or execution
occurs. Existing trusted-workspace automatic Action trust policy is unchanged;
it neither activates the archive nor bypasses effect permissions. Notes, Skills
and Research retain their separately authorized isolated editors; Boards,
Recipes, library data and assets remain read-only.

The private-display acceptance verifies archive previews before and after clean
restart, exact bytes and modes, unchanged source, and rejection of stale
snapshots, wrong digests, traversal, physical archive paths and unsupported
install/execute/register/grant operations. `npm run test:next-trial:prepare`
only stages an isolated fixture; it is not Electron acceptance. Real-user root
migration remains unauthorized; external-writer coverage remains **unknown**.
The fixture includes nonempty historical Action authority/grant/run files,
hidden and binary state, and an empty directory, all verified read-only before
and after restart with source bytes, modes, inode, modification times and
directories unchanged.

After isolated installation, run the packaged `next-runtime/check.cjs` with an
absolute Python interpreter path under Node >=22.18:

```sh
node /absolute/isolated-extension/next-runtime/check.cjs /absolute/python3
node /absolute/isolated-extension/next-runtime/check.cjs /absolute/python3 \
  --probe-parent /absolute/disposable-directory
```

The optional Linux probe **creates and removes a uniquely named fixture** inside
the explicitly selected directory. Choose an empty disposable directory on the
same filesystem as the planned destination; never use a real Knowledge Root.
It executes `renameat2(RENAME_NOREPLACE)`, tests an occupied-target collision and
directory `fsync`. A symbol-only interpreter check cannot prove the kernel,
filesystem, permissions or policy permits those operations. Neither probe checks
free space, quiescence, power-loss guarantees or source compatibility.

### Linux prerequisites and limits

* An externally installed **Node >=22.18.0** with working `node:sqlite` and
  its OS shared libraries. The VS Code embedded Node is not assumed to qualify.
  The package includes the production Node dependency closure pinned by file
  hashes, not the Node executable.
* An absolute **Python >=3.10** with the standard library, including `ctypes`,
  `sqlite3` and `pathlib`; the compatibility adapters also invoke `python3` on
  `PATH`, which must itself be >=3.10. These interpreters and system libraries
  are not delivered in the VSIX. The narrow import/read-only fixture needs no pip
  packages. Other paths need Python packages such as FastMCP and model packages;
  they are not installed or claimed as available merely by bundling resources
  and vendored wheels.
* Linux libc must expose `renameat2` and the target kernel/filesystem must accept
  `RENAME_NOREPLACE` for directory publication; source stage and target must be
  on the same filesystem. The destination must be absent. Directory `fsync`,
  ordinary create/write/remove permissions and sufficient disk space are needed.
  No non-atomic or cross-volume fallback is claimed.

The synthetic Linux fixture exercises a stale-plan rejection, import, status,
authenticated native Note read, original inventory adapter, CLI backup, and
relocated restore using **test-only explicit native restore authority**; it checks
Notes, Skill, Paper, Prompt and asset bytes. It is not a production authority or
an end-user restore UI. The VSIX is installed and uninstalled only in a fresh
profile. Windows native qualification, complete legacy dependencies, production
client integration, full parity, signed releases and real-root cutover remain
outstanding.
