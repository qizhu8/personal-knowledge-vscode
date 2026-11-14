import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    recipe = json.loads((fixture / "external-report-recipe.json").read_text())
    oracle = json.loads((fixture / "external-report-original-trace.json").read_text())
    state_file = fixture / "native-report-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {"responses": []}
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")
    expect(panel).to_be_visible(timeout=20000)
    if panel.get_attribute("open") is None:
        panel.locator("summary").click()
    button = panel.locator("[data-native-recipe-lazy-authorize]")
    expect(button).to_be_visible()

    def project(value):
        if isinstance(value, dict):
            ignored = {"started_at", "completed_at", "last_heartbeat_at", "last_progress_at",
                       "heartbeat_age_seconds", "progress_age_seconds"}
            return {key: project(item) for key, item in value.items() if key not in ignored}
        return [project(item) for item in value] if isinstance(value, list) else value

    def call(name, args, mode="mcp"):
        request = {"operation": "mcp.tool.recipe_run_" + name, "args": args}
        button.click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=10000)
        field.fill(json.dumps(request))
        field.press("Enter")
        expect(page.get_by_text("Authorize this exact mutating legacy Recipe request?", exact=True)).to_be_visible(timeout=15000)
        detail = page.locator(".dialog-message-detail")
        expect(detail).to_contain_text(descriptor["root"])
        expect(detail).to_contain_text(recipe["executableDigest"])
        expect(detail).to_contain_text("external-caller-reported")
        expect(detail).to_contain_text('"executionAuthority": false')
        page.get_by_role("button", name="Authorize exact lazy Recipe request", exact=True).click()
        published = panel.locator("[data-native-lazy-public-request]")
        expect(published).to_be_visible(timeout=15000)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            approved = json.loads(published.inner_text())
            if approved["operation"] == request["operation"] and all(
                    approved["args"].get(key) == value for key, value in args.items()):
                break
            page.wait_for_timeout(50)
        else:
            raise AssertionError("The exact external report request was not published.")
        request_file = fixture / "native-report-approved-request.json"
        request_file.write_text(json.dumps(approved))
        output = fixture / "native-report-public-result.json"
        result = subprocess.run([descriptor["recipePublicNode"], descriptor["recipeLazyClient"],
                                 str(fixture), mode, str(request_file), str(output)],
                                capture_output=True, text=True, timeout=30000)
        assert result.returncode == 0, result.stdout + result.stderr
        record = json.loads(output.read_text())
        assert record["getReadOnly"] is False and record["noAuthorityReplay"] is True
        state["responses"].append(record)
        return record["result"]

    if stage == "native-report-start":
        args = {"recipe_id": recipe["recipeId"], "command_id": "universal-real-external-caller",
                "inputs_json": '{"task":"Read the exact synthetic file and preserve its evidence."}'}
        assert project(call("start", args)) == project(oracle["start"])
        run_id = oracle["start"]["run_id"]
        assert project(call("get", {"run_id": run_id}, "http")) == project(oracle["get_initial"])
        assert project(call("next", {"run_id": run_id, "command_id": "claim-universal-first"})) == project(oracle["next"])
        assert project(call("get", {"run_id": run_id}, "http")) == project(oracle["get_claimed"])
        assert project(call("progress", oracle["progress_args"], "http")) == project(oracle["progress_claimed"])
        ledger = fixture / "native-external-caller-effects.jsonl"
        for index, report in enumerate(oracle["reports"]):
            actual_hash = hashlib.sha256((fixture / "workspace/recipe-input.txt").read_bytes()).hexdigest()
            assert json.loads(report["args"]["result_json"])["sha256"] == actual_hash
            with ledger.open("a") as output:
                output.write(json.dumps({"node": report["args"]["node_id"], "sha256": actual_hash}) + "\n")
                output.flush()
                os.fsync(output.fileno())
            assert project(call("report", report["args"], "mcp" if index % 2 == 0 else "http")) == project(report["response"])
        assert project(call("report", oracle["reports"][0]["args"], "http")) == project(oracle["replay"])
        assert project(call("get", {"run_id": run_id})) == project(oracle["final"])
        failed = call("start", {**args, "command_id": "universal-real-external-failure"})
        assert project(failed) == project(oracle["failure"]["start"])
        assert project(call("next", {"run_id": failed["run_id"], "command_id": "claim-failure-first"})) == project(oracle["failure"]["next"])
        for report in oracle["failure"]["reports"]:
            assert project(call("report", report["args"])) == project(report["response"])
        interrupted = call("start", {**args, "command_id": "installed-external-report-interrupted"})
        state["interrupted"] = interrupted["run_id"]
        claimed = call("next", {"run_id": state["interrupted"], "command_id": "claim-before-real-sigkill"})
        assert claimed["next_action"]["kind"] == "execute_node"
        state["claimedNode"] = claimed["next_action"]["node_id"]
        state["originalRuntimeReportParity"] = True
        state["failureAndNullResultParity"] = True
    else:
        observed = call("get", {"run_id": state["interrupted"]}, "http")
        assert observed["next_action"]["state"] == "launch-outcome-unknown"
        assert observed["next_action"]["replay_allowed"] is False
        assert observed["current_result"]["counts"]["pending"] == 5
        fresh = call("next", {"run_id": state["interrupted"], "command_id": "do-not-resurrect-report"})
        assert fresh["next_action"]["replay_allowed"] is False
        assert fresh["current_result"]["counts"]["pending"] == 5
        annotated = call("progress", {"run_id": state["interrupted"], "node_id": state["claimedNode"],
                                     "command_id": "inspect-unknown-without-regaining-authority",
                                     "progress_json": '{"message":"inspection only; never replay"}'}, "http")
        assert annotated["next_action"]["state"] == "launch-outcome-unknown"
        assert annotated["next_action"]["replay_allowed"] is False
        assert annotated["current_result"]["counts"]["pending"] == 5
        assert project(call("get", {"run_id": oracle["start"]["run_id"]})) == project(oracle["final"])
        state["fullRestartUnknownNeverReplayed"] = True
    assert len((fixture / "native-external-caller-effects.jsonl").read_text().splitlines()) == 6
    state_file.write_text(json.dumps(state))
    print(f"PASS real installed external Recipe report: {stage}", flush=True)
