---
name: PKM Skills
description: "MUST use for every substantial coding, research, debugging, or operational task, and again when later user instructions arrive, to preserve Agent Session todos and execute work through Recipes."
tags:
  - pkm
  - copilot
  - skill-router
  - knowledge-management
type: system
router_version: 1.5.0
created: 2026-08-12
---

# PKM Skills

PKM is the canonical source for personal, workflow, and domain-specific skills. Native `SKILL.md` files are generated discovery adapters and are not independent sources of truth.

## Managed Task Routing

For a substantial task, call `pkm.agent_session_capabilities`, then call
`pkm.agent_session_start` before the first substantive edit or operational
mutation. A substantial task is a user goal that needs multiple execution or
validation steps, benefits from progress/recovery state, or may continue across
turns. Use one Agent Session for the user goal, not one per todo item.

Do not start an Agent Session for a quick answer, a single read-only lookup, a
trivial one-command request, or casual conversation. When the host chat/session
ID is available, pass it as `host_session_id` so related tasks remain grouped.

At the start of every later user turn while work may still be active, call
`pkm.agent_session_status` before planning or using tools. Reconcile the new
instruction against the durable running and pending todos. This turn gate is
mandatory: do not rely on chat memory alone and do not begin the new request
until earlier unfinished work has been preserved, explicitly redirected, or
explicitly cancelled.

After starting a substantial task, append its actionable plan with
`pkm.agent_session_todo_append`, then claim work with
`pkm.agent_session_todo_next`. Report a todo as `succeeded`, `failed`, or
`skipped` with `pkm.agent_session_todo_report` only after obtaining relevant
evidence. Session todos are the ordered user-goal backlog; Recipe runs may
provide a more detailed executable graph for the currently running todo.

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
overall user outcome is validated; do not equate a completed checklist with a
validated outcome.

## Before Substantial Work

For coding, research, debugging, operational workflows, or domain-specific tasks:

1. Call `pkm.skill_capabilities` to discover the current PKM Skill workflow.
2. Call `pkm.skill_context` with the task and relevant workspace, file, and diagnostic context.
3. If it returns `disabled: true`, immediately continue with Copilot's native search tools; this is the automatic fallback contract.
4. If it returns `no_match: true`, continue without a PKM Skill; do not force a weak match.
5. Review the returned summaries and call `pkm.get_skill(skill_id)` only for candidates you will apply.
6. Follow every returned `required` Skill and apply `recommended` Skills when they fit the task.
7. Keep each returned `skill_id` and `content_hash` for maintenance feedback.

Do not load the entire Skill catalog. Prefer the smallest relevant set.

## Recipe Discovery and Evolution

For every claimed substantial todo, call `pkm.recipe_capabilities` and
`pkm.recipe_search` before inventing its execution plan. Apply this to coding,
research, debugging, and operational work; the user does not need to mention a Recipe,
Recipe Library, or workflow. Start a qualified Library Recipe when one
matches. Otherwise start an ad hoc Recipe run that represents the intended
steps and validation. Do not execute a substantial todo outside a Recipe run
merely because search returned no match.
Pass the complete task contract and qualify candidates by purpose, inputs,
outputs, safety constraints, and graph shape rather than name or score alone.

Use a qualified Library Recipe with its pinned revision and executable digest.
A no-match result is valid: use an ad hoc Recipe rather than forcing a weak
Library match or misrepresenting a Skill as a Recipe. The Agent Session todo is
the durable cross-turn commitment; its linked Recipe run is the executable
graph for that todo. Report the todo complete only after the Recipe is terminal
and the requested outcome has independent validation evidence.

For an ad hoc plan, use supported workflow nodes rather than guessing a node
kind. The minimal definition is
`{"schema":"pkm.workflow.definition/v1","spec":{"inputs":{},"nodes":[{"nodeId":"work","kind":"pkm.step.noop/v1","config":{},"dependsOn":[]}],"outputs":{},"completion":{"requiredNodes":["work"]}}}`.

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
