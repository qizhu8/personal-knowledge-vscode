import importlib.util
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("node_runtime", ROOT / "resources/node_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def executable(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o700)
    return path


with tempfile.TemporaryDirectory(prefix=".node-runtime-", dir=ROOT / "tests") as temporary:
    root = Path(temporary)
    proc = root / "proc"
    stale = executable(root / "old" / "node")
    current = executable(root / "updated" / "node")
    (proc / "40").mkdir(parents=True)
    (proc / "41").mkdir()
    (proc / "40" / "cmdline").write_bytes(b"python\0server.py\0")
    (proc / "40" / "status").write_text("Name:\tpython\nPPid:\t41\n", encoding="ascii")
    (proc / "41" / "cmdline").write_bytes(b"node\0--type=extensionHost\0")
    (proc / "41" / "status").write_text("Name:\tnode\nPPid:\t1\n", encoding="ascii")
    (proc / "41" / "exe").symlink_to(current)

    assert runtime.resolve_node(str(stale), proc_root=str(proc), start_pid=40) == str(current), (
        "the live Extension Host must win over the stale configured executable")
    assert runtime.resolve_node(str(stale), proc_root=str(proc), start_pid=40,
                               environ={"PKM_NODE_EXECUTABLE": str(stale)}) == str(current)

    # Copilot SDK-owned MCP processes descend from the persistent agentHost,
    # not from a window's extensionHost; reloading the window need not replace it.
    (proc / "41" / "cmdline").write_bytes(b"node\0--type=agentHost\0")
    assert runtime.resolve_node(str(stale), proc_root=str(proc), start_pid=40,
                                environ={}) == str(current)

    # A missing host and missing configured executable must not fall through to PATH.
    (proc / "41" / "cmdline").write_bytes(b"node\0")
    try:
        runtime.resolve_node(None, proc_root=str(proc), start_pid=40, environ={"PATH": str(root)})
        raise AssertionError("Node resolution must fail closed instead of searching PATH")
    except RuntimeError as error:
        assert "PATH-based Node fallback is intentionally disabled" in str(error)

    # The explicitly injected extension-host executable is a safe non-/proc fallback.
    assert runtime.resolve_node(None, proc_root=str(proc), start_pid=40,
                                environ={"PKM_NODE_EXECUTABLE": str(current)}) == str(current)

    nodejs = executable(root / "explicit" / "nodejs")
    assert runtime.resolve_node(str(nodejs), proc_root=str(proc), start_pid=40, environ={}) == str(nodejs)
    assert runtime.resolve_node(None, proc_root=str(proc), start_pid=40,
                                environ={"PKM_NODE_EXECUTABLE": str(nodejs)}) == str(nodejs)
    try:
        runtime.resolve_node("nodejs", proc_root=str(proc), start_pid=40, environ={"PATH": str(nodejs.parent)})
        raise AssertionError("a relative Node alias must not trigger PATH lookup")
    except RuntimeError as error:
        assert "PATH-based Node fallback is intentionally disabled" in str(error)

    unrelated = executable(root / "untrusted" / "python")
    try:
        runtime.resolve_node(None, proc_root=str(proc), start_pid=40,
                             environ={"PKM_NODE_EXECUTABLE": str(unrelated)})
        raise AssertionError("an unrelated executable must not be accepted as Node")
    except RuntimeError as error:
        assert "PATH-based Node fallback is intentionally disabled" in str(error)

print("VS Code Node identity resolution tests passed")
