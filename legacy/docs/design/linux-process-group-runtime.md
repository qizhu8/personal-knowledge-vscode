# Linux managed process groups

The original API Chat `run_process` uses the Chat's trusted workspace and tool
permission flow. Background runs additionally require durable-run approval, a
deadline and an idempotency key. `process_get`, `process_output` and
`process_cancel` operate on that Chat's evidence directory; cancellation goes
through tool permission. The local Chat `processControl` UI calls
`getChatProcess`, `pauseChatProcess`, `resumeChatProcess` or
`cancelChatProcess`; Stop requires confirmation, and remote/agent-controlled
Chats cannot use those controls. Chat Stop requests cancellation of the
owning Chat's earlier background runs. The old supervisor uses a POSIX process
group, not a kernel-enforced process tree.

Next's `RuntimeProcessService` defaults to its existing direct-child scope.
A trusted native host may explicitly configure `linux-process-group` for an
already allowlisted adapter; this does not add a public launch operation or
accept executable paths, PIDs or signals from a process-control request. The
Workflow process bridge additionally requires an explicit host command
configuration with `directChildOnly: false` and this scope. Its native
`pause(actorId, runId)` and `resume(actorId, runId)` control only one
unambiguous active job owned by that actor; the existing Workflow cancel path
requests cancellation. These methods are a native host boundary, not a new
remote permission or an installed Chat UI.

An explicitly composed private native Chat host can route managed Chat
`run_process`, `process_get`, `process_output` and `process_cancel` through
`LegacyApiChatProcesses`. A dedicated database binds each idempotent handle
to the host actor, source, namespace and Chat. The host must supply an exact
command/cwd/argument allowlist, owner fence and separate asynchronous
authorization callback and separate private capture directory; model input cannot grant execution. The existing
native experiment webview sends `processControl` to that private host with
Chat/workspace checks and Stop confirmation. Managed Task cancellation also
requests cancellation of that Chat's earlier jobs. It reports partial errors
after attempting the other jobs; a Task control can already have committed
when process cancellation fails. These ports are disabled unless explicitly
composed, and no default installed host or real user approval is supplied.
`createLegacyChatProcessApprovalBridge` is an injectable boundary for a future
owner: it requires the owner fence, live Chat policy, real user permission
request and local Stop confirmation callbacks. It mirrors the old Chat
protective/ask/read-only/allow-all decisions, Chat/window-scoped grants, and
fresh one-shot background approval. It rechecks authority after a user decision
and responds to cancellation. The port is not a user interface, and wiring a
test callback is not production approval. `createOwnedLegacyChatProcessHost`
combines an explicitly supplied Storage owner, Chat source, process adapter,
and in-memory approval broker; it does not establish that owner. The native
experimental UI polls pending approvals and requires a separate local Stop
confirmation. Remembered approvals must be committed by the owner under its
own live fence; the broker's subsequent recheck cannot undo a stale write.
These are opt-in ports, not a production adoption or a Portal command grant.
`startOwnedLegacyChatProcessUiHost` additionally composes this owner with the
managed Chat HTTP host and checks the caller's live selected-owner fence
before and after asynchronous Chat admissions. It has no installed caller;
the only current full composition is an isolated test. Neither this factory
nor the experimental webview provides a production owner or switches paths.
`startManagedClientSelectedOwnerChat` is an explicit embedding entry through
the managed host's selected-owner capability. It registers Chat as an owner
child before startup, rechecks the supplied profile fence, and drains it on
connection abort or managed-host shutdown. The matching
`registerSelectedOwnerChatUi` accepts only an explicit live binding and
connection, verifies the host identity and process-approval capability, and
reuses the existing Chat renderer and user approval cards. It registers a
separate `personalKnowledge.nextSelectedChat` view and container, hidden unless
an explicit owner is live; disconnect or a failed authority check disposes it.
It does not replace the original Chat view. Neither entry reads a fixture grant or
registers itself by default. Attachment, Recipe and Todo authority are not
supplied by this composition.

The shared native Chat provider commits a new selection only after its history
loads. Failed or superseded navigation retains the previous Chat and cannot
dispatch another request while selection is pending. A Todo-associated Chat
opens as an unsolicited state update, not as a fabricated renderer navigation
receipt. These fixes do not enable default routing or original-root ownership.

The ordinary Chat shell also accepts an explicitly supplied owned view backend.
That path attaches the existing renderer without registering the legacy Chat
agent-control writer; unsupported legacy Portal and host operations fail closed.
The selected-owner adapter validates the live binding and delegates draining to
its owner. A forked-owner test exercises the ordinary shell against an imported
4.0.22 Chat, but the original-root Chat owner, cross-host handoff and full
workflow authority are not available. Normal activation supplies no owned backend;
this interface is not an adoption gate or permission to switch production.

An experimental in-place adoption can now pass its **live, same-process**
`Storage` to `startManagedClientHostFromAdoptedRoot`. It checks the actual
lease, canonical root and workspace binding and claims that Storage once.
The host drains registered Chat children before releasing Storage; failed
drain permanently closes admission and retains the lease for a retry. Startup
factories which fail without returning a drainable resource retain the claim
for process-level recovery rather than asserting cleanup. The caller must not
close or transfer the Storage independently while the host owns it.

An isolated PID-namespace contract test uses the real 4.0.22 Chat archive,
in-place adoption, managed Chat and a private model: original history,
continuation and reconnect, explicit process approval, descendant pause,
resume, confirmed stop and owner drain were exercised. An injected failed
child drain retained the lease and excluded a competing fence until retry.
This is not Code activation, an admitted production handoff, or cross-host
Chat/profile authority. In particular, prelaunch readiness is not a Storage
lease or permission to register an original-root writer.
The prelaunched MCP child also owns the exclusive Root fence: it cannot run
alongside a second adopted-Storage Chat owner. Integration must put MCP and
Chat in one trusted owner process over the same live Storage and provide
separately authenticated, revocable transports and a single ordered drain.
`startAdoptedRootUnifiedHost` exposes the same Storage and native Core to a
trusted embedding attachment while retaining the managed Chat interface.
`attachReadOnlyMcpToAdoptedOwner` fixes the experimental MCP actor to read-only,
requires an independent synchronous authority fence, and registers its drain
before startup. Owner shutdown starts all registered drains, waits for all,
and retains Storage if any fail. This is a contract for a trusted adapter:
the adapter must enforce the fence on **every** request and await all effects
on disconnect/close. No real MCP transport, writable MCP admission, listener,
or product activation is provided by this attachment contract.
The experimental `attachAdoptedRootReadOnlyMcp` attaches the existing legacy
MCP server and its read-only actor to a caller-supplied transport over the
same owner, exposing only `list_notes` and `legacy_knowledge_read`. It admits
at most 16 tool calls, checks independent MCP authority on each inbound
protocol message and before and after each tool, and tracks handler completion even when cancellation or disconnect suppresses a reply. Other original read
tools are excluded because some maintain derived state without an
effect-boundary revocation check. Shutdown stops new
calls, waits for admitted effects and the persistent worker, closes the MCP
server and awaits the embedding's explicit underlying-connection close.
Disconnect must be wired to the supplied revocation signal; SDK stdio framing
alone does not provide that guarantee for a socket. An isolated real
SDK/client Unix-socket test uses synthetic authority. This is neither writable
MCP parity nor authenticated cross-host ownership or ordinary Code activation.
An independent isolated original-root test kills only its own spawned owner:
the managed parent and descendant stop, strict adoption resume restores Chat,
the process outcome remains unknown without signaling a historical PID or
replaying it, and original Chat bytes and captured stdout remain intact. The
test's owner takeover evidence and profile authority are fixtures.
`attachAdoptedRootSessionChat` binds this Chat host to the **same** live
Storage as a host session, an independently issued profile and the exact
selected chats. Chat scope and profile revocation drain the registered child;
neither an MCP session nor the lease implies Chat authority. A private
direct-fork IPC test revokes Chat while a parent and descendant are active:
the drained acknowledgement follows their shutdown, Environment remains
available, and parent disconnect drains and releases the owner. The test
issuer is synthetic and does not qualify ordinary Code activation.

`createAdoptedRootChatViewBackend` is a separate ordinary-shell adapter for a
trusted embedding. Its session and profile fences must independently bind the
same owner, root, workspace, profile and Chat scope; the endpoint, bearer and
session ID do not grant authority. It rechecks the configured canonical root
and filesystem identity, fences locally before requesting Chat-scope drain,
and propagates an unconfirmed drain for retry. A private test invokes the
ordinary `openApiChat` command through the shell and this adapter against the
real adopted owner HTTP endpoint, then drains Chat without revoking
Environment. VS Code and the view provider are stubs and the issuer is a
fixture; this is not an installed Code journey or production activation.

`requestAdoptedRootChatAuthority` asks the local user to select one Chat and
confirm its original root, profile, owner session and configuration fingerprint.
The short-lived profile capability is valid only for that selected Chat. It
rechecks the trusted host and root/profile identities, signals revocation on
host or window changes, and must be wired to the owner's registered Chat child
so effects drain before acknowledgement. The host fence and candidate list
must come from a separately authenticated embedding; a dialog, session ID or
configuration digest cannot authenticate the owner, authorize another scope or
permit root handoff. A private same-process test uses this issuer, the real
native Chat provider, ordinary shell and adopted-owner HTTP endpoint with
VS Code APIs and the host issuer stubbed. A separate installed Code fixture
exercised actual workspace trust, picker cancellation, single-Chat confirmation
and disconnect revocation; it used a fixture extension and host, not ordinary
PKM activation or an adopted owner. That Code fixture predates the in-process
identity-branding change below; it does not validate that change.
Cross-process capability transport and ordinary activation remain separate work.

`createAdoptedRootChatParentSession` accepts only the actual in-process intent
object, its original host fence and signal, and a live direct child; copies and
serialized IDs cannot authorize it. A trusted embedding must additionally
authenticate the exact transport and owner. Its local Chat signal fences new
view requests before the existing parent control sends deny-only scope
revocation. Disconnect, timeout or failed acknowledgement is unknown and
does not undo the local fence; callers may retry the drain. Startup cleanup
failure exposes a retry capability rather than claiming the child drained.
Private tests use a real forked IPC peer and, separately, an adopted owner
with a managed parent/descendant; the latter's child profile and the VS Code
interaction are fixtures. The existing IPC has no authenticated Chat grant
or per-effect cross-process fence, so this adapter is not production
cross-host authorization and is not wired into normal activation.

An isolated workspace test uses the real Standalone/managed Storage owner,
local model and HTTP Chat path. It checks cross-Chat refusal, profile
revocation while a decision is awaiting, and disconnect both before approval
and after an owned process starts. Host shutdown also drains the child. A
selected-renderer test sends and approves through the actual provider with
VS Code APIs mocked, over that same live HTTP/model/process path; it is not
an installed Code or Electron test. These tests do not establish original-root
ownership. A separate selected-owner cross-process path is being integrated;
it does not establish a live original-archive writer fence or same-root
adoption. Normal activation keeps the original Chat path.

The explicitly selected IPC owner enables queue/steer only for its selected
Chats, with the owner and source fences rechecked after asynchronous
authorization. Queue retries with the same submission identity and unchanged
contents return the current queue state, even after its revision changes;
they never dispatch a second copy. A cancelled Task is checked again after
pending memory-context work before invoking the model. The isolated renderer
test exercises this through the selected IPC owner and a loopback model, not
an installed Code window. Steering is previewed without consuming the queue;
the HTTP, VS Code and Copilot SDK model adapters commit it only after their
own prompt-budget checks and immediately before dispatch. A changed queue,
cancelled attempt or revoked source fails the commit. Unsupported injected
model ports fail closed instead of consuming steering. A process interruption
after commit remains uncertain and is never automatically replayed.

In isolated real-fork tests, revocation during process approval or model
preflight and a preflight IPC timeout retain the steer as queued. Once the
dispatch boundary is committed, a lost dispatch acknowledgement retains it
as applied, not as a fresh queued request. Reopening the same private Chat
does not automatically dispatch either case. A process write observed before
revocation, including after a committed steer and a fresh approval, is recorded
as uncertain and is not repeated. A timed-out or revoked separate outcome
review cannot write a review decision, including from a late IPC reply. The
tests use a local fixture provider and a stub VS Code model API, not an
installed Code UI.

In a private installed Code profile, closing the selected trial after a real
foreground process write retained the queued steer and uncertain outcome;
reopening the same Chat required explicit review and editing before execution.
A separate installed test timed out a local HTTP model request after sending a
committed steer: its `MODEL_TIMEOUT` receipt and applied input survived
restart without replay. These are not installed VS Code LM IPC timeout tests;
the profile exposed no callable VS Code models and fixture dialogs supplied
the approvals. The 4.0.22 original renderer also sent and dispatched queued
input to the local provider in read-only mode. Its intentionally unavailable
Python and VS Code models caused reported memory and profile-extraction errors,
so that test does not establish those services work.

For a selected Chat, the Task Sessions list opens the exact original or native
Task in a read-only Harness. It does not resume a Session or inherit its
permissions. A private installed test used two completed Sessions created by
the verified 4.0.22 store, opened both through the actual Chat renderer and
host, and repeated the inspection after reopening the same profile and
selected Chat. The original Chat and Session files stayed unchanged; no model
request was sent. The test candidate overlaid only the two Chat UI files onto
the earlier frozen runtime and is not an integrated migration release.

After completing a selected Chat Task, fresh ordinary inputs use the same
managed history and Chat-scoped authority without creating a visible Session.
An internal Chat scope partitions turn storage; old Task Sessions and their
receipts remain associated only with their original Tasks. Queue and steering
remain bound to the exact active Task or the ordinary Chat scope. Stop fences
pending admissions and cancels in-flight managed work without marking an
ordinary Chat permanently stopped. Operation identities and unresolved
outcomes retain their existing no-replay checks. The untouched plain-Chat path
is not promoted to managed execution by a queue request.

An isolated real HTTP host test covers completed original and native Tasks,
ordinary input, denied authority, queue/steer, an admission/cancel race, a
running cancellation, reopening, and starting a new Task. It uses a synthetic
provider. A separate selected-owner fork test also covers approval revocation
before a process runs and revocation after a real process effect; the outcome
and steering remain retained without replay. Its VS Code LM bridge is a stub.
In private installed Code profiles, verified original 4.0.22 and a frozen
Next Chat overlay each completed a Task, sent and queued ordinary inputs, and
started another Task. Next reopened the same profile and retained the history
and new Task without another model request. The fixture used a local HTTP
provider and automatically answered dialogs; the original reported unavailable
Memory and Profile services. Original synthetic Chat and Session files stayed
unchanged in the Next run. This overlay is not an integrated migration release.

Selected Chat stores a separate recovery binding in the approving VS Code
profile. Reopening requires the same private trial, workspace database,
original root and snapshot identities, plus fresh model and exact-program
approval. The recovered child admits only the pinned Chat, not general trial
operations. It compares original Chat content against the unchanged snapshot;
restarted Host records and empty per-Host request directories are not Chat
content. Changed history or requests fail closed. Pending inputs require
explicit review, and unknown effects remain unknown rather than replaying.
This remains optimistic source checking, not a writer fence or root adoption.

An original 4.0.22 MCP start can leave empty `api-chat-control` directories
with group permissions under umask 002. Archive inspection accepts only the
known empty control tree under a verified private Linux ancestor; shared-mode
trees containing control records remain blocked. Directory identities and
timestamps are rechecked during inspection and the ancestor guard is included
in the archive fingerprint. Root ctime is checked during inspection rather
than across adoption, which creates its own root entries. This guard does not
fence another process running as the same user.
`createSelectedChatProfilePolicy` composes a selected capability with an
explicit profile, archive authority and exact executable/cwd/argument
entries. It checks these during approval and immediately before spawning,
including queued work. The source must supply either a live writer fence or
an explicitly labelled optimistic snapshot conflict checker; the latter does
not claim an atomic snapshot, writer exclusion or source quiescence. The
callbacks must come from the actual authorities: the factory does not
establish writer exclusion or fence a profile writer's durable commit.
On Linux, this profile opens and validates the executable and cwd, then passes
those descriptors through the process-group supervisors; the leader uses
`/proc/self/fd` so a later pathname substitution does not redirect that
launch. This requires usable procfs and read access to both objects, even
where an ordinary path launch would require only execute/search access.
Open descriptors do not freeze an inode's contents, executable interpreter,
dynamic libraries or script/data arguments; in-place modification remains
possible. This is not authorization against an adversary who can modify
those objects. Isolated tests replace the contents of the executable inode,
an argument script, and a shebang interpreter after the executable is opened;
the real approved process runs the changed content in all three cases.
The old Chat prompt approves a program, arguments and cwd, not a content
digest. Next retains the existing permission modes and one-shot background
approval rather than claiming immutable bytes or adding a digest restriction.
Its approval explicitly warns that contents may change. A descriptor-based
launch that cannot start reports the readable-file/directory, procfs,
selection/source and interpreter requirements; it does not claim that a
failed launch succeeded. Foreground remembered grants can still suppress a
new prompt, just as under the old permission semantics.
The old Chat did not have this static exact-command allowlist; it is an
additional restriction, not a claim of old behavior.

Selected-owner Next remembers new foreground approvals in the independent
workspace, authenticated by a per-Chat key in the VS Code profile's
SecretStorage. Grants bind the original root identity, workspace, Chat, source
fingerprint and exact selected program/cwd/arguments and executable identity.
Original grants are not inherited. A synchronous owner and snapshot check
fences the SQLite commit. Background execution still requires one-shot
approval. The Chat permissions reset first drains and closes the selected owner,
then deletes its key; failures are reported as unconfirmed. Reopening requires
fresh model/program selection. Restoring an older workspace database after a
successful reset cannot authenticate its prior grants with the new key; this
does not protect against rollback of the VS Code profile's SecretStorage itself.
Different profiles and Chats do not share these grants.

Isolated parent-fork tests exercised the actual Copilot SDK package over a
local JSON-RPC fixture, including once, remember, process execution, host
restart, reset and denial. A separate frozen v3-based Chat-only overlay was
installed into a private Code profile: the actual UI performed once, remember,
restart/reuse, reset after its success notification, and denial after another
restart. That journey used a local HTTP provider and fixture dialog responses,
not the SDK or a paid model. Closing before reset acknowledgement does not
prove that reset completed. Neither journey qualifies an integrated package or
production adoption.

An installed caller needs a profile selection owned by `NextManagedClient`
and an authenticated child protocol that blocks new admissions before
selection changes, revokes and drains the child, and waits for its ACK.
SDK discovery also recognizes a VS Code installation whose SDK is in
`node_modules.asar` and whose matching native runtime is in
`node_modules.asar.unpacked`, without combining different installation roots.
An offline Electron test loaded Code 1.143.0's bundled SDK 1.0.23-preview.5
and discovered a fixture model through local JSON-RPC. The test redirects the
SDK's stdio runtime to a local proxy and supplies a synthetic token; it does not
run the bundled native runtime, contact a model, or establish installed-UI
approval or production qualification. The offline test also creates a real SDK
session and observes a fixture `run_process` tool request and continuation; the
fixture itself executes no tool. Directly replacing the connection with
`forUri` failed because this SDK rejects that mode when the production client
sets `useLoggedInUser: false`; the fixture therefore preserves the SDK's stdio
connection instead of altering production authentication.
An installed private Code attempt loaded that bundled SDK and started the
isolated trial, but the automation did not progress beyond the initial
information-notification/setup interaction. It did not reach model selection,
process approval, restart or reset, so it supplies no installed SDK-permission
qualification. Its failed fixtures and workbench captures are retained.
The revised isolated UI driver avoids dismissing a later picker with a global
Escape and tracks the real information API without replacing its response.
Headless DOM tests exercise the driver controls, but are not an installed Code
journey. With the same v5 package and a separately hashed fixture bundle, a
private installed Code journey subsequently selected the actual bundled SDK and
used a loopback JSON-RPC model to approve once, remember, restart and reuse the
grant, confirm reset and its success notification, then restart and deny. Three
controlled processes ran; seven SDK sends used three connections and no HTTP
provider requests, and the original synthetic archive was unchanged. Path
selection and the token were fixtures, and the SDK stdio runtime was redirected
to a local proxy. This does not qualify the native runtime, real account or model,
the integrated package, or production adoption.

Channel loss must leave unresolved effects UNKNOWN. The child must also receive
an independently verified live archive fence or explicitly optimistic snapshot
capability and exact executable policy; paths, persisted identities and a
single upgrade approval cannot supply them.
Only after those boundaries exist can the existing shell select the new
provider without falling back to the old writer for an admitted Next root.

`createProductionChatModel` accepts an explicitly selected HTTP profile and
in-memory credential, checks its live selection around asynchronous operations,
and does not retry. OpenAI-compatible and Azure endpoints require HTTPS except
for loopback HTTP. VS Code language models are not supported by this adapter
and never fall back to HTTP. Managed Chat history exposes only allowlisted
model failure codes and guidance, not provider error bodies or credentials.
Isolated loopback and managed-host tests exercise the transport, not an
external provider. The current native turn is limited to 4096 output tokens;
the provider adapter also applies the selected profile limit. Its maximum
30-minute total provider timeout differs from the old Chat's idle timeout.
Tool results use the original 16,000 UTF-16 code-unit boundary: an invalid or
larger result becomes a failed tool-result message for the next inference.
The native Chat composition opts into a bounded 96,002-byte gateway JSON
ceiling and a 131,072-byte approval-result ceiling; generic gateway and
approval defaults remain 16,000 and 65,536 bytes respectively. This allows
the old 16,000 UTF-16 code-unit result boundary, including JSON escaping,
without granting any new operation or approval. If that gateway ceiling is
exceeded after a known committed operation, the execution receipt remains
successful while the model sees the old failed-tool limit message; the
operation is not replayed. Other gateway failures continue inference only when
the gateway proves its effect was not committed; unknown effects,
cancellation and user rejection do not replay.
The selected process host also returns the original failed-tool message for a
strictly invalid `process_get` handle after its Chat authorization check,
without accessing a process.
Managed Task input admission uses the original 16,000 UTF-16 code-unit
boundary. Independent Next prompt, token and durable-record limits still apply,
so admission alone does not guarantee that every such input reaches a model.
An isolated selected-owner IPC and loopback-model test covers a 12,000-character
Chinese input and rejection of 16,001 ASCII characters before model dispatch.
The 4.0.22 HTTP budget counts UTF-8 content and serialized tool calls, 32
bytes per message plus 32, and any tool schema as an additional message.
Next uses that formula instead of counting the entire wire JSON as tokens.
An authenticated oracle compares the same hard-round notice and prompt at the
2,048-token boundary, with 128 reserved for output; the accepted message is
delivered intact and the next byte is rejected before transport. This is a
conservative byte estimate, not the provider's actual tokenizer.
Managed Task context no longer silently drops all but twelve messages; its
explicit message and byte bounds can still reject a larger history without
deleting it. Original image attachments remain in history; like the old
requestMessages projection, managed history does not resend earlier images.
The inline image validator uses the original image-size metadata check and
limits: 512 KiB, 4,096 pixels per side and 16 megapixels. The decoder inspects
image metadata; it is not a full pixel integrity check. Corrupt or oversized
inputs fail before Task dispatch. No image download is performed.
Constructing this adapter does not itself select a profile, establish an owner,
or enable production Chat routing.

An installed-Code isolated profile exposed a source conflict from the old Chat
Host refreshing its `api-chat-control/hosts` record every three seconds. The
optimistic snapshot now tolerates only a monotonic `updatedAt` change in an
otherwise identical, compact original Host JSON record, together with the
corresponding file replacement and hosts-directory metadata change. Host
identity, other fields, directory identity and membership, requests, history
and the copied archive remain checked. Noncanonical Host records remain under
the strict fingerprint. This is not a writer fence or a guarantee against
changes between observations; it never grants authority based on a Host PID.
Capture retries a bounded number of recognized Host-read or archive graph
verification races, then still compares the complete source. A validated
Host's captured bytes, not a second unchecked read, are copied.

The explicitly selected owner can save an image from its readable Chat history
to a user-chosen local or VS Code filesystem-provider destination, including
overwriting an existing file after an additional explicit confirmation. The selection,
owner and image are checked again after both dialogs. Local paths inside the
original root or snapshot and multi-link files are refused; symlinks are
resolved before the protected-root check. Arbitrary filesystem providers must
be trusted not to alias protected local data; their stat/write operations do
not provide a general atomic compare-and-swap.
An isolated VS Code 1.143 hybrid-package journey exercised the actual GTK
save chooser and native VS Code Replace confirmation, with the old target
unchanged before confirmation, the original PNG saved afterward, no model
call and the synthetic source archive unchanged. Other setup dialogs were
fixture-driven; this does not demonstrate ordinary production activation or
general provider safety.

A fresh Next workspace can instead read a separately supplied, read-only Chat
archive through a caller-provided source capability. This does not authorize
the original root. A separate, explicitly granted live evidence capability
can read exact original Chat process records and output; absent that capability
the independent source cannot read them. Reads compare file identity and
metadata before and after, re-open the path and report detected changes.
This is optimistic, not a writer lock. Historical active records stay UNKNOWN
and cannot be controlled; an existing original background key is not replayed,
but an old writer can still race by creating the same key after the check.
As in 4.0.22, an authorized read of not-yet-created output for an original
launching or cancelled-before-output process returns an empty pending range.
Next still reports a launching supervisor as UNKNOWN and requires the recorded
stream byte count to be zero; a missing file that should contain output is an
error. The parent directory and record are rechecked, so this is an optimistic
observation rather than proof that an old supervisor remains alive.
The Storage gate remains unchanged. In a private, isolated VS Code
journey the user-facing approval, launch, pause, resume, native Stop
confirmation, cancellation and captured output were exercised. A second
approved run had its live guardian killed; after host restart its receipt
remained UNKNOWN and its captured output remained readable. This is a
guardian-failure/restart test, not a claim that the host itself was killed.
The separate isolated Runtime test kills the actual host while paused.
The default Linux VS Code confirmation is a native X11 window, not a CDP DOM
dialog; the private test exercises its actual confirmation button.

The host owns a guardian, which starts a controller and an independent
lifecycle owner outside the job group. The lifecycle owner is the controller's
child and owns the unreaped session leader; only that owner issues group
signals. The leader starts the configured program. Pausing stops the leader
and its group, never the lifecycle owner. If the guardian dies or the
controller itself is killed during a pause, the owner's IPC parent disconnect
causes it to terminate and resume the stopped group, then escalate while its
leader remains owned. A controller failure is still UNKNOWN even if this
cleanup succeeds; retained output remains readable. Restart marks
paused/running receipts interrupted; no stored PID is signalled or execution
replayed. A paused RuntimeProcess deadline excludes paused time. In group
mode the diagnostic receipt PID identifies the guardian, not the user program,
and confers no authority.

The private adapter supports foreground (default 30 seconds, maximum 120),
and background (explicit 1–86400 seconds and idempotency key). It writes
stdout and stderr to separate private native files with the old combined
64 MiB cap; output beyond that requests termination. Bounded ranged reads
also support original background and foreground evidence through directory
descriptors and no-follow opens, without modifying original records or logs.
Original active records are explicitly unknown and never confer PID authority.
The read-only path does not relax the root-adoption gate, which still rejects
the unadopted `api-chat-tool-results` directory.

This is not installed Chat parity: the adapter still requires an explicitly
configured executable/cwd/argument allowlist, a dedicated runtime database and
capture directory, and a live host; the old background supervisor could
outlive a window reload. Existing supervisor handles cannot be handed off
using persisted PIDs. Workflow's process-step active timeout excludes pauses, but its
absolute run and scheduler-lease deadlines remain hard fences: the original
Workflow model also defines these as absolute instants, whereas the old Chat
process supervisor explicitly excludes paused time from its process timeout.
Normal completion currently terminates remaining members of the group;
the original supervisor's pipe lifetime can differ. An unsuccessful group
cleanup request or unexpected guardian exit is reported as interrupted, not
success. The former STOP/CONT race is reproduced in
`tests/linux-pause-race-repro.test.mjs` in its own PID namespace; the new
transition test kills the guardian after the real group has stopped and before
the host processes its pause acknowledgement. A Chat HTTP test verifies tree
cleanup, scoped UNKNOWN, retained output and recovery without replay.

This is not containment: a program can leave its group/session. If the
lifecycle owner itself is independently killed while the group is stopped, the
stopped leader cannot handle its IPC disconnect; if the leader is independently
killed, its group identity may no longer be safely controlled. Those failures
remain UNKNOWN and can leave descendants, rather than authorizing signals to
historical PIDs. The owner's unreaped child handle protects the identity
while it is alive; it is not an independent kernel lock or a takeover fence.
The host reports a supervisor or leader exit even if descendants keep inherited
output pipes open: after a bounded drain it closes the pipes and reports UNKNOWN,
retaining captured output. Chat process receipts explicitly describe the group
boundary, including after cancellation and foreground completion.

`tests/linux-group-boundaries.test.mjs` runs in isolated PID namespaces. It
kills the controller through its owning guardian while three processes are
paused and observes retained output, cross-actor denial, UNKNOWN, group exit,
independent owner exit and database reopen. A separate test kills the lifecycle
owner through its parent and verifies UNKNOWN and the still-stopped group;
namespace exit, not historical-PID signalling, cleans up those fixtures. A
further test runs the actual legacy supervisor and the Next supervisor against
a program that launches a detached child, checking pause, resume and cancel.
In both, that child continues through group pause and cancellation; this is
an existing legacy limitation, not a new admission requirement. An escaped child that
holds an output pipe open is detectable and yields UNKNOWN; one using ignored
stdio is not reliably detectable, so a group terminal state is not evidence
that all descendants exited. A cgroup or similarly verified containment and
owner protocol would be needed for stronger guarantees.

The actual old supervisor also leaves three stopped processes after its own
SIGKILL in an isolated reproduction. Its heartbeat becomes stale and the
outcome is UNKNOWN; retained log evidence is readable, but a historical PID
does not authorize cancellation. This is a legacy limitation, not evidence
that the new lifecycle owner can guarantee cleanup after its own death.

## Required production owner interfaces

The future owner must provide the approval bridge with:

- A live owner fence and a binding to the exact root, workspace, actor, source
  fingerprint, Chat namespace and Chat ID; a marker or legacy session alone
  does not establish exclusive ownership.
- Current trusted-workspace and Chat permission mode, grants scoped to the
  sending window, and whether control originates in that owning local Chat.
- A real, cancellable user-permission request for the supplied scope, title,
  detail and one-shot flag, plus local Stop confirmation using the supplied
  process record. Both decisions must be revalidated against current owner and
  Chat state after the user responds.
- A dedicated fenced process database, a separate private capture directory,
  and explicit executable, working-directory and argument policy.

These are injection points, not proof that an adopted-root owner or production
approval channel exists. Do not weaken the existing adoption or evidence gate
to compose them.

To complete the old path, compose the installed host with actual user/tool
approval and a durable authority that survives window reload without treating
a stored PID as ownership. Test crash/reconnect before controlling a previous
supervisor. Coordinate a fenced, symlink-safe, read-only adoption and ranged
reader for `api-chat-tool-results`; do not simply allowlist that directory.
Prove original evidence adoption with a dedicated receipt and unchanged
same-root source checks. Workflow's separate default limits remain unchanged.

## Experimental direct-child Chat effect gate

The unconnected `adopted-root-chat-effect-gate` and
`legacy-api-chat-effect-child` prototype binds each `history` or `continue`
request to the live branded Chat authority and a separate synchronous intent
decision. An admitted request remains in flight until the child reports that
its executor settled. Revocation fences new work and requires both settlement
and the existing parent-control drain acknowledgement. An acknowledgement
received before settlement, IPC loss or replay remains UNKNOWN; timeout may
be retried only after the actual work settles and a fresh drain succeeds.

The isolated fork test waits for its real child process to exit before its
fixture acknowledges drain. Its deliberately early acknowledgement is a
negative test, not a physical-drain proof. The actual Chat backend is not
routed through this prototype: the unique effect entry point, genuine
per-operation user intent, complete process-tree containment and trusted
non-inherited IPC peer remain unproven integration prerequisites. A branded
object or a serialized request ID alone is not cross-host authorization;
production activation and cross-host grants remain disabled.

The experimental Chat parent can alternatively consume the owner's branded
`chat` deny-only scope handle instead of claiming the child itself. It checks
the exact child, session and scope for every new admission, never disposes the
shared control, and keeps the separate Chat-profile fence. The embedding owns
the global fence and the shared control lifetime. Its scope signal fences Chat
synchronously even when another caller initiates revocation; the adapter cannot
borrow that caller's in-flight acknowledgement and conservatively reports an
unknown drain when it cannot issue its own request.
The handle grants no Chat access and does not attest physical drain.
