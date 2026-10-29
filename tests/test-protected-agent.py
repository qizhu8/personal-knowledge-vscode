import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "scripts/protected-agent.py"


@unittest.skipUnless(shutil.which("bwrap"), "bubblewrap is required for OS-isolation tests")
class ProtectedAgentTest(unittest.TestCase):
    def test_direct_writes_denied_but_real_mcp_recovery_succeeds(self):
        with tempfile.TemporaryDirectory(prefix="pkm-agent-isolation-") as temporary:
            base = Path(temporary)
            root = base / "knowledge"
            workspace = base / "workspace"
            evidence = base / "evidence"
            (root / "skills").mkdir(parents=True)
            workspace.mkdir()
            (evidence / "blobs").mkdir(parents=True)
            (root / "skills/Original.md").write_text("Do not alter")
            content = b"Restored through MCP only\n"
            digest = hashlib.sha256(content).hexdigest()
            (evidence / "blobs" / digest).write_bytes(content)
            plan = {"schema": "pkm.knowledge-recovery/v1", "knowledgeRoot": str(root),
                    "files": [{"path": "notes/Recovered.md", "mode": "100644", "sha256": digest}]}
            raw = json.dumps(plan).encode()
            (evidence / "plan.json").write_bytes(raw)
            config = base / "mcp.json"
            config.write_text(json.dumps({"mcpServers": {"pkm": {"command": sys.executable,
                "args": [str(REPO / "resources/knowledge_recovery.py"), "--root", str(root)]}}}))
            check = workspace / "check.py"
            check.write_text("""
import asyncio, json, os, subprocess, sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
root, evidence, launcher, digest, configuration = map(str, sys.argv[1:])
for operation in (
    lambda: (Path(root)/'skills/Original.md').write_text('destroy'),
    lambda: (Path(root)/'skills/Original.md').unlink(),
    lambda: (Path(root)/'skills').rename(Path(root)/'renamed'),
    lambda: (Path(root)/'notes').mkdir(),
    lambda: Path(configuration).write_text('Replace trusted writer'),
):
    try: operation()
    except PermissionError: pass
    except OSError as error:
        assert error.errno == 30, error
    else: raise AssertionError('A direct knowledge mutation bypassed isolation')
Path('source-edit.txt').write_text('Development source remains writable')
async def main():
    parameters=StdioServerParameters(command=sys.executable,args=[launcher,'--bridge-client','/tmp/pkm-mcp.sock'])
    async with stdio_client(parameters) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            preview=await client.call_tool('knowledge_recovery_preview',{'evidence_directory':evidence})
            assert not preview.isError
            result=await client.call_tool('knowledge_recovery_apply',{'evidence_directory':evidence,'approved_plan_sha256':digest})
            assert not result.isError, result
asyncio.run(main())
assert (Path(root)/'notes/Recovered.md').read_bytes() == b'Restored through MCP only\\n'
print('OS isolation: overwrite/delete/rename/create denied; source edit allowed; real external MCP recovery succeeded')
""")
            result = subprocess.run([sys.executable, str(LAUNCHER), "--knowledge-root", str(root),
                "--workspace", str(workspace), "--mcp-config", str(config), "--",
                sys.executable, str(check), str(root), str(evidence), str(LAUNCHER),
                hashlib.sha256(raw).hexdigest(), str(config)], capture_output=True, text=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((root / "skills/Original.md").read_text(), "Do not alter")
            self.assertEqual((root / "notes/Recovered.md").read_bytes(), content)
            self.assertTrue((workspace / "source-edit.txt").exists())
            print(result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
