#!/usr/bin/env python3
"""Exercise the installed selected-Chat UI against the isolated local provider."""
import json
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


root = Path(os.environ["PKM_SELECTED_FIXTURE"])
long_steer = "BUDGET_STEER_" + "x" * 6000
recovered = "RECOVERED_EDITED_STEER"
cancelled = "CANCELLED_QUEUED_STEER"


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


def observations():
    log = root / "steer-provider-observations.json"
    return json.loads(log.read_text()) if log.exists() else {"calls": 0, "users": []}


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(sys.argv[1])
        frame = None
        try:
            page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
            page.wait_for_load_state("networkidle", timeout=30000)
            page.bring_to_front()
            (root / "renderer-connected").write_text("ready")
            header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
            page.wait_for_timeout(1500)
            if header.count() and header.get_attribute("aria-expanded") != "true":
                header.click()

            def chat_frame():
                for candidate in page.frames:
                    if candidate.locator("#composer").count() and candidate.locator("#native-chat-experiment").is_visible():
                        return candidate
                return None

            frame = wait_for(chat_frame, "selected Chat webview")
            wait_for(lambda: (root / "ui-ready").exists(), "extension-host selected Chat setup")
            wait_for(lambda: frame.locator("#chats option").count() > 0, "selected Chat option")
            if not frame.locator("#chats").is_visible():
                frame.locator(".chat-list-open").first.click()
            frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            frame.locator("#prompt").fill("Start foreground process for steer budget")
            frame.locator("#send").click()

            def approve_process(number):
                button = frame.get_by_role("button", name="Allow once", exact=True)
                wait_for(lambda: button.count() and button.is_enabled(), f"approval {number}")
                button.click()
                wait_for(lambda: (root / f"process-start-{number}").exists(), f"foreground process {number}")

            def queue(text):
                wait_for(lambda: frame.locator("#send").get_attribute("aria-label") == "Steer", "steer input mode")
                frame.locator("#prompt").fill(text)
                frame.locator("#send").click()
                wait_for(lambda: text in frame.locator("#queued-inputs").inner_text(), "queued steer")

            approve_process(1)
            wait_for(lambda: observations()["calls"] == 1, "first provider request")
            queue(long_steer)
            (root / "release-process-1").write_text("release")
            wait_for(lambda: not frame.locator("#stop").is_visible(), "budget failure stops task")
            wait_for(lambda: "MODEL_CONTEXT_BUDGET" in frame.locator("#messages").inner_text(), "context-budget failure")
            assert long_steer in frame.locator("#queued-inputs").inner_text()
            assert long_steer not in frame.locator("#messages").inner_text()
            assert observations()["calls"] == 1, "Budget rejection must not dispatch the steer"

            frame.locator("#queued-inputs").get_by_role("button", name="Edit queued message").click()
            editor = frame.locator("#queued-inputs").get_by_role("textbox", name="Edit queued message")
            editor.fill(recovered)
            save = frame.locator("#queued-inputs").get_by_role("button", name="Save queued message")
            wait_for(lambda: save.is_enabled(), "queue edit authorization")
            save.click()
            wait_for(lambda: recovered in frame.locator("#queued-inputs").inner_text(), "saved queue edit")
            run = frame.locator("#queued-inputs").get_by_role("button", name="Run queued inputs")
            wait_for(lambda: run.is_enabled(), "explicit queue recovery")
            run.click()
            wait_for(lambda: "RECOVERED_AFTER_BUDGET" in frame.locator("#messages").inner_text(), "recovered provider response")
            wait_for(lambda: observations()["calls"] == 2, "recovery provider request")
            assert recovered in observations()["users"], "Edited input was not sent to the real provider"

            wait_for(lambda: not frame.locator("#stop").is_visible(), "recovery completion")
            frame.locator("#prompt").fill("Start second foreground process for cancellation")
            frame.locator("#send").click()
            approve_process(2)
            wait_for(lambda: observations()["calls"] == 3, "second task provider request")
            queue(cancelled)
            pid = int((root / "process-pid-2").read_text())
            assert pid > 1 and Path(f"/proc/{pid}").exists(), "Foreground process must still be active before cancellation"
            frame.locator("#stop").click()
            wait_for(lambda: not frame.locator("#stop").is_visible(), "cancel task")
            assert cancelled in frame.locator("#queued-inputs").inner_text()
            assert observations()["calls"] == 3, "Cancelled steer must not dispatch"
            (root / "ui-complete").write_text(json.dumps({
                "providerRequests": observations()["calls"],
                "budgetSteerLength": len(long_steer),
                "recoveredEditedSteer": recovered,
                "cancelledQueuedSteer": cancelled,
            }))
        except Exception:
            details = traceback.format_exc()
            if frame:
                try:
                    details += "\nWebview text:\n" + frame.locator("body").inner_text(timeout=5000)
                except Exception:
                    pass
            (root / "ui-error.txt").write_text(details)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL installed steer UI: {error}", file=sys.stderr)
        sys.exit(1)
