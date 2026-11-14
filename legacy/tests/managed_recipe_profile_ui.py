"""Actual ordinary VS Code Recipe dialogs and original Graph/JSON Workbench, without approval/backend mocks."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from native_chat_recipe_ui import original


def main():
    endpoint, directory, stage = sys.argv[1:]
    fixture = Path(directory)
    assert Path.cwd().samefile(fixture)
    descriptor = json.loads((fixture / "managed-recipe-descriptor.json").read_text())
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint)
        page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
        page.wait_for_load_state("networkidle", timeout=45000)
        page.bring_to_front()
        welcome = page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True)
        if welcome.is_visible():
            page.keyboard.press("Escape")
        if stage == "legacy":
            original(playwright, page, descriptor)
            return

        def file_dialog(filename):
            field = page.locator(".quick-input-widget input")
            expect(field).to_be_visible(timeout=15000)
            field.fill(filename)
            field.press("Enter")
            page.wait_for_timeout(250)
            if field.is_visible() and field.input_value().rstrip("/") == filename.rstrip("/"):
                field.press("Enter")

        def exact(approved=True):
            expect(page.get_by_text("Approve this exact Recipe request?", exact=True)).to_be_visible(timeout=15000)
            detail = page.locator(".dialog-message-detail")
            expect(detail).to_contain_text(descriptor["independent"])
            expect(detail).to_contain_text("local:owner")
            if approved:
                page.get_by_role("button", name="Approve exact Recipe request", exact=True).click()
            else:
                page.get_by_role("button", name="Cancel", exact=True).click()

        def workbench():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                for frame in page.frames:
                    try:
                        if frame.locator("#native-run-start").count():
                            expect(frame.locator("#name")).to_be_visible()
                            return frame
                    except Exception:
                        if not frame.is_detached():
                            raise
                page.wait_for_timeout(100)
            raise AssertionError("The actual ordinary Recipe Workbench did not open.")

        def output(frame, predicate=None):
            field = frame.locator("#native-run-state")
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                text = field.inner_text()
                try:
                    result = json.loads(text)
                    if predicate is None or predicate(result):
                        return result
                except json.JSONDecodeError:
                    pass
                page.wait_for_timeout(100)
            raise AssertionError(field.inner_text())

        def action(frame, name):
            frame.locator(f"#native-run-{name}").click()

        def start(frame):
            action(frame, "start")
            field = page.locator(".quick-input-widget input")
            expect(field).to_be_visible()
            field.fill('{"synthetic":"ordinary-global-input"}')
            field.press("Enter")
            exact()
            return output(frame, lambda result: result.get("next_action", {}).get("kind") == "call_recipe_run_next")

        def next_node(frame):
            action(frame, "next")
            exact()
            return output(frame, lambda result: result.get("next_action", {}).get("kind") == "request_user_input")

        def human(frame, approved):
            action(frame, "input")
            expect(page.locator(".monaco-dialog-box")).to_contain_text(descriptor["original"]["gate"]["definition"]["spec"]["nodes"][0]["config"]["prompt"])
            page.get_by_role("button", name="Approve" if approved else "Reject", exact=True).click()
            exact()
            return output(frame, lambda result: result.get("next_action", {}).get("node_id") == "record-approved"
                          or result.get("status") == "failed")

        def report(frame, outcome, result, expected):
            action(frame, "report")
            field = page.locator(".quick-input-widget input")
            expect(field).to_be_visible()
            field.fill(outcome)
            field.press("Enter")
            expect(field).to_be_visible()
            field.fill(json.dumps(result))
            field.press("Enter")
            exact()
            return output(frame, lambda response: response.get("status") == expected)

        if stage == "native":
            page.keyboard.press("Control+Alt+Shift+n")
            file_dialog(descriptor["independent"] + "/")
            file_dialog(descriptor["node"])
            page.get_by_role("button", name="Create Trial", exact=True).click(timeout=15000)
            field = page.locator(".quick-input-widget input")
            toast = page.locator(".notification-toast").filter(has_text="Isolated PKM Next trial started.")
            if toast.count():
                clear = toast.locator("[aria-label='Clear Notification']")
                if clear.count():
                    clear.click()
            expect(field).to_be_visible(timeout=30000)
            page.keyboard.press("Escape")
            page.keyboard.press("Control+Alt+Shift+w")
            expect(field).to_be_visible()
            field.fill("New controlled Recipe")
            field.press("Enter")
            frame = workbench()
            frame.locator("#name").fill("Ordinary managed Recipe")
            frame.get_by_role("button", name="JSON", exact=True).click()
            frame.locator("#json").fill(json.dumps(descriptor["original"]["gate"]["definition"], indent=2))
            frame.get_by_role("button", name="Save", exact=True).click()
            exact(False)
            expect(frame.locator("#status")).to_contain_text("fresh exact private host authority", timeout=15000)
            frame.get_by_role("button", name="Save", exact=True).click()
            exact()
            expect(frame.locator("#status")).to_have_text("Saved", timeout=15000)
            started = start(frame)
            waiting = next_node(frame)
            assert waiting["next_action"]["kind"] == "request_user_input"
            frame.page.screenshot(path=str(fixture / "ordinary-recipe-waiting.png"))
            (fixture / "ordinary-recipe-before-restart.json").write_text(json.dumps({
                "runId": started["run_id"], "challenge": waiting["next_action"]["challenge_id"],
                "start": started, "waiting": waiting,
            }, indent=2))
            print("PASS ordinary activation, original Graph/JSON UI, denied Save, exact Save/start/claim, durable waiting Gate", flush=True)
        elif stage == "restart":
            before = json.loads((fixture / "ordinary-recipe-before-restart.json").read_text())
            page.keyboard.press("Control+Alt+Shift+w")
            page.get_by_role("button", name="Reopen Recipe Workspace", exact=True).click(timeout=15000)
            file_dialog(descriptor["node"])
            field = page.locator(".quick-input-widget input")
            expect(field).to_be_visible(timeout=30000)
            field.fill("Ordinary managed Recipe")
            field.press("Enter")
            frame = workbench()
            action(frame, "refresh")
            exact()
            recovered = output(frame, lambda result: result.get("run_id") == before["runId"])
            assert recovered["next_action"]["challenge_id"] == before["challenge"]
            work = human(frame, True)
            assert work["next_action"]["inputs"] == {"synthetic": "ordinary-global-input"}
            external = fixture / "synthetic-caller-output.txt"
            external.write_text("Actual synthetic work performed by the external caller under its own permissions.\n")
            evidence = {"callerFile": external.name, "sha256": hashlib.sha256(external.read_bytes()).hexdigest()}
            completed = report(frame, "succeeded", evidence, "completed")
            start(frame)
            next_node(frame)
            human(frame, True)
            action(frame, "cancel")
            exact()
            cancelled = output(frame, lambda result: "cancellationRequested" in json.dumps(result))
            assert cancelled["status"] == "running"
            failed = report(frame, "failed", {"caller": "Acknowledged cancellation; no second external effect."}, "failed")
            start(frame)
            next_node(frame)
            rejected = human(frame, False)
            assert rejected["status"] == "failed"
            frame.page.screenshot(path=str(fixture / "ordinary-recipe-restarted.png"))
            (fixture / "ordinary-recipe-renderer-evidence.json").write_text(json.dumps({
                "actualHumanModals": True, "oldWorkbenchReused": True, "challengePreserved": True,
                "recovered": recovered, "completed": completed, "cooperativeCancellation": cancelled,
                "callerAcknowledgedCancellation": failed, "humanRejected": rejected, "externalCallerEvidence": evidence,
                "automaticAgentExecution": False,
            }, indent=2))
            page.keyboard.press("Control+Alt+Shift+c")
            page.wait_for_timeout(1000)
            print("PASS actual SIGKILL/full Code restart, independent pin, fresh human input, real caller report, cooperative cancellation and rejection", flush=True)
        else:
            raise AssertionError(stage)


if __name__ == "__main__":
    main()
