# Linux state/config protection (experimental)

This tool protects explicitly selected legacy state as opaque local bytes. It
does **not** perform a live restore, migration, MCP switch, or credential/keyring
recovery. Build the current runtime first (`npm run build`); Node 22.18+ and
Linux/Python 3 are required. No services are terminated.

## Managed runtime retirement is not data recovery

`managed-migration.mjs` prepares and verifies immutable candidates before
`publishIsolatedManagedGeneration(root, generation)` switches the active pointer.
Publication requires the same durable workspace and compatible protocol/component
pins. `inspectIsolatedManagedRuntime(root)` exposes candidates, process leases and
durable transition history. `cleanupIsolatedManagedRuntime(root)` removes inactive
runtime bytes only after their launcher/staging processes exit; it never terminates
clients, deletes workspace data, or rewinds a database. Live clients therefore
appear as pending cleanup until they drain and disconnect. The first-publication
baseline remains metadata, not a permanent binary retention pin.
Publication and launch admission currently require Linux/Python 3 advisory locks;
the kernel releases them after a process crash. Other platforms fail explicitly.
Do not delete the persistent `.migration-publication-guard` file while running.

Separated workspaces place the managed server under `runtime/managed-server`.
Flat/adopted workspaces retain their explicit existing boundary; nested runtime
installation is not silently admitted there. Candidate staging defaults to an
8 GiB byte budget with 64 MiB free-space headroom on the destination.

Native model selection preserves immutable admissions, selection/learning history
and retirement receipts while retiring unselected model files. Interrupted cleanup
resumes under the workspace writer lease. Selecting an already retired package
requires explicit verified source readmission: historical receipts are not model
backups. Embedding-index activation atomically retires previous vectors, preserving
small retirement checkpoints; scoped derived reset never removes core SQLite or
durable user state. Reversing runtime versions is supported only while compatibility
holds and the selected binaries remain installed or are explicitly restaged.

## Request and commands

Create a **0600**, local JSON request (never put credentials in command arguments):

```json
{
  "schema": "pkm.cold-state-request/v1",
  "originalRoot": "/absolute/original-library",
  "externalDirectories": [
    { "id": "remote-pkm", "path": "/absolute/PKM-globalStorage-directory" },
    { "id": "client-profile", "path": "/absolute/identified-client-profile" }
  ],
  "configurationFiles": [
    { "id": "machine-settings", "path": "/absolute/Machine/settings.json" }
  ],
  "fileLinks": [
    {
      "path": "/absolute/PKM-globalStorage-directory/retrieval/serving-release.json",
      "target": "/canonical/exact-serving-release.json"
    }
  ],
  "opaqueLinks": "refuse"
}
```

The fixed original scopes are the **entire** `.pkm`, `chatrooms`, `mcp-server`,
and `knowledge.db` plus `-wal`, `-shm`, `-journal`. Every explicit external
directory is included in full, without filename/content exclusions. Explicit
configuration files also include those three sidecar paths. Missing paths are
recorded, not silently skipped. At least one external directory must be
explicitly supplied; the tool cannot discover/prove all local VS Code profiles.
Overlapping selections and unknown request fields are rejected. Do not select
an entire profile and separately select a configuration file already inside it.
Run from outside **all** selected roots. A shell/coordinator with its working
directory inside the library is itself a blocker; parent processes are not
exempted.

```sh
CONTROLLER=/absolute/pkm-v5/experimental/cold-state-recovery.mjs
cd /
node "$CONTROLLER" plan /absolute/request.json
node "$CONTROLLER" capture /absolute/request.json "$HOME/.local/state/pkm-v5-recovery/new-capture"
node "$CONTROLLER" verify "$HOME/.local/state/pkm-v5-recovery/new-capture" MANIFEST_SHA256
node "$CONTROLLER" restore "$HOME/.local/state/pkm-v5-recovery/new-capture" MANIFEST_SHA256 "$HOME/.local/state/pkm-v5-recovery/new-restored-copy"
```

Keep the returned manifest SHA-256 independently of the capture. `verify`
requires this exact pin, not a hash read from the same untrusted directory.
`plan`, successful `capture`, and successful `restore` exit **2** with
`readiness:"not-ready"`; failures exit **1**, successful byte verification exits
**0**. CLI output contains summaries/hashes, never configuration values, rows,
transcripts, link text, or secret values. Capture paths and request/manifest
metadata are private too.

The module exports async `planColdStateRecovery(request, options?)`,
`captureColdStateRecovery(request, newCapturePath, options?)`,
`verifyColdStateRecovery(capturePath, independentManifestSha256)`, and
`restoreColdStateRecovery(capturePath, independentManifestSha256, newPrivatePath)`.
There is deliberately no `cold:true`, authority callback, PID exemption,
process-killing option, overwrite option, or active-original restore API.
The only API option is `{writerFence}`: an already-held, same-module branded
`LinuxRootWriterFence` for exactly `originalRoot`. It is checked repeatedly,
never reacquired, replaced or released by this controller, and never exempts
any writer inventory check. The caller retains it for its canonical owner
handoff and remains responsible for release; a look-alike object is rejected.
This optional root fence does not create external-profile/global cold authority.

## Guarantees and remaining authority

* The existing Linux legacy-writer gate must pass for the original root, every
  external directory (or its existing ancestor when absent), and configuration
  parent directories, before copying and on repeated checks. An active writer
  or uninspectable process refuses capture. No test fixture flag substitutes
  for this gate.
* These process observations **are not a shutdown lease**: a writer could start
  between observations. Consequently this controller never issues global cold
  authority or claims cross-domain atomicity. It records
  `global-shutdown-not-proven`; integration must obtain independent stronger
  shutdown authority before treating these bytes as a cutover baseline.
* Identity/size/mtime/ctime inventories before copying, streaming copy hashes,
  a second full source-hash inventory, and full payload closure checks must
  agree. One source attempt is made, with no automatic retries. Source reads
  never open SQLite or use `immutable=1`; captured databases include raw
  sidecars. SQLite integrity/recovery runs only on separate validation copies
  during capture and restore, never on the protected raw payload.
* Destinations must be brand-new direct children of the canonical
  `$HOME/.local/state/pkm-v5-recovery`, outside the original/selected sources,
  checkout, and session-state paths. Descriptor-based no-follow traversal,
  owned 0700 directories/0600 files, ancestor ACL/group checks, fsync, and the
  existing atomic no-replace primitive protect publication. No original file
  or mode is changed. Recovery streams bytes; it does **not preserve inode
  identity**, and does not restore source ownership, permissions, timestamps,
  ACLs or extended attributes. Original stat metadata is retained in inventory.
  This is explicit byte-state protection, not a complete filesystem-image
  backup or proof of credentials recoverability.
  Verification/restore retain the capture's bound Linux home/private-base
  policy; relocation to another account/home is not qualified by this API.
* JSONL inventories and 1MiB I/O buffers avoid loading database/history bytes
  or entire inventories into memory. A single directory is limited to 200,000
  children, depth to 128, inventory lines to 64KiB. Unsafe paths, hardlinks,
  special files, unknown shapes, and changed sources fail closed.
  There is **no per-file or aggregate source-byte limit** imposed by this
  recovery tool, and no 512MiB/20,000-entry import limit. Byte totals use BigInt;
  filesystem capacity still limits capture, restore and separate SQLite
  validation copies. Request/manifest JSON reads are limited to 4MiB, and each
  external/configuration/file-link request list to 32 entries.
* Optional `fileLinks` binds exact selected symlink paths to exact canonical
  regular-file targets. The absolute link text must equal `target` byte-for-byte.
  Link and target identities are checked before/after, target bytes are hashed
  before/after copying, and target parent directories join the writer gates.
  If already covered by one selected scope the target is reused; otherwise
  exactly that one file is added as `link-target-N`. No directory is followed
  implicitly, and directory targets, chains, cycles, duplicate/ambiguous
  bindings and hardlinks refuse. A standalone SQLite target also needs its
  sidecars covered by explicit selections; approval does not grant access to
  unrelated neighboring files. Approved target bytes are materialized at their
  own payload location, **not flattened onto the original symlink path**.
  The private `file-link` inventory row retains original link text/identity and
  the target identity/hash/location. Verify and fresh restore check both this
  mapping and materialized target bytes without reopening original sources.
  They do not recreate symlinks or claim inode/filesystem-image preservation.
* All other symlinks refuse by default. Explicit `opaqueLinks:"metadata-only"` retains
  exact link text in the private inventory, never follows or materializes the
  link, and reports incomplete target closure. If SQLite is present, opaque
  **unapproved** target closure prevents database qualification and capture
  refuses. Approved, fully bound regular-file links do not cause this refusal.
* Failed/interrupted `.NAME.partial-UUID` stages are retained for review; they
  are never ready baselines, even if a publication race left completion bytes
  inside them. Verification rejects partial directory names. Nothing captured
  is automatically deleted. Successful captures also remain **not cold-ready**.

The restored layout is `payload/<scope-id>/...` (file scopes use the scope ID
as the filename), with `inventory.jsonl`, `manifest.json`,
`sqlite-validation/db-N/`, and `restore.complete.json` alongside it. Absent
scopes have no payload entry. A restore completion record is not a capture
completion record and cannot be fed back as a verified capture. Never copy
these files over live original paths using an external overwrite command.

Focused regression: `tests/cold-state-recovery.test.mjs`, run using the existing
Linux framework isolation with its workspace parent set beneath the private
recovery directory, not `/tmp`. Fixtures exercise the real writer inventory,
WAL recovery, explicit absence, config/history bytes, pins/corruption,
no-overwrite publication, approved/unapproved links, target/link changes,
retained real fences, source changes and interrupted stages. From the checkout:

```sh
TMPDIR="$HOME/.local/state/pkm-v5-recovery" node tests/framework/run.cjs --file tests/cold-state-recovery.test.mjs --no-build --jobs 1 --json
```

For a persistent synthetic JSON report at an explicitly printed private path:

```sh
node --input-type=commonjs - <<'JS'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),{executeSuite}=require('./tests/framework/workspace.cjs');
(async()=>{
  const repositoryRoot=process.cwd(),base=path.join(os.homedir(),'.local/state/pkm-v5-recovery');
  const stat=fs.lstatSync(base);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('Unsafe recovery test parent');
  const parent=path.join(base,'controller-tests-'+randomUUID());fs.mkdirSync(parent,{mode:0o700});
  const result=await executeSuite({name:'cold-state-recovery-focused',command:[process.execPath,'--disable-warning=ExperimentalWarning','--test','--test-concurrency=1','tests/cold-state-recovery.test.mjs'],timeoutMs:180000},{repositoryRoot,temporaryParent:parent,reportDirectory:parent});
  process.chdir(parent);fs.writeFileSync('result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({report:path.join(parent,'result.json'),outcome:result.outcome,cleaned:result.cleaned}));
  console.log(result.stdout);if(result.stderr)console.error(result.stderr);
  if(result.outcome!=='passed')process.exitCode=1;
})();
JS
```

The framework sets a private fixture workspace; the test process binds its HOME
inside that workspace. The runner retains only its synthetic `result.json`
under the printed unique private parent; successful fixture workspaces are
removed. This test arrangement grants no production authority.
