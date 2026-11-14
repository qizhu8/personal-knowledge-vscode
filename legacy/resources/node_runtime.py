"""Resolve the Node executable belonging to the current VS Code host."""

import os
from pathlib import Path


def _process_executable(pid, proc_root):
    process = Path(proc_root) / str(pid)
    try:
        arguments = (process / "cmdline").read_bytes().split(b"\0")
        if not any(role in arguments for role in (b"--type=extensionHost", b"--type=agentHost")):
            return None
        executable = os.readlink(process / "exe")
    except (OSError, ValueError):
        return None
    if executable.endswith(" (deleted)"):
        return None
    candidate = Path(executable)
    try:
        if candidate.name.lower() not in {"node", "node.exe"}:
            return None
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            return None
    except OSError:
        return None
    return str(candidate)


def _extension_host_ancestor(proc_root, start_pid):
    current = start_pid
    visited = set()
    for _ in range(64):
        if current <= 1 or current in visited:
            break
        visited.add(current)
        executable = _process_executable(current, proc_root)
        if executable:
            return executable
        try:
            status = (Path(proc_root) / str(current) / "status").read_text(encoding="ascii")
            parent = next(line for line in status.splitlines() if line.startswith("PPid:"))
            current = int(parent.split()[1])
        except (OSError, StopIteration, ValueError, IndexError):
            break
    return None


def resolve_node(configured=None, *, proc_root="/proc", start_pid=None, environ=None):
    """Prefer the live VS Code ancestor host executable; never search PATH for Node."""
    if start_pid is None:
        start_pid = os.getppid()
    current_host = _extension_host_ancestor(proc_root, start_pid)
    if current_host:
        return current_host

    environment = os.environ if environ is None else environ
    for candidate_path in (environment.get("PKM_NODE_EXECUTABLE"), configured):
        if not candidate_path:
            continue
        candidate = Path(candidate_path)
        try:
            if (candidate.is_absolute()
                    and candidate.name.lower() in {"node", "node.exe", "nodejs", "code", "code.exe", "code-oss", "code-insiders"}
                    and candidate.is_file() and os.access(candidate, os.X_OK)):
                return str(candidate)
        except OSError:
            pass

    raise RuntimeError(
        "The current VS Code Node executable could not be resolved. Reopen the VS Code window "
        "so its Extension Host starts from the updated installation, then reconnect this PKM "
        "MCP instance. PATH-based Node fallback is intentionally disabled.")
