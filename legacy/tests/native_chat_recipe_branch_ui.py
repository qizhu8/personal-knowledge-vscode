import json
from pathlib import Path
import subprocess
import time
from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    evidence = json.loads((fixture / "static-branch-source.json").read_text())
    recipe = evidence["recipe"]
    oracle = json.loads((fixture / "static-branch-original-trace.json").read_text())
    state_file = fixture / "native-branch-ui-state.json"
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
            raise AssertionError("The exact static-branch request was not published.")
        request_file = fixture / "native-branch-approved-request.json"
        request_file.write_text(json.dumps(approved))
        output = fixture / "native-branch-public-result.json"
        result = subprocess.run([descriptor["recipePublicNode"], descriptor["recipeLazyClient"],
                                 str(fixture), mode, str(request_file), str(output)],
                                capture_output=True, text=True, timeout=30000)
        assert result.returncode == 0, result.stdout + result.stderr
        record = json.loads(output.read_text())
        assert record["getReadOnly"] is False and record["noAuthorityReplay"] is True
        state["responses"].append(record)
        return record["result"]

    def perform(scenario, node_id, inputs):
        result = subprocess.run([descriptor["recipePublicNode"], descriptor["recipeBranchCaller"],
                                 str(fixture), scenario, node_id, json.dumps(inputs)],
                                capture_output=True, text=True, timeout=10000)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    if stage == "native-branch-start":
        for scenario, old in oracle["scenarios"].items():
            assert project(call("start", old["start_args"])) == project(old["start"])
            assert project(call("next", old["next_args"], "http")) == project(old["next"])
            for index, report in enumerate(old["reports"]):
                node_id = report["args"]["node_id"]
                if scenario == "cancel" and index == 1:
                    assert project(call("progress", old["progress_args"], "http")) == project(old["progress"])
                if scenario == "io-failure" and index == 1:
                    try:
                        (fixture / "workspace/caller-missing-input").read_bytes()
                        raise AssertionError("Actual caller input unexpectedly exists.")
                    except FileNotFoundError:
                        pass
                if scenario != "inspection-failure" and (index == 0 or scenario in ("valid", "invalid")):
                    work = perform(scenario, node_id, old["inputs"])
                    assert work["outcome"] == report["args"]["outcome"]
                    assert work["result"] == json.loads(report["args"]["result_json"])
                assert project(call("report", report["args"], "http" if index % 2 else "mcp")) == project(report["response"])
            assert project(call("get", {"run_id": old["start"]["run_id"]}, "http")) == project(old["final"])
            assert project(call("report", old["reports"][0]["args"])) == project(old["replay"])
        args = {**oracle["scenarios"]["invalid"]["start_args"], "command_id": "installed-static-branch-interrupted"}
        interrupted = call("start", args)
        state["interrupted"] = interrupted["run_id"]
        claimed = call("next", {"run_id": state["interrupted"], "command_id": "claim-installed-static-before-kill"})
        assert claimed["next_action"]["node_id"] == "inspect"
        inputs = json.loads(args["inputs_json"])
        work = perform("interrupted", "inspect", inputs)
        chosen = call("report", {"run_id": state["interrupted"], "node_id": "inspect",
                                "outcome": work["outcome"], "result_json": json.dumps(work["result"]),
                                "command_id": "choose-invalid-before-real-kill", "detail": "full"})
        assert chosen["next_action"]["node_id"] == "repair"
        completed = {item["node_id"]: item for item in chosen["current_result"]["completed_nodes"]}
        assert completed["inspect"]["outcome"] == "invalid" and completed["record-valid"]["outcome"] == "skipped"
        state["selectedCasePersistedBeforeKill"] = True
        state["originalRuntimeFiveScenarioParity"] = True
    else:
        for name, args in [
                ("get", {}),
                ("next", {"command_id": "never-replay-selected-static-path"}),
                ("progress", {"node_id": "repair", "command_id": "inspect-static-unknown",
                              "progress_json": '{"message":"inspection only; never replay or switch branch"}'})]:
            observed = call(name, {"run_id": state["interrupted"], "detail": "full", **args}, "http")
            assert observed["next_action"]["state"] == "launch-outcome-unknown"
            assert observed["next_action"]["replay_allowed"] is False
            assert observed["current_result"]["counts"]["pending"] == 1
            completed = {item["node_id"]: item for item in observed["current_result"]["completed_nodes"]}
            assert completed["inspect"]["outcome"] == "invalid" and completed["record-valid"]["outcome"] == "skipped"
        for scenario in ("valid", "invalid"):
            old = oracle["scenarios"][scenario]
            assert project(call("get", {"run_id": old["start"]["run_id"]})) == project(old["final"])
        assert not (fixture / "workspace/branch-interrupted/repaired.txt").exists()
        assert not (fixture / "workspace/branch-interrupted/validated.txt").exists()
        assert not (fixture / "workspace/branch-interrupted/archive.json").exists()
        state["fullRestartUnknownNeverReplayedOrSwitched"] = True
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"{stage}.png"), full_page=True)
    print(f"PASS actual installed static-branch external caller {stage}; no ports, gates or automatic agent claimed.", flush=True)
