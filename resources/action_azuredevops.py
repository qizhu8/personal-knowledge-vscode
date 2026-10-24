"""Explicitly installed, read-only Azure DevOps query using the execution host's Azure CLI."""

import datetime
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

from recipe_runtime import _execute_command_worker


def fail(code, message, blocked=False):
    return {"ok": False, "failure": {"code": code, "message": message, "blocked": blocked}}


def cli_failure(result):
    text = result.get("stderr", "").lower()
    if result.get("timed_out"):
        return fail("network_timeout", "The read-only status request timed out; remote work was not cancelled.")
    if result.get("stdout_truncated"):
        return fail("response_too_large", "Azure CLI status output exceeded 64 KiB.")
    if "tf401019" in text:
        return fail("access_or_not_found", "Azure DevOps did not distinguish missing project from missing access.", True)
    if re.search(r"\b401\b", text) or any(marker in text for marker in ("az login", "aadsts", "authentication required", "not logged")):
        return fail("authentication_failed", "Authenticate the execution host using the operator's existing CLI workflow.", True)
    if re.search(r"\b403\b", text) or any(marker in text for marker in ("forbidden", "permission denied", "access denied")):
        return fail("permission_denied", "The execution host identity cannot read this run; no identity switch was attempted.", True)
    if re.search(r"\b404\b", text) or any(marker in text for marker in ("not found", "does not exist")):
        return fail("not_found", "The requested project or run was not found.")
    if any(marker in text for marker in ("connection", "resolve", "network", "timed out", "ssl", "certificate")):
        return fail("network_error", "The status endpoint could not be reached or verified.")
    return fail("cli_failed", "Azure CLI status query failed; raw CLI output is not exported.")


def execute(argv):
    with tempfile.TemporaryDirectory(prefix="pkm-ado-query-") as directory:
        root = Path(directory)
        spec = {"program": argv[0], "args": argv[1:], "cwd": os.getcwd(),
                "timeoutSeconds": 20, "maxOutputBytes": 65536}
        (root / "command.json").write_text(json.dumps(spec), encoding="utf-8")
        _execute_command_worker(root / "command.json", root / "result.json")
        return json.loads((root / "result.json").read_text(encoding="utf-8"))


def query(inputs, runner=execute, executable=None):
    organization, project, run_id = inputs.get("organization"), inputs.get("project"), inputs.get("run_id")
    if (not isinstance(organization, str) or not re.fullmatch(
            r"https://(?:dev\.azure\.com/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.visualstudio\.com)/?", organization)
            or not isinstance(project, str) or not project.strip() or len(project) > 256
            or not isinstance(run_id, str) or not re.fullmatch(r"[0-9]{1,40}", run_id)):
        return fail("invalid_input", "Require an Azure DevOps HTTPS organization, project and decimal string run_id.")
    az = executable or shutil.which("az")
    if not az:
        return fail("missing_toolchain", "Azure CLI is not installed on the Action execution host; PKM does not install it.", True)
    common = ["--organization", organization, "--project", project, "--output", "json", "--only-show-errors"]
    result = runner([az, "pipelines", "build", "show", "--id", run_id, *common])
    if not result.get("ok") or result.get("stdout_truncated"):
        return cli_failure(result)
    try:
        build = json.loads(result["stdout"])
    except (ValueError, KeyError):
        return fail("invalid_response", "Azure CLI returned invalid JSON.")
    if (not isinstance(build, dict) or str(build.get("id")) != run_id
            or not isinstance(build.get("definition"), dict) or build["definition"].get("id") is None):
        return fail("invalid_response", "The status response does not identify the requested run and pipeline.")
    status, outcome = build.get("status"), build.get("result")
    if status not in {"notStarted", "inProgress", "completed", "cancelling", "postponed", "none"}:
        return fail("invalid_response", "The status response contains an unknown run state.")
    terminal = status == "completed"
    if terminal and outcome not in {"succeeded", "failed", "canceled", "partiallySucceeded", "skipped", "none"}:
        return fail("invalid_response", "A completed run requires an explicit result.")
    timeline = runner([az, "devops", "invoke", "--organization", organization,
        "--area", "build", "--resource", "timeline", "--route-parameters",
        "project=" + project, "buildId=" + run_id, "--api-version", "7.1",
        "--http-method", "GET", "--output", "json", "--only-show-errors"])
    if not timeline.get("ok") or timeline.get("stdout_truncated"):
        return cli_failure(timeline)
    try:
        records = json.loads(timeline["stdout"])["records"]
    except (ValueError, KeyError, TypeError):
        return fail("invalid_response", "The timeline response is not a task list.")
    if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
        return fail("invalid_response", "The timeline response contains invalid tasks.")
    tasks = [{"name": str(item.get("name", ""))[:256], "state": item.get("state"), "result": item.get("result")}
             for item in records if item.get("state") == "inProgress" or item.get("result") == "failed"][:100]
    return {"ok": True, "output": {
        "remote_id": run_id, "pipeline_id": str(build["definition"]["id"]),
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "url": organization.rstrip("/") + "/" + quote(project, safe="") + "/_build/results?buildId=" + quote(run_id),
        "status": status, "result": outcome, "terminal": terminal, "tasks": tasks}}


def status_definition(action_id):
    az = shutil.which("az")
    script = str(Path(__file__).resolve())
    inputs = {"organization": {"type": "string", "pattern": r"^https://(?:dev\.azure\.com/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.visualstudio\.com)/?$"},
              "project": {"type": "string", "minLength": 1, "maxLength": 256},
              "run_id": {"type": "string", "pattern": "^[0-9]{1,40}$"}}
    outputs = {"remote_id": {"type": "string"}, "pipeline_id": {"type": "string"},
               "observed_at": {"type": "string"}, "url": {"type": "string"}, "status": {"type": "string"},
               "result": {"type": ["string", "null"]}, "terminal": {"type": "boolean"}, "tasks": {"type": "array"}}
    return {"schema": "pkm.action.definition/v1", "action_id": action_id, "version": 1,
            "description": "Read-only Azure DevOps build and task status using the explicitly authorized host CLI identity.",
            "effects": ["remote-read"], "input_schema": {"type": "object", "properties": inputs,
                "required": list(inputs), "additionalProperties": False},
            "output_schema": {"type": "object", "properties": outputs, "required": list(outputs), "additionalProperties": False},
            "examples": [], "implementations": [{"id": "azure-cli", "kind": "program",
                "platforms": ["Linux", "Windows", "Darwin"], "program": "python",
                "args": [script, *(["--azure-cli", az] if az else [])], "files": [script, *([az] if az else [])],
                "result_protocol": "pkm.action.result/v1"}]}


if __name__ == "__main__":
    if len(sys.argv) not in {1, 3} or len(sys.argv) == 3 and sys.argv[1] != "--azure-cli":
        raise ValueError("Use only the pinned --azure-cli executable binding.")
    print(json.dumps(query(json.load(sys.stdin), executable=sys.argv[2] if len(sys.argv) == 3 else None)))
