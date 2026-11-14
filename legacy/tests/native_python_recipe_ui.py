import argparse
import importlib.util
import json
from pathlib import Path
import time
from playwright.sync_api import expect, sync_playwright


def run(page, frame, descriptor, stage, controller):
    fixture = Path(descriptor["root"]).parent
    old = json.loads((fixture / "native-python-recipe-old-environment.json").read_text())
    state_file = fixture / "native-python-recipe-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    controller.choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")

    def controls():
        expect(panel).to_be_visible(timeout=20000)
        if panel.get_attribute("open") is None:
            panel.locator("summary").click()

    def editor(new=False):
        controls()
        excluded = tuple(page.frames)
        if new:
            panel.get_by_role("button", name="New Recipe library definition", exact=True).click()
        else:
            panel.locator(f'[data-native-recipe-edit-id="{state["recipeId"]}"]').click()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            for candidate in page.frames:
                try:
                    if candidate not in excluded and candidate.locator("#page-title").count() and candidate.locator("#name").is_visible():
                        return candidate
                except Exception:
                    if not candidate.is_detached():
                        raise
            page.wait_for_timeout(100)
        raise AssertionError("Native SQL Recipe Workbench did not appear.")

    def save(workbench):
        workbench.locator("#save").click()
        expect(page.get_by_text("Save this exact native Recipe library definition?", exact=True)).to_be_visible(timeout=15000)
        page.get_by_role("button", name="Save exact Recipe definition", exact=True).click()
        expect(workbench.locator("#status")).to_contain_text("Saved", timeout=20000)

    if stage == "author":
        workbench = editor(new=True)
        workbench.locator("#name").fill("SATURN reviewed SQL Python")
        workbench.locator('[data-mode="json"]').click()
        workbench.locator("#json").fill(json.dumps(old["definition"]))
        workbench.locator("#validate").click()
        expect(workbench.locator("#status")).to_contain_text("Definition is valid", timeout=15000)
        save(workbench)
        state = workbench.evaluate("() => ({recipeId:recipe.recipeId,knowledgeId:recipe.knowledgeId,aliases:recipe.aliases})")
    elif stage == "edit-source":
        workbench = editor()
        workbench.locator("#description").fill("Real SQL revision changed after an exact native Python/public decision.")
        save(workbench)
        expect(workbench.locator("#revision")).to_contain_text("Revision 2")
    else:
        controls()
        native = stage == "native-cancel"
        selector = "data-native-recipe-id" if native else "data-native-recipe-public-id"
        panel.locator(f'[{selector}="{state["recipeId"]}"]').click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        value = f"installed-{stage}"
        inputs = {"value": value, "mode": "hold" if stage in ("native-cancel", "crash") else "complete"}
        field.fill(json.dumps(inputs))
        field.press("Enter")
        if stage == "missing":
            expect(frame.locator("#error")).to_contain_text("ENOENT", timeout=15000)
        else:
            expect(page.get_by_text("Approve Python execution for this exact SQL Recipe run?", exact=True)).to_be_visible(timeout=15000)
            detail = page.locator(".dialog-message-detail")
            expect(detail).to_contain_text(old["prefix"])
            expect(detail).to_contain_text(state["recipeId"])
            expect(detail).to_contain_text(value)
            expect(detail).to_contain_text("Exact script hashes and literal argv")
            expect(detail).to_contain_text("$(touch never-created)")
            expect(detail).to_contain_text('"kind":"recipe"')
            if stage == "decline":
                page.get_by_role("button", name="Cancel", exact=True).click()
            else:
                page.get_by_role("button", name="Approve exact SQL Recipe Python run", exact=True).click()
                title = "Run this exact Recipe with the installed trusted adapter?" if native else "Authorize this exact MCP/HTTP native Recipe request?"
                expect(page.get_by_text(title, exact=True)).to_be_visible(timeout=15000)
                run_id = json.loads(page.locator(".dialog-message-detail").inner_text().split("\nFresh authority", 1)[0])["runId"]
                button = "Run exact native Recipe" if native else "Authorize exact public Recipe request"
                page.get_by_role("button", name=button, exact=True).click()
                if native:
                    row = panel.locator(f'[data-native-recipe-run-id="{run_id}"]')
                    expect(row).to_have_count(1, timeout=15000)
                    expect(row.locator("pre")).to_contain_text('"state": "running"', timeout=15000)
                    row.get_by_role("button", name="Cancel Recipe run", exact=True).click()
                    expect(page.get_by_text("Cancel this exact native Recipe run?", exact=True)).to_be_visible(timeout=15000)
                    page.get_by_role("button", name="Cancel exact Recipe run", exact=True).click()
                    expect(row).to_contain_text("cancelled", timeout=15000)
                    state["cancelRunId"] = row.get_attribute("data-native-recipe-run-id")
                else:
                    approved = panel.locator("[data-native-public-recipe-request]")
                    expect(approved).to_have_count(1, timeout=15000)
                    deadline = time.monotonic() + 15
                    while True:
                        request = json.loads(approved.inner_text())
                        if request["args"]["inputs"] == inputs:
                            break
                        assert time.monotonic() < deadline, "Publication retained an older exact request."
                        page.wait_for_timeout(50)
                    (fixture / f"python-request-{stage}.json").write_text(json.dumps(request))
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"native-python-{stage}.png"), full_page=True)
    print(f"PASS actual installed SQL Python native UI {stage}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("endpoint")
    parser.add_argument("descriptor")
    parser.add_argument("stage")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("native_controller", Path(__file__).with_name("test-native-chat-ui-installed.py"))
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    descriptor = json.loads(Path(args.descriptor).read_text())
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.endpoint, timeout=30000)
        try:
            page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
            frame = controller.open_chat(page)
            if args.stage != "serve":
                run(page, frame, descriptor, args.stage, controller)
            else:
                fixture = Path(descriptor["root"]).parent
                command_file = fixture / "python-ui-command.json"
                result_file = fixture / "python-ui-result.json"
                def publish_result(value):
                    pending = fixture / "python-ui-result.next"
                    pending.write_text(json.dumps(value))
                    pending.replace(result_file)
                (fixture / "python-ui-ready").write_text("ready")
                previous = None
                while True:
                    command = json.loads(command_file.read_text()) if command_file.exists() else None
                    if command and command["id"] != previous:
                        previous = command["id"]
                        if command["stage"] == "stop":
                            publish_result({"id": previous, "ok": True})
                            break
                        try:
                            run(page, frame, descriptor, command["stage"], controller)
                            publish_result({"id": previous, "ok": True})
                        except Exception as error:
                            page.screenshot(path=str(fixture / "native-python-ui-failure.png"), full_page=True)
                            publish_result({"id": previous, "error": str(error)})
                            raise
                    page.wait_for_timeout(50)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
