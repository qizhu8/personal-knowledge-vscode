# User / Agent Profiles and PKM Chat priorities

Status: proposed design, 2026-10-22. Profile storage, UI and request integration
are not implemented. The first implementation slice is readable Chat Activity;
it does not depend on introducing a Profile system or another harness framework.

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
Projects: communication, collaboration, development and verification habits.
Do not store credentials, inferred sensitive traits, project facts, temporary
instructions or entire conversations.

Proposed record: schema, stable ID, revision, updated time, and short preference
entries. V1 should use direct user editing. Memory may eventually suggest an
update, but must not silently promote a guess to an accepted preference.

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

These are design recommendations, not authorization to migrate user data:

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
- Deletion stops future use. Retention of historical persona snapshots needs
  an explicit privacy policy and user-visible behavior before implementation.
- Validate revisions/conflicts across windows. Never overwrite concurrent
  edits with an old loaded card or recover a deleted profile silently.

Storage identity across local/remote hosts and historical deletion semantics
are implementation gates to settle before shipping Profile persistence.
They do not block the Activity work below.

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

Settle the storage/privacy gates; then deliver User/Agent Profile CRUD and
persona cards together with request snapshots and context accounting. Do not
ship a role picker that only changes a visible name. Verify unconfigured
compatibility, concurrent edits, deletion, historical inspection, overrides,
read-only viewing and zero model/tool calls when opening cards.

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
