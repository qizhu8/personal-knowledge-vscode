import json
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    traces = json.loads((fixture / "reflection-gate-original-trace.json").read_text())
    old = traces["reflection"]
    state_file = fixture / "native-reflection-gate-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {"responses": []}
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")
    expect(panel).to_be_visible(timeout=20000)
    if panel.get_attribute("open") is None:
        panel.locator("summary").click()
    button = panel.locator("[data-native-recipe-lazy-authorize]")
    expect(button).to_be_visible()

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
        expect(detail).to_contain_text("external-caller-reported")
        if name == "submit_input":
            expect(detail).to_contain_text(args["challenge_id"])
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
            raise AssertionError("The exact Reflection/Gate request was not published.")
        request_file = fixture / "native-reflection-gate-approved.json"
        request_file.write_text(json.dumps(approved))
        output = fixture / "native-reflection-gate-response.json"
        result = subprocess.run([descriptor["recipePublicNode"], descriptor["recipeLazyClient"],
                                 str(fixture), mode, str(request_file), str(output)],
                                capture_output=True, text=True, timeout=30000)
        assert result.returncode == 0, result.stdout + result.stderr
        record = json.loads(output.read_text())
        assert record["getReadOnly"] is False and record["noAuthorityReplay"] is True
        state["responses"].append(record)
        return record["result"]

    def skill(tool, args):
        endpoint = json.loads((fixture / "native-reflection-skills.json").read_text())
        request = urllib.request.Request(endpoint["endpoint"], method="POST",
                                         data=json.dumps({"tool": tool, "args": args}).encode(),
                                         headers={"Authorization": "Bearer " + endpoint["token"],
                                                  "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        assert result["ok"], result
        return result

    def deny_forged_report(args):
        request_file = fixture / "native-reflection-gate-forged.json"
        request_file.write_text(json.dumps({"operation": "mcp.tool.recipe_run_report", "args": args}))
        output = fixture / "native-reflection-gate-forged-result.json"
        result = subprocess.run([descriptor["recipePublicNode"], descriptor["recipeLazyClient"],
                                 str(fixture), "unapproved", str(request_file), str(output)],
                                capture_output=True, text=True, timeout=30000)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(output.read_text())["denied"] is True

    if stage == "native-reflection-gate-start":
        started = call("start", old["start_args"])
        assert started["run_id"] == old["start"]["run_id"]
        current = call("next", {"run_id": started["run_id"], "command_id": "installed-reflection-next"}, "http")
        context = None
        for index, step in enumerate(old["steps"]):
            assert current["next_action"]["node_id"] == step["action"]["node_id"]
            assert current["next_action"]["inputs"] == old["inputs"]
            if index == 0:
                result = json.loads(step["args"]["result_json"])
            else:
                expected = old["skill_calls"][index - 1]
                args = dict(expected["args"])
                if index == 2:
                    args["interaction_id"] = context["interaction_id"]
                value = skill(expected["name"], args)
                if index == 1:
                    context = value
                    assert [(row["skill_id"], row["content_hash"]) for row in value["skills"]] == [
                        (row["skill_id"], row["content_hash"]) for row in expected["result"]["skills"]]
                    result = {"related-skills": value}
                else:
                    result = {"maintenance-result": value}
            current = call("report", {**step["args"], "result_json": json.dumps(result)}, "http")
            assert current["ok"], current
            completed = next(row for row in current["current_result"]["completed_nodes"]
                             if row["node_id"] == step["action"]["node_id"])
            assert completed["result"] == result
        assert current["status"] == "completed"
        state["actualSkillContextAndFeedback"] = True
        ports = traces["ports"]
        call("start", ports["start_args"])
        current = call("next", ports["next_args"])
        for report in ports["reports"]:
            assert current["next_action"]["inputs"] == ports["inputs"]
            current = call("report", report["args"], "http")
            assert current["ok"], current
            completed = next(row for row in current["current_result"]["completed_nodes"]
                             if row["node_id"] == report["args"]["node_id"])
            assert completed["result"] == json.loads(report["args"]["result_json"])
        assert current["status"] == "completed"
        state["actualOriginalRawPortsAndGlobalInputs"] = True
        approved = old["gates"][0]
        call("start", approved["start_args"])
        claimed = call("next", approved["next_args"])
        assert claimed["next_action"] == approved["next"]["next_action"]
        deny_forged_report(approved["forged_args"])
        submitted = call("submit_input", approved["submit_args"], "http")
        assert submitted["next_action"]["inputs"] == {"approval": "original-global-approval"}
        assert call("report", approved["report_args"])["status"] == "completed"
        pending = old["gates"][1]
        call("start", pending["start_args"])
        claimed = call("next", pending["next_args"])
        assert claimed["next_action"] == pending["next"]["next_action"]
        state["waitingBeforeSIGKILL"] = claimed["next_action"]
        state["explicitApprovalAndForgedReportDenied"] = True
    else:
        pending = old["gates"][1]
        resumed = call("get", {"run_id": pending["start"]["run_id"], "detail": "full"}, "http")
        assert resumed["next_action"] == state["waitingBeforeSIGKILL"]
        deny_forged_report(pending["forged_args"])
        rejected = call("submit_input", pending["submit_args"])
        assert rejected["status"] == "failed", rejected
        completed = next(row for row in rejected["current_result"]["completed_nodes"]
                         if row["node_id"] == pending["submit_args"]["node_id"])
        assert completed["outcome"] == "rejected"
        assert completed["result"] == json.loads(pending["submit_args"]["response_json"])
        state["sameChallengeAfterActualSIGKILLAndExplicitRejection"] = True
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"{stage}.png"), full_page=True)
    print("PASS installed actual Reflection/Gate/global-input raw reports " + stage, flush=True)
