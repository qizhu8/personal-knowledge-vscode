# Independent API Chat

Agent Sessions uses the same user groups as Chat List: user group → Chat →
Task Session. Spawned worker Chats are nested under their parent Chat; existing
Chats receiving a delegation retain their own user group. Empty/no-Task Chats
also appear inside their user group rather than as loose top-level entries.
This is a display projection; Task and host-group identities are unchanged.

Assistant replies and delegated worker result cards share sanitized Markdown,
KaTeX math (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`) and Mermaid rendering.
Math and diagram libraries load locally only when needed. Raw HTML is displayed
as text; unsafe links and interactive Mermaid bindings are disabled. Invalid
math or diagrams show explicit rendering errors.

Sending immediately shows a local user bubble before dispatching the request.
It remains marked as sending/awaiting sync until its exact submission identity
appears in saved messages or the input queue. Rejections retain the current draft
and display an error; local bubbles are not written to conversation history.

For independent work, the manager is instructed to put all ready sibling tasks
in one `spawn_workers.tasks` batch before sleeping. This is model guidance, not
a guarantee that every model follows it; dependent tasks should still wait.
Displaying a worker's saved original answer is local UI work and uses no model
tokens. Event-driven manager wakeups, summaries and decisions do call the model
and incur input/output tokens, including worker results admitted as context.

Run **Personal Knowledge Manager: Open API Chat** from the command palette.
The Webview opens in the secondary (right) sidebar on VS Code versions supporting
`viewsContainers.secondarySidebar`; the current development host is 1.140.
The extension's general minimum version has not changed. Older hosts without
this contribution location cannot use this view.

## Configuration

Click the model name / **Choose model** button beside Send. For a new direct-HTTP
chat, select **VS Code models** to open the actual available-model picker, or
**Connect API provider...** to configure HTTP. An already connected VS Code chat
opens discovery/selection directly. The header gear (**Model connection**) also
switches provider sources. Choose one of two connection paths:

1. **Use VS Code models**: choose an actually available model from VS Code's
  Language Model API. Sign in to the relevant provider and approve access when
  VS Code asks. PKM does not request an API key or extract a Copilot login token.
  Copilot and other configured providers can appear, subject to their actual
  availability, permissions, quota and subscription. If the list is empty, sign
  in or configure providers using VS Code's **Manage Language Models** command.
2. **OpenAI-compatible** or **Azure OpenAI**: provide a base endpoint, model
  ID/deployment name and API key as described below.

The model source and identity are saved per chat. A successful model selection
also saves its source, identity and capability profile in VS Code user state as
the default for new chats. Cancelled selections leave the default unchanged;
existing chats keep their own selections. Without a remembered model, new chats
use `personalKnowledge.apiChatProvider` (initially OpenAI-compatible).
The default does not copy chat history, context, selected budgets, keys, tools,
MCP connections or permissions. HTTP endpoint/key configuration remains shared
as described below. Remembered native metadata lets the model display survive
reload, but is not proof of availability. Discovery runs only when explicitly
connecting/refreshing or sending, not on activation. The selected model is
checked again before each request. A missing
model does not silently fall back to another model. Hosts without this public API
show an explicit error. PKM still owns the conversation, Session and tool runner;
this path does not reuse Copilot's Agent Host or history. Registered VS Code
tools can be controlled in the Tools tree, as described below.

The current Copilot extension also registers `copilotcli` model metadata for its
CLI chat-session selector, but its Language Model request callback is empty and
its token counter returns zero. PKM excludes that catalog-only vendor and rejects
previously saved selections before calling it. A model's presence in discovery
alone is not evidence that an extension can invoke it. This restriction must be
re-evaluated if the provider implements public requests in a later version.

For direct HTTP connections, the key is entered through a native
password input and stored in VS Code SecretStorage, never in the Webview or
conversation JSON. Leaving the key empty keeps the existing key.

- OpenAI-compatible example: `https://api.openai.com/v1`.
- Azure example: `https://your-resource.openai.azure.com` with a deployment name.
- Local servers may use HTTP on localhost. Remote endpoints require HTTPS.
- The endpoint must have no embedded credentials, query string or fragment.
- The provider must implement streaming Chat Completions; Responses-only and
  native Anthropic APIs are not supported yet.

Direct HTTP chat reuses `personalKnowledge.aiEndpoint`, `aiModel`, `aiAzureApiVersion` and
the existing AI API key. Changing them also affects HTTP script summarization.
`personalKnowledge.apiChatProvider` is independent of `aiBackend`: selecting
Copilot for summaries does not select a chat provider. For direct HTTP models,
add IDs to `personalKnowledge.apiChatModels` or choose **Enter API model ID...**.
`personalKnowledge.apiChatTimeoutSeconds` defaults to 120 (range 10-600), covering
each model call and its stream, not the complete Chat activity. Waiting for user
input or tools does not consume that model-call timeout. Requests are not
automatically retried.

Model display names are not API IDs. For a name such as **GPT-6.1 Sol**, use its
entry only if the public VS Code model catalog actually exposes it. A model
visible in another chat product need not be exposed to extensions. An exposed
entry belonging to the catalog-only `copilotcli` vendor cannot be used
through this route even though Copilot CLI can display it. Instead,
configure an API provider that supports it and use that provider's exact model
ID or Azure deployment name; PKM does not guess an ID or certify availability.

## Extension Host Builds

The exact-Host control queue also supports `tools` for native MCP diagnostics.
With empty arguments it returns bounded registered tool names, counts, and native
tool API availability without creating a Chat, starting a server, or calling a
model/tool. Explicit `{ "start": true }` requests managed PKM startup through
VS Code's existing trust checks before reading the catalog; it does not restart
other servers or change tool selection. A registered catalog is not proof that
Copilot enabled those tools for a particular agent request.

Installation updates files on disk; it does not replace code already loaded in
other windows. The status bar shows the running PKM build fingerprint. Click it
or run **Personal Knowledge Manager: Show Running Extension Hosts** to compare
loaded and installed version/fingerprint, PID and VS Code version, online host
records and coordinated-reload verification. Startup logs and `session_info`
also include the captured build identity; subsequent disk changes do not change
that running identity. Packages verify fingerprints against shipped artifacts.

After installing one verified package, run **Personal Knowledge Manager: Reload
All Registered Hosts to Installed Build**. A single native confirmation broadcasts
to registered hosts sharing this installation and profile storage. The target is
resolved from the installer's extension registration, including version-directory
changes; malformed or ambiguous registration blocks reload instead of guessing.
Busy PKM Chat/background work
defers reload; the request expires after five minutes. Completion requires a new
online host in the same storage slot reporting the requested build and completed
background integration preparation, not merely accepting the request.
On activation, PKM automatically checks and upgrades its managed MCP runtime and
generated server in the background. Concurrent windows serialize this work;
successful upgrades require no setup dialog or manual regeneration. Existing
account bindings and manual registration ownership are preserved. Missing Python,
conflicting/newer runtimes and migration failures remain explicit in Host Status
and Config; failed or incomplete preparation cannot acknowledge upgrade success.
This restarts other extensions in those windows too;
external agent activity is not tracked and must be stopped first.

Legacy hosts without this coordinator require an initial manual reload. Other
machines/installations/profiles are separate cohorts. Missing or expired registrations
are not evidence that every VS Code host has upgraded; no process is force-killed.

## Chat Names and Status

Internal resource links use `pkm://` URLs. **Copy PKM URL** in the Chat header
or library menu copies `pkm://chats/<workspace-namespace>/<Chat UUID>`, not a
bare UUID. The namespace is stable across reloads. Paste it into **Go to PKM
Path**, or click a PKM link in a Chat response, to open the existing Chat.
An address from another workspace is rejected with guidance to open its original
workspace; opening a link does not create a Chat, start a model, or change permissions.
The native control API and `list_chats` return `chatUrl`; use that URL as the
`chat_id`/`chatId` input to get, send, cancel, or `ask_chat`. Legacy UUID inputs
remain accepted for compatibility, but are not resource links.

User messages align right and assistant messages align left. Every message has a
small bottom-right token footer: pending messages show `Awaiting token usage`,
valid reported input/output counts are shown when supplied, and absent counts show
`Token usage not reported`. Request input includes history/context/tools; it is not an
independent count for the user message. Counts cover reported model rounds only,
not unreported rounds or provider billing. Workflow stages use identical compact
colored dots, with status/tooltips and expandable activity preserved.

The header pencil opens **Rename chat**. Names are trimmed, limited to 120
characters, saved with the conversation/native Session, and never overwritten by
the first prompt. Cancelling leaves the previous name unchanged; a pending rename
still belongs to the chat where it was opened, even after switching chats.

Every history option starts with **Running**, **Idle**, **New result**,
**Needs input**, or **Paused**. Live runtime state takes priority over disk recovery, including
background chats. **Needs input** covers edit/program/MCP approval while running,
or the next user turn after a viewed reply/failure. **New result** means a completed
request has not yet been acknowledged in the visible selected chat; this receipt
survives reload. A selected chat is acknowledged only when visible and scrolled
to the end. Hidden views/background selections do not clear it, and an old
receipt cannot acknowledge a newer result. Fresh chats and acknowledged stopped
responses are **Idle**. Recovered interrupted requests require input, not a false
running indicator.

## Context and History

**Options** is collapsed by default and holds attached context, Context/Output
limits, History and token/cost/provider details. An attachment count remains in
the summary and Add context tooltip. Folding the controls does not disable their
limits or detach selected references; explicit expansion is preserved on refresh.

The add-file button attaches the editor selection, current file, or chosen text
files, including knowledge files. Attachments are snapshots, not live watches;
remove/re-add them after edits. Nothing scans or uploads the whole workspace.
Sending transmits the current message, selected context, and, when **History**
is enabled, budget-selected recent dialogue and matching Chat evidence to the
selected model provider. Historical tool calls are never replayed wholesale.
Files may contain secrets: inspect the selection before attaching it.
The displayed input estimate conservatively counts UTF-8 bytes, including system
text, attachments, selected Memory/Skills, bounded dialogue and builtin schemas.
MCP schemas are discovered and checked at connection time. This is not provider
tokenization; every model round is checked against the configured window.

Limits: 160 KB per chosen file, 60,000 attached characters, 16,000 message
characters and 100,000 UTF-8 output bytes per model inference, including serialized
tool calls. The output byte limit resets for each tool round; it is not a
cumulative task limit or a token estimate. Requests use the configured model
context/output budget, not an unrelated 100,000-character ceiling. Required input,
explicit context and active tool results are never silently shortened; if these
alone exceed the budget, the request fails before model dispatch. Optional
retrieved references and recent dialogue are admitted only when they fit.

## Native Session Ownership

Each Chat has a stable runtime Group (`hostKind: pkm`). Casual conversations
remain Group-only. **Start Task** creates an explicit compatible
`pkm.agent.session/v1` record with `origin: pkm-native` and `runtimeOwner: pkm`.
Chat titles name Groups; Task titles remain independent. Replies are not Todos.
**Complete Task** preserves its evidence and allows a later Task in the same Chat;
unfinished Todos or attached Recipes must be resolved first. Existing Task
and Todo evidence is not migrated or silently removed.
Agent Sessions shows native/external/unknown source labels; names are not used
to infer ownership. Existing Copilot/Claude host identities project as external;
ambiguous legacy records remain unknown, without a bulk migration.

Conversation JSON lives under `.pkm/state/api-chats/<workspace-hash>` in the
configured Knowledge Root, with atomic replacement and private file permissions.
The shared Chat List enumerates existing workspace partitions in that root,
without moving histories. Windows using different Knowledge Roots do not share
the list. File/process tools remain bound to the originating workspace, including
legacy histories whose partition supplies that identity.
Native Session records include owned conversation/context state, so selected
Session Snapshots can capture that state, not hidden model reasoning.
These are local plaintext records, not encrypted archives; normal filesystem
backups can include them. SecretStorage keys are not copied into those records.

User-managed Chat folders live separately in `.pkm/state/api-chats/library.json`.
The header's back arrow opens the collapsible Chat List. Chats default to
**Ungroup**; folders can be created, renamed and deleted. Deleting a folder moves
its Chats to Ungroup, not Trash. Drag a Chat to a folder or use its context menu
to move it. **Trash** stays at the bottom and supports restore, permanent delete
and Empty Trash. Destructive actions require confirmation; Task/Group evidence
is preserved even when a Chat is permanently deleted.

Shared-file notifications refresh lists across windows. Revision checks and a
cross-process write lock reject stale overwrites and overlapping requests.
Running Chats cannot be trashed. New requests record their process owner; only
a confirmed absent same-machine process permits interrupted-state recovery,
never an automatic model retry. Legacy requests without ownership evidence are
not automatically recovered. Another window's live request remains read-only.

Switching chats does not misroute or cancel another chat's response. The header
**Pause Chat** button cancels the selected request and persists an explicit pause.
Sending and incoming native Session questions remain blocked after reload until
**Resume Chat** is clicked. While paused, the primary composer button also becomes
**Resume Chat** and remains available even with an empty draft or no model connection.
Resume preserves the draft without replaying a request or submitting a message;
send the message explicitly after resuming. The running composer's **Stop response**
button only cancels the current response and leaves the Chat available for new messages.
Pausing or stopping a source does not cancel an already approved independent
delegation. Stop the target Chat to cancel its work; its own permissions still apply.
Session stop/Trash/removal is detected within one
second and aborts generation without recreating the Session. Partial chat text
is preserved. After a process interruption, persisted streaming replies appear
as interrupted; they are not automatically replayed. Restore a trashed Session
before sending again, or start a new chat after stopping/deleting it.

In Agent Sessions, right-click a running Session or a paused PKM-native Session
and choose **Stop Session**. Stopping preserves Todos and Recipe evidence. A
stopped/completed Session can then be moved to Trash; the Trash menu supports
Restore and confirmed permanent deletion. Paused external Sessions are not
stopped through this native ownership path.

## Agent-Driven Chats

The automation MCP domain exposes the real owning Extension Host controller,
not a preview server or a second model runner. Agents can create visible Chats,
send prompts, inspect results and explicitly cancel responses:

1. Call `api_chat_capabilities` and select the exact online Host by workspace,
  machine and loaded build. Empty/virtual workspaces do not advertise a Host.
2. Call `api_chat_models(host_id, command_id)` and poll its returned receipt with
  `api_chat_request_get(host_id, request_id)` for actual callable native models.
3. Call `api_chat_create(host_id, title, command_id, model_id)` and poll the
  receipt for `chatId`. Omit `model_id` only to use remembered/default settings.
  Creation opens the actual sidebar Chat and does not send or create a Task.
4. Call `api_chat_send(host_id, chat_id, prompt, command_id)` once. Inspect its
  receipt, or use `api_chat_get` while generation or inline approval is pending.
  `api_chat_list` returns workspace-local non-Trash metadata; read-only calls
  do not create, recover or adopt conversations. `api_chat_cancel` cancels only
  the owning Host's current response, retaining partial output and history.

Use a unique `command_id` for each explicit operation. Repeating the same ID and
input returns the existing receipt, never another creation/model invocation.
Conflicting inputs are rejected. A receipt marked `succeeded` means the
controller operation returned: inspect `reply.status`, `reply.error` and actual
tool statuses before claiming a successful model answer. Responses are bounded
and disclose truncation; unavailable credits remain `null`, not zero.

Mutation requires a trusted filesystem workspace and the existing Chat's
ownership/permission policy. Busy, paused, foreign-owned and trashed Chats are
not resumed or taken over. Native confirmations remain enabled; the API cannot
set Allow All, select an unavailable fallback model or automatically retry.
Agent-driven turns exclude recursive Chat control and `ask_session` delegation.
Sending can incur real model/tool charges and transmit the Chat's selected
history/context. Model discovery can trigger the provider's native consent.

Private Host registrations and request receipts live under
`.pkm/state/api-chat-control` in the Knowledge Root. Receipts contain the submitted
prompt and bounded answer as local plaintext; normal backups may include them.
They do not include SecretStorage keys, full tool results or hidden reasoning.
There is no automatic receipt deletion. Host IDs change on reload. Offline
queued/running receipts report `outcome_unknown` without rewriting or replaying
them; inspect the existing Chat rather than submit another charged attempt.
An installed package is not a loaded Host: reload explicitly before expecting
its registry or new tools. The MCP runtime must also be regenerated/restarted
through the supported setup/upgrade path to discover the new tool catalog.

## Model Budgets and Activity

Each assistant attempt keeps its own persisted workflow rail (circles connected
by lines). Green means completed, blue running, amber waiting for input, red
failed, and muted grey cancelled. Icons and labels carry the same information;
color is not the only signal. Click a node for its event and time, or expand
Activity for the recorded sequence and actually advertised tool names. Terminal
timers stop. Reload recovers interrupted nodes without replaying the request.
Historical attempts retain their own graph when the next request starts.

Only the latest failed/cancelled/interrupted response offers Retry. It requires
an explicit inline Chat decision and replaces that failed assistant response in place with
a new attempt using current settings and the original user message/images.
The original user message ID, content and position stay unchanged; no duplicate
user message is appended or sent as extra history. The failed response and its
tool-result memory are excluded from the new inference. An unsent image draft
remains untouched. Earlier conversation turns are preserved. Retrying can repeat charges and tool
side effects. Busy, paused and superseded responses cannot be retried, and no
automatic retries are enabled.

The composer Tools icon opens a searchable tree of builtin tools, native MCP
namespaces/other VS Code tools and each configured HTTP MCP server. Source and
individual-tool toggles, mixed states and **Only this source** control the next
request. New Chats default-enable available tools; saved explicit exclusions
remain disabled. Native namespace labels are name-based, not verified server
provenance. `session_info` reports the current
request's Session identity, model, permission mode and actual tool list.
The shield icon is visible in the main composer toolbar; **Agent settings** also
offers **Permissions**. Ordinary new Chats explicitly use **Protective**; QA
Chats explicitly select **Allow All**. Protective allows verified workspace-local
operations and asks once for a disclosed, remembered per-Chat outside-workspace
boundary grant. Unknown-scope MCP calls and programs need that grant; a local
working directory does not confine a program. Another Chat does not inherit it.
Read-only excludes edits, programs, MCP and Session
cooperation. Ask-before-changes uses inline Chat approvals and remembered scopes.
Verified reads are free; verified non-destructive changes share one remembered
grant. Unclassified/destructive tools retain tool-specific grants. Public native
registrations do not expose verified safety annotations, so PKM does not infer
read-only safety from their names. **Allow All** enables all configured tools,
clears prior selection exclusions, and skips PKM approval prompts but
does not bypass VS Code confirmations, workspace trust or ownership checks.
The permission picker labels this **Allow All (PKM)** and explains this boundary:
PKM-controlled loop, Retry and Complete Task decisions appear as inline Chat
cards, not VS Code-level modal dialogs. These decisions cannot be approved by
changing tool permissions. Pending cards are scoped to their Chat, attempt and
sending-window context; stopping/disposal removes active cards, and changed
idle conversations invalidate Retry/Task confirmations without executing them.
Reset approvals clears remembered grants; cancelled settings leave the previous
mode unchanged. These controls are not an OS-level
filesystem/network sandbox for approved processes.
`pkm_search` searches local note/skill titles and categories (at most 12 matches;
notes are drawn from the first 1,000 catalog items); `pkm_read` reads an exact
local catalog identity with bounded content. Both require a trusted workspace;
their verified builtin read operations need no change approval in Ask mode,
but outside-root references still require the Protective boundary grant. These
are not access to all PKM services or subscribed/Broker content. Read-only mode
keeps safe read/question tools, not write/process/MCP/cooperation tools.
PKM supplies its own Session ID and actual tool availability to the model even
when no tool is selected. Independent Streamable HTTP MCP connections remain
supported. The Tools tree lists the actual `vscode.lm.tools`
registry on capable hosts. Enabled registrations are made available
through `find_vscode_tools` (bounded schema discovery) and `invoke_vscode_tool`
(exact discovered name and validated input). PKM uses `vscode.lm.invokeTool`
with `toolInvocationToken: undefined` outside a Chat Participant, preserving
VS Code's tool confirmations as well as PKM's saved permission policy. There is no
fabricated token, copied credential or separately launched stdio process.
The [public invocation API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelToolInvocationOptions)
only supplies an inline native confirmation token through a real Chat Participant
request. A custom PKM webview cannot manufacture that token, relocate VS Code's
confirmation into its own DOM, or override it with Allow All.
Opening PKM Chat in a trusted workspace starts background discovery of the
extension-managed `pkm` server when its tools are not registered yet. The
targeted native startup publishes the current Knowledge Root's definition and
waits for live tools before refreshing the Tools tree. Core extension activation
and the initial Chat page do not wait for this discovery. Read-only Chats skip
it; saved exclusions and native confirmations remain unchanged. Startup errors
are reported separately, with no automatic tool-call retry or replay. A broken
or missing managed runtime still requires repair in Config.
Servers must already be configured, trusted and registered by VS Code; this
does not imply access to every Copilot-internal tool. Missing registrations
fail explicitly. The bridge currently returns text results only, not MCP
resources, prompts or image results. New chats do not inherit exclusions/grants.

The native selector groups registered PKM tools into Skills, Notes, Papers,
Chatroom, Recipe, Agent Sessions, Subscriptions, Retrieval and Runtime. Other
VS Code/MCP tools remain selectable in a separate group. Grouping does not
rename invocation IDs, add unavailable functions or change saved selections.

For collapsible groups in Copilot, run **Personal Knowledge Manager: Export PKM
MCP Tool Sets** after PKM MCP has registered its tools. The export contains only
the current Host's registrations, using VS Code prompt references such as
`pkm/list_skills`; actual calls retain IDs such as `mcp_pkm_list_skills`.
Choose a new `.toolsets.jsonc` file in the current client's user Tool Sets
folder, located through **Chat: Configure Tool Sets**. Existing files are never
overwritten. A different client/profile, including a local client connected to
a remote Host, may require moving the exported file into its own Tool Sets
folder. Exporting alone neither enables tools nor bypasses approvals. MCP's
wire-level tool list remains flat; clients without Tool Sets keep their own UI.
Regenerate to a new file after changing the available MCP tools.

`replace_text` changes an open document without saving it. `save_file` requires
the edit's exact SHA-256 `afterHash`, the applicable saved permission grant and unchanged document
version/content, then verifies the saved disk content. Configured save actions
may change the document and are disclosed. Tests run against disk only after
an approved save; approved programs are not sandboxed.

## Session Diagnosis

Options contains an Export Chat diagnostics icon. The native Save dialog exports
`pkm.chat.diagnostics/v1`: up to 20 assistant attempts, error categories, model
and limits, tool names/statuses and bounded workflow timings. It does not export
chat/context text, images, tool arguments/results, raw provider errors, endpoint
URLs, API keys or hidden reasoning. Older records may lack per-attempt manifests;
absence means unknown, not proof that a historical schema was empty.

From a built checkout, the equivalent read-only command is:

```sh
node scripts/export-chat-diagnostics.js <knowledge-root> <session-id>
```

It checks PKM-native ownership/identity, rejects malformed/external records,
limits source/output sizes, and never resumes or modifies the target Session.
The Library Recipe **PKM Native Chat Session Diagnosis** is persisted as
`recipe_f73177a622faec24138f613f3da78481`, revision 3, executable digest
`7eeed33bee0856964d436077e7794b2e277e42da968a6abe440e8e03c064b2b4`.
Inputs: `session_id`, `knowledge_root`, `extension_root` (a built checkout).
Its bounded export command is followed by explicit Agent diagnosis/report nodes,
not a provider rerun or deployment. Node.js and existing build artifacts are
prerequisites; installing/building/reloading is not part of this recipe.

Native `LanguageModelDataPart` is not necessarily an image. PKM reads only bounded
`usage` JSON containing valid nonnegative integer `prompt_tokens`,
`completion_tokens` and optional `prompt_tokens_details.cached_tokens`, as
verified in the installed Copilot provider. Only the last valid usage per model
round is accumulated; no other payload fields are retained. Other bounded
`stateful_marker`, `thinking`, `context_management`, `phase_data` and
`cache_control` metadata is discarded without parsing/persisting it. Unknown binary data
and invalid/oversized real images still fail; metadata-only streams remain empty
response errors. Absent or invalid usage is unavailable, not zero billing. Old records do not
retain the exact streamed MIME, so diagnosis separates static provider evidence
from directly observed runtime data. New diagnostics whitelist reported token
counts and scalar usage-frame totals (received, valid, invalid); they never
copy metadata payloads. Counts are delivered when a model round finishes and
published immediately. No background account-usage polling is implemented.

## Real Native Acceptance

Run **Personal Knowledge Manager: Run Chat E2E Acceptance** in the installed,
reloaded VS Code Host. Consent and select an actual callable model. The command
creates a visible timestamped Chat and runs up to six independent probes, plus
tool rounds: reply/usage, MCP listings, actual Note/Skill bodies, a complete
Recipe definition, read-only Session status, and existing-file edit/save/process
verification. A failed MCP probe does not skip coding. Truncated bodies,
metadata-only responses and failed tool results do not pass body-read gates.
Session status is intentionally read-only: it does not prove mutation tools or
that the MCP transport's active Session belongs to this Chat. PKM's saved permission
policy and native confirmations remain in force. Existing Chats are not replayed or modified; failures are
retained without automatic retries or fallback.

Evidence lives in the workspace's newly created `chat-e2e-*/acceptance.json`
and its retained fixture files. The report records model/Session identity,
actual tool statuses, registered names, token/usage-frame observations and the
exact test command, exit code, marker and file hashes. Success requires that
every probe passes, and the fixture test remains unchanged and passes against
the saved module. Each probe has a separate verdict and failure receipt.
`credits: null` means not supplied by the public API, never zero credits.
Local mocked tests or a browser preview are not substitutes for this acceptance.

The built-in **PKM Chat E2E Acceptance** Recipe in `System/PKM/Chat` guides three
Agent steps: prepare an isolated Session, execute the native acceptance command,
and verify the retained report against actual tool/test evidence. It never
resumes the original Session or substitutes mocks for a missing provider. If
the Agent cannot invoke native commands, the execution step waits for the user
to run the command and provide its report; the Recipe does not grant automatic
Session control. Failed/cancelled attempts are retained without automatic retry.

## Request Budgets

**Context** has at most five slider presets, derived from the selected model's
local window (1/16, 1/8, 1/4, 1/2 and full, with a 256 minimum and duplicates
removed). The adjacent display uses compact K/M labels (for example, 128K or 1M)
without rounding the internal budget. Existing custom values are not snapped to
a preset until the slider is changed. A smaller window is a rejection limit,
not automatic truncation or summarization of attached context. **Options** is
collapsed by default and contains **Output**; its existing limit stays enforced
when hidden. Lowering Context can reduce the reserved output to keep it bounded.

Model, context-window and output-limit changes apply to the next request, even
while the current response runs. A request captures its model, selected context,
tools and server configuration. Window means total input plus reserved output,
not a provider option that purchases a different physical context window.

VS Code models use discovered `maxInputTokens` as a conservative local total
budget, with reserved output deducted from it; this is not a claim about the
provider's full context window. Their **Output per inference** setting is a local
token guard for visible text and serialized tool calls, using the model tokenizer
when available. Without a tokenizer, PKM displays and saves an explicit warning:
valid provider usage can enforce the token limit at the end of that inference,
before pending tools execute; without either counter local token enforcement is
unavailable. UTF-8 bytes are never substituted for output tokens.
Each tool round receives the full configured output-token budget on both native
and HTTP transports. Previous rounds' usage remains in cost/diagnostic totals but
does not consume the next round's budget. The separate 100,000-byte per-inference
limit and tool-loop controls still apply.
The default follows discovered model output metadata (4096 when unavailable),
not a fixed 1024-token agent total. This is not a provider-enforced output-token
or billing cap. Generation and hidden reasoning may consume additional quota
before cancellation. Verified provider-specific usage data parts can supply
actual token counts; providers omitting them show unavailable usage. The public
API does not guarantee usage data or expose actual charges, so PKM shows
**Billing unavailable** or **Credits unavailable**, without invented prices.
Providers control access, quota and billing. PKM instructions/reference context
are supplied as user messages because this API has no system-message role.

For direct HTTP models, configure `personalKnowledge.apiChatModelProfiles` with
verified provider metadata:

```json
[{"id":"my-profile","model":"my-deployment","label":"My model",
  "status":"active","contextWindow":32768,"maxOutputTokens":4096,
  "includeUsage":true,"outputTokenParameter":"max_completion_tokens",
  "inputPricePerMillion":1,"outputPricePerMillion":2,"currency":"USD"}]
```

These example limits/prices are illustrative, not a model catalog. Deprecated
status or a past `deprecatedAt` blocks the model, including configured aliases.
Unknown legacy IDs are marked unverified and use a conservative 4096-token local
window; deprecation cannot be inferred universally from arbitrary deployment IDs.
Set `outputTokenParameter` to `max_tokens` for providers requiring the older name.

Activity shows actual request stages, elapsed time and expandable tool arguments,
status and results. Usage is accumulated across model rounds when reported.
Cost is an estimate at configured rates, not an invoice; cache discounts and
surcharges are not calculated. The output allowance is shared across up to eight
rounds, with at most sixteen calls per round. Cancel/timeout preserves partial
output and warns when in-flight execution may already have occurred.

### Credits and Multi-Round Cost

[GitHub's usage-based pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
converts model-priced input, cached input, cache writes where applicable and
output into GitHub AI Credits: **1 AI credit = USD 0.01**. Rates can depend on
model/context tier; cached input is not necessarily free. Some existing annual
plans remain on legacy premium-request billing. This conversion is not a contract
that internal `AIU` telemetry equals UI credits, nor a billing unit for other
providers.

For discovered Copilot models, the UI shows **Credits unavailable**: the public
VS Code Language Model API does not supply billed credits, account plan or quota.
It does not show zero, invent a tariff, or apply Copilot's unit to direct HTTP
providers. Other native providers retain **Billing unavailable**; configured
direct HTTP prices remain in their configured currency.

The direct HTTP **First-call estimate** is not a whole-turn cost cap: each tool
round can resend history and growing tool results, adding input costs even when
the output allowance is shared. Context bounds each call, not cumulative input.
The runtime currently enforces eight model rounds, sixteen calls per round, a
shared output allowance and the request deadline. It does not yet enforce a
cumulative input/credit cap, general delegated subagents, or context compression.
Those require separate runtime budgets; a slider or a smaller Output alone cannot
prevent the multi-round amplification described by the supplied Copilot lesson.

## Agent Configuration

The composer Agent configuration button and native Session component diagram
configure retrieval/history, external Markdown Skills, explicit attachments,
model budgets, builtin permissions and MCP servers. Explicit attachments remain
snapshots. Skill and Chat Memory selection is automatic, not a required checklist.

The **Retrieval** panel shows Top 10 or Top 20 typed candidates from the last
request receipt, with that request's actual model as the target. Only selected
context connects. Type filtering changes the view, not model context. Sources
include Chat Memory segments, Skills, Notes, Scripts, Recipes, Research and
indexed subscriptions. API/function kinds are extensible visualization contracts;
no API/function source adapter or automatic execution is implemented.
The current knowledge route is lexical unified retrieval, not a learned ranking
model. Raw scores/components and source URIs are inspectable. Memory uses bounded
dialogue and a lexical-overlap rule; pools are interleaved rather than falsely
globally ranked across incomparable scoring methods. Flow thickness is normalized
within the scoring method and is not a probability.

Memory belongs to one Chat, with optional Task branches and 1,200-character
source slices. Content-hashed IDs change when the source or tool outcome changes.
Each terminal tool outcome is indexed separately, even when its containing reply
failed, was cancelled or was interrupted. Outcome status and arguments accompany
each tool slice; failed tool outcomes are not presented as successful facts.
Recent tool evidence is eligible for retrieval. Up to four matching segments
with at least 60% of the best lexical score are considered, alongside at most six
short complete dialogue messages (no historical images or tool serialization).
Matching evidence takes budget priority over recent dialogue. History off disables
both. Up to three knowledge bodies of at most 4,000 characters are considered;
larger bodies are omitted with an explicit L2-required reason, not cut mid-source.
All automatic context is optional and checked with actual tool schemas before
every model round. Persisted selection flags/counts describe the admitted context,
not the pre-budget shortlist. Scripts and Recipes are not executed.
Unavailable/revision-changed bodies are not selected. Persisted receipts contain
bounded metadata, not duplicate bodies or hidden reasoning. Knowledge retrieval
honors workspace trust and the Protective outside-workspace grant. Provider
invocation has a five-second deadline and validates a bounded candidate batch.
Malformed results, provider exceptions and timeouts produce a visible retrieval
warning, not a failed primary Chat request. Cancellation remains cancellation.
Compression, automatic L2 refinement and learned segment retrieval remain future work.

### Activity retrieval timeline

Every assistant activity records separate Memory and knowledge retrieval attempts,
their duration, and the actual selected context before each model round. Click the
Memory icon on an answer, or choose an activity in the Retrieval panel. The second
selector switches between recall attempts and sends. A recall shortlist is not
evidence of transmission: only a send snapshot describes the admitted context.
Each send exposes the conservative UTF-8 budget estimate and selected/excluded
candidates. Retrieved references appear in a collapsible list, grouped by the
sources actually present. Chat dialogue and tool receipts are distinguished;
type filtering and Top 10/20 only change the inspection view. Memory summaries
show the first 30 Unicode characters of the source slice, with UUIDs relegated
to expanded metadata. Tool summaries use the actual result, not the repeated
provenance header. Expanding a Memory entry lazily resolves its exact
content-sensitive ID and displays the complete segment; changed or missing
revisions explicitly report unavailable. Expansion and loaded content survive
streaming refreshes and are cleared when switching Chats. The retrieval flow
remains available in a separate collapsible section. Non-Memory receipts expose
their retained source metadata, not an invented historical resource body.
Raw scores remain per-method values, not probabilities or a measured precision
score. Relevance annotation and learned feedback ingestion are not implemented.

The last receipt remains available for older Chats. Activity history retains up
to 32 attempts and the latest 32 send snapshots; omitted sends are counted
explicitly. These records contain metadata, not duplicate source bodies. Missing
or revised source content is reported unavailable rather than substituted.
Retries, manager wakeups and peer-message responses are separate activities with
their own timeline. No extra model call is used to render or summarize it.

### Retrieval-first acceptance

Run `npm run test:chat-context` for source immutability, the eight original
regressions, and real controller/disk-store/local-HTTP acceptance. Run
`npm run test:api-chat` for existing permissions, native-model, tools, transport
and browser regressions. The context suite explicitly labels future mechanisms
as TODO; passing implemented cases is not a claim that those TODOs are complete.
An 8K-window request over the synthetic >100K-character tool history must reach
HTTP with the exact relevant evidence, without unrelated tool output, without
turning History off, and without rewriting persisted evidence.

Tools require a trusted workspace. Available tools start enabled; saved exclusions
remain meaningful:

- `read_file`: bounded authorized text reads; `find_files`: bounded workspace glob listing;
  `search_text`: bounded literal search, not regex or shell.
- `replace_text`: a unique exact replacement, with policy-based PKM approval.
  Stale versions are rejected; edits remain unsaved in VS Code.
- `run_process`: policy-based approval for non-interactive program launch, separate
  program/arguments, closed stdin, restricted inherited environment, output cap
  and 1-120 second deadline. Programs can still modify files outside the workspace
  or access the network; inspect the approval prompt before authorizing.
- `ask_user`: native single/multi-choice picker and optional free-text input.
  Dismissal returns a cancelled answer, not consent. Answers are model-visible;
  this is not a secret/password collection tool.
- `ask_session`: one explicitly approved question to an advertised idle,
  unpaused PKM-native Session. Returns an immediate delegation receipt.
- `ask_chat`: the same independent delegation for an ordinary Chat, using its
  canonical PKM URL from `list_chats`.
- `read_chat_result`: read an approved receipt's status and bounded saved answer
  immediately, without starting a model, blocking, retrying or polling.
- `spawn_workers`: create a batch of independent worker Chats and dispatch them
  concurrently. Recursive workers share reusable tree-wide concurrent capacity.
- `assign_workers`: batch activities to existing idle Chats without reparenting
  them or changing their models, histories, permissions or user groups.
- `request_manager_input`: hold a worker activity for clarification or a suggestion.
- `stop_worker`, `respond_worker`, `resolve_worker`: control an exact owned
  receipt/activity/attempt (and decision episode for responses), never another
  unrelated activity. Manager responses cannot grant human permissions.
- `list_workers`: inspect tree membership and parent/child URLs without history.
- `send_worker_message`: explicit, persistent, addressed messaging within one
  task tree. It does not read another Chat's Memory or conversation.

### Worker task trees, sleep and explicit messaging

`spawn_workers` accepts focused `{title, question}` tasks. It creates visible
ordinary Chats, not automatic Tasks. Workers inherit the manager's selected
model, budgets, tool selection, MCP configuration and permission mode, but not
its messages, attachments, draft images or remembered grants. Their tool calls
continue to obey those inherited selections and their own approvals. A worker
may become a manager by calling `spawn_workers` itself; no separate recursion
budget is reset at that boundary.

Defaults are **3 automatically approved concurrent workers** and **10 maximum** across
the entire tree, configured by `personalKnowledge.apiChatAutomaticWorkers` and
`personalKnowledge.apiChatMaximumWorkers`. The automatic threshold must not
exceed the hard maximum. Only increasing the approved capacity needs explicit
approval, even under Allow All. An approved quota of six can be reused after
resolution without asking again. Reservations and releases are persisted under
a cross-process lock. Completed/cancelled temporary workers archive full results
and tool evidence before their Chat is removed and capacity is released. Existing
Chats retain their history/group and release their activity binding. Failed or
interrupted activities retain evidence and capacity until `resolve_worker`;
blockers are not terminal resolution. An uncertain dispatch is never replayed
automatically. The capacity belongs to this tree, not to a model turn or each manager. A new
independent task tree starts in a new Chat.

After the dispatch round the manager stops model requests and releases its
stream/connections/timers. **Sleep is a scheduler state, not a repeated wait tool
or model poll.** PKM reports actionable outcomes and blockers: completed,
failed/interrupted, cancelled, clarification, suggestion, real human permission,
active-time limit, or a suspected loop with repeated-tool evidence. Ordinary
running/progress/resume updates affect UI only. Events are bound to activity and
attempt and deduplicated per decision episode; stale reports cannot control
replacement work. A busy manager processes events after its current activity.
Explicit peer messages are not coalesced. Wake
requests contain bounded events and result references; larger answers can be
read through the existing receipt tool. If work remains, the manager sleeps again.
Token deltas and elapsed-clock refreshes do not wake the manager. A runtime-limit
notice does not imply execution has stopped. It reuses `apiChatLoopReviewMinutes`,
excludes approval/input waits, and permits a manager to continue or terminate the
exact activity. Stop never rolls back tool effects already performed.

Quota approval offers **Yes / No / Let me ask a question**. Follow-up answers
use a separate tools-disabled model request with bounded context/output; they
may incur model charges, are accounted on the active reply, and never constitute
consent or create workers. The original decision remains pending.

The worker status strip shows active/approved/maximum capacity and an expandable
task tree. Archived results open locally with rich rendering and tool-status
evidence; `read_chat_result` supports character-offset paging. Existing Chat
inputs identify their source manager, receipt and dispatch time. Chat List nests
new workers beneath their manager, preserves existing Chat groups, and sorts
only active above inactive with stable order inside each partition. Agent
Sessions follows **user group → Chat → Task**, including empty Chats.

Failed worker details are visible even when the task-tree node is collapsed.
The owning manager or an ancestor manager can explicitly **Resume worker** for
an idle, unarchived failed/interrupted/cancelled activity still occupying its
tree slot. Busy, stale, unrelated or archived activities cannot be resumed.
Resume preserves the worker Chat, activity, receipt, quota reservation, failed
response and recorded tool evidence, then creates a new continuation turn and
attempt using that worker's saved model, tools and permissions. The manager view
is not switched to the worker.

Unlike in-place Retry, Resume does not delete the failed response or replay the
original assignment. A bounded checkpoint supplies the assignment, failure,
partial answer and recent tool evidence; the complete history remains stored.
The model is instructed to inspect existing artifacts and uncertain effects
before continuing, and to split oversized changes into smaller operations.
This is evidence-based continuation, not a complete runtime checkpoint or an
exactly-once guarantee: previously failed tools may already have changed external
state. Clicking Resume authorizes another model attempt and its possible charges;
normal tool approval rules still apply. No worker is resumed automatically.

Peers send text to a specific task-tree Chat URL and receive a delivery ID once
the inbox is saved. Only that message, sender identity and delivery metadata are
shared; there is no hidden common Memory. A busy recipient queues the message,
and a sleeping/idle recipient is woken. Delivery means queued, not that a model
has already processed it. Tree members and parent links are discoverable through
`list_workers`, with pagination. Explicit messaging and wake tools are available
only when the task-tree tool remains enabled.

Stop also works while a manager sleeps and disables its automatic wakeups; it
does not cancel independent children. Pause, failed/cancelled manager requests,
Trash and changed sending-window context likewise prevent auto-wakes. Queued
events remain visible in saved state. Host reload does not silently replay child
jobs or resume model work in another window: send/resume explicitly in the owner
context. This implementation is not a durable distributed scheduler or a claim
that running workers survive Host shutdown. PKM's five-second supervisor detects
dead local owner processes and durably reports interruption without asking the
worker to report its own crash. PID reuse, hung processes and remote-host leases
are not inferred as crashes; long-running live activities use the review events.

`npm run test:chat-workers` verifies real controller/store/HTTP dispatch overlap,
no-poll sleep, individual completion wakeups, shared recursive limits, mandatory
expansion approval and explicit peer inbox delivery.

### Refresh and motion

Chat refresh reuses unchanged message DOM instead of rebuilding every bubble,
preserving open disclosures and avoiding unnecessary animation restarts. New
popover openings use a short opacity/position transition; hover/focus surfaces
use restrained color transitions. Reduced-motion preferences disable the new
transitions. Draft, scroll-follow and permission behavior are unchanged.

Delegating Chats use an original 16-by-16 pixel-art magic teacher holding a
book and wand. Workers use a matching wizard stirring a stationary cauldron;
a worker that delegates to its own workers becomes a teacher as well.
Manager identity comes from retained dispatch receipts, so it survives worker
archival and removal. The same roles appear in the library, selected Chat,
worker tree, delegation results and active Activity indicators.
Only running roles animate. Other states keep a static character with the
existing state color/shape as a corner badge and an explicit role/status
accessible label. Ordinary Chats keep the existing cauldron loading icon.
Backgrounded or disconnected views pause motion; reduced-motion preferences
show a single stationary pixel frame. No Minecraft or third-party art is used.

The permission control and **Allow All** sit beside **Options** in the composer
toolbar. Permission, tool, settings and memory choices open separate popovers
without moving the composer. Model selection acknowledges the click immediately
while the host loads its available models. Permissions choose a persistent
per-Session mode. **Protective** asks for the Chat's outside-workspace boundary grant.
**Read only** permits enabled workspace reads and user questions, but
withholds edits, programs, MCP and Session questions. **Ask before changes**
uses remembered scopes for PKM approval. **Allow All** skips PKM approvals but
does not bypass native VS Code confirmations or trust. Changes apply to the next request, not a running
tool catalog; read-only is not a general sandbox for providers or attachments.

An explicit permission change (including **Allow All** in a pending approval)
does not retarget an already-running request owned by this window. Its captured
tool catalog and execution environment remain fixed; live approval/read-only
checks still apply. Different sending windows, workspace/root/account changes,
or changed trust still reject execution. Queued inputs retain their original
permission/context digest and require explicit resubmission if it no longer
matches. Genuine context-change errors name the changed fields without exposing
their filesystem or account values.

### Tool-loop continuation

`personalKnowledge.apiChatLoopReviewMinutes` defaults to **30** and accepts
integers from **1 through 1440**. An activity is one submitted Chat turn, including
its model/tool rounds, not each UI Activity entry. Settings apply to the next
request. Chat asks whether to **Continue**, **Answer with current results**, or
**Cancel** only when both the active-time window has elapsed and a repeated tool
loop is detected. Time or round count alone does not fail a productive turn.
Continue grants a fresh active-time window, retaining completed results without
replaying tools. Allow All does not approve this independent decision.
The inline Chat card offers all three actions; choose Cancel or Stop to abort.
Switching Chats hides the card without approving, retargeting or cancelling it.
`apiChatMaxToolRounds` remains a legacy SDK round-review limit, not
the native Chat policy.

Chat also suspects a loop after the same function returns the same result for
the same canonical arguments three times without observable progress. Object
key order does not count as progress; changed arguments or results reset that
function's repetition count. This detects repeated observable behavior, not
semantic task completion. Interleaved functions are tracked independently.
Exact wait/poll exceptions are `wait`, `sleep`, `poll`, `core.sleep`,
`mcp_pkm_chat_standby`, `mcp_pkm_api_chat_request_get`, and
`mcp_pkm_recipe_run_progress`. Legacy SDK round allowances still count these calls.

Summarize performs a final tool-free model turn, explicitly records any pending
calls as not executed, and keeps call/result IDs paired. Cancel aborts the run.
The review clock pauses for PKM user input, approvals and continuation decisions.
Output, context, individual model/tool deadlines and cancellation remain separate
boundaries. Checks run between calls, not inside a stalled in-flight tool. Native
provider confirmations are not tracked as PKM waiting states. The library's
non-interactive fallback summarizes instead of inventing user consent.

The visible Activity header combines completed/recorded steps, the current step
and its elapsed time. The recorded count is not a prediction of future task
size. Expand Activity for detailed steps, tool results and debug information.

For the historical Note follow-up error, the former small round allowance was
a concrete termination path, not evidence that no relevant Notes existed.
Use `pkm_search` and `pkm_read` for verified local reads. Native MCP tools are
invoked through `vscode.lm.invokeTool`; VS Code owns their confirmation. PKM's
Allow All skips its own prompts but cannot disable that independent host
confirmation. This distinction must be checked on the installed host rather
than inferred from an isolated model test.

Successful editor replacements record relative path, workspace index, timestamp,
SHA-256 before/after hashes and bounded `+added/-removed` counts. The response's
**Applied edits** expander sums successful edit operations, not net Git changes
or saved files. Declined/stale/cancelled edits are not counted; counts become
unknown when concurrent changes or bounded diff limits prevent attribution.
Program/MCP execution is explicitly marked as not file-attributed. This ledger
is evidence of edits, not proof that tests passed or a rollback mechanism.

For VS Code models, enabled tools also require the selected model's tool-calling
capability and the host's structured tool-message API. Unsupported combinations
fail before any tool execution; text-only chats do not require these capabilities.

File reads, edits, saves and process working directories can use absolute or
parent paths after the outside-workspace permission boundary. Physical symlink
targets are authorized before reading and rechecked after approval. Hidden/sensitive
paths and `node_modules` remain rejected, including sensitive symlink targets.
Find/search glob discovery remains workspace-local. Explicit attachments are a separate
user-authorized path. Filesystem-backed workspaces are required. Multi-root tools
accept a zero-based `workspace` index. Execution occurs on the extension host,
which is the remote machine under Remote SSH, not necessarily the desktop OS.

File operations use VS Code APIs with physical-path checks. Process launch uses
Node without an implicit shell. Linux/macOS cancellation targets the process group;
Windows uses `taskkill /T /F`. Windows `.cmd`/`.bat` wrappers are rejected: use a
native executable (for example `node.exe`) directly. Termination is best-effort;
detached descendants or remote side effects cannot be guaranteed undone.

## MCP Connections

Add a Streamable HTTP MCP URL through Agent configuration. HTTPS is required
except localhost HTTP. Embedded credentials, query strings, fragments and
redirects are disallowed. Optional bearer tokens are entered only in a native
password input and stored in SecretStorage, not conversation JSON. Choose allowed
tools explicitly; every remote call needs native approval. Servers can be disabled
or removed. To change a URL/token/tool selection, remove and add the connection.

Connections are established and closed per request. Discovery is bounded to the
first 64 tools/page; select at most sixteen per server and four servers per chat.
Duplicate identical calls are blocked within a request, and SDK reconnection
retries are disabled. A failed/cancelled remote call may already have taken effect.
Do not automatically retry uncertain operations. Recorded results are sent to the
model and saved locally; check the server's data policies before enabling it.

Only Streamable HTTP with optional bearer authentication is supported currently;
stdio, legacy SSE, OAuth and automatic reuse of Copilot/Claude MCP connections are
not supported. Ordinary model requests do not require MCP. Automatic Recipe
execution/retrieval remains out of scope. Markdown is sanitized, remote images are
not loaded, and tool results are rendered as text, never executable HTML.

## Running Input

While a response runs, **Steer** supplies text at the next model-round boundary;
completed tools are retained and the runtime does not restart the active request.
**New task** saves a separate text request in a per-Chat FIFO queue. Both actions
confirm receipt before clearing the draft and deduplicate submission IDs. Up to
20 inputs are retained. Running-time input is text-only; images stay with idle drafts.

If the current response finishes before a steer reaches a boundary, that input
remains queued for the next serialized turn. Successful completion drains the queue.
Stop, failure and reopening do not replay pending work: **Run queued inputs** or
explicitly sending another request resumes FIFO processing. Queued inputs can be
removed individually. Other Chats can run independently. A Chat owned by another
window remains read-only, and changing settings affects the next request.

Status distinguishes an animated running cauldron, green completion (including
read results), red failure, yellow user-input/result waiting, and blue stop/pause.
Only a never-run or otherwise idle Chat uses the empty indicator.

## Native Session Questions

Enable `ask_session` through Agent configuration. Up to eight other native chats
are advertised by Session identity and title. One attempt is allowed per source
turn, including a declined attempt. Stopped, deleted, trashed, externally owned,
paused or busy targets are refused; questions are not queued. The explicit native
approval identifies the target, question and possible additional model charges.

The target retains its own model, selected context, complete history and tool
permissions. The source conversation and the target's unsent image draft are
not forwarded. A provenance-tagged user turn and stable delegation identity are
persisted in the target. Approval returns a receipt immediately; the source is
not blocked waiting for the answer. Saved results appear beside the source turn
and can be read with `read_chat_result`, at most 12,000 answer characters and
16,000 serialized JSON characters; truncation is indicated. Binary outputs stay
in the target Chat. A delegated target cannot recursively delegate. Source
cancellation does not cancel the child. Denied approval starts no child request.
Reopening reconciles saved receipts with their exact target turns, without
restarting a model. New results become unread; waiting does not lock the composer.

This is single-hop cooperation between native chats in the active extension
host, not Copilot/Claude Agent Host control, automatic wake scheduling, parallel
workers or a cross-Host background scheduler. Native VS Code confirmations remain
independent of inline PKM approvals. Charges across both Sessions cannot be
capped in credits through the public API.

## Images

Select an actual VS Code model that advertises `imageInput`, then use the image
button to choose PNG/JPEG files. There are at most two images per draft/message,
512 KB per image, 4096 pixels per side, 16 megapixels and 2 MB total stored image
bytes per conversation. MIME/type, dimensions and canonical Base64 are checked;
files are not automatically resized. SVG, GIF and WebP are not supported.

Attachments are binary `LanguageModelDataPart` messages, not image paths or text
containing Base64. Input requires a modern host with DataPart and a model exposing
image capability and token counting; unsupported combinations fail explicitly.
The text estimate excludes image tokens and is labelled accordingly. Provider
token counting checks complete image messages and tool schemas before every
call, against Context plus reserved Output. It is not billed usage or a guarantee
of the provider's internal image-token accounting.

Actual PNG/JPEG binary responses are previewed and persisted, with an explicit
native **Save image** dialog. At most two bounded image response parts are
accepted per turn. Image output is provider-dependent: the public API exposes no
image-generation capability flag, and PKM does not manufacture one or provide an
image-generation tool. The text Output guard does not meter binary output cost.
Direct HTTP image input/output and paste/drop attachments are not implemented.
Voice input is intentionally excluded.

Images, including drafts, live in the same private-permission plaintext chat and
native Session records as text, and can be included in backups/Snapshots. History
can resend complete image messages. Only explicitly chosen images are uploaded;
new attachments added during generation belong to the next request. Previews
use validated inline raster data; remote Markdown images remain blocked.

## Copilot Comparison

The public MIT-licensed `microsoft/vscode-copilot-chat` source was inspected at
revision [`5863f5a`](https://github.com/microsoft/vscode-copilot-chat/tree/5863f5a7088958050792b5dccbe8b46c6e13eccc).
Question/permission/image test patterns informed local regressions, not a claim
of equivalent implementation or compatibility with Copilot's private runtime.
Relevant references are `permissionHelpers.spec.ts`, `askQuestionsTypes.ts`,
`askUserQuestionHandler.ts`, `imageToolUtils.spec.ts` and
`executionSubagentTool.spec.ts` in that revision. A small portion of the last
suite was reviewed; the whole Copilot suite was not ported or executed.

| Capability | PKM native Chat status |
| --- | --- |
| Model picker, context/output controls, rename/status/timer | Implemented; actual catalog, no guessed model identities |
| Chat Memory and typed knowledge retrieval | Automatic lexical/rule baseline; Top 10/20 collapsible source previews and retrieval flow, Task segments, bounded injection; no learned-model claim |
| External Markdown Skills and explicit attachments | User-authorized snapshots, separate from Chat Memory |
| Workspace/outside read/edit/save and program execution | Bounded builtins, physical-path checks and Protective/Ask/All policy |
| User question UI | Sixth builtin; choices/free text, dismissal/cancellation tested |
| Session questions | Seventh builtin; approved single-hop native cooperation only |
| MCP tools | Explicit Streamable HTTP connections; no inherited Copilot tools/OAuth/stdio |
| Permissions and loop escape | Protective/read-only/ask/Allow All, persistent Pause/Resume, deadlines/round limits |
| File-change evidence | Per-response successful edit counts/hashes; no net Git diff or process attribution |
| Images | Gated native binary input and actual response display/save; no direct HTTP vision/generation tool |
| Copilot execution/search subagents and auto-wake | Not implemented; Session questions are not an equivalent |
| Terminal interaction, debugger/test/diagnostics/browser tools | Not built in; explicitly configured MCP may expose separate tools |
| Automatic context compression, cumulative credit cap | Not implemented; credits/quota unavailable through the API |
| Voice | Intentionally excluded |

There is no honest percentage of "all Copilot functions" from this partial
review. Seven PKM builtin names do not mean seven Copilot-equivalent workflows.

## Validation

`npm run test:api-chat` builds the assets and runs transport, storage and
controller tests using temporary stores, fake credentials and mocked boundaries,
including VS Code model discovery, routing, native text/tool/image parts,
permissions, pause, native questions, image budgets, evidence persistence and cancellation.
It also runs real temporary filesystem/process tests and a local HTTP MCP fixture.
Linux execution is validated; Windows/macOS runtime and installed-extension checks
still require their respective hosts. Cross-platform interfaces are implemented,
but this is not a claim that those hosts have already passed the suite.
The current source build script uses POSIX commands; Windows source builds need
WSL/Git Bash. This does not change the packaged extension's runtime adapters.
`node tests/test-api-chat.js --preview` serves an ephemeral localhost UI fixture
for browser checks; it is not a live model chat. Stop it after verification.
Live provider authentication, VS Code's consent dialog, actual model responses
and installed-extension behavior require a separate local host acceptance check.