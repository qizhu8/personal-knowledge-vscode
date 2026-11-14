#!/usr/bin/env python3
"""Use real VS Code dialogs and a private local SDK transport for selected Chat."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from selected_chat_sdk_dialogs import handle_dialogs

root = Path(os.environ["PKM_SELECTED_FIXTURE"])
phase = int(os.environ.get("PKM_SELECTED_PHASE", "1"))


def trace(value):
    with (root / f"sdk-phase{phase}-ui-actions.log").open("a") as log:
        log.write(value + "\n")


def wait_for(predicate, description, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except Exception:
            pass
        time.sleep(0.15)
    raise AssertionError(f"Timed out: {description}")


def wait_ready(page):
    marker = root / ("ui-ready" if phase == 1 else f"permission-phase{phase}-ready")
    deadline = time.monotonic() + 65
    observed = ""
    while time.monotonic() < deadline:
        if marker.exists():
            return
        if (root / "driver-errors.json").exists():
            raise AssertionError((root / "driver-errors.json").read_text())
        try:
            text = page.locator("body").inner_text(timeout=1000)
            if text != observed:
                observed = text
                (root / f"sdk-phase{phase}-last-workbench.txt").write_text(text)
                (root / f"sdk-phase{phase}-last-workbench.html").write_text(page.content())
            handle_dialogs(page, root, trace, phase)
        except Exception as error:
            trace(f"setup action error: {error}")
        time.sleep(0.15)
    raise AssertionError("Selected Chat setup did not complete")


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
        wait_ready(page)
        header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
        if header.count() and header.get_attribute("aria-expanded") != "true":
            header.click()
        frame = wait_for(lambda: next((candidate for candidate in page.frames
                                      if candidate.locator("#native-chat-experiment").count()
                                      and candidate.locator("#native-chat-experiment").is_visible()), None), "selected Chat")
        if not frame.locator("#prompt").is_visible():
            frame.locator(".chat-list-open").first.click(timeout=15000)
        expect(frame.locator("#prompt")).to_be_visible(timeout=30000)
        if phase == 1:
            frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            wait_for(lambda: page.locator(".quick-input-widget").is_visible(), "Task title")
            page.locator(".quick-input-widget input").first.fill("Private selected Chat task")
            page.locator(".quick-input-widget input").first.press("Enter")
            expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
            send(frame, "Run once.")
            prompt = frame.get_by_role("button", name="Allow once", exact=True)
            expect(prompt).to_be_visible(timeout=30000)
            assert not (root / "ticks").exists()
            prompt.click()
            wait_for(lambda: (root / "ticks").exists() and (root / "ticks").read_text() == "x", "once process")
            wait_for(lambda: frame.locator("#messages").inner_text().count("SDK_FIXTURE_SUCCESS") >= 1, "once response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            send(frame, "Run and remember.")
            prompt = frame.get_by_role("button", name="Approve & remember", exact=True)
            expect(prompt).to_be_visible(timeout=30000)
            assert (root / "ticks").read_text() == "x"
            prompt.click()
            wait_for(lambda: (root / "ticks").read_text() == "xx", "remembered process")
            wait_for(lambda: frame.locator("#messages").inner_text().count("SDK_FIXTURE_SUCCESS") >= 2, "remembered response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            (root / "ui-complete").write_text("done")
        elif phase == 2:
            send(frame, "Run after restart.")
            wait_for(lambda: (root / "ticks").read_text() == "xxx", "remembered process after restart")
            wait_for(lambda: frame.locator("#messages").inner_text().count("SDK_FIXTURE_SUCCESS") >= 3, "restarted response")
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
            assert frame.get_by_role("button", name="Approve & remember", exact=True).count() == 0
            if not frame.locator("#permissions").is_visible():
                frame.locator("#chat-actions-toggle").click()
            frame.locator("#permissions").click()
            expect(frame.locator("#reset-permissions")).to_be_enabled()
            frame.locator("#reset-permissions").click()
            button = page.get_by_role("button", name="Reset and close Chat", exact=True)
            expect(button).to_be_visible(timeout=30000)
            button.click()
            wait_for(lambda: frame.is_detached() or not frame.locator("#prompt").is_visible(), "reset closes selected Chat")
            wait_for(lambda: page.locator(".notifications-toasts .notification-list-item").filter(
                has_text="Next Chat remembered process approvals were reset. Reopen the Chat to continue."
            ).first.is_visible(),
                     "reset success notification")
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
                (root / f"sdk-permission-phase{phase}-workbench.html").write_text(page.content())
                page.screenshot(path=str(root / f"sdk-permission-phase{phase}-error.png"))
            if frame:
                detail += "\nChat:\n" + frame.locator("body").inner_text(timeout=5000)
        except Exception:
            pass
        (root / f"sdk-permission-phase{phase}-error.txt").write_text(detail)
        raise
    finally:
        browser.close()
