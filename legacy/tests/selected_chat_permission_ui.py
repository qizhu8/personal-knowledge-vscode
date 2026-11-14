#!/usr/bin/env python3
"""Exercise selected Chat process approval and reset in an isolated Code profile."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

root = Path(os.environ["PKM_SELECTED_FIXTURE"])
phase = int(os.environ.get("PKM_SELECTED_PHASE", "1"))


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


def send(frame, text):
    frame.locator("#prompt").fill(text)
    expect(frame.locator("#send")).to_be_enabled(timeout=30000)
    frame.locator("#send").click()


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(sys.argv[1])
    page = None
    frame = None
    try:
        page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
        page.wait_for_load_state("networkidle", timeout=45000)
        page.bring_to_front()
        if phase == 1:
            (root / "renderer-connected").write_text("ready")
        wait_for(lambda: (root / ("ui-ready" if phase == 1 else f"permission-phase{phase}-ready")).exists(), "selected Chat")
        header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
        if header.count() and header.get_attribute("aria-expanded") != "true":
            header.click()
        frame = wait_for(lambda: next((candidate for candidate in page.frames
                                      if candidate.locator("#native-chat-experiment").count()
                                      and candidate.locator("#native-chat-experiment").is_visible()), None), "selected Chat library")
        if not frame.locator("#prompt").is_visible():
            frame.locator(".chat-list-open").first.click(timeout=15000)
        expect(frame.locator("#prompt")).to_be_visible(timeout=30000)
        if phase == 1:
            frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
            send(frame, "Run once.")
            prompt = frame.get_by_role("button", name="Allow once", exact=True)
            expect(prompt).to_be_visible(timeout=30000)
            assert not (root / "ticks").exists()
            prompt.click()
            wait_for(lambda: (root / "ticks").exists() and (root / "ticks").read_text() == "x", "once process")
            wait_for(lambda: frame.locator("#messages").inner_text().count("FIXTURE_SUCCESS") >= 1, "once response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            send(frame, "Run and remember.")
            prompt = frame.get_by_role("button", name="Approve & remember", exact=True)
            expect(prompt).to_be_visible(timeout=30000)
            assert (root / "ticks").read_text() == "x"
            prompt.click()
            wait_for(lambda: (root / "ticks").read_text() == "xx", "remembered process")
            wait_for(lambda: frame.locator("#messages").inner_text().count("FIXTURE_SUCCESS") >= 2, "remembered response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            (root / "ui-complete").write_text("done")
        elif phase == 2:
            send(frame, "Run after restart.")
            wait_for(lambda: (root / "ticks").read_text() == "xxx", "remembered process after restart")
            wait_for(lambda: frame.locator("#messages").inner_text().count("FIXTURE_SUCCESS") >= 3, "restarted response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            assert frame.get_by_role("button", name="Approve & remember", exact=True).count() == 0
            if not frame.locator("#permissions").is_visible():
                frame.locator("#chat-actions-toggle").click()
            frame.locator("#permissions").click()
            expect(frame.locator("#reset-permissions")).to_be_enabled()
            frame.locator("#reset-permissions").click()
            wait_for(lambda: frame.is_detached() or not frame.locator("#prompt").is_visible(), "reset closes selected Chat")
            wait_for(lambda: (root / "permission-reset-confirmed").exists(), "reset acknowledged after key deletion")
        else:
            send(frame, "Run after reset.")
            prompt = frame.get_by_role("button", name="Deny", exact=True)
            expect(prompt).to_be_visible(timeout=30000)
            prompt.click()
            expect(prompt).to_be_hidden(timeout=30000)
            frame.wait_for_timeout(2000)
            assert (root / "ticks").read_text() == "xxx"
        (root / f"permission-phase{phase}-complete").write_text(json.dumps({"phase": phase, "complete": True}))
    except Exception:
        detail = traceback.format_exc()
        try:
            if page:
                detail += "\nFrames:\n" + "\n".join(candidate.url for candidate in page.frames)
                detail += "\nWorkbench:\n" + page.locator("body").inner_text(timeout=5000)
                page.screenshot(path=str(root / f"permission-phase{phase}-error.png"))
            if frame:
                detail += "\nChat:\n" + frame.locator("body").inner_text(timeout=5000)
        except Exception:
            pass
        (root / f"permission-phase{phase}-error.txt").write_text(detail)
        raise
    finally:
        browser.close()
