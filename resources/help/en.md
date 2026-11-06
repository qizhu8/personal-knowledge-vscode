# Your practical guide to PKM

PKM helps you keep useful knowledge, find it again, and give an AI assistant enough context to do real work. Start small: **save one Note, reopen it, then ask an Agent to use it**. You do not need to configure every feature.

This guide is for using PKM, not developing it. The links open the corresponding PKM page. **Copy Agent request** only copies an example: paste it into your chosen chat, replace the bracketed details, and review what the Agent plans to do.

## 1. Start with your first Note

**Use it for:** meeting notes, decisions, troubleshooting steps, or anything you would otherwise lose in chat history.

1. Open [Notes](pkm-help:notes), click **Note**, and choose Markdown.
   If you have not selected a Knowledge Root yet, open [General & MCP](pkm-help:mcp) and choose a folder for your knowledge first. This is a storage choice, not a requirement to finish MCP setup.
2. Give it a meaningful title and folder, write a few lines, and save.
3. Select it again in the list to check it was saved. Use the search box to find it later.
4. Right-click the Note and copy its PKM path when you want an Agent to use that exact source.

Your Knowledge Root is the folder where PKM stores your content. Ordinary Notes and Skills are Markdown files. **Basic Notes and Skills do not require Python, MCP, or a downloaded embedding model.** Todo Boards are different: use their guarded controls, not direct Markdown edits.

A copied PKM path identifies the source; it does not grant access. If your chosen Agent cannot read it with its current tools, open the Note and paste the relevant content or attach its Markdown file. Configure MCP later if you want an external Agent to read/write PKM through tools.

```agent
Read this PKM Note: [paste its copied PKM path].
Summarize the decisions and unresolved questions. Preserve the original Note.
Show which statements are supported by the Note and which need clarification.
```

## 2. Choose the right home for your work

| What you want to keep or do | Where to go |
| --- | --- |
| Facts, meeting notes, decisions | [Knowledge → Notes](pkm-help:notes) |
| Reusable instructions or a proven way of doing something | [Knowledge → Skills](pkm-help:skills) |
| Papers, conclusions, citations, research ideas | [Knowledge → Research](pkm-help:papers) |
| Versioned prompt templates | [Tools → Prompts](pkm-help:prompts) |
| Reusable code, scripts, runtime environments, local services | [Tools → Scripts](pkm-help:scripts), [Packages](pkm-help:packages), [Environments](pkm-help:environments), [Servers](pkm-help:servers) |
| A task contract, owner, dependencies, and acceptance | Create a **Todo Board** from [Notes](pkm-help:notes) |
| Persistent conversations and projects | [PKM Chat](pkm-help:chat), [Projects](pkm-help:projects), [Threads](pkm-help:chatroom) |
| Repeatable automated workflows | [Automation → Recipe Library](pkm-help:recipes) |
| Configuration, sharing, sync, background work | [General & MCP](pkm-help:mcp), [Sharing & Subscribe](pkm-help:subscriptions), [GitHub Sync](pkm-help:githubSync), [Background Tasks](pkm-help:backgroundTasks) |

You can use only the parts you need. A Project groups work; a Note stores knowledge; a Todo Board tracks commitments. They are not interchangeable.

### Research and reusable tools: a quick start

- **Research:** right-click a folder/group and choose **New Paper…** or **New Idea…**. Record the source, the conclusion, and what is still a hypothesis.
- **Prompts:** right-click the project/task/version folder and choose **New Prompt…**. Use versions and comparison to keep improvements traceable instead of overwriting a useful baseline.
- **Scripts:** right-click a folder and choose **New Script…**. Describe inputs and expected output. Review code and prerequisites before executing it.
- **Packages:** **Import Git** captures a source snapshot of a branch; it does not install dependencies or prove the code works.
- **Environments / Servers:** register the actual environment on this machine; inspect a service's configuration and status before starting it. These executable resources need runtime prerequisites even though reading Notes does not.

```agent
Help me with [a research question or recurring script/prompt workflow].
Find existing PKM material first. Suggest the right content type and a small
draft with sources, inputs, expected output, and verification.
Separate evidence from hypotheses. Do not execute code, install dependencies,
or overwrite an existing version until I approve.
```

## 3. Find knowledge and make it reusable

Use the content search box for the current collection. For an Agent, supply copied PKM paths when you know the source; otherwise ask it to search and explain what it selected.

The default Exact/BM25 retrieval does not need an embedding model. [Router](pkm-help:skillRouter) offers optional semantic retrieval and performance observations; leave those settings alone until the basic workflow is useful. Missing quality labels or timing data means **unknown**, not zero or proven improvement.

A **Skill** is a reusable procedure: explain when it applies, the steps, prerequisites, expected output, and how to verify the result. Do not turn guesses from one failed attempt into a proven Skill.

```agent
Find my PKM knowledge about [topic]. Read the most relevant sources and cite their PKM paths.
Turn the verified procedure into a draft Skill: when to use it, prerequisites,
steps, expected output, and verification. Keep uncertain points explicit.
Ask before replacing an existing Skill.
```

## 4. Ask an Agent to do useful work

[PKM Chat](pkm-help:chat) lets you choose a model, context, tools, and permissions. An external Copilot or other Agent can use PKM through MCP when that client is configured and its tools are enabled.

A good request includes **goal + sources + allowed changes + expected result + verification + stopping condition**. You do not need to know every tool name: the Agent should discover the available tools, check prerequisites, then act.

```agent
Goal: [what I want to achieve].
Context: [copied PKM paths and relevant files].
Allowed changes: [specific files/items]. Do not modify [out of scope].
Deliver: [a Note, patch, comparison, or other concrete result].
Verify with: [test, readback, or measurable criterion].
Stop when verified, or report the blocker with evidence. Do not install,
publish, delete, or change permissions without my approval.
```

Inspect the Chat's tool activity and results instead of relying only on its final wording. A successful tool call is not automatically a successful task. Tool actions can already have happened when you cancel: **check recorded results before retrying**, especially writes or remote submissions.

Model calls can incur charges. A tool-round limit is not a time or credit limit. Keep requests bounded and prefer one finished, saved slice over a large unfinished exploration.

## 5. Track tasks with a Todo Board

In [Notes](pkm-help:notes), create a Note and choose **Todo Board**. A Board has structured Work Items with goals, scope, acceptance criteria, dependencies, owners, evidence, and Table/Board/Timeline views.

- Write what “done” means before assigning work.
- Assign to yourself, a PKM Chat, or an explicitly authorized external worker.
- **Assignment alone does not start an Agent.** Open the chosen chat and explicitly ask it to take the task.
- Workers report their outcome and evidence. **Reported Done is not accepted**; review and accept separately.
- External workers must use the Board's authorized command tools. A distinct worker identity may require a Board-scoped token copied from the UI. Treat it as a secret; never paste it into public Notes.

Open a Work Item to inspect its contract and evidence; **Accept** records your review decision. For an external worker, save its assignment first, reopen the item editor, and use **Copy / rotate external worker token** when available. Copying a token is not permission to broaden the assigned scope.

```agent
Read the Todo Board [copied Board path] and Work Item [ID].
Check its current scope, dependencies, owner, and acceptance criteria.
If authorized and available, claim it using PKM's task tools, then do only that work.
Record verification and evidence. Do not edit Board Markdown/JSON directly,
claim another Agent's work, or mark your own output accepted.
```

## 6. Separate a conversation, a Task, and a Worker

A Chat is your ongoing conversation. A PKM Chat **Task** gives work a persistent execution context; its Agent Session can be inspected in [Automation → Agent Sessions](pkm-help:agentSessions). An Agent Session is not the same as a Todo Board item.

For quick questions, ordinary Chat is enough. For longer work, explicitly create/select the appropriate Task in PKM Chat. External Agents cannot create or manage PKM Chat-only Agent Sessions; they can work on authorized Boards and use other available PKM tools.

In PKM Chat, the checklist **Start Task** control opens the managed-task start flow. Review the selected Chat's tools and permissions first. During an active response, **New task** queues a new request instead of steering the current one; that input mode is not itself a managed Agent Session.

Workers are child Chats for **independent pieces** of work. Parallelism is not automatically faster or cheaper. Keep write scopes disjoint and have the parent integrate and verify the combined result.

```agent
Split this task only if there are genuinely independent pieces.
Give each Worker a goal, exact sources, non-overlapping write scope,
expected output, verification, and stop condition.
Keep shared builds and final acceptance in the parent. Do not let Workers
edit the same file or spawn more Workers unnecessarily.
```

## 7. Keep a useful fact without confusing Memory and Notes

Notes are explicit knowledge documents you can organize and share. Memory is for durable scoped facts or conventions, not a replacement for the source document or task tracker.

When using explicit Memory tools, state the scope and source. External MCP can propose/read Memory, but confirmation of explicit long-term Memory requires the appropriate local decision. Do not assume “remember this” means the fact is already confirmed or recalled into every future prompt.

Review and confirm the proposal in the local PKM Chat when its Memory decision prompt appears; an external tool response cannot perform that confirmation for you.

```agent
Propose this verified convention as scoped Memory for [this project]:
[convention]. Source: [exact reference].
Check for an existing equivalent before adding it. Do not store secrets
or personal data. Tell me whether it is proposed or confirmed.
```

## 8. Reuse a workflow with Recipes and Actions

Use [Recipe Library](pkm-help:recipes) when you repeat a stable process with known inputs and outputs. A Recipe is a reusable workflow; its run is a particular execution. Start with existing Recipes and their intent, inputs, and attached knowledge before creating another.

[Action Library](pkm-help:actionLibrary) and [Action Workbench](pkm-help:actions) are for reusable Actions and their execution. Scripts, pipelines, local environments, and external CLI tools still need their own dependencies, authentication, and approval.

```agent
I repeatedly do [workflow]. Search the PKM Recipe Library first.
Compare existing Recipes with my inputs [inputs] and expected result [output].
Prefer reuse or a small extension. Propose a new Recipe only if no close match fits.
Explain prerequisites, effects, approval points, and verification before running it.
```

System Recipes are protected built-ins, not personal files to overwrite. Validate a workflow before running it. Never interpret a diagram or saved Recipe as evidence that it has executed successfully.

## 9. Organize projects and collaborate

[Projects](pkm-help:projects) groups longer-running work. Use [Threads](pkm-help:chatroom) for conversations linked to that work; use the Project timeline/Gantt for planned dates and observed progress.

For collaboration, specify a primary worker, expected output, current context, reviewers, and a decision. A progress update, handoff, completion claim, and review decision mean different things. Keep blockers explicit instead of exchanging endless “please continue” acknowledgements.

```agent
For Project [name], organize [objective] into a few concrete tasks.
For each, propose the primary owner, scope, dependencies, expected output,
acceptance criteria, and reviewer. Link the existing Notes and Threads.
Do not assign people or start Agents until I confirm.
```

## 10. Share knowledge without exposing everything

[Sharing & Subscribe](pkm-help:subscriptions) lets you share selected knowledge or subscribe to a Broker without merging it into your own collection. [GitHub Sync](pkm-help:githubSync) is for explicitly selected publication/sync and backup targets. [Portal Connections](pkm-help:portalConnections) connects supported portal experiences.

Review what is public/private before publishing. Repository access exposes committed content and history; a PKM selection is not per-file security for Git readers. Private browser content and guest access have their own boundaries.

```agent
Prepare a sharing plan for [selected PKM items].
Show the target, included content, assets, privacy settings, and access boundaries.
Check for credentials or private material. Do not publish, push, create invites,
or change access until I review and approve the plan.
```

Invites, Magic Links, and worker tokens can grant access. Do not put them in public knowledge, screenshots, or commit history.

## 11. Recover work with an Agent Snapshot

Open [Agent Snapshot](pkm-help:agentSnapshots), choose a PKM Chat Task, and create a snapshot of the captured task state. **Copy Read Prompt** lets an Agent read that snapshot without creating a new Session. **Recover into New PKM Chat** starts a separate recovery path.

The copied prompt requests reading; it does not change the Agent's permissions or prevent other enabled tools from writing. Keep the request and tool permissions read-only for inspection.

```agent
Read this existing PKM Snapshot: [paste Copy Read Prompt information].
Summarize the goal, completed work, blockers, and remaining verification.
Inspect current files/results before continuing. Do not replay earlier
mutations or remote submissions just because a conversation stopped.
```

A Snapshot is not a backup of every file. Its record/payload must still exist locally or be restored from an explicitly selected backup. GitHub Sync Snapshot backup is not enabled by default. Snapshot payload obfuscation is not protection against an attacker; do not treat it as a secure secret vault.

## 12. Enable MCP only when you need AI integration

Open [General & MCP](pkm-help:mcp) or [choose Python](pkm-help:setup).

1. Select a Python 3.10+ base interpreter; use List Pythons or Browse, then Validate & Save.
2. PKM creates its isolated `pkm-mcp` environment, installs packages, generates the service, and checks runtime health. Watch the actual phase/output.
3. Configure the **client you will use**, then confirm discovery and an actual `check_version` call in that client.

The VS Code project interpreter and PKM base Python are different. For Remote SSH, use Python on the remote host; a remote Linux configuration does not configure a Windows-local client.

VS Code native Agent discovery and Copilot CLI/SDK registration are separate. Do not duplicate an existing server within one client. Registration does not itself grant trust, start the server, or prove tools are visible. Runtime ready, retrieval scheduled, and client verified are different states.

```agent
Diagnose why this client cannot use PKM MCP.
Identify the actual host/client, Python, managed runtime, registration,
trust/start state, and whether check_version is available.
Report the first blocking step and the smallest safe next action.
Do not edit registrations, install packages, change permissions, or stop
processes until I approve.
```

No Python found? Install Python 3.10+ on the target host and scan again. A package download failure should show details and a retry path; “Later” defers setup, not completion.

## 13. When something is slow, blocked, or failed

Problem banners offer the next relevant action and a link to the appropriate
section of this guide. Opening guidance does not install, delete, publish, or
repeat an Agent request. Setup/environment warnings clear after a healthy status
is observed; opening guidance or dismissing an error does not prove recovery.

- **Missing component or broken MCP environment?** Review server setup or environment repair. Select a valid base Python, read the failed phase/output, and check active clients before using the explicit Create/Repair action.
  Opening the MCP settings view and refreshing its status are inspection-only; they do not start installation or retry maintenance. Existing automatic preparation after an explicit Python/configuration change is unchanged.
- **Ordinary environment missing?** In Environments, choose **Review _name_** in the problem summary to expand and focus the affected registration. Recheck its folder and interpreter on this host. If it moved, register the correct folder. Do not use MCP Repair for an unrelated environment.
- **Package/version probe failed?** Inspect the error, not an empty package count. A recheck reads status; it does not install packages or delete the environment.
- **Model setup failed?** Review model Python, preparation phase and resource budget. Model rechecking does not redownload the weights. Exact + BM25 remains available without an embedding model.
- **Host disconnected or interface failed?** Use Reconnect for connection failures and Reload interface for resource failures. Open the diagnostic log; these actions do not undo earlier tool operations.

- **Still preparing?** Check [Background Tasks](pkm-help:backgroundTasks) for real ongoing work, then the relevant view's output.
- **Agent stopped?** Inspect tool receipts and saved changes first. Do not resend a mutation blindly.
- **Runtime repair needs action?** Follow the shared-client drain/reconnect guidance. Do not kill unrelated processes or bypass safeguards.
- **Sync conflict?** Review both versions and the target's diagnostic details before choosing a resolution.
- **No relevant knowledge?** Check the selected sources, exact paths, permissions, and whether required content exists. An embedding download is not the first fix.

```agent
Investigate [problem] without changing configuration.
Use the current error, relevant logs and tool receipts.
Separate observed facts from hypotheses; explain the likely blocker and
one safe next step. State what remains unverified.
```

For a useful bug report, include what you tried, expected vs actual behavior, extension version, local/remote host, error text, and relevant non-secret diagnostics. Do not include credentials, invite links, or private knowledge.

## 14. A simple routine that grows with you

**Capture → organize → ask → verify → reuse.**

Save useful knowledge as Notes. Turn proven procedures into Skills. Give Agents exact sources and bounded goals. Check the output before accepting it. Use Boards, Recipes, Workers, sharing, and Snapshots only when they solve a real recurring need.

PKM does not make unknown results true, approvals unnecessary, or every operation automatic. You stay in control of what is edited, executed, shared, and accepted.
