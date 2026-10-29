import argparse
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "resources"))
from action_modules import ModuleRuntime


def main():
    parser = argparse.ArgumentParser(description="Local Action Workbench preview with isolated state and real Action execution.")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("Choose an existing working directory.")
    store = workspace / "action-workbench-preview"
    ModuleRuntime(store).configure_workspace(str(workspace))
    allowed = {"catalog", "module_sets", "load", "remove", "import", "export", "validate", "queue", "cancel_validation",
               "resume_validation", "select_implementation", "save_graph", "check_graph", "call", "run", "cancel_run", "choices", "answer_choice",
               "group_create", "action_rename", "action_move", "action_delete", "definition_read", "definition_save", "source_read", "source_save"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            pathname = urlsplit(self.path).path
            if pathname == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            assets = {"/": (ROOT / "resources" / "action-workbench.html", "text/html"),
                      "/codicon.css": (ROOT / "dist" / "webview" / "codicon.css", "text/css"),
                      "/codicon.ttf": (ROOT / "dist" / "webview" / "codicon.ttf", "font/ttf")}
            if pathname not in assets:
                self.send_error(404)
                return
            file, content_type = assets[pathname]
            content = file.read_bytes()
            if pathname == "/":
                content = content.replace(b"<head>", b'<head><link rel="stylesheet" href="/codicon.css">')
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def do_POST(self):
            origin = "http://127.0.0.1:" + str(self.server.server_port)
            if self.path != "/api" or self.headers.get("Origin") != origin or self.headers.get("Content-Type") != "application/json":
                self.send_error(403)
                return
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 1024 * 1024:
                self.send_error(413)
                return
            try:
                request = json.loads(self.rfile.read(length))
                if request["method"] not in allowed:
                    raise ValueError("Unsupported preview operation.")
                if request["method"] in {"import", "export"}:
                    field = "local_path" if request["method"] == "import" else "destination"
                    if field not in request.get("params", {}):
                        raise ValueError("Use the VS Code Workbench package file dialog; the browser preview has no native file picker.")
                process = subprocess.run([sys.executable, str(ROOT / "resources" / "action_modules.py"), "--api", str(store)],
                                         input=json.dumps(request), text=True, capture_output=True, timeout=30)
                result = json.loads(process.stdout)
                if request["method"] == "catalog":
                    result["preview_workspace"] = str(workspace)
            except Exception as error:
                result = {"ok": False, "error": str(error)}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("Action Workbench: http://127.0.0.1:" + str(server.server_port), flush=True)
    print("Isolated preview state: " + str(store), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()