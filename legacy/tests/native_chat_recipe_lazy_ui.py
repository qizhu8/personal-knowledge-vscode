import hashlib
import json
import subprocess
from pathlib import Path
import time
from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    evidence = json.loads((fixture / "controlled-lazy-recipe-evidence.json").read_text())
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")
    expect(panel).to_be_visible(timeout=20000)
    if panel.get_attribute("open") is None:
        panel.locator("summary").click()
    button = panel.locator("[data-native-recipe-lazy-authorize]")
    expect(button).to_be_visible()
    state_file = fixture / "native-lazy-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {"responses": []}

    def effects():
        file = Path(evidence["effects"])
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

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
        expect(detail).to_contain_text(evidence["recipeId"])
        expect(detail).to_contain_text(evidence["recipe"]["executableDigest"])
        expect(detail).to_contain_text(evidence["script"])
        expect(detail).to_contain_text("Get synchronizes state and is NOT read-only")
        page.get_by_role("button", name="Authorize exact lazy Recipe request", exact=True).click()
        published = panel.locator("[data-native-lazy-public-request]")
        expect(published).to_be_visible(timeout=15000)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            approved = json.loads(published.inner_text())
            if approved["operation"] == request["operation"] and all(approved["args"].get(key) == value for key, value in args.items()):
                break
            page.wait_for_timeout(50)
        else:
            (fixture / "native-lazy-publish-failure.json").write_text(json.dumps({"expected": request, "shown": approved}))
            raise AssertionError("Private modal approval did not publish the exact request.")
        request_file = fixture / "native-lazy-approved-request.json"
        request_file.write_text(json.dumps(approved))
        output = fixture / "native-lazy-public-result.json"
        script = Path(descriptor["recipeLazyClient"])
        result = subprocess.run([descriptor["recipePublicNode"], str(script), str(fixture), mode,
                                 str(request_file), str(output)], capture_output=True, text=True, timeout=30000)
        assert result.returncode == 0, result.stdout + result.stderr
        record = json.loads(output.read_text())
        assert record["getReadOnly"] is False
        assert record["noAuthorityReplay"] is True
        state["responses"].append(record)
        return record["result"]

    def start(command, mode):
        response = call("start", {"recipe_id": evidence["recipeId"], "command_id": command,
                                 "inputs_json": json.dumps({"mode": mode})})
        assert response["ok"], response
        assert response["run_id"] == "recipe_run_" + hashlib.sha256(command.encode()).hexdigest()[:24]
        assert response["recipe"]["recipe_id"] == evidence["recipeId"]
        return response["run_id"]

    def get(run_id, predicate):
        for _attempt in range(10):
            value = call("get", {"run_id": run_id}, "http")
            if predicate(value):
                return value
            page.wait_for_timeout(100)
        raise AssertionError(value)

    def await_effects(count):
        deadline = time.monotonic() + 10
        while len(effects()) < count and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert len(effects()) == count, effects()

    if stage == "native-lazy-start":
        state["pending"] = start("installed-lazy-pending", "complete")
        get(state["pending"], lambda value: value["current_result"]["counts"]["pending"] == 2)
        assert len(effects()) == 0
        state["complete"] = start("installed-lazy-complete", "complete")
        first = call("next", {"run_id": state["complete"], "command_id": "first-request"})
        get(state["complete"], lambda value: value["current_result"]["counts"]["succeeded"] == 1)
        await_effects(1)
        page.wait_for_timeout(200)
        assert len(effects()) == 1
        replay = call("next", {"run_id": state["complete"], "command_id": "first-request"}, "http")
        assert replay["replayed"] is True and replay["version"] == first["version"]
        conflict = call("next", {"run_id": state["complete"], "command_id": "first-request", "detail": "full"})
        assert conflict["error"]["code"] == "recipe-run-next-failed"
        assert "reused" in conflict["error"]["message"]
        call("next", {"run_id": state["complete"], "command_id": "second-request"}, "http")
        get(state["complete"], lambda value: value["status"] == "completed")
        await_effects(2)
        state["cancel"] = start("installed-lazy-cancel", "hold")
        call("next", {"run_id": state["cancel"], "command_id": "held-first"})
        await_effects(3)
        running = call("next", {"run_id": state["cancel"], "command_id": "not-a-second-step"}, "http")
        assert running["next_action"]["node_id"] == "first"
        assert running["current_result"]["counts"]["pending"] == 1
        call("progress", {"run_id": state["cancel"], "node_id": "first", "command_id": "cancel-request",
                          "progress_json": '{"cancellationRequested":true}'}, "http")
        cancelled = get(state["cancel"], lambda value: value["status"] == "failed")
        assert cancelled["current_result"]["completed_nodes"][0]["result"]["cancelled"] is True
        await_effects(3)
    elif stage == "native-lazy-reopen":
        assert len(effects()) == 3, "No explicit next: no effect on a complete Code/broker restart."
        get(state["pending"], lambda value: value["current_result"]["counts"]["pending"] == 2)
        get(state["complete"], lambda value: value["status"] == "completed")
        get(state["cancel"], lambda value: value["status"] == "failed")
        call("next", {"run_id": state["pending"], "command_id": "first-after-explicit-restart"})
        get(state["pending"], lambda value: value["current_result"]["counts"]["succeeded"] == 1)
        await_effects(4)
        state["crash"] = start("installed-lazy-crash", "hold")
        call("next", {"run_id": state["crash"], "command_id": "crash-first"}, "http")
        await_effects(5)
        state["actualEffectBeforeBrokerSIGKILL"] = True
    elif stage == "native-lazy-unknown":
        assert len(effects()) == 5, "SIGKILL must not dispatch any unrequested or previously started step."
        unknown = get(state["crash"], lambda value: value["next_action"].get("state") == "launch-outcome-unknown")
        assert unknown["next_action"]["replay_allowed"] is False
        receipt = call("next", {"run_id": state["crash"], "command_id": "crash-first"})
        assert receipt["replayed"] is True
        explicit = call("next", {"run_id": state["crash"], "command_id": "fresh-command-does-not-permit-replay"}, "http")
        assert explicit["next_action"]["state"] == "launch-outcome-unknown"
        pending = get(state["pending"], lambda value: value["current_result"]["counts"]["pending"] == 1)
        assert pending["current_result"]["counts"]["succeeded"] == 1
        assert len(effects()) == 5
        call("next", {"run_id": state["pending"], "command_id": "explicit-second-after-restart"})
        get(state["pending"], lambda value: value["status"] == "completed")
        await_effects(6)
        state["knownCancellationFailed"] = True
        state["unknownNeverReplayed"] = True
        state["pendingPreservedAcrossTwoRestarts"] = True
    else:
        raise AssertionError(stage)
    assert all(effect["literal"] == evidence["literal"] for effect in effects())
    assert not (fixture / "workspace/NEVER-CREATED").exists()
    state["effects"] = effects()
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"{stage}.png"), full_page=True)
    print(f"PASS actual installed controlled lazy Recipe {stage}: native modal + exact one-use MCP/HTTP, no arbitrary executable authority.", flush=True)
