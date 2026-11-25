"""Explicit read-only Azure CLI Action adapter; admission and consent belong to the native host."""
import datetime
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
from urllib.parse import quote


def fail(code, message, blocked=False):
    return {"ok": False, "failure": {"code": code, "message": message, "blocked": blocked}}


def execute(argv):
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   shell=False, env={**os.environ, "AZURE_EXTENSION_USE_DYNAMIC_INSTALL": "no"})
    except OSError:
        return fail("missing_toolchain", "The approved Azure CLI could not be started; PKM does not install or replace it.", True)
    buffers = [bytearray(), bytearray()]
    oversized = threading.Event()

    def capture(stream, target):
        while True:
            block = stream.read(4096)
            if not block:
                return
            target.extend(block[:max(0, 65537 - len(target))])
            if len(target) > 65536:
                oversized.set()
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                return

    threads = [threading.Thread(target=capture, args=(stream, target), daemon=True)
               for stream, target in zip([process.stdout, process.stderr], buffers)]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=1)
        return fail("network_timeout", "The read-only status request timed out; remote work was not cancelled.")
    for thread in threads:
        thread.join(timeout=1)
    if any(thread.is_alive() for thread in threads):
        return fail("network_timeout", "The local query did not close its output streams; remote work was not cancelled.")
    output, errors = (bytes(value) for value in buffers)
    if oversized.is_set():
        return fail("response_too_large", "Azure CLI status output exceeded 64 KiB.")
    if process.returncode:
        text = errors.decode("utf-8", errors="replace").lower()
        if "tf401019" in text:
            return fail("access_or_not_found", "Azure DevOps did not distinguish missing project from missing access.", True)
        if re.search(r"\b401\b", text) or any(x in text for x in ("az login", "aadsts", "authentication required", "not logged")):
            return fail("authentication_failed", "Authenticate the execution host using the operator's existing CLI workflow.", True)
        if re.search(r"\b403\b", text) or any(x in text for x in ("forbidden", "permission denied", "access denied")):
            return fail("permission_denied", "The execution host identity cannot read this run; no identity switch was attempted.", True)
        if re.search(r"\b404\b", text) or any(x in text for x in ("not found", "does not exist")):
            return fail("not_found", "The requested project or run was not found.")
        if any(x in text for x in ("connection", "resolve", "network", "timed out", "ssl", "certificate")):
            return fail("network_error", "The status endpoint could not be reached or verified.")
        return fail("cli_failed", "Azure CLI status query failed; raw CLI output is not exported.")
    try:
        return {"ok": True, "output": json.loads(output)}
    except (ValueError, UnicodeDecodeError):
        return fail("invalid_response", "Azure CLI returned invalid JSON.")


def query(inputs, runner=execute):
    if not isinstance(inputs, dict):
        return fail("invalid_input", "Status input must be an object.")
    organization, project, run_id = inputs.get("organization"), inputs.get("project"), inputs.get("run_id")
    if (not isinstance(organization, str) or not re.fullmatch(
            r"https://(?:dev\.azure\.com/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.visualstudio\.com)/?", organization)
            or not isinstance(project, str) or not project.strip() or len(project) > 256
            or not isinstance(run_id, str) or not re.fullmatch(r"[0-9]{1,40}", run_id)):
        return fail("invalid_input", "Require an Azure DevOps HTTPS organization, project and decimal string run_id.")
    az = shutil.which("az")
    if not az:
        return fail("missing_toolchain", "Azure CLI is not installed on the Action execution host; PKM does not install it.", True)
    base = organization.rstrip("/") + "/" + quote(project, safe="") + "/_apis/build/builds/" + run_id
    common = ["--method", "GET", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--output", "json", "--only-show-errors"]
    response = runner([az, "rest", "--url", base + "?api-version=7.1", *common])
    if not response.get("ok"):
        return response
    build = response.get("output")
    if (not isinstance(build, dict) or str(build.get("id")) != run_id or not isinstance(build.get("definition"), dict)
            or build["definition"].get("id") is None or build.get("status") not in
            {"notStarted", "inProgress", "completed", "cancelling", "postponed", "none"}):
        return fail("invalid_response", "The status response does not identify the requested run and pipeline.")
    terminal, outcome = build["status"] == "completed", build.get("result")
    if outcome is not None and not isinstance(outcome, str):
        return fail("invalid_response", "The run result must be a string or null.")
    if terminal and outcome not in {"succeeded", "failed", "canceled", "partiallySucceeded", "skipped", "none"}:
        return fail("invalid_response", "A completed run requires an explicit result.")
    timeline = runner([az, "rest", "--url", base + "/timeline?api-version=7.1", *common])
    if not timeline.get("ok"):
        return timeline
    timeline_output = timeline.get("output")
    records = timeline_output.get("records") if isinstance(timeline_output, dict) else None
    if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
        return fail("invalid_response", "The timeline response contains invalid tasks.")
    tasks = [{"name": str(item.get("name", ""))[:256], "state": item.get("state"), "result": item.get("result")}
             for item in records if item.get("state") == "inProgress" or item.get("result") == "failed"][:100]
    return {"ok": True, "output": {"remote_id": run_id, "pipeline_id": str(build["definition"]["id"]),
            "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "url": organization.rstrip("/") + "/" + quote(project, safe="") + "/_build/results?buildId=" + quote(run_id),
            "status": build["status"], "result": outcome, "terminal": terminal, "tasks": tasks}}


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    print(json.dumps(query(json.load(sys.stdin))))
