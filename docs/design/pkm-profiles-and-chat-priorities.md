# User / Agent Profiles and PKM Chat priorities

Status: v1 Profile storage, cards and Chat attempt integration implemented,
2026-10-22. Portal snapshot protocol and runner are implemented; the parent-owned
`extension.ts` glue below must be connected before Portal disclosure is enabled.
Readable Chat Activity remains independent of Profiles.

## Product intent

PKM is a knowledge-backed working environment, not just a fleet of coding
terminals. Learn from other projects to find flaws in our design, not to copy
their product shape. Preserve existing knowledge ownership, permissions,
explicit managed Tasks, durable Actions, and remote-execution boundaries.

The immediate goal is a Chat usable for real daily development: the user can
understand execution without opening raw receipts, intervene safely, and
inspect evidence afterwards. Opening a dashboard is not sufficient acceptance.

## Separate concepts

| Concept | Answers | Does not establish |
|---|---|---|
| User Profile | How does this user prefer to collaborate? | A task, permission grant or personal-history dump |
| Agent Profile | What is this agent's focus and working approach? | Proven competence, tools or execution authority |
| Skill | What reusable method can the agent use? | Its identity or access rights |
| Memory | What experience and evidence can be recalled? | An automatically accepted preference |
| Project / Task | What outcome is being pursued in this context? | A permanent agent identity |
| Model profile | Which provider/model and budgets are configured? | A User or Agent Profile |
| Manager / worker | What execution relationship exists now? | A professional role such as PM or SDE |

### User Profile

A small, explicitly maintained set of stable preferences across Chats and
Projects: communication, collaboration, development and verification habits,
plus explicit reusable user requirements with their applicability conditions.
Do not store credentials, inferred sensitive traits, project facts, temporary
instructions or entire conversations.

The accepted card uses direct user editing. A separate, private/root-scoped
`pkm.user-profile-fragments/v1` collection now captures model-derived habits,
interests, focus areas, cautions and requirements from completed local PKM Chat turns, with
explicit history backfill. Each independently retrievable fragment retains stable
identity, tags, revision and verbatim message evidence. A keyword cloud filters
these fragments; frequency is not confidence or retrieval relevance. Derived
observations never silently become accepted preferences, permission or mandatory
Chat context. Requirements alone can be semantically qualified for the current
local human request and enter budgeted context as defeasible user context.
An AML-specific unavailable-extension constraint must not be recalled for
generic document writing or PKM tests, and current corrections take precedence.
Handwritten cards and their historical snapshots remain unchanged.
See [Chat Profile behavior and fragment contract](../api-chat.md) for collection
scope, model usage, exclusions, cancellation, storage limits and removal behavior.

Profile and Agent Session visualizations share the existing **Cache / Memory /
Disk** logical tier contract, not a new age-based classification:

- **Cache / short-term:** actual model context. The Root-wide Profile has no
  selected Chat context and says so explicitly. Inspect the selected Session's
  last sent manifest there; prepared input is not proof of transmission. A stored
  requirement enters Cache only when selected, budgeted and actually sent.
- **Memory / mid-term:** Chat-derived, evidence-backed fragments and their
  keyword cloud. The read-only snapshot adds `storageTier: "memory"` without
  rewriting v1 records, invoking a model, or changing their identity and revision.
- **Disk / long-term:** the explicitly maintained accepted Profile card. It has
  an independent lifetime; observations do not automatically become preferences
  or published Note/Skill assets.

The shared renderer does not equate Piece abstraction Level, statement age,
retrieval selection or model confidence with a temporal tier. Source-backed
fragments remain private observations, not additional authority.

### Agent Profile

An agent has a stable identity separate from an individual Chat or attempt.
A role template may seed a Profile, but is not the identity of every agent
with that role. Two SDE agents can have different specialties and priorities.

Proposed record: schema, stable ID, revision, updated time, display name, role,
focus, working preferences and responsibility boundaries. Keep these bounded
and understandable rather than introducing an extensible personality ontology.
Do not use biography text to assert experience the agent does not possess.

Example role focuses, not fixed templates:

| Role | Possible focus |
|---|---|
| PM | User problem, scope, priority and acceptance |
| DS | Data quality, statistical evidence and experimental conclusions |
| SDE | Correctness, maintainability, tests and operational reliability |
| AS | Research hypotheses, algorithms/models and experimental validity |

Profile identity does not replace Chat ID, Task Session ID, worker tree/activity
ID or execution-host identity. Assignment explicitly references an Agent
Profile; do not infer it from a Chat title, model name or manager/worker status.
V1 should not create persistent personas for temporary workers without an
explicit assignment.

## Always-inspectable persona cards

- A stable User Profile entry opens the user's concise preference card.
- Chat identity and Agent entries in Projects / Agent Sessions open the
  corresponding Agent Profile card.
- Cards show role, focus, working preferences and responsibility boundaries,
  not a raw system prompt. Distinguish configured focus from verified outcomes.
- Viewing works before, during and after execution, without model inference,
  tool execution, synthetic Tasks or a new Chat.
- Show current Profile revision separately from the revision used by a selected
  historical attempt. A later edit must not rewrite historical identity.
- An unassigned Agent Profile reads "not assigned"; a missing historical
  revision reads "unavailable", never substituted with the current version.
- Editing, deletion and reassignment are explicit. Existing history and
  running attempts must not change implicitly. Cross-root reads retain their
  existing access boundaries.

Do not add a second agent-management dashboard just to expose these cards.
Use the existing Chat, Projects and Agent Sessions surfaces.

## Context and evidence contract

Profile content is preference/context, not a way to override runtime policy,
trust, tool permissions, approval, budgets or Task/Action completion authority.
Current explicit task requirements take precedence over general preferences.
Conflicts with project requirements must remain visible rather than silently
discarding one side.

Capture applicable User/Agent Profile revisions when preparing an attempt.
Keep the selected snapshots stable through its model/tool rounds; edits apply
to the next attempt. Retry is a new attempt and records the revisions it uses.
No Profile configured must preserve existing Chat behavior.

Count Profile content in the real input/context budget. Proposed initial
character ceilings are 2,000 for User preferences and 4,000 for an Agent card,
subject to validation before implementation. Character ceilings are not token
counts. Reject oversized edits explicitly; never silently truncate a profile
and then claim its full content was applied.

A future context receipt should identify Profile ID/revision/content hash,
whether content was applied, and its accounting source. It must correspond to
the actual prepared/sent messages, not merely the UI's selected configuration.
Reuse existing immutable history/snapshot storage where suitable; avoid a new
event store just for profiles.

Do not add fields to the existing strict `pkm.chat.execution/v1` structure
without a compatible schema change. That structure records sending environment
and authorization, not persona. Keep Profile context evidence separate unless
a deliberate execution-schema revision becomes necessary.

## Storage and lifecycle proposal

The original v1 storage/privacy defaults remain in place unless the user
explicitly enables the optional repository storage described below:

- User Profile belongs to user-scoped private state, not a synced Note/Skill
  and not exclusively to one Knowledge Root. User/account and Remote Host
  identity must be resolved explicitly; an extension host's global storage
  alone does not provide cross-device identity or synchronization.
- Agent Profile ownership must be explicit. Start with private, root-scoped
  agent records referenced by Chats/Projects; do not publish personal content
  in shared knowledge or GitHub Sync manifests by default.
- Cross-machine transport should send only an explicitly assigned, bounded
  Profile snapshot through an authorized execution request. A Portal pairing
  must not imply access to the controller's entire user profile or history.
- Deletion stops future use. The approved retention policy preserves historical
  persona snapshots until the corresponding Chat history is deleted; cards
  explain this before deletion.
- Validate revisions/conflicts across windows. Never overwrite concurrent
  edits with an old loaded card or recover a deleted profile silently.

By default, v1 resolves identity to the current OS user, VS Code profile and
extension Host's private `globalStorageUri`. This is **not** a cloud account
identity, shared Host identity or cross-device synchronization promise. A local
Host and SSH/remote Host have separate User Profiles. Agent ownership is the
resolved Knowledge Root path within that same private Host storage.

### Implemented v1 behavior

- Open **Profiles** in the Chat toolbar, **User / Agent Profiles** in Chat
  Settings / Agent configuration, or the same card in Projects / Agent Sessions.
  Native cards can be inspected/edited without inference, tool calls, a new
  Chat or a Task, including while an attempt runs. Configured focus is not a
  verified outcome. Historical cards show recorded revisions, not current ones.
- User and Agent card fields are name, role, focus, working preferences and
  responsibility boundaries. Total limits are 2,000 / 4,000 UTF-16 characters
  across all card fields; name/role are individually limited to 120. These
  character limits are not token counts. Oversized edits fail without saving.
- Private files live under `globalStorageUri/profiles/user` and
  `globalStorageUri/profiles/roots/<root-path-hash>`, outside Note/Skill/Sync
  assets by default. Schema `pkm.profile/v1` uses UUID identity, monotonically increasing
  revision and update time. Cross-process locks, revision CAS, atomic writes and
  0600 files prevent stale windows from overwriting accepted changes. Each
  registry is capped at 1,000 records including deletion tombstones.

### Optional root-owned Profiles and GitHub Sync

This phase includes **User / Agent Profiles only**. Long-term SQLite Memory,
Chat history, credentials, local consent and execution state are not Profile
Sync content.

1. Open **Profiles → Profile storage / GitHub Sync**. The confirmation previews
   both private and repository cards, including identities, revisions and
   deletion tombstones. Cancel leaves storage unchanged.
2. If the Knowledge Root has no `profiles` directory, accepted migration
   atomically copies current cards into `profiles/user/<uuid>.json` and
   `profiles/agent/<uuid>.json`. Original private copies and historical attempt
   snapshots remain unchanged. If the directory already exists (including an
   empty directory), explicitly adopt those repository cards instead; never
   overwrite or automatically merge them with this Host's private cards.
3. Local approval lives under
   `globalStorageUri/profiles/sync/<root-path-hash>.json`, outside Sync content.
   User Profiles in repository mode belong to that Knowledge Root, **not**
   every knowledge library on the Host. Other roots stay private by default.
   A fresh device does not use downloaded cards until it separately approves
   local repository storage. Existing Chat Agent assignments do not change.
4. In **GitHub Sync**, explicitly select **User / Agent Profiles** under
   **Private**, then save and approve the destination. Approval binds the
   Knowledge Root, repository, branch and exact item/folder rules, including
   future cards covered by those rules. Changing destination or expanding the
   rules requires confirmation again. Profiles cannot be selected as Public;
   both public and private Profile selections start empty.

**Private is a content classification, not encryption or proof of a private
GitHub repository.** Cards are plaintext; anyone with repository access can
read them. Prefer a private repository and exclude secrets from cards. Future
edits within an approved selection may transfer normally. Older versions can
remain in Git history and other devices after a card is deleted.

Concurrent edits use revision plus loaded-card comparisons. Sync shares the
repository mutation lock with local editing and attempt capture. Divergent
Profile edits and independently created User identities go to the existing
manual conflict workbench; Profiles do not use automatic JSON field merges or
Agent-assisted merge. A resulting registry must have at most one active User.
Missing assigned Agents, malformed cards, unsupported manifests and stale
approval raise explicit errors, not a current-card fallback. Profile
publications declare the `profile-cards` manifest capability so older readers
cannot silently rewrite unsupported content.

**To stop transfer**, deselect Profiles in **every** Sync target and save.
**Use private Profiles** only switches this Host back to its preserved private
cards; it does not revoke target transfer, delete repository cards, remove
published copies/history or change other devices. Re-enable local repository
mode only after reviewing the current cards again. Sync deletion uses an
identity/revision tombstone with empty card fields; historical Chat snapshots
remain immutable until their Chat history is deleted.

### Shared behavior in both storage modes

- Creating an Agent does not assign it. Assignment is explicit per Chat, also
  usable by its native Agent Session / Project entry; temporary workers do not
  inherit Agent identity. No agent-selection inference from title, model or role.
- Every local attempt (including Retry) captures current applicable cards once.
  That snapshot is a mandatory separate system message, stable through tool
  rounds and included in existing context planning, native/HTTP budget validation
  and transport accounting. If it cannot fit, no model round is dispatched.
  No configured cards means no added Profile message.
- `ChatMessage.profileContext` uses `pkm.chat.profiles/v1`, separate from the
  strict execution context schema. It records full bounded card snapshots,
  ID/revision, per-card hashes, combined hash, exact context-message hash and
  `mandatory-context-plan` accounting. Existing round budget manifests prove
  inclusion; their prepared/sent status and transport receipts determine whether
  dispatch happened. A snapshot alone is not proof of a sent model request.
  Snapshots are immutable on history save, and use existing segmented history
  storage when needed, not a separate profile event store.
- Deletion erases the active card content and retains an identity/revision
  tombstone. It stops future use, does not modify running attempts and does not
  rewrite/remove historical Chat snapshots. Those remain until the corresponding
  Chat history is deleted. Other Chats referencing a deleted Agent must explicitly
  unassign it; a missing/deleted/corrupt card raises an error, never a fallback.
- A Portal attempt does **not** automatically load the controlled user's private
  cards. Only a bounded, explicitly supplied request snapshot can be applied.
  Protocol capability `profiles-v1` is advertised only when the executor wiring
  declares support. Unsupported Hosts reject explicit snapshots instead of
  dropping them. Request deduplication binds both prompt and snapshot; pairing,
  permission grants and model/MCP sends do not automatically disclose profiles.

### Parent integration: exact `extension.ts` wiring

No `extension.ts` edits are part of this slice. The existing Chat registration
already handles Profile cards. The remaining Portal forwarding is:

```ts
import type { PersonaSnapshot } from "./chat/persona-profiles";

// Alongside remoteChatExecutor / portalChatContext:
let portalProfileReview:
  ((chatId: string) => Promise<PersonaSnapshot | undefined>) | undefined;
// Add the optional final parameter to the existing executor declaration:
let remoteChatExecutor: ((prompt: string, signal: AbortSignal,
  requestId: string, chatId: string, observer?: PortalObserver,
  source?: PortalSource, profileSnapshot?: PersonaSnapshot) => Promise<unknown>) | undefined;
```

In `ensurePeer`'s `new PeerSession({...})` options, add
`profileSnapshots: true` **only after** connecting every forwarding step below:

```ts
execute: async (prompt, signal, requestId, profileSnapshot) => {
  // Preserve ALL existing authorization, cancellation and observation code.
  // Add profileSnapshot as the final argument to the existing call:
  const result = await remoteChatExecutor(
    prompt, localController.signal, requestId, owner.id,
    /* existing observer callback */,
    /* existing PortalSource object */,
    profileSnapshot);
  // Preserve existing result-sharing authorization / finally cleanup.
}
```

At API Chat shell initialization, replace the executor forwarding and add:

```ts
remoteChatExecutor = (prompt, signal, requestId, chatId, observer, source, profileSnapshot) => {
  if (!apiChat) throw new Error("PKM Chat is unavailable.");
  return apiChat.executeRemoteTask(prompt, signal, requestId, chatId, observer, source, profileSnapshot);
};
portalProfileReview = chatId => {
  if (!apiChat) throw new Error("PKM Chat is unavailable.");
  return apiChat.reviewPortalProfiles(chatId);
};
```

In the **local human** `"Send task"` branch, replace `peer.submit(prompt)`:

```ts
const owner = [...this.chatPortals.values()].find(item => item.room === room);
if (!owner || !portalProfileReview) throw new Error("Portal Profile review is unavailable.");
const snapshot = await portalProfileReview(owner.id);
const requestId = peer.submit(prompt, undefined, snapshot);
```

Keep the MCP `peer.submit(args.prompt, args.requestId)` path unchanged: no
implicit local-profile export and no model-triggered disclosure dialog.
Optionally show `profileSnapshot` in the existing controlled-side `approveTask`
dialog by accepting its third argument; never add it to generic telemetry or
public observations. Full explicit snapshots remain inspectable in local history.

Validation (no installation required):

```sh
./node_modules/.bin/tsc -p tsconfig.json --pretty false --noEmit
# Runtime tests require the full build: bare tsc overwrites bundled shared dist.
npm run build
# Keep runner-created fixture files inside this checkout:
mkdir -p tests/.profile-test-runtime
TMPDIR="$PWD/tests/.profile-test-runtime" node --test --test-reporter=dot \
  tests/test-persona-profiles.js tests/test-persona-profile-ui.js \
  tests/test-chat-context-contracts.js tests/test-peer-collaboration.js \
  tests/test-persona-profile-browser.js
rmdir tests/.profile-test-runtime
```

These cover private scopes, limits, concurrent edits/deletes, corrupted records,
immutable historical evidence, no-inference viewing/editing, explicit assignment,
actual HTTP model/tool rounds, mid-attempt edits, next-attempt/retry revisions,
budget rejection without dispatch, Portal default isolation/explicit snapshots,
capability rejection and snapshot-bound duplicate suppression. Live installed
UI / cross-Host Portal acceptance still requires parent integration and release;
isolated tests are not evidence that an installed Host has this build.

Combination/adoption coverage additionally exercises one explicitly assigned
Chat through HTTP model selection, native provider discovery/selection, a second
native model and a switch back through the real Settings handler. Every
successful request retains the User/Agent snapshot and exact pinned text; both
native image requests contain actual PNG data parts and counted transport
receipts. A Profile-assigned HTTP image attempt fails explicitly without dropping
the image, switching providers or dispatching a request. Assignment, attachments
and historical snapshots survive persistence across these switches.

The Chromium Profile test mounts the built Projects/Agent configuration renderer
and the complete built Chat webview. Mouse/keyboard activation propagates the
exact Session identity and `profiles` section into the actual Chat configuration
handler; mocked native VS Code dialogs inspect/edit cards and persist an explicit
assignment. Chat toolbar, Settings and Agent menu entries work with a busy Chat
state, without model discovery/inference or creating another Task. This verifies
browser-to-handler adoption with native dialog API doubles, not an installed
VS Code window or live provider/vision service. Project-wide defaults/inheritance
remain intentionally outside the v1 scope.

Fixture contract: every `ApiChatView` that sends must receive an explicit
fixture-private `globalStorageUri`, just as a real VS Code `ExtensionContext`
does. Worker and installed ctx-host fixtures now supply it; missing context is
not interpreted as an unconfigured Profile. The actual worker regression
verifies ordinary unconfigured manager/worker HTTP dispatch with no Profile
message/card creation, and verifies that missing Host storage and genuine
`ENOTDIR` Profile storage errors still stop dispatch explicitly.

`tests/ctx-host/persona.js` exports `run(extension, fixtureRoot, phase)` for the
existing installed ctx-host runner after its installed-VSIX / isolated-root
gates. It loads the supplied extension's actual modules, stores cards only under
`fixtureRoot/persona/private-host`, and uses the fixture Knowledge Root's real
Chat state directory to satisfy execution ownership checks. Initial acceptance
makes exactly two loopback-only HTTP requests, edits/deletes the cards, checks
the actual sent budget manifests/transport hashes and writes bounded fixture
evidence. The restart phase requires a different process, makes no model
request and checks the same immutable historical evidence and deleted-card
non-reuse. `tests/test-persona-installed-helper.js` smoke-tests both phases in
fresh Node processes with a VS Code API double; it is not itself evidence of an
installed VSIX run.

## Development order

### P0: readable, truthful PKM Chat execution

1. **Readable Activity slice.** Show file globs, query/scope, requested file
   ranges and edit targets in row labels. Keep arguments/results expandable.
   Reuse the same descriptions in Harness tool graphs, with original call
   names and IDs retained. Live activity is initially expanded; an explicit
   collapse/expand choice survives refresh and completion.
2. **Truthful timing and usage.** Use recorded dispatch/result time, not CPU
   time or remote-job duration. Attach reported input/output/reasoning tokens
   to the actual model round, not every tool. Missing usage is unknown.
   Public provider summaries remain inspectable at that round; unsupported
   providers do not get invented thinking text.
3. **Daily-task acceptance.** Exercise read/search/edit/test, approvals,
   Stop, failure, Retry, history and cross-window ownership. A dispatch
   receipt is not completion; an interrupted side effect is not safe to replay.
   Browser fixtures are necessary, not a substitute for a real large task.
4. **Resource checks.** Measure before optimizing. First validate whether
   per-fragment public-summary persistence needs the same coalescing as text.
   Bound view/history work and clean test-owned services without changing
   durable production-service semantics.

Actual local GitHub Sync conflicts remain an independent open blocker.
Isolated regression success or this document does not mark them resolved.

### P1: profile vertical slice

The local v1 slice above delivers User/Agent Profile CRUD, persona cards,
snapshots and context accounting together. Portal forwarding and installed
cross-Host acceptance remain the explicit parent-owned integration/release gate.
Verify unconfigured compatibility, concurrent edits, deletion, historical
inspection, overrides, read-only viewing and zero model/tool calls when opening
cards; do not ship a role picker that only changes a visible name.

### P1: Memory / Retrieval transparency

Replace the illustrative per-kind Memory pyramid with views grounded in the
actual organization and execution receipts. Trace recalled/materialized/
selected/excluded/missing/stale/sent assets by attempt and model round.
Clarify requested/prepared/served routes and fallback; do not infer an external
engine's unreported internal phases. Continue under MEM-04 / RET-07.

### P2: evidence-led architecture improvements

Review fact ownership, lifecycle/disposal, dependency settlement and failure
recovery against the references below. Change abstractions only for a verified
bug or a demonstrated need. No blanket plugin-framework migration, automatic
self-modifying harness, aggressive agent fan-out or automatic process killing.

## Reference use

The research scope is the five repositories supplied by the user. These are
design references, not adopted dependencies, verified performance promises or
instructions to install/run external workflows.

| Reference | Examined revision | Useful question |
|---|---|---|
| [Harness2](https://github.com/google-research/harness2) | `1cfe254e8d25b15f37048c3730134686abe60335` | Can improvements be compared with evidence and rolled back? |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `687f282e8625c6b8d11ff58211a90524be2e4317` | Are durable facts, live events and scoped lifecycle effects clearly separated? |
| [Matt Pocock Skills](https://github.com/mattpocock/skills) | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | Do workflows reproduce the actual symptom and verify public behavior? |
| [Ponytail](https://github.com/DietrichGebert/ponytail) | `09c434ab73ca43761c5d8b0c5d341926c2fba710` | Can existing capabilities solve the full problem without another abstraction? |
| [Orca](https://github.com/stablyai/orca) | `301059fb77d083eb93c744f20c5a89906d8c4c3a` | Can users find waiting agents, inspect ownership and recover without wasting resources? |

Initial research is partial. Distinguish confirmed bugs, testable design risks
and intentional PKM product differences. Link findings to concrete code and
trigger conditions before making implementation claims.
