#!/usr/bin/env python3
import argparse
import json
import pathlib

from playwright.sync_api import sync_playwright


def respond(page, command, data):
    page.evaluate("message => window.dispatchEvent(new MessageEvent('message', {data:message}))",
                  {"command": command, "data": data})


def rename_fixture(page, name):
    page.evaluate("""name => {
        const fixture = structuredClone(projectSnapshot);
        fixture.agentSnapshots[0].name = name;
        window.dispatchEvent(new MessageEvent('message', {data:{command:'projectState', data:fixture}}));
    }""", name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4187/?view=agentSnapshots")
    parser.add_argument("--screenshots-dir", default="/tmp/pkm-snapshot-browser")
    args = parser.parse_args()
    screenshots = pathlib.Path(args.screenshots_dir)
    screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        row = page.locator(".agent-snapshot-tree-item").first
        row.wait_for()
        page.wait_for_function("window.__previewMessages.some(item => item.command === 'agentSnapshotContents')")
        snapshot = page.evaluate("projectSnapshot.agentSnapshots[0]")
        assert row.locator(".tt").inner_text().strip().endswith(snapshot["task"])
        folder = page.locator(".agent-snapshot-workspace .tree-cat-hdr").first
        folder.focus()
        folder.press("Space")
        assert folder.get_attribute("aria-expanded") == "false"
        assert not row.is_visible()
        folder.press("Space")
        assert row.is_visible()
        row.locator(".cattree-item-menu").click()
        menu = page.locator("#paper-ctx")
        assert "Copy Magic Code" not in menu.inner_text()
        assert "Recover into New PKM Chat" in menu.inner_text()
        menu.get_by_text("Copy Read Prompt", exact=True).click()
        page.wait_for_function("window.__previewMessages.some(item => item.command === 'copyText')")
        copied = page.evaluate("window.__previewMessages.filter(item => item.command === 'copyText').at(-1).text")
        assert copied == ('Read the PKM Agent Snapshot state first: call the PKM MCP function agent_session_snapshot_read with '
                          '{"magic_code":"' + snapshot["magicCode"] + '"}. It is read-only and does not create an Agent Session; '
                          'continue from its task, todos, checkpoints and Recipe run states.')
        row.click(button="right")
        menu.get_by_text("Rename…", exact=True).click()
        field = page.locator("#pk-modal-input")
        assert field.input_value() == snapshot["task"]
        field.fill("   ")
        page.locator("#pk-modal-ok").click()
        assert page.locator("#pk-modal-error").inner_text()
        field.fill("  QPS  ")
        field.press("Enter")
        page.wait_for_function("window.__previewMessages.some(item => item.command === 'agentSnapshotRename')")
        request = page.evaluate("window.__previewMessages.find(item => item.command === 'agentSnapshotRename')")
        assert request["snapshotId"] == snapshot["snapshotId"] and request["name"] == "QPS"
        rename_fixture(page, request["name"])
        assert page.locator(".agent-snapshot-title h3").inner_text() == "QPS"
        assert row.locator(".tt").inner_text().strip().endswith("QPS")
        page.get_by_role("button", name="Rename Snapshot", exact=True).click()
        assert field.input_value() == "QPS"
        field.fill("Do not save")
        page.get_by_role("button", name="Cancel", exact=True).click()
        assert page.evaluate("window.__previewMessages.filter(item => item.command === 'agentSnapshotRename').length") == 1
        capture = {"snapshotId": snapshot["snapshotId"], "session": {
            "task": "Captured Snapshot verification", "status": "running", "agent": {"name": "Copilot Agent"},
            "privateContext": "</pre><script>unsafe</script>",
            "todos": [{"title": "Validate capture", "status": "succeeded", "details": "Captured evidence"},
                      {"title": "Package extension", "status": "pending"}],
            "checkpoints": [{"checkpointId": "checkpoint_preview", "reason": "Before restart",
                             "state": {"summary": "Saved commitments", "decisions": ["Keep recovery identity"]}}],
        }, "recipeRuns": [{"runId": "recipe_run_preview", "status": "running",
                           "nodes": {"build": {"state": "succeeded"}, "verify": {"state": "pending"}}}]}
        respond(page, "agentSnapshotContents", capture)
        contents = page.locator(".agent-snapshot-contents")
        assert contents.locator("h4").all_text_contents() == ["Todos (2)", "Checkpoints (1)", "Recipe Runs (1)"]
        record = contents.locator("details").first
        record.locator("summary").click()
        assert "Captured Snapshot verification" in record.locator("pre").inner_text()
        assert contents.locator("script").count() == 0
        record.locator("summary").click()
        todo = contents.locator("ol details").first
        todo.locator("summary").click()
        assert "Captured evidence" in todo.locator("pre").inner_text()
        respond(page, "agentSnapshotContents", {"snapshotId": "agent_snapshot_stale", "session": {"task": "Wrong"}})
        assert "Captured Snapshot verification" in contents.inner_text()
        screenshots_taken = []
        for width, height in [(1280, 900), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            if width < 500:
                rename_fixture(page, "A" * 200)
            page.evaluate("document.fonts.ready")
            title = page.locator(".agent-snapshot-title h3").bounding_box()
            icon = page.locator(".agent-snapshot-title .ibtn").bounding_box()
            assert title["x"] + title["width"] <= icon["x"] + 1
            assert icon["width"] == 26 and icon["height"] == 26
            assert icon["x"] + icon["width"] <= width
            tree_menu = row.locator(".cattree-item-menu").bounding_box()
            tree_title = row.locator(".tt").bounding_box()
            assert tree_menu["width"] == 24 and tree_menu["height"] == 24
            assert tree_title["x"] + tree_title["width"] <= tree_menu["x"] + 1
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            screenshot = screenshots / f"snapshot-{width}.png"
            page.screenshot(path=str(screenshot), full_page=True)
            screenshots_taken.append(str(screenshot))
        rename_fixture(page, "QPS")
        assert page.evaluate("projectSnapshot.agentSnapshots[0].magicCode") == snapshot["magicCode"]
        assert page.evaluate("projectSnapshot.agentSnapshots[0].task") == snapshot["task"]
        respond(page, "agentSnapshotContents", {"snapshotId": snapshot["snapshotId"], "error": "Cannot read <capture>"})
        assert contents.get_by_role("alert").inner_text() == "Cannot read <capture>"
        retry = contents.locator("button")
        assert retry.inner_text().strip() == "Retry"
        retry.click()
        page.wait_for_function("window.__previewMessages.filter(item => item.command === 'agentSnapshotContents').length === 2")
        respond(page, "agentSnapshotContents", {"snapshotId": snapshot["snapshotId"], "session": {"task": "Empty capture"}, "recipeRuns": []})
        assert "No captured Todos" in contents.inner_text()
        assert "No captured Checkpoints" in contents.inner_text()
        assert "No captured Recipe runs" in contents.inner_text()
        page.evaluate("state.tab='agentSessions'; projectSnapshot.agentSessions[0].task='Long Session title '.repeat(30); renderAgentSessions()")
        for width, height in [(1280, 900), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator(".agent-session-row").first.click(button="right")
            session_menu = page.locator("#paper-ctx.agent-session-context-menu")
            assert session_menu.evaluate("element => getComputedStyle(element).display") == "block"
            assert session_menu.locator(".pctx-header").count() == 0
            assert "Long Session title" not in session_menu.inner_text()
            items = session_menu.locator(".pctx-item").all()
            bounds = [item.bounding_box() for item in items]
            assert len(bounds) >= 3
            assert all(current["y"] + current["height"] <= following["y"] + 1
                       for current, following in zip(bounds, bounds[1:]))
            menu_bounds = session_menu.bounding_box()
            assert 0 <= menu_bounds["x"] and menu_bounds["x"] + menu_bounds["width"] <= width
            assert 0 <= menu_bounds["y"] and menu_bounds["y"] + menu_bounds["height"] <= height
            screenshot = screenshots / f"session-menu-{width}.png"
            page.screenshot(path=str(screenshot))
            screenshots_taken.append(str(screenshot))
            page.evaluate("closePaperMenu()")
            page.evaluate("agentSessionTrashContextMenu(new MouseEvent('contextmenu', {clientX:innerWidth-5, clientY:innerHeight-5}), projectSnapshot.agentSessions[0].sessionId)")
            assert session_menu.locator(".pctx-header").count() == 0
            assert session_menu.locator(".pctx-item").all_text_contents() == ["Restore", "Delete Permanently…"]
            assert session_menu.evaluate("element => getComputedStyle(element).display") == "block"
            menu_bounds = session_menu.bounding_box()
            assert 0 <= menu_bounds["x"] and menu_bounds["x"] + menu_bounds["width"] <= width
            assert 0 <= menu_bounds["y"] and menu_bounds["y"] + menu_bounds["height"] <= height
            page.evaluate("closePaperMenu()")
        assert not errors, errors
        browser.close()
    print(json.dumps({"status": "passed", "screenshots": screenshots_taken}))


if __name__ == "__main__":
    main()