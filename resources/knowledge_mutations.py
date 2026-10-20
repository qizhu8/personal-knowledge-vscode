"""Delegate MCP mutations to PKM's shared Trash and deletion-journal implementation."""
import json
import os
from pathlib import Path
import subprocess
import re


def write_markdown(store, area, relative, previous, content, node, extension_root):
    helper = Path(__file__).with_suffix(".js")
    request = {"operation": "write-markdown", "area": area, "path": relative,
               "previous": previous, "content": content}
    result = subprocess.run(
        [str(node), str(helper), str(extension_root), str(store)],
        input=json.dumps(request), text=True, capture_output=True, check=True,
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    value = json.loads(result.stdout)
    if value.get("ok") is not True:
        raise RuntimeError("The Knowledge mutation was not confirmed.")


def trash_file(store, area, relative, node, extension_root, expected_sha256=None):
    helper = Path(__file__).with_suffix(".js")
    request = {"operation": "trash", "area": area, "path": relative}
    if expected_sha256:
        request["expectedSha256"] = expected_sha256
    result = subprocess.run(
        [str(node), str(helper), str(extension_root), str(store)],
        input=json.dumps(request), text=True, capture_output=True, check=True,
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    return json.loads(result.stdout)


def register_knowledge_mutation_tools(mcp, store, node, extension_root):
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
