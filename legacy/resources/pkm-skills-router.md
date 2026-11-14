---
name: PKM Skills
description: "Use at the start of every multi-step agent task: coding, implementation, bug fixes, refactoring, research, analysis, diagnosis, or code review. Retrieves personal Skills and Recipes and reads PKM Agent Snapshots; skip quick answers, trivial commands, and casual conversation."
tags:
  - pkm
  - copilot
  - skill-router
  - knowledge-management
type: system
router_version: 2.0.0
created: 2026-08-12
---

# PKM Skills

PKM is the canonical source for personal, workflow, and domain-specific skills. Native `SKILL.md` files are generated discovery adapters and are not independent sources of truth.

## Agent Snapshots (read-only)

PKM Agent Sessions belong to PKM Chat. External agents do not start, track,
checkpoint, or recover Agent Sessions, and there are no `agent_session_start`,
`agent_session_todo_*`, or `agent_session_snapshot_recover` tools.

When a user pastes an Agent Snapshot Magic Code (`PKM-SNAP-...`) or asks you to
continue or inspect captured work, call `pkm.agent_session_snapshot_read` with
that Magic Code. It is read-only and never creates an Agent Session. It returns
the task, todos, checkpoints, the latest checkpoint state, and — for Snapshots
captured from PKM Chat — Recipe run states and recent conversation. Snapshots
from other agents contain no Recipes. Continue the work in your own context from
that state; use `pkm.agent_session_snapshot_list` only to find a Snapshot.

If the Snapshot is absent from the current Knowledge Root, explain that the
Magic Code identifies the Snapshot but does not contain its locally obfuscated
payload; the record must first be restored from its origin Knowledge Root or an
explicitly configured GitHub Sync backup. Never present new work as recovered.

To create a Snapshot or recover one into a new PKM Chat with its own Task,
direct the user to the Agent Snapshots panel in PKM. The payload uses PKM's
fixed local `uone` obfuscation key only to avoid plaintext on disk; it is not
credential protection and must not be described as security encryption.

## Multi-step Task Tracking

Track multi-step work with your host's native plan or todo facility. Prefer one
to three outcome-oriented steps, report a step complete only after obtaining
relevant evidence, and keep goals, results, and evidence in their owning
runtime records without copying the conversation into durable state.

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

Use a Recipe when it provides a validated reusable solution, reliable Script automation,
or useful task structure: dependencies, parallel exploration, bounded repetition,
or necessary human decisions. A mature linear Recipe is a valid match; do not
reject it merely because the task has no branches. Ordinary work without a
matching solution or useful structure can stay in Session todos and native tools.

For a Todo that could reuse a solution or benefit from structure, call `pkm.recipe_search` once with the
complete task contract. Call `recipe_capabilities` only when its contract is
not already available or its version changed. Qualify candidates by purpose,
inputs, outputs, constraints, and graph shape rather than name or score alone.

Use a qualified Library Recipe with its pinned revision and executable digest.
A no-match result is valid. Create an ad hoc Recipe only when a task-specific
solution or useful decomposition adds value; never create a one-node noop Recipe merely to
represent work already tracked by a Todo. The task step remains the
cross-turn commitment. Report it complete only after any attached
Recipe is terminal and the outcome has independent validation evidence.

For a qualified recurring Recipe, call `recipe_usage_summary` with its
`recipe_id` only when past execution cost or failure patterns could change
the run plan. Compare the matching revision, not aggregate results from older
definitions. Repeated failures or retries are a hint to inspect that node and
its current prerequisites before execution, not proof that the Recipe is wrong;
unknown token usage is not zero cost. Keep raw run history out of the task
context unless the compact summary identifies a specific failure to inspect.

Recipe action tools return compact state by default. Request full run detail
only when historical node results, usage, or observability diagnostics are
needed.

A failed attempt is a valid result, not a requirement to retry until success.
Distinguish insufficient model capability, an unclear Recipe, and an infeasible
path only when evidence supports the diagnosis; otherwise retain uncertainty.
Follow the applicable failure policy: retry within budget, use a stronger model,
try a new or revised Recipe, or record the result and continue where dependencies
permit. Preserve earlier attempt evidence; never treat a failed prerequisite as
a successful output. Do not claim automatic Script execution, model escalation,
or multi-agent scheduling unless the runtime actually supports that operation.

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
