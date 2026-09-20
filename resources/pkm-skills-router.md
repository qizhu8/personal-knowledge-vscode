---
name: PKM Skills
description: "Use when: starting substantial coding, research, debugging, or workflow tasks that may benefit from personal conventions or domain knowledge; also use when reusable knowledge should be added to or updated in PKM."
tags:
  - pkm
  - copilot
  - skill-router
  - knowledge-management
type: system
router_version: 1.1.6
created: 2026-08-12
---

# PKM Skills

PKM is the canonical source for personal, workflow, and domain-specific skills. Native `SKILL.md` files are generated discovery adapters and are not independent sources of truth.

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
