"""Delegate MCP mutations to PKM's shared Trash and deletion-journal implementation."""
import json
import os
from pathlib import Path
import subprocess
import re
from todo_api import register_todo_api_tools
from capability_api import register_capability_tools


def write_markdown(store, area, relative, previous, content, node, extension_root):
    helper = Path(__file__).with_suffix(".js")
    request = {"operation": "write-markdown", "area": area, "path": relative,
               "previous": previous, "content": content}
    try:
        result = subprocess.run(
            [str(node), str(helper), str(extension_root), str(store)],
            input=json.dumps(request), text=True, capture_output=True, check=True,
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Markdown write rejected: {error.stderr.strip()}") from error
    value = json.loads(result.stdout)
    if value.get("ok") is not True:
        raise RuntimeError("The Knowledge mutation was not confirmed.")


def trash_file(store, area, relative, node, extension_root, expected_sha256=None):
    helper = Path(__file__).with_suffix(".js")
    request = {"operation": "trash", "area": area, "path": relative}
    if expected_sha256:
        request["expectedSha256"] = expected_sha256
    try:
        result = subprocess.run(
            [str(node), str(helper), str(extension_root), str(store)],
            input=json.dumps(request), text=True, capture_output=True, check=True,
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Knowledge Trash rejected: {error.stderr.strip()}") from error
    return json.loads(result.stdout)

def register_knowledge_mutation_tools(mcp, store, node, extension_root, memory_config=None):
    def work_items_request(operation, slug, **values):
        helper = Path(__file__).with_suffix(".js")
        request = {"operation": operation, "area": "notes", "path": slug + ".md", **values}
        if operation == "capability" and memory_config is not None:
            request["memoryConfig"] = memory_config
        try:
            result = subprocess.run(
                [str(node), str(helper), str(extension_root), str(store)],
                input=json.dumps(request), text=True, capture_output=True, check=True,
                env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"Work Item operation failed: {error.stderr.strip()}") from error
        return json.loads(result.stdout)

    register_todo_api_tools(mcp, work_items_request)
    register_capability_tools(mcp, work_items_request)

    @mcp.tool(annotations={"readOnlyHint": True})
    def note_work_items(slug: str) -> dict:
        """Read authoritative Todo Board items (or legacy Note blocks) and CAS digest.

        For Todo Boards the JSON document is authoritative; Markdown is not a task
        editing interface. Read before every command. No model or task runs.
        Reading never claims work. To take a task, use note_work_item_command
        with action='claim'; its authenticated identity becomes ownerId.
        Never directly edit the Board JSON, Markdown, ownership or audit files.
        """
        return work_items_request("work-items-read", slug)

    @mcp.tool(annotations={"readOnlyHint": False})
    def todo_board_create(title: str, category: str = "") -> dict:
        """Create an empty structured Todo Board in Notes, not a Markdown checklist.

        Returns slug, items and digest. Use note_work_item_command to create and
        manage tasks; never write task blocks using add_note/update_note.
        Named add/update_workitem and add/update_userstory APIs manage contracts;
        acceptance delegation remains user-only. Existing documents are never
        overwritten or auto-converted.
        """
        slug = f"{category}/{title}" if category else title
        return work_items_request("todo-board-create", slug, title=title, category=category)

    @mcp.tool(annotations={"readOnlyHint": True})
    def note_work_item_notes(query: str = "", limit: int = 20) -> dict:
        """Discover Notes with explicit Work Item blocks, on request only (1-1000 results).

        Query matches Note slug/title/description. Malformed Notes return explicit
        error entries, not silently empty items. No model or background scan runs.
        """
        return work_items_request("work-item-notes", "_discovery", query=query, limit=limit)

    @mcp.tool(annotations={"readOnlyHint": False})
    def note_work_item_command(slug: str, expected_digest: str, command: dict, worker_token: str | None = None) -> dict:
        """Apply one digest-CAS Work Item lifecycle command under the shared mutation lock.

        Commands: create/edit with item; claim/release/accept/reopen with id and
        optional reason; transition with id,state,optional reason,blockedReason,outcome,evidence.
        Default external identity is mcp:external. For a distinct external Agent,
        the user assigns external:copilot/claude/other:<id> in Board UI and copies
        a Board-scoped worker token to that Agent. Supply worker_token to use that
        identity, never a caller role override. Tokens grant worker policy only.
        This command API is the only supported Agent write path. Raw file edits
        and generic Markdown updates are not Todo editing interfaces.
        Rotating the token invalidates previous access. Native Chats have stable
        identities without a token.
        This compatibility endpoint retains restrictive worker policy; use the
        named Board APIs for contract/Story management and soft-delete/restore.
        Workers create unowned Planning items, claim them, edit only their own
        nonterminal evidence/links/verification/blockedReason, and transition them.
        Done requires outcome and evidence, not acceptance. Accept requires a user
        or an explicitly user-delegated reviewer and reason; reopen is user-only
        with reason. Release requires owner and reason. History is generated.
        OnHold requires reason and retains ownership. On dedicated Boards, claims,
        Active resumes and active reassignment enforce one WIP task per stable Agent
        across all Boards in the knowledge root. WORKITEM_FOCUS_CONFLICT changes nothing:
        explicitly put current work OnHold, submit real completion evidence, or defer
        the new task. Never silently suspend/complete previous work.
        Never blindly retry conflicts or lower acceptance criteria.
        """
        values = {"expectedDigest": expected_digest, "command": command}
        if worker_token is not None:
            values["workerToken"] = worker_token
        return work_items_request("work-item-command", slug, **values)

    @mcp.tool(annotations={"readOnlyHint": False})
    def note_work_item_upsert(slug: str, expected_digest: str, item: dict) -> dict:
        """Compatibility create/edit routed through worker lifecycle policy.

        Uses fixed identity mcp:external, not the low-level manual user-equivalent
        upsert API. New items must be unowned Planning without history/acceptance,
        projectId or reviewerIds; edits require ownership and preserve protected
        fields and generated history/decision. Use note_work_item_command to
        claim, transition or release. Read first; never blindly retry a conflict.
        """
        return work_items_request("work-item-upsert", slug, expectedDigest=expected_digest, item=item)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
    def knowledge_file_trash(area: str, path: str, expected_sha256: str) -> dict:
        """Move an exact reviewed file to PKM Trash, only if its original bytes still match SHA-256."""
        if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
            raise ValueError("A reviewed file SHA-256 is required.")
        return trash_file(store, area, path, node, extension_root, expected_sha256)


if __name__ == "__main__":
    import argparse
    from fastmcp import FastMCP
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--extension-root", required=True)
    args = parser.parse_args()
    server = FastMCP("pkm-knowledge-mutations")
    register_knowledge_mutation_tools(server, args.root, args.node, args.extension_root)
    server.run()
