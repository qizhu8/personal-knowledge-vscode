#!/usr/bin/env python3
"""Inspect two original completed Tasks through the installed selected Chat."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


root = Path(os.environ["PKM_SELECTED_FIXTURE"])
restart = os.environ.get("PKM_SELECTED_RESTART") == "1"


def wait_for(predicate, description, timeout=70):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except Exception:
            pass
        time.sleep(0.2)
    raise AssertionError(f"Timed out: {description}")


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(sys.argv[1])
    frame = None
    try:
        page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
        page.wait_for_load_state("networkidle", timeout=45000)
        page.bring_to_front()
        if not restart:
            (root / "renderer-connected").write_text("ready")
        wait_for(lambda: (root / ("recovery-ui-ready" if restart else "ui-ready")).exists(), "selected Chat")
        header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
        if header.count() and header.get_attribute("aria-expanded") != "true":
            header.click()

        def chat_frame():
            return next((candidate for candidate in page.frames
                         if candidate.locator("#composer").count()
                         and candidate.locator("#native-chat-experiment").is_visible()), None)

        frame = wait_for(chat_frame, "selected Chat webview")
        sessions = json.loads((root / "original-task-sessions.json").read_text())
        section = frame.locator("details[data-native-task-sessions]")
        wait_for(lambda: section.count() and section.is_visible(), "historical Session list")
        section.locator("summary").click()
        for index, session in enumerate(sessions):
            button = frame.locator(f'button[data-native-task-session="{session["sessionId"]}"]')
            wait_for(lambda: button.count() and button.is_visible(), f"Session button {index}")
            button.click()

            def rendered():
                for candidate in page.frames:
                    panel = candidate.locator("#harness")
                    if panel.count() and panel.is_visible():
                        text = panel.inner_text(timeout=3000)
                        if session["title"] in text and candidate.locator('.pkm-harness-stage[data-stage="configure"]').count():
                            return candidate
                return None

            harness = wait_for(rendered, f"exact Task harness {index}")
            harness.locator('.pkm-harness-stage[data-stage="configure"]').first.click()
            wait_for(lambda: session["marker"] in harness.locator(".pkm-harness-inspector").inner_text(),
                     f"original Task input {index}")
        (root / ("recovery-ui-complete" if restart else "ui-complete")).write_text(json.dumps({
            "inspected": [session["sessionId"] for session in sessions],
            "eachTaskHadItsOwnOriginalInput": True,
        }))
    except Exception:
        detail = traceback.format_exc()
        try:
            detail += "\nFrames:\n" + "\n".join(candidate.url for candidate in page.frames)
            detail += "\nWorkbench:\n" + page.locator("body").inner_text(timeout=5000)
            if frame:
                detail += "\nChat:\n" + frame.locator("body").inner_text(timeout=5000)
            page.screenshot(path=str(root / "session-ui-error.png"))
        except Exception:
            pass
        (root / ("session-restart-ui-error.txt" if restart else "session-ui-error.txt")).write_text(detail)
        raise
    finally:
        browser.close()
