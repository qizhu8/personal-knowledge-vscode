#!/usr/bin/env python3
"""Launch-context persistence without inferring identity from PIDs or active chats."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from mcp_call_guard import ManagedMcpLifecycle, managed_mcp_launch_attribution


class AttributionTests(unittest.TestCase):
    def test_explicit_context_is_durable_and_lifecycle_unchanged(self):
        context = {"schema": "pkm.mcp.attribution/v1", "source": "pkm-chat", "scope": "chat",
                   "hostId": "registered-host", "editorSessionId": "editor-session",
                   "hostSlotId": "existing-slot", "extensionHostPid": 123,
                   "workspace": "file:///workspace", "machine": "machine", "chatId": "caller-chat",
                   "extensionHostLogUri": "file:///c:/logs/session/window2/exthost/uone.pkm"}
        with tempfile.TemporaryDirectory(dir=ROOT / "tests", prefix=".mcp-attribution-") as directory:
            root = Path(directory)
            (root / "active-generation.json").write_text(json.dumps({
                "schema": "pkm.mcp.lifecycle/v1", "generation": "first"}))
            manifest = {"schema": "pkm.mcp.lifecycle/v1", "generation": "first",
                        "managedRoot": directory, "version": "1.0.0", "components": {}}
            with patch.dict(os.environ, {"PKM_MCP_LAUNCH_ATTRIBUTION": json.dumps(context)}):
                lifecycle = ManagedMcpLifecycle(manifest)
            with patch.dict(os.environ, {"PKM_MCP_LAUNCH_ATTRIBUTION": "{}"}):
                status = lifecycle.status()
                self.assertEqual(status["attribution"], context)
                self.assertEqual(status["phase"], "accepting")
                self.assertEqual(status["inFlight"], 0)
                self.assertEqual(json.loads(lifecycle.registry.read_text())["attribution"], context)
                self.assertEqual(lifecycle.quiesce()["phase"], "drained")
                self.assertEqual(json.loads(lifecycle.registry.read_text())["attribution"], context)

    def test_shared_missing_and_malformed_contexts(self):
        shared = {"schema": "pkm.mcp.attribution/v1", "source": "vscode-provider",
                  "scope": "shared-host", "hostId": "same-host", "editorSessionId": "same-editor-session",
                  "extensionHostPid": 123}
        with patch.dict(os.environ, {"PKM_MCP_LAUNCH_ATTRIBUTION": json.dumps(shared)}):
            self.assertEqual(managed_mcp_launch_attribution(), shared)
            self.assertNotIn("chatId", managed_mcp_launch_attribution())
        fallback = {"schema": "pkm.mcp.attribution/v1", "source": "standalone", "scope": "unknown"}
        malformed = [None, [], {}, {**shared, "chatId": "guessed"},
                     {**shared, "workspace": "\nforged"}, {**shared, "extensionHostPid": True},
                     {**shared, "editorSessionId": {}}, {**shared, "scope": "chat", "chatId": "guessed"},
                     {**shared, "workspace": "x" * 2049},
                     *[{**shared, "extensionHostLogUri": value} for value in [
                         {}, "", "x" * 2049, "file:///logs\nforged", "/logs/window2",
                         "not a uri", "file:///logs with spaces"]]]
        for raw in ["", "{", "x" * 32769] + [json.dumps(value) for value in malformed]:
            with self.subTest(raw=raw[:80]), patch.dict(os.environ, {"PKM_MCP_LAUNCH_ATTRIBUTION": raw}):
                self.assertEqual(managed_mcp_launch_attribution(), fallback)


if __name__ == "__main__":
    unittest.main()
