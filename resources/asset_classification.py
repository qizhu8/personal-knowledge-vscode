"""Model-free asset stewardship, with session-local dry-run approvals and durable rollback."""
import json
import os
from pathlib import Path
import subprocess


def register_asset_classification_tools(mcp, store, node, extension_root):
    previews = {}

    def invoke(request):
        result = subprocess.run(
            [str(node), str(Path(__file__).with_suffix('.js')), str(extension_root), str(store)],
            input=json.dumps(request), text=True, capture_output=True,
            env={**os.environ, 'ELECTRON_RUN_AS_NODE': '1'})
        if result.returncode:
            raise RuntimeError('Asset classification failed; no asset content is logged.')
        return json.loads(result.stdout)

    @mcp.tool(annotations={'readOnlyHint': True, 'destructiveHint': False})
    def asset_classify_preview() -> dict:
        """Read-only model-free rules and duplicate/correction review. No model calls or writes.
        Private assets are excluded. Review evidence with the user before explicit subset approval.
        Previews expire on MCP restart; no merge, deletion, move or autonomous consolidation.
        """
        value = invoke({'operation': 'preview'})
        if len(previews) >= 8:
            previews.pop(next(iter(previews)))
        previews[value['id']] = value
        return value

    @mcp.tool(annotations={'readOnlyHint': False, 'destructiveHint': False})
    def asset_classify_apply(preview_id: str, proposal_ids: list[str]) -> dict:
        """After explicit user approval, apply only listed classification proposal IDs from a preview.
        Metadata-only frontmatter/sidecars, stale-hash skips, recoverable journal. Dedupe/corrections are review-only.
        """
        if preview_id not in previews or not proposal_ids:
            raise ValueError('An active preview and explicit approved proposal IDs are required.')
        return invoke({'operation': 'apply', 'preview': previews[preview_id], 'proposalIds': proposal_ids})

    @mcp.tool(annotations={'readOnlyHint': False, 'destructiveHint': False})
    def asset_classify_rollback(journal_id: str) -> dict:
        """Restore exact pre-apply bytes from a journal; skip metadata edited since apply."""
        return invoke({'operation': 'rollback', 'journalId': journal_id})
