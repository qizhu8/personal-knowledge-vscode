#!/usr/bin/env python3
"""Exercise a selected Chat before a crash and after an actual Code restart."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


root = Path(os.environ["PKM_SELECTED_FIXTURE"])
restart = os.environ.get("PKM_SELECTED_RESTART") == "1"
queued = "RECOVERY_PENDING_STEER"
edited = "RECOVERED_EDITED_STEER"


def wait_for(predicate, description, timeout=70):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception:
            pass
        time.sleep(0.2)
    raise AssertionError(f"Timed out: {description}")


def calls():
    file = root / "steer-provider-observations.json"
    return json.loads(file.read_text())["calls"] if file.exists() else 0


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(sys.argv[1])
        frame = None
        try:
            page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
            page.wait_for_load_state("networkidle", timeout=45000)
            page.bring_to_front()
            if not restart:
                (root / "renderer-connected").write_text("ready")
            page.wait_for_timeout(1500)
            header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
            if header.count() and header.get_attribute("aria-expanded") != "true":
                header.click()

            def chat_frame():
                for candidate in page.frames:
                    if candidate.locator("#composer").count() and candidate.locator("#native-chat-experiment").is_visible():
                        return candidate
                return None

            frame = wait_for(chat_frame, "selected Chat webview")
            wait_for(lambda: (root / ("recovery-ui-ready" if restart else "ui-ready")).exists(), "extension-host setup")
            wait_for(lambda: frame.locator("#chats option").count() > 0, "selected Chat")
            if not frame.locator("#chats").is_visible():
                frame.locator(".chat-list-open").first.click()
            wait_for(lambda: "ORIGINAL_RETAINED_MESSAGE" in frame.locator("#messages").inner_text(), "original message")
            wait_for(lambda: "ORIGINAL_ARCHIVED_QUEUE" in frame.locator("#native-workflow-controls").text_content(), "original archived queue")

            def review():
                button = frame.get_by_role("button", name="Review unknown outcomes", exact=True)
                wait_for(lambda: button.count() and button.is_enabled(), "unknown outcome review")
                button.click()
                wait_for(lambda: "Effect remains UNKNOWN; never replayed" in frame.locator("#native-workflow-controls").inner_text(),
                         "explicit unknown decision")

            if not restart:
                review()
                frame.locator("#prompt").fill("Start foreground process before host crash")
                frame.locator("#send").click()
                approve = frame.get_by_role("button", name="Allow once", exact=True)
                wait_for(lambda: approve.count() and approve.is_enabled(), "foreground process approval")
                approve.click()
                wait_for(lambda: (root / "process-start-1").exists(), "foreground process started")
                wait_for(lambda: frame.locator("#send").get_attribute("aria-label") == "Steer", "steer mode")
                frame.locator("#prompt").fill(queued)
                frame.locator("#send").click()
                wait_for(lambda: queued in frame.locator("#queued-inputs").inner_text(), "queued steer before crash")
                assert calls() == 1
                (root / "ui-crash-ready").write_text("ready")
            else:
                assert "Start foreground process before host crash" in frame.locator("#messages").inner_text()
                wait_for(lambda: queued in frame.locator("#queued-inputs").inner_text(), "same queued steer after restart")
                wait_for(lambda: frame.get_by_role("button", name="Review unknown outcomes", exact=True).count(),
                         "unknown outcome after crash")
                assert calls() == 1, "Restart dispatched a provider request"
                assert (root / "process-count").read_text() == "1", "Restart repeated a process effect"
                review()
                page.wait_for_timeout(2000)
                editor_button = frame.locator("#queued-inputs").get_by_role("button", name="Edit queued message")
                editor_button.click()
                save = frame.locator("#queued-inputs").get_by_role("button", name="Save queued message")
                wait_for(lambda: save.is_enabled(), "queue edit authorization")
                frame.locator("#queued-inputs").get_by_role("textbox", name="Edit queued message").fill(edited)
                save.click()
                wait_for(lambda: edited in frame.locator("#queued-inputs").inner_text(), "saved queue edit")
                run = frame.locator("#queued-inputs").get_by_role("button", name="Run queued inputs")
                wait_for(lambda: run.is_enabled(), "explicit queue recovery")
                run.click()
                wait_for(lambda: "RECOVERED_AFTER_BUDGET" in frame.locator("#messages").inner_text(), "fresh provider response")
                wait_for(lambda: calls() == 2, "explicit recovery request")
                assert (root / "process-count").read_text() == "1", "Explicit recovery repeated the unknown process"
                assert "ORIGINAL_ARCHIVED_QUEUE" in frame.locator("#native-workflow-controls").text_content()
                (root / "recovery-ui-complete").write_text(json.dumps({
                    "providerCallsBeforeReview": 1, "providerCallsAfterExplicitRecovery": 2,
                    "oldMessage": "ORIGINAL_RETAINED_MESSAGE", "oldQueue": "ORIGINAL_ARCHIVED_QUEUE",
                    "queuedBeforeRestart": queued, "explicitlyEditedInput": edited,
                    "processStarts": 1,
                }))
        except Exception:
            detail = traceback.format_exc()
            if frame:
                try:
                    detail += "\nWebview text:\n" + frame.locator("body").inner_text(timeout=5000)
                except Exception:
                    pass
            (root / ("recovery-ui-error.txt" if restart else "crash-ui-error.txt")).write_text(detail)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL selected Chat recovery UI: {error}", file=sys.stderr)
        sys.exit(1)
