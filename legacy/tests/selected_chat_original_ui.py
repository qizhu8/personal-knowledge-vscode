#!/usr/bin/env python3
"""Exercise the installed original Chat through its renderer and local provider."""
import json
import os
import sys
import time
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(os.environ["PKM_SELECTED_FIXTURE"])


def wait_for(predicate, description, timeout=60):
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
        (root / "renderer-connected").write_text("ready")
        wait_for(lambda: (root / "ui-ready").exists(), "original Chat selection")
        frame = wait_for(lambda: next((candidate for candidate in page.frames
                                      if candidate.locator("#prompt").count()
                                      and candidate.locator("#prompt").is_visible()), None), "original Chat composer")
        frame.locator("#prompt").fill("ORIGINAL_UI_FIRST")
        frame.locator("#send").click()
        wait_for(lambda: (root / "original-first-request").exists(), "first provider request")
        wait_for(lambda: frame.locator("#send").get_attribute("aria-label") in ("Steer", "Queue new task"), "running composer")
        frame.locator("#prompt").fill("ORIGINAL_UI_QUEUED")
        frame.locator("#send").click()
        wait_for(lambda: "ORIGINAL_UI_QUEUED" in frame.locator("#queued-inputs").inner_text(), "original queued input")
        (root / "original-release").write_text("release")
        wait_for(lambda: json.loads((root / "original-provider-observations.json").read_text())["calls"] == 2,
                 "original queue provider dispatch")
        wait_for(lambda: "ORIGINAL_UI_QUEUED_RESPONSE" in frame.locator("#messages").inner_text(), "queued response")
        (root / "ui-complete").write_text(json.dumps({"first": "ORIGINAL_UI_FIRST", "queued": "ORIGINAL_UI_QUEUED"}))
    except Exception:
        detail = traceback.format_exc()
        try:
            detail += "\nFrames:\n" + "\n".join(candidate.url for candidate in page.frames)
            detail += "\nWorkbench:\n" + page.locator("body").inner_text(timeout=5000)
            page.screenshot(path=str(root / "original-ui-error.png"))
            if frame:
                detail += "\nChat:\n" + frame.locator("body").inner_text(timeout=5000)
        except Exception:
            pass
        (root / "original-ui-error.txt").write_text(detail)
        raise
    finally:
        browser.close()
