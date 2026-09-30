---
name: PKM Skills
description: "Route substantial work into PKM guardrails without adding orchestration that does not change execution."
tags:
  - pkm
  - copilot
  - skill-router
  - knowledge-management
type: system
router_version: 1.7.0
created: 2026-08-12
---

# PKM Skills

PKM is the canonical source for personal, workflow, and domain-specific skills. Native `SKILL.md` files are generated discovery adapters and are not independent sources of truth.

## Agent Snapshot Creation Fast Path

When a user asks to create, generate, or save an Agent Snapshot, use the
PKM-provided `Create Agent Snapshot` Recipe under
`System/PKM/Agent Sessions`. Search for that exact built-in, start its pinned
revision and digest, then call `recipe_run_next`. Its native operation creates
and verifies the Snapshot in-process without an Agent-executed step.

Return the Recipe's reusable Magic Code recovery prompt to the user. No
recovery password exists. The Snapshot payload is stored with PKM's fixed local
`uone` obfuscation key only to avoid plaintext on disk; it is not credential
protection and must not be described as security encryption.

Do not replace a missing built-in with an ad hoc Recipe. Report that the
installed Extension or MCP runtime needs upgrade/repair so the System Recipe
identity, executable digest, and allowlisted native operation remain pinned
together.

## Agent Snapshot Recovery Fast Path

When a user pastes `Recover PKM Agent Snapshot PKM-SNAP-...`, call
`pkm.agent_session_snapshot_recover` immediately with that Magic Code. This
recovery call creates and activates the successor Agent Session, so do not call
`agent_session_start` first. After successful recovery, follow the returned
`next_action` and continue the restored todos and Recipe runs.

If recovery reports that the Snapshot is absent from the current Knowledge
Root, do not create a replacement Session that looks recovered. Explain that
the Magic Code identifies the Snapshot but does not contain the locally
obfuscated payload. The Agent Snapshot record must first be restored from the
origin Knowledge Root or an explicitly configured GitHub Sync backup.

## Managed Task Routing

For a substantial mutating task, call `pkm.agent_session_start` before the first
substantive edit or operational mutation. Call `agent_session_capabilities`
only when the tool contract is not already available in the current
conversation or its version changed. A substantial task is a user goal that
needs multiple execution or validation steps and benefits from durable
progress/recovery state. Use one Agent Session for the user goal.

Do not start an Agent Session for assessment, explanation, code review, or
read-only diagnosis, even when several reads or tests are needed, unless the
user asks for durable tracking or the work is likely to continue across turns.
Also skip it for a quick answer, trivial command, or casual conversation. When
the host chat/session ID is available, pass it as `host_session_id`.

At the start of every later user turn while work may still be active, call
`pkm.agent_session_status` before planning or using tools. Reconcile the new
instruction against the durable running and pending todos. This turn gate is
mandatory: do not rely on chat memory alone and do not begin the new request
until earlier unfinished work has been preserved, explicitly redirected, or
explicitly cancelled.
Use its default compact projection for this turn gate. Request `detail=full`
only when complete historical todos, checkpoints, or receipts are specifically
needed for recovery or diagnosis.

After starting a substantial task, append a small outcome-oriented plan with
`pkm.agent_session_todo_append`, then claim work with
`pkm.agent_session_todo_next`. Report a todo as `succeeded`, `failed`, or
`skipped` with `pkm.agent_session_todo_report` only after obtaining relevant
evidence. Prefer one to three durable outcome Todos; do not create separate
Todos for narration, status summaries, or steps already enforced by a Recipe.
Keep report summaries concise and evidence-oriented. Session todos are the
ordered user-goal backlog; Recipe runs may provide a more detailed executable
graph only when they add control value.

When a later user instruction arrives, classify it before changing the queue.
If it replaces, contradicts, or cancels earlier work, treat it as a redirect and
state which unfinished todos are affected, then call
`pkm.agent_session_todo_replan` to interrupt, update, or cancel them. When the
user asks for an explanation or status before work continues, interrupt the
running todo with a `report_status` action; complete that action only after
reporting to the user, then claim the automatically resumed todo. If the new
instruction adds non-conflicting work, append new todos at the tail
with a new idempotent `command_id`; do not abandon, reorder, or preempt the
running and pending todos. A valid payload is
`[{"title":"Implement change","details":"Preserve existing behavior"},{"title":"Validate","details":"Run focused tests"}]`.

Checkpoint only at useful recovery boundaries. End the Agent Session after the
overall user outcome is validated. Omit the Session-end summary when Todo
outcomes already contain the evidence; do not restate the final answer in
durable state.

## Before Substantial Work

Use `pkm.skill_context` when personal conventions, domain knowledge, or a
project-specific procedure could materially change execution. Repository-local
inspection with an obvious native workflow does not need Skill retrieval.
Call `skill_capabilities` only when its contract is not already available or
its version changed.

If `skill_context` returns `disabled: true` or `no_match: true`, continue with
native tools. Fetch only candidates you will actually apply with
`pkm.get_skill`; follow every `required` Skill and retain its ID/hash for
feedback. Reuse an already loaded applicable Skill during the same task instead
of retrieving it again.

Do not load the entire Skill catalog. Prefer the smallest relevant set.

## Recipe Discovery and Evolution

Use a Recipe only when its executable graph adds a guardrail that ordinary Todo
tracking does not provide: branching, bounded repetition, a mandatory human
gate, a pinned reusable procedure, a background command, or an allowlisted
native operation. Linear inspect → edit → validate work should stay in the
Agent Session Todo and native tools.

For a Todo that needs those controls, call `pkm.recipe_search` once with the
complete task contract. Call `recipe_capabilities` only when its contract is
not already available or its version changed. Qualify candidates by purpose,
inputs, outputs, constraints, and graph shape rather than name or score alone.

Use a qualified Library Recipe with its pinned revision and executable digest.
A no-match result is valid. Create an ad hoc Recipe only when the required
control graph still exists; never create a one-node noop Recipe merely to
represent work already tracked by a Todo. The Agent Session Todo remains the
durable cross-turn commitment. Report it complete only after any attached
Recipe is terminal and the outcome has independent validation evidence.

Recipe action tools return compact state by default. Request full run detail
only when historical node results, usage, or observability diagnostics are
needed.

After execution, record concrete friction and reusable evidence. When a Recipe
should be corrected or expanded, use the advertised Recipe authoring/proposal
action if available. If persistence is unavailable, preserve a reviewable
design proposal and state the limitation explicitly; never claim the Recipe was
updated. Create a new Library Recipe only for a recurring, stable workflow that
is not already covered.

## Broker Skills

`pkm.skill_context` and `pkm.search_skills` include subscribed Broker Skills alongside local Skills. Broker Skill IDs are canonical `pkm://subscriptions/...` paths; use the returned ID with `pkm.get_skill` and retain its provenance. Broker Skills are read-only: do not create maintenance proposals for them or copy them into the local Knowledge Root.

## Unified Retrieval

Each Subscriber maintains one typed index containing its local Skills, Notes, and Scripts plus content from every subscribed Broker. Use `pkm.search_knowledge` for explicit cross-content retrieval; query type words are soft preferences, while `content_type_filter` is strict. Model-based routing is currently disabled. If `search_knowledge` returns `disabled: true`, continue with Copilot's native search tools. Use `pkm.retrieval_status` to inspect the ready corpus revision.

## Maintaining Skills

When the work reveals reusable knowledge:

1. Call `pkm.skill_feedback` with the Skill IDs used, outcome, and evidence.
2. Call `pkm.propose_skill_update` when a concrete reusable change is justified.
3. Include the Skill ID, base content hash, reason, evidence, and proposed content or patch.
4. Do not edit generated native `SKILL.md` projections.
5. Do not directly overwrite a formal PKM Skill unless the user explicitly requests it.
6. Let the user review proposals in PKM before formal knowledge changes.

Create a new Skill proposal only when the learning is reusable across sessions, evidence supports it, and no existing Skill owns the knowledge. Prefer updating an existing Skill over creating a duplicate.

## Safety

Never store credentials, tokens, personal secrets, or transient task state in a Skill. Separate verified reusable procedures from hypotheses and one-off observations.
