import json
import os
import re
import subprocess
from pathlib import Path
import time
from urllib.parse import urlparse, urlunparse
from playwright.sync_api import expect


def original(playwright, page, descriptor):
    fixture = Path(descriptor["root"]).parent
    page.bring_to_front()
    page.keyboard.press("Control+Alt+Shift+r")
    deadline = time.monotonic() + 30
    prompt = page.get_by_text("Do you want Code to open the external website?", exact=True)
    while not prompt.count() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    expect(prompt).to_be_visible()
    candidates = page.locator(".monaco-dialog-box a").evaluate_all(
        "links => links.flatMap(link => [link.href, link.title, link.textContent])")
    url = next((value for value in candidates if value and "_pkm_token=" in value), None)
    if not url:
        page.get_by_role("button", name="Copy", exact=True).click()
        assert os.environ["DISPLAY"] == "127.0.0.1:91"
        assert Path(os.environ["XAUTHORITY"]) == fixture / "Xauthority"
        import tkinter
        clipboard = tkinter.Tk()
        clipboard.withdraw()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                clipboard.update()
                try:
                    url = clipboard.clipboard_get()
                    if "_pkm_token=" in url:
                        break
                except tkinter.TclError:
                    pass
                page.wait_for_timeout(100)
        finally:
            clipboard.destroy()
    cancel = page.get_by_role("button", name="Cancel", exact=True)
    if cancel.is_visible():
        cancel.click()
    parsed = urlparse(url)
    assert parsed.scheme == "http" and parsed.port and parsed.query.startswith("_pkm_token=")
    # The real old router advertises os.hostname(); only loopback exists in this private network namespace.
    url = urlunparse(("http", f"127.0.0.1:{parsed.port}", parsed.path, "", parsed.query, ""))
    (fixture / "legacy-recipe-browser-url.json").write_text(json.dumps({"url": url, "kind": "actual-original-code-url-dialog"}))
    browser_environment = dict(os.environ)
    short_temp = "/proc/self/cwd/t"
    assert Path.cwd().samefile(fixture)
    assert Path(short_temp).samefile(fixture / "t")
    browser_environment.update(TMPDIR=short_temp, TMP=short_temp, TEMP=short_temp)
    browser_environment.update(DBUS_SESSION_BUS_ADDRESS="unix:path=/proc/self/cwd/no-bus",
                               DBUS_SYSTEM_BUS_ADDRESS="unix:path=/proc/self/cwd/no-bus")
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ["PKM_UI_CHROMIUM"],
                                         env=browser_environment)
    editor = browser.new_page()
    try:
        editor.goto(url, wait_until="networkidle")
        expect(editor.locator("#name")).to_have_value("SATURN trusted original Recipe")
        expect(editor.locator("#graph .graph-node")).to_have_count(2)
        editor.get_by_role("button", name="JSON", exact=True).click()
        definition = json.loads(editor.locator("#json").input_value())
        assert [node["nodeId"] for node in definition["spec"]["nodes"]] == ["inspect", "record"]
        assert all(node["kind"] == "pkm.step.noop/v1" for node in definition["spec"]["nodes"])
        description = "SATURN edited in the actual original installed Recipe Workbench."
        editor.locator("#description").fill(description)
        with editor.expect_response(lambda response: response.request.method == "PUT" and "/api/recipe" in response.url) as received:
            editor.get_by_role("button", name="Save", exact=True).click()
        response = received.value
        save_error = None
        if response.status != 200:
            assert response.status == 400, response.text()
            save_error = response.json()["error"]
            assert save_error == "Unsupported canonical JSON type: undefined", save_error
            editor.screenshot(path=str(fixture / "legacy-recipe-save-refusal.png"), full_page=True)
            print("OBSERVED original Workbench Save refusal:", save_error, flush=True)
        editor.reload(wait_until="networkidle")
        readback = editor.request.get(f"http://127.0.0.1:{parsed.port}/api/recipe")
        assert readback.status == 200, readback.text()
        recipe = readback.json()["recipe"]
        assert recipe["recipeId"] == descriptor["legacyRecipe"]["recipeId"]
        assert recipe["revision"] == descriptor["legacyRecipe"]["recipeRevision"] + (not save_error)
        assert recipe["executableDigest"] == descriptor["legacyRecipe"]["recipeExecutableDigest"]
        expect(editor.locator("#description")).to_have_value(
            description if not save_error else descriptor["legacyRecipe"]["recipe"]["description"])
        editor.screenshot(path=str(fixture / "legacy-recipe-workbench.png"), full_page=True)
        (fixture / "legacy-recipe-ui-evidence.json").write_text(json.dumps({
            "kind": "actual-installed-original-vsix-recipe-workbench",
            "transport": "actual-old-code-router/private-loopback/headless-chromium",
            "recipe": recipe, "nodeIds": ["inspect", "record"],
            "save": {"status": response.status, "error": save_error, "persisted": not save_error,
                     "requestFields": sorted(response.request.post_data_json)},
            "legacyAuthoringQualified": not save_error,
            "migrationQualified": False,
        }))
    finally:
        browser.close()


def native(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    original_evidence = json.loads((fixture / "original-recipe-evidence.json").read_text())
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")

    def open_panel():
        expect(panel).to_be_visible(timeout=20000)
        if panel.get_attribute("open") is None:
            panel.locator("summary").click()
        expect(panel).to_contain_text("Authoring and full original executor/control parity are not enabled.")

    def create(mode):
        open_panel()
        panel.locator(f'[data-native-recipe-id="{original_evidence["recipeId"]}"]').click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill(json.dumps({"mode": mode}))
        field.press("Enter")
        expect(page.get_by_text("Run this exact Recipe with the installed trusted adapter?", exact=True)).to_be_visible(timeout=15000)
        detail = page.locator(".dialog-message-detail")
        expect(detail).to_contain_text(descriptor["root"])
        expect(detail).to_contain_text(original_evidence["recipeId"])
        expect(detail).to_contain_text('"mode": "' + mode + '"')
        run_id = json.loads(detail.inner_text().split("\nFresh authority", 1)[0])["runId"]
        page.get_by_role("button", name="Run exact native Recipe", exact=True).click()
        return run_id

    def row(run_id):
        return panel.locator(f'[data-native-recipe-run-id="{run_id}"]')

    state_file = fixture / "native-recipe-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    open_panel()
    expect(row(original_evidence["unknownRunId"])).to_contain_text("unknown")
    expect(row(original_evidence["unknownRunId"])).to_contain_text("original historical evidence")
    expect(row(original_evidence["completedRunId"])).to_contain_text("completed")
    if stage == "native-recipe-complete":
        run_id = create("complete")
        expect(row(run_id)).to_contain_text("succeeded", timeout=20000)
        expect(panel).to_have_attribute("open", "")
        open_panel()
        expect(row(run_id)).to_contain_text(original_evidence["inputSha256"])
        state["complete"] = run_id
    elif stage == "native-recipe-cancel":
        run_id = create("cancel")
        marker = fixture / f"native-recipe-held-{run_id}.json"
        deadline = time.monotonic() + 15
        while not marker.exists() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert marker.exists(), "Real adapter must hold before its effect."
        open_panel()
        expect(row(run_id).locator("pre")).to_contain_text(
            re.compile(r'"nodeId":\s*"record",\s*"state":\s*"running"'), timeout=15000)
        row(run_id).get_by_role("button", name="Cancel Recipe run", exact=True).click(timeout=15000)
        expect(page.get_by_text("Cancel this exact native Recipe run?", exact=True)).to_be_visible(timeout=15000)
        expect(page.locator(".dialog-message-detail")).to_contain_text(run_id)
        page.get_by_role("button", name="Cancel exact Recipe run", exact=True).click()
        expect(row(run_id)).to_contain_text("cancelled", timeout=15000)
        open_panel()
        expect(row(run_id)).to_contain_text("effect UNKNOWN")
        state["cancel"] = run_id
    elif stage == "native-recipe-crash":
        run_id = create("crash")
        marker = fixture / f"native-recipe-held-{run_id}.json"
        deadline = time.monotonic() + 15
        while not marker.exists() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert marker.exists(), "The real adapter must fsync its effect before SIGKILL."
        state["crash"] = run_id
    elif stage in ("native-recipe-reopen", "native-recipe-unknown-reopen", "native-recipe-final-reopen"):
        expect(row(state["complete"])).to_contain_text("succeeded")
        expect(row(state["cancel"])).to_contain_text("cancelled")
        if stage != "native-recipe-reopen":
            expect(row(state["crash"])).to_contain_text("unknown")
            expect(row(state["crash"])).to_contain_text("effect UNKNOWN")
            expect(row(state["crash"]).get_by_role("button", name="Cancel Recipe run", exact=True)).to_have_count(0)
            panel.get_by_role("button", name="Refresh Recipe state", exact=True).click()
            open_panel()
            expect(row(state["crash"])).to_contain_text("unknown")
    else:
        raise AssertionError(stage)
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"{stage}.png"), full_page=True)
    print(f"PASS actual installed same-root Recipe UI {stage}; original runs historical-only, authoring not qualified.", flush=True)


def library(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    state_file = fixture / "native-library-ui-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")

    def controls():
        expect(panel).to_be_visible(timeout=20000)
        if panel.get_attribute("open") is None:
            panel.locator("summary").click()

    def editor(excluded=()):
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
        raise AssertionError("Actual native Recipe Workbench did not appear.")

    def open_editor(new=False):
        controls()
        excluded = tuple(page.frames)
        if new:
            panel.get_by_role("button", name="New Recipe library definition", exact=True).click()
        else:
            panel.locator(f'[data-native-recipe-edit-id="{state["recipeId"]}"]').click()
        return editor(excluded)

    def approve_save(workbench, expected="Saved"):
        workbench.locator("#save").click()
        expect(page.get_by_text("Save this exact native Recipe library definition?", exact=True)).to_be_visible(timeout=15000)
        expect(page.locator(".dialog-message-detail")).to_contain_text(descriptor["root"])
        expect(page.locator(".dialog-message-detail")).to_contain_text(state["recipeId"])
        page.get_by_role("button", name="Save exact Recipe definition", exact=True).click()
        if expected:
            expect(workbench.locator("#status")).to_contain_text(expected, timeout=20000)

    def public_client(mode, revision, request_file=None):
        output = fixture / f"native-recipe-public-{mode}-result.json"
        log = fixture / f"native-recipe-public-{mode}.log"
        script = Path(__file__).parent / "next-trial-electron/native-recipe-public-client.cjs"
        with log.open("w") as stream:
            process = subprocess.Popen([descriptor["recipePublicNode"], str(script), str(fixture), mode,
                                        str(revision), str(request_file) if request_file else "-", str(output)],
                                       cwd=fixture, stdout=stream, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 40
            while process.poll() is None and time.monotonic() < deadline:
                page.wait_for_timeout(50)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                raise AssertionError(f"Actual {mode} client timed out: {log.read_text()}")
        assert process.returncode == 0, log.read_text()
        return json.loads(output.read_text())

    if stage == "native-library-author":
        workbench = open_editor(new=True)
        expect(workbench.locator(".graph-node")).to_have_count(2)
        state = workbench.evaluate("() => ({recipeId:recipe.recipeId,knowledgeId:recipe.knowledgeId,aliases:recipe.aliases})")
        workbench.locator("#name").fill("SATURN native authored library")
        workbench.locator("#description").fill("Native library revision one.")
        approve_save(workbench)
        expect(workbench.locator("#revision")).to_contain_text("Revision 1")
        workbench.locator('[data-mode="json"]').click()
        valid = workbench.locator("#json").input_value()
        invalid = json.loads(valid)
        invalid["spec"]["nodes"] = []
        workbench.locator("#json").fill(json.dumps(invalid))
        workbench.locator("#validate").click()
        expect(workbench.locator("#status")).to_contain_text("invalid", timeout=15000)
        approve_save(workbench, "invalid")
        expect(workbench.locator("#revision")).to_contain_text("Revision 1")
        workbench.locator("#json").fill(valid)
        workbench.locator("#validate").click()
        expect(workbench.locator("#status")).to_contain_text("Definition is valid")
        workbench.locator('[data-mode="graph"]').click()
        workbench.locator("#reorganize").click()
        workbench.locator("#description").fill("Native library revision two.")
        approve_save(workbench)
        expect(workbench.locator("#revision")).to_contain_text("Revision 2")
        stale = open_editor()
        expect(stale.locator("#revision")).to_contain_text("Revision 2")
        tabs = page.get_by_role("tab").filter(has_text="Recipe Library · SATURN native authored library")
        expect(tabs).to_have_count(2)
        tabs.nth(0).click()
        winner = workbench
        winner.locator("#description").fill("Native library conflict winner.")
        approve_save(winner)
        expect(winner.locator("#revision")).to_contain_text("Revision 3")
        tabs.nth(1).click()
        expect(stale.locator("#revision")).to_contain_text("Revision 2")
        stale.locator("#description").fill("Must not overwrite winner.")
        approve_save(stale, "conflict")
        expect(stale.locator("#revision")).to_contain_text("Revision 2")
        reopened = open_editor()
        expect(reopened.locator("#revision")).to_contain_text("Revision 3")
        expect(reopened.locator("#description")).to_have_value("Native library conflict winner.")
        expect(reopened.locator(".graph-node")).to_have_count(2)
        assert reopened.evaluate("recipe.knowledgeId") == state["knowledgeId"]
        assert reopened.evaluate("recipe.aliases") == state["aliases"]
        controls()
        panel.locator(f'[data-native-recipe-id="{state["recipeId"]}"]').click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill(json.dumps({"mode": "complete"}))
        field.press("Enter")
        expect(page.get_by_text("Run this exact Recipe with the installed trusted adapter?", exact=True)).to_be_visible(timeout=15000)
        page.get_by_role("button", name="Run exact native Recipe", exact=True).click()
        run = panel.locator('[data-native-recipe-run-id^="recipe_native_"]')
        expect(run).to_have_count(1, timeout=20000)
        expect(run).to_contain_text("succeeded", timeout=20000)
        state["runId"] = run.get_attribute("data-native-recipe-run-id")
        if descriptor.get("recipePublic"):
            state["publicRequests"], state["publicRunIds"] = [], []
            for mode in ("mcp", "http"):
                controls()
                panel.locator(f'[data-native-recipe-public-id="{state["recipeId"]}"]').click()
                field = page.locator(".quick-input-widget input")
                expect(field).to_be_visible(timeout=15000)
                field.fill(json.dumps({"mode": "complete"}))
                field.press("Enter")
                expect(page.get_by_text("Authorize this exact MCP/HTTP native Recipe request?", exact=True)).to_be_visible(timeout=15000)
                expect(page.locator(".dialog-message-detail")).to_contain_text(descriptor["root"])
                page.get_by_role("button", name="Authorize exact public Recipe request", exact=True).click()
                request = panel.locator("[data-native-public-recipe-request]")
                expect(request).to_have_count(1, timeout=15000)
                deadline = time.monotonic() + 15
                while True:
                    approved = json.loads(request.inner_text())
                    if not state["publicRequests"] or approved != state["publicRequests"][-1]:
                        break
                    assert time.monotonic() < deadline
                    page.wait_for_timeout(50)
                state["publicRequests"].append(approved)
                request_file = fixture / f"native-public-{mode}-approved.json"
                request_file.write_text(json.dumps(approved))
                state_file.write_text(json.dumps(state))
                result = public_client(mode, 3, request_file)
                state["publicRunIds"].append(result["runId"])
                state_file.write_text(json.dumps(state))
    elif stage == "native-library-crash":
        workbench = open_editor()
        expect(workbench.locator("#revision")).to_contain_text("Revision 3")
        workbench.locator("#description").fill("Native library COMMIT before SIGKILL.")
        approve_save(workbench, expected=None)
        marker = fixture / "native-recipe-library-committed.json"
        deadline = time.monotonic() + 15
        while not marker.exists() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert marker.exists(), "Real native SQL COMMIT must precede broker SIGKILL."
        expect(workbench.locator("#status")).to_contain_text("No automatic retry", timeout=15000)
    elif stage in ("native-library-recovered", "native-library-final"):
        workbench = open_editor()
        expect(workbench.locator("#revision")).to_contain_text("Revision 4")
        expect(workbench.locator("#description")).to_have_value("Native library COMMIT before SIGKILL.")
        assert workbench.evaluate("recipe.knowledgeId") == state["knowledgeId"]
        assert workbench.evaluate("recipe.aliases") == state["aliases"]
        expect(workbench.locator(".graph-node")).to_have_count(2)
        workbench.locator('[data-mode="json"]').click()
        expect(workbench.locator("#json")).to_have_value(re.compile(r'"record"'))
        controls()
        expect(panel.locator(f'[data-native-recipe-run-id="{state["runId"]}"]')).to_contain_text("succeeded")
        if descriptor.get("recipePublic"):
            public_client("read-mcp" if stage == "native-library-recovered" else "read-http", 4)
    else:
        raise AssertionError(stage)
    state_file.write_text(json.dumps(state))
    page.screenshot(path=str(fixture / f"{stage}.png"), full_page=True)
    print(f"PASS actual native Recipe LIBRARY UI {stage}; durable definitions, not run creation.", flush=True)
