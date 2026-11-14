import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
root = Path(fixture["root"])


def stage(expected):
    for _ in range(600):
        try:
            progress = json.loads((root / "progress.json").read_text())
            assert progress["stage"] != "failed", progress.get("error")
            if progress["stage"] == expected:
                return
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Runner did not reach {expected}")


with sync_playwright() as playwright:
    browser = None
    page = None
    try:
        for _ in range(300):
            try:
                browser = playwright.chromium.connect_over_cdp(
                    f"http://127.0.0.1:{fixture['port']}", timeout=1000
                )
                if browser.contexts and browser.contexts[0].pages:
                    page = browser.contexts[0].pages[0]
                    break
            except Exception:
                pass
            time.sleep(0.1)
        assert page is not None, "Private VS Code CDP unavailable"
        page.set_default_timeout(15000)
        page.wait_for_load_state("domcontentloaded")
        page.locator(".monaco-workbench").wait_for()

        def picker(path, title):
            widget = page.locator(".quick-input-widget")
            widget.wait_for(state="visible")
            widget.get_by_text(title, exact=True).wait_for(state="visible")
            field = widget.locator("input").first
            field.fill(path)
            field.press("Enter")

        def preview():
            picker(fixture["source"], "Select a quiescent DISPOSABLE legacy copy (never the live Knowledge Root)")
            picker(fixture["destination"], "Choose a NEW isolated destination directory path (must not exist)")
            picker(fixture["node"], "Select trusted Node.js executable (>=22.18, node:sqlite required)")
            picker(fixture["python"], "Select trusted Python executable for atomic no-replace publication")
            page.get_by_role("button", name="Inspect disposable copy", exact=True).click()
            page.get_by_text(
                "Review the read-only plan in PKM Next Experimental output", exact=False
            ).last.wait_for(state="visible")
            clear_notifications()

        def clear_notifications():
            page.keyboard.press("Control+Shift+P")
            widget = page.locator(".quick-input-widget")
            widget.wait_for(state="visible")
            widget.locator("input").first.fill(">Notifications: Clear All Notifications")
            page.keyboard.press("Enter")
            widget.wait_for(state="hidden")

        stage("cancel-source")
        page.locator(".quick-input-widget").wait_for(state="visible")
        page.keyboard.press("Escape")
        stage("preview-deny")
        preview()
        stage("deny-confirm")
        page.get_by_role("button", name="Cancel", exact=True).click()
        stage("preview-accept")
        preview()
        stage("accept-confirm")
        body = page.locator(".monaco-dialog-box").inner_text()
        assert fixture["source"] in body and fixture["destination"] in body
        digest = re.search(r"Plan SHA-256:\s*([a-f0-9]{64})", body).group(1)
        page.get_by_role("button", name="Import exact inspected plan", exact=True).click()
        page.get_by_text("Isolated import published. No service", exact=False).last.wait_for(state="visible")
        clear_notifications()
        stage("published")
        output = page.locator('.monaco-editor[data-uri^="output:"]')
        output.click()
        page.keyboard.press("Control+a")
        page.keyboard.press("Control+c")
        (root / "ui-copied.json").write_text(json.dumps({"planSha256": digest}))
        for _ in range(150):
            try:
                assert json.loads((root / "output-verified.json").read_text())["passed"]
                break
            except FileNotFoundError:
                time.sleep(0.1)
        else:
            raise AssertionError("Installed runner did not verify real Output clipboard")
        (root / "ui-passed.json").write_text(json.dumps({"passed": True, "planSha256": digest}))
        print("PASS real installed-host workbench dialogs and preview/receipt output")
    except Exception:
        if page is not None:
            try:
                (root / "ui-dom.html").write_text(page.content())
                (root / "ui-text.txt").write_text(page.locator("body").inner_text())
            except Exception:
                pass
        raise
    finally:
        if browser is not None:
            browser.close()
