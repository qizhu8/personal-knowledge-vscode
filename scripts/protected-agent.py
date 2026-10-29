#!/usr/bin/env python3
"""Launch an Agent with read-only knowledge and an external MCP writer."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading


def pump(read, write):
    while True:
        data = os.read(read.fileno(), 65536)
        if not data:
            break
        while data:
            data = data[os.write(write.fileno(), data):]


def bridge_client(address):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(address)
        outgoing = connection.makefile("wb", buffering=0)
        def forward():
            pump(sys.stdin.buffer, outgoing)
            connection.shutdown(socket.SHUT_WR)
        thread = threading.Thread(target=forward, daemon=True)
        thread.start()
        pump(connection.makefile("rb", buffering=0), sys.stdout.buffer)


def launch(args):
    root = Path(args.knowledge_root).resolve(strict=True)
    workspace = Path(args.workspace or os.getcwd()).resolve(strict=True)
    if root == workspace or root in workspace.parents and not (
            root / "packages" in workspace.parents or workspace == root / "packages"):
        raise ValueError("Only development packages may be writable inside the Knowledge Root.")
    if workspace in root.parents:
        raise ValueError("A writable workspace must not contain the Knowledge Root.")
    bubblewrap = shutil.which("bwrap")
    if not bubblewrap:
        raise RuntimeError("bubblewrap is required. No unprotected fallback is permitted.")
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        command = ["copilot"]
    executable = shutil.which(command[0])
    if not executable:
        raise ValueError("Agent executable was not found: " + command[0])
    command[0] = executable
    broker = None
    processes = set()
    process_lock = threading.Lock()
    configuration = (Path(args.mcp_config) if args.mcp_config
                     else Path.home() / ".copilot" / "mcp-config.json").resolve()
    with tempfile.TemporaryDirectory(prefix="pkm-protected-agent-") as temporary:
        directory = Path(temporary)
        socket_path = directory / "mcp.sock"
        if not args.no_mcp:
            config = json.loads(configuration.read_text())["mcpServers"]["pkm"]
            interpreter = config["command"]
            server_args = config.get("args", [])
            if not server_args or not Path(server_args[0]).is_file():
                raise ValueError("Configured PKM MCP server was not found.")
            server_path = Path(server_args[0]).resolve()
            runtime = (Path.home() / ".copilot").resolve()
            if workspace in server_path.parents or runtime in server_path.parents:
                raise ValueError("The trusted MCP server must be outside writable Agent directories.")
            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    process = subprocess.Popen(
                        [interpreter, *server_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        env={**os.environ, **config.get("env", {})})
                    with process_lock:
                        processes.add(process)
                    try:
                        def forward():
                            pump(self.rfile, process.stdin)
                            process.stdin.close()
                        sender = threading.Thread(target=forward, daemon=True)
                        sender.start()
                        pump(process.stdout, self.wfile)
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        with process_lock:
                            processes.discard(process)
            class Broker(socketserver.ThreadingUnixStreamServer):
                daemon_threads = True
            broker = Broker(str(socket_path), Handler)
            socket_path.chmod(0o600)
            threading.Thread(target=broker.serve_forever, daemon=True).start()
        bridge_script = Path(__file__).resolve()
        mcp_config = directory / "mcp.json"
        mcp_config.write_text(json.dumps({"mcpServers": {"pkm": {
            "type": "local", "command": sys.executable,
            "args": [str(bridge_script), "--bridge-client", "/tmp/pkm-mcp.sock"],
            "tools": ["*"]}}}))
        arguments = [bubblewrap, "--ro-bind", "/", "/", "--unshare-all", "--share-net",
                     "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                     "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run",
                     "--ro-bind", str(root), str(root),
                     "--bind", str(workspace), str(workspace), "--chdir", str(workspace)]
        runtime = Path.home() / ".copilot"
        if runtime.is_dir() and runtime != root and runtime not in root.parents:
            arguments += ["--bind", str(runtime), str(runtime)]
        if configuration.is_file():
            arguments += ["--ro-bind", str(configuration), str(configuration)]
        if broker:
            arguments += ["--ro-bind", str(socket_path), "/tmp/pkm-mcp.sock",
                          "--ro-bind", str(mcp_config), "/tmp/pkm-mcp.json"]
            if Path(executable).name in ("copilot", "copilot.exe"):
                command += ["--additional-mcp-config", "@/tmp/pkm-mcp.json"]
        environment = {**os.environ, "PKM_KNOWLEDGE_READONLY": str(root)}
        environment.pop("DBUS_SESSION_BUS_ADDRESS", None)
        environment.pop("VSCODE_IPC_HOOK_CLI", None)
        try:
            return subprocess.run([*arguments, "--", *command], env=environment).returncode
        finally:
            if broker:
                broker.shutdown()
                broker.server_close()
                with process_lock:
                    active = list(processes)
                for process in active:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-client")
    parser.add_argument("--knowledge-root")
    parser.add_argument("--workspace")
    parser.add_argument("--no-mcp", action="store_true")
    parser.add_argument("--mcp-config")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.bridge_client:
        bridge_client(args.bridge_client)
    else:
        if not args.knowledge_root:
            parser.error("--knowledge-root is required")
        try:
            raise SystemExit(launch(args))
        except (OSError, ValueError, RuntimeError) as error:
            print("Protected Agent launch failed: " + str(error), file=sys.stderr)
            raise SystemExit(1)
