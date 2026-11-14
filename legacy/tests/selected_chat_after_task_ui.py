#!/usr/bin/env python3
"""Exercise Task completion, ordinary input, queue and Task restart in installed Code."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(os.environ["PKM_SELECTED_FIXTURE"])
original = os.environ.get("PKM_SELECTED_ORIGINAL_UI") == "1"
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
        wait_for(lambda: (root / ("recovery-ui-ready" if restart else "ui-ready")).exists(), "Chat selection")
        if not original:
            header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
            if header.count() and header.get_attribute("aria-expanded") != "true":
                header.click()
            library = wait_for(lambda: next((candidate for candidate in page.frames
                if candidate.locator("#native-chat-experiment").is_visible()), None), "selected Chat library")
            if not library.locator("#prompt").is_visible():
                library.get_by_role("button", name="Completed New chat", exact=True).click()
        frame = wait_for(lambda: next((candidate for candidate in page.frames
                                      if candidate.locator("#prompt").count()
                                      and candidate.locator("#prompt").is_visible()), None), "Chat composer")
        if restart:
            wait_for(lambda: frame.locator("#task").get_attribute("aria-label") == "Complete Task", "new Task after restart")
            text = frame.locator("#messages").inner_text()
            assert "AFTER_TASK_ARCHIVED_HISTORY" in text
            assert "ORIGINAL_UI_FIRST" in text and "ORIGINAL_UI_QUEUED" in text
            assert "ORIGINAL_UI_FIRST_RESPONSE" in text and "ORIGINAL_UI_QUEUED_RESPONSE" in text
            (root / "recovery-ui-complete").write_text(json.dumps({"historyRetained": True, "newTaskRetained": True}))
        else:
            wait_for(lambda: frame.locator("#task").get_attribute("aria-label") == "Complete Task", "original active Task")
            assert "AFTER_TASK_ARCHIVED_HISTORY" in frame.locator("#messages").inner_text()
            frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            if original:
                decision = frame.locator('section[aria-label="Chat decision"]')
                wait_for(lambda: decision.is_visible(), "original completion decision")
                decision.get_by_role("button", name="Complete Task").click()
            wait_for(lambda: frame.locator("#task").get_attribute("aria-label") == "Start Task", "completed Task")
            frame.locator("#prompt").fill("ORIGINAL_UI_FIRST")
            frame.locator("#send").click()
            wait_for(lambda: (root / "original-first-request").exists(), "ordinary provider request")
            wait_for(lambda: frame.locator("#send").get_attribute("aria-label") in ("Steer", "Queue new task"),
                     "running ordinary composer")
            if frame.locator("#task-mode").is_visible():
                frame.locator("#task-mode").click()
            frame.locator("#prompt").fill("ORIGINAL_UI_QUEUED")
            frame.locator("#send").click()
            wait_for(lambda: "ORIGINAL_UI_QUEUED" in frame.locator("#queued-inputs").inner_text(), "ordinary queued input")
            (root / "original-release").write_text("release")
            wait_for(lambda: json.loads((root / "original-provider-observations.json").read_text())["calls"] == 2,
                     "ordinary queued dispatch")
            wait_for(lambda: "ORIGINAL_UI_QUEUED_RESPONSE" in frame.locator("#messages").inner_text(), "ordinary reply")
            wait_for(lambda: not frame.locator("#task").is_disabled(), "idle Task button")
            if not frame.locator("#task").is_visible():
                frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            wait_for(lambda: frame.locator("#task").get_attribute("aria-label") == "Complete Task", "new Task")
            (root / "ui-complete").write_text(json.dumps({"completedOriginalTask": True,
                "ordinaryInput": "ORIGINAL_UI_FIRST", "queuedInput": "ORIGINAL_UI_QUEUED", "startedNewTask": True}))
    except Exception:
        detail = traceback.format_exc()
        try:
            detail += "\nFrames:\n" + "\n".join(candidate.url for candidate in page.frames)
            detail += "\nWorkbench:\n" + page.locator("body").inner_text(timeout=5000)
            if frame:
                detail += "\nChat:\n" + frame.locator("body").inner_text(timeout=5000)
            page.screenshot(path=str(root / "after-task-ui-error.png"))
        except Exception:
            pass
        (root / ("after-task-restart-error.txt" if restart else "after-task-ui-error.txt")).write_text(detail)
        raise
    finally:
        browser.close()
