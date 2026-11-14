"""Run structured test reporters; expose failures, never the successful test log."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import xml.etree.ElementTree as ET


def parse_junit(path: Path) -> dict:
    root = ET.parse(path).getroot()
    if root.tag not in {"testsuites", "testsuite"}:
        raise ValueError("Expected a JUnit testsuite or testsuites root")
    cases = list(root.iter("testcase"))
    failures = []
    skipped = 0
    for case in cases:
        skipped += case.find("skipped") is not None
        for kind in ("failure", "error"):
            for error in case.findall(kind):
                failures.append({
                    "case_id": "::".join(filter(None, [
                        case.get("classname"), case.get("name"),
                    ])),
                    "kind": kind,
                    "message": error.get("message", ""),
                    "details": "".join(error.itertext()),
                })
    for suite in root.iter("testsuite"):
        for error in suite.findall("error"):
            failures.append({
                "case_id": suite.get("name", "suite"), "kind": "error",
                "message": error.get("message", ""),
                "details": "".join(error.itertext()),
            })
    reported_failures = sum(
        int(suite.get("failures", "0")) + int(suite.get("errors", "0"))
        for suite in root.iter("testsuite")
    )
    if reported_failures and not failures:
        raise ValueError("JUnit reports failures but has no failure diagnostics")
    return {"tests": len(cases), "skipped": skipped, "failures": failures}


def run_gate(config: dict) -> dict:
    runner = config.get("runner")
    if runner not in {"pytest", "node"}:
        raise ValueError("runner must be pytest or node")
    command = config.get("command")
    if not isinstance(command, list) or not command or any(
        not isinstance(arg, str) or not arg for arg in command
    ):
        raise ValueError("command must be a nonempty argv array")
    timeout = config.get("timeout_seconds", 300)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 3500:
        raise ValueError("timeout_seconds must be finite and between 0 and 3500")
    threshold = config.get("coverage_threshold")
    if threshold is not None and (
        isinstance(threshold, bool) or not isinstance(threshold, (int, float))
        or not math.isfinite(threshold) or not 0 <= threshold <= 100
    ):
        raise ValueError("coverage_threshold must be between 0 and 100")
    if threshold is not None and runner != "pytest":
        raise ValueError("Coverage gating currently requires pytest-cov")
    cwd = Path(config["cwd"]).resolve(strict=True)
    artifact_root = Path(config["artifact_directory"]).resolve()
    artifact_root.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix="test-gate-", dir=artifact_root))
    report = artifacts / "junit.xml"
    log = artifacts / "full.log"
    coverage = artifacts / "coverage.json"
    argv = list(command)
    if runner == "pytest":
        argv += [f"--junitxml={report}"]
        if threshold is not None:
            argv += [f"--cov-report=json:{coverage}", f"--cov-fail-under={threshold}"]
    else:
        argv = [command[0], "--test", "--test-reporter=junit", *command[1:]]
    gates = []
    exit_code = None
    with log.open("wb") as output, report.open("wb") if runner == "node" else open(os.devnull, "wb") as junit:
        try:
            process = subprocess.Popen(
                argv, cwd=cwd, stdout=junit if runner == "node" else output,
                stderr=output, start_new_session=os.name == "posix",
            )
        except OSError as error:
            gates.append({"kind": "startup", "message": str(error)})
        else:
            try:
                exit_code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=output, stderr=output, check=False,
                    )
                    process.kill()
                process.wait()
                gates.append({"kind": "timeout", "message": f"Exceeded {timeout} seconds"})
    if exit_code not in (None, 0):
        gates.append({"kind": "exit", "message": f"Test runner exited with {exit_code}"})
    parsed = {"tests": 0, "skipped": 0, "failures": []}
    try:
        parsed = parse_junit(report)
    except (OSError, ET.ParseError, ValueError) as error:
        gates.append({"kind": "report", "message": str(error)})
    if parsed["tests"] - parsed["skipped"] <= 0:
        gates.append({"kind": "no-tests", "message": "No non-skipped test cases ran"})
    percentage = None
    if threshold is not None:
        try:
            percentage = json.loads(coverage.read_text())["totals"]["percent_covered"]
            if isinstance(percentage, bool) or not isinstance(percentage, (int, float)) or not math.isfinite(percentage) or not 0 <= percentage <= 100:
                raise ValueError("Invalid coverage percentage")
            if percentage < threshold:
                gates.append({"kind": "coverage", "message": f"{percentage}% is below {threshold}%"})
        except (OSError, ValueError, KeyError, TypeError) as error:
            gates.append({"kind": "coverage-report", "message": str(error)})
    result = {
        "schema": "pkm.test-gate/v1",
        "all_passed": exit_code == 0 and not gates and not parsed["failures"],
        **parsed, "gate_failures": gates, "exit_code": exit_code,
        "coverage": percentage,
        "artifacts": {"directory": str(artifacts), "log": str(log), "junit": str(report)},
    }
    if threshold is not None:
        result["artifacts"]["coverage"] = str(coverage)
    result_path = artifacts / "result.json"
    result["artifacts"]["result"] = str(result_path)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def compact_result(result: dict) -> dict:
    failures = result["failures"]
    compact = {**result, "failures": [
        {**failure, "message": failure["message"][:500], "details": failure["details"][:1500]}
        for failure in failures[:10]
    ]}
    compact["failure_count"] = len(failures)
    compact["diagnostics_truncated"] = len(failures) > 10 or any(
        len(failure["message"]) > 500 or len(failure["details"]) > 1500
        for failure in failures
    )
    return compact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        if not isinstance(config, dict):
            raise ValueError("Configuration must be a JSON object")
        result = run_gate(config)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({
            "schema": "pkm.test-gate/v1", "all_passed": False,
            "failures": [], "gate_failures": [{"kind": "configuration", "message": str(error)}],
        }))
        return 2
    print(json.dumps(compact_result(result), ensure_ascii=False))
    return 0 if result["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
