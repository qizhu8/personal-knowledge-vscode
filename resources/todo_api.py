"""Named, bounded Todo APIs. Authority and validation live in the shared TS reducer."""


def register_todo_api_tools(mcp, request):
    def call(api, values, worker_token=None):
        args = {key: value for key, value in values.items() if value is not None}
        values = {"api": api, "args": args}
        if worker_token is not None:
            values["workerToken"] = worker_token
        return request("todo-api", args.get("board_slug", "_discovery"), **values)

    read = {"readOnlyHint": True, "openWorldHint": False}
    write = {"readOnlyHint": False, "openWorldHint": False}
    delete = {**write, "destructiveHint": True}

    @mcp.tool(annotations=read)
    def list_boards(query: str | None = None, offset: int = 0, limit: int = 50) -> dict:
        """Discover dedicated Todo Boards; paginated. Read never claims work."""
        return call("list_boards", {"query": query, "offset": offset, "limit": limit})

    @mcp.tool(annotations=read)
    def get_board(board_slug: str, worker_token: str | None = None) -> dict:
        """Board identity, digest and task state counts. No mutation."""
        return call("get_board", {"board_slug": board_slug}, worker_token)

    @mcp.tool(annotations=read)
    def list_workitems(board_slug: str, states: list[str] | None = None, story_id: str | None = None,
                       owner_id: str | None = None, unassigned: bool = False, actionable: bool = False,
                       include_deleted: bool = False, query: str | None = None, offset: int = 0, limit: int = 50,
                       expected_digest: str | None = None, worker_token: str | None = None) -> dict:
        """Find tasks by todo/active/blocked/on-hold/completed, Story or owner. actionable means
        unassigned todo with completed dependencies, not execution permission. Deleted
        tasks hidden by default. Pin expected_digest when paging. Reads never claim."""
        args = {"board_slug": board_slug, "states": states, "story_id": story_id, "owner_id": owner_id,
                "unassigned": unassigned, "actionable": actionable, "include_deleted": include_deleted,
                "query": query, "offset": offset, "limit": limit, "expected_digest": expected_digest}
        return call("list_workitems", args, worker_token)

    @mcp.tool(annotations=read)
    def get_workitem(board_slug: str, id: str, include_deleted: bool = False, worker_token: str | None = None) -> dict:
        """Read task details and generated audit; include_deleted inspects soft-deleted tasks."""
        return call("get_workitem", {"board_slug": board_slug, "id": id, "include_deleted": include_deleted}, worker_token)

    @mcp.tool(annotations=read)
    def list_userstories(board_slug: str, query: str | None = None, include_deleted: bool = False,
                         offset: int = 0, limit: int = 50, expected_digest: str | None = None,
                         worker_token: str | None = None) -> dict:
        """List Story contracts and child counts; deleted hidden by default."""
        args = {"board_slug": board_slug, "query": query, "include_deleted": include_deleted,
                "offset": offset, "limit": limit, "expected_digest": expected_digest}
        return call("list_userstories", args, worker_token)

    @mcp.tool(annotations=read)
    def get_userstory(board_slug: str, id: str, include_deleted: bool = False,
                      offset: int = 0, limit: int = 50, worker_token: str | None = None) -> dict:
        """Story high-level information and paginated children, including completed tasks."""
        args = {"board_slug": board_slug, "id": id, "include_deleted": include_deleted, "offset": offset, "limit": limit}
        return call("get_userstory", args, worker_token)

    @mcp.tool(annotations=read)
    def list_agents(board_slug: str, query: str | None = None, offset: int = 0, limit: int = 50,
                    worker_token: str | None = None) -> dict:
        """Actual PKM Chat names/IDs/URLs and recorded external owner IDs. Starts no Agent."""
        args = {"board_slug": board_slug, "query": query, "offset": offset, "limit": limit}
        return call("list_agents", args, worker_token)

    def mutate(api, board_slug, expected_digest, worker_token, **fields):
        return call(api, {"board_slug": board_slug, "expected_digest": expected_digest, **fields}, worker_token)

    @mcp.tool(annotations=write)
    def add_workitem(board_slug: str, expected_digest: str, item: dict, worker_token: str | None = None) -> dict:
        """Create Planning task: item requires id,title,goal,scope,acceptance; optional
        parentId,projectId,dependsOn,plannedStart/plannedEnd,links. No audit/owner overrides."""
        return mutate("add_workitem", board_slug, expected_digest, worker_token, item=item)

    @mcp.tool(annotations=write)
    def update_workitem(board_slug: str, id: str, expected_digest: str, patch: dict, reason: str,
                        clear_fields: list[str] | None = None, worker_token: str | None = None) -> dict:
        """Patch task contract/schedule/dependencies with reason; clear optional fields
        explicitly. Never patch state/owner/audit; use dedicated APIs. Reload on conflict."""
        return mutate("update_workitem", board_slug, expected_digest, worker_token,
                      id=id, patch=patch, reason=reason, clear_fields=clear_fields)

    @mcp.tool(annotations=delete)
    def delete_workitem(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Soft-delete task with reason; live dependents prevent deletion. Audit retained."""
        return mutate("delete_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def restore_workitem(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Restore deleted task; parent/dependencies must be live. No implicit parent restore."""
        return mutate("restore_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def move_workitem(board_slug: str, id: str, expected_digest: str, reason: str,
                      story_id: str | None = None, worker_token: str | None = None) -> dict:
        """Reparent task; omit story_id to move to Unassigned. Preserve owner and state."""
        return mutate("move_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason, story_id=story_id)

    @mcp.tool(annotations=write)
    def add_userstory(board_slug: str, expected_digest: str, item: dict, worker_token: str | None = None) -> dict:
        """Create Story contract: id,title,goal (problem/user value),scope,acceptance.
        Optional storyStatus draft/confirmed, schedule, project, dependencies and links."""
        return mutate("add_userstory", board_slug, expected_digest, worker_token, item=item)

    @mcp.tool(annotations=write)
    def update_userstory(board_slug: str, id: str, expected_digest: str, patch: dict, reason: str,
                         clear_fields: list[str] | None = None, worker_token: str | None = None) -> dict:
        """Patch Story contract/schedule with reason; no state/owner/audit/reviewer overrides."""
        return mutate("update_userstory", board_slug, expected_digest, worker_token,
                      id=id, patch=patch, reason=reason, clear_fields=clear_fields)

    @mcp.tool(annotations=delete)
    def delete_userstory(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Soft-delete Story only after moving/deleting live children and dependent references."""
        return mutate("delete_userstory", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def restore_userstory(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Restore Story; does not automatically restore its deleted children."""
        return mutate("restore_userstory", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def claim_workitem(board_slug: str, id: str, expected_digest: str, worker_token: str | None = None) -> dict:
        """Atomically claim task as authenticated Agent and move to active. Reject another
        owner or unfinished dependencies. One Active task per Agent across all Boards.
        WORKITEM_FOCUS_CONFLICT requires an explicit choice: hold current with a reason,
        submit its real completion evidence, or defer the new task. Never switch silently.
        Without token identity is mcp:external; use stable token identity for distinct Agents."""
        return mutate("claim_workitem", board_slug, expected_digest, worker_token, id=id)

    @mcp.tool(annotations=write)
    def assign_workitem(board_slug: str, id: str, expected_digest: str, owner_id: str, reason: str,
                        worker_token: str | None = None) -> dict:
        """Assign task to PKM Chat ID or external:copilot/claude/other:<id>. Starts no Agent
        and grants no token/reviewer authority. Audit records the caller, not assignee."""
        return mutate("assign_workitem", board_slug, expected_digest, worker_token, id=id, owner_id=owner_id, reason=reason)

    @mcp.tool(annotations=write)
    def release_workitem(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Current owner releases task back to todo; reason required."""
        return mutate("release_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def change_workitem_state(board_slug: str, id: str, expected_digest: str, state: str,
                              blocked_reason: str | None = None, outcome: str | None = None,
                              evidence: list[str] | None = None, verification: list[dict] | None = None,
                              worker_token: str | None = None, reason: str | None = None) -> dict:
        """Current owner transitions todo/active/blocked/on-hold/completed. On-hold needs
        reason, keeps owner and frees focus. Active resumes enforce one task across Boards.
        Blocked needs blocked_reason;
        completed needs outcome Success/Failed/Unsure and evidence. Completed is not accepted."""
        return mutate("change_workitem_state", board_slug, expected_digest, worker_token, id=id, state=state,
                      blocked_reason=blocked_reason, outcome=outcome, evidence=evidence, verification=verification, reason=reason)

    @mcp.tool(annotations=write)
    def submit_workitem_result(board_slug: str, id: str, expected_digest: str, outcome: str,
                               evidence: list[str], verification: list[dict] | None = None,
                               worker_token: str | None = None) -> dict:
        """Current owner submits result/evidence/test reports atomically; completes but
        does not accept. Verification records layer,status,evidence,optional reason."""
        return mutate("submit_workitem_result", board_slug, expected_digest, worker_token, id=id,
                      outcome=outcome, evidence=evidence, verification=verification)

    @mcp.tool(annotations=write)
    def accept_workitem(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Only explicitly user-delegated reviewer may accept completed task with evidence.
        Agent Board management access does not permit self-delegation or automatic acceptance."""
        return mutate("accept_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def reopen_workitem(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Reopen completed task with reason; clear acceptance/outcome, preserve evidence and audit."""
        return mutate("reopen_workitem", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def reopen_userstory(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Reopen completed Story with reason before reopening or adding children."""
        return mutate("reopen_userstory", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def change_userstory_state(board_slug: str, id: str, expected_digest: str, state: str,
                               blocked_reason: str | None = None, outcome: str | None = None,
                               evidence: list[str] | None = None, verification: list[dict] | None = None,
                               worker_token: str | None = None, reason: str | None = None) -> dict:
        """Independently change Story state; active claims it. Completed requires all
        live children accepted plus outcome/evidence. On-hold needs reason.
        Story state does not consume task focus. No child-count auto completion."""
        return mutate("change_userstory_state", board_slug, expected_digest, worker_token, id=id, state=state,
                      blocked_reason=blocked_reason, outcome=outcome, evidence=evidence, verification=verification, reason=reason)

    @mcp.tool(annotations=write)
    def accept_userstory(board_slug: str, id: str, expected_digest: str, reason: str, worker_token: str | None = None) -> dict:
        """Explicitly delegated reviewer accepts completed Story with evidence and reason."""
        return mutate("accept_userstory", board_slug, expected_digest, worker_token, id=id, reason=reason)

    @mcp.tool(annotations=write)
    def add_workitem_comment(board_slug: str, id: str, expected_digest: str, text: str, worker_token: str | None = None) -> dict:
        """Append progress/handoff comment to a task or Story with authenticated actor/time."""
        return mutate("add_workitem_comment", board_slug, expected_digest, worker_token, id=id, text=text)

    @mcp.tool(annotations=read)
    def list_workitem_history(board_slug: str, id: str, offset: int = 0, limit: int = 50,
                              expected_digest: str | None = None, worker_token: str | None = None) -> dict:
        """Paginated generated task/Story history, including soft-deleted records."""
        args = {"board_slug": board_slug, "id": id, "offset": offset, "limit": limit, "expected_digest": expected_digest}
        return call("list_workitem_history", args, worker_token)

    @mcp.tool(annotations=read)
    def list_board_changes(board_slug: str, since: str | None = None, offset: int = 0, limit: int = 50,
                           expected_digest: str | None = None, worker_token: str | None = None) -> dict:
        """Board events including deletes/restores; stable event_id. since is inclusive
        UTC timestamp. Pin expected_digest for pagination; reload rather than retry conflicts."""
        args = {"board_slug": board_slug, "since": since, "offset": offset, "limit": limit, "expected_digest": expected_digest}
        return call("list_board_changes", args, worker_token)
