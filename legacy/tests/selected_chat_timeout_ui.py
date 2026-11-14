#!/usr/bin/env python3
"""Exercise an installed selected Chat model timeout after a committed steer."""
import json
import os
import sqlite3
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


root = Path(os.environ["PKM_SELECTED_FIXTURE"])
restart = os.environ.get("PKM_SELECTED_RESTART") == "1"
queued = "TIMEOUT_PENDING_STEER"


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


def receipt():
    db = sqlite3.connect(f"file:{root / 'trial/workspace/core.sqlite'}?mode=ro", uri=True)
    try:
        turns = [json.loads(row[0]) for row in db.execute("SELECT record FROM chat_turn_records")]
        queues = [json.loads(row[0]) for row in db.execute("SELECT state_json FROM legacy_managed_chat_queue")]
        return (any(turn.get("failure") == "MODEL_TIMEOUT" for turn in turns)
                and any(item.get("text") == queued and item.get("status") == "applied"
                        for state in queues for item in state["items"]))
    finally:
        db.close()


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
                return next((candidate for candidate in page.frames
                             if candidate.locator("#composer").count()
                             and candidate.locator("#native-chat-experiment").is_visible()), None)

            frame = wait_for(chat_frame, "selected Chat webview")
            wait_for(lambda: (root / ("recovery-ui-ready" if restart else "ui-ready")).exists(), "extension-host setup")
            wait_for(lambda: frame.locator("#chats option").count() > 0, "selected Chat")
            if not frame.locator("#chats").is_visible():
                frame.locator(".chat-list-open").first.click()
            wait_for(lambda: "ORIGINAL_RETAINED_MESSAGE" in frame.locator("#messages").inner_text(), "original message")
            wait_for(lambda: "ORIGINAL_ARCHIVED_QUEUE" in frame.locator("#native-workflow-controls").text_content(),
                     "original archived queue")
            if not restart:
                button = frame.get_by_role("button", name="Review unknown outcomes", exact=True)
                wait_for(lambda: button.count() and button.is_enabled(), "unknown outcome review")
                button.click()
                wait_for(lambda: "Effect remains UNKNOWN; never replayed" in frame.locator("#native-workflow-controls").inner_text(),
                         "explicit unknown decision")
                frame.locator("#prompt").fill("Start foreground process before provider timeout")
                frame.locator("#send").click()
                approve = frame.get_by_role("button", name="Allow once", exact=True)
                wait_for(lambda: approve.count() and approve.is_enabled(), "foreground process approval")
                approve.click()
                wait_for(lambda: (root / "process-start-1").exists(), "foreground process started")
                wait_for(lambda: frame.locator("#send").get_attribute("aria-label") == "Steer", "steer mode")
                frame.locator("#prompt").fill(queued)
                frame.locator("#send").click()
                wait_for(lambda: queued in frame.locator("#queued-inputs").inner_text(), "queued steer")
                assert calls() == 1
                (root / "release-process-1").write_text("release")
                wait_for(lambda: (root / "timeout-provider-request").exists(), "second provider request")
                wait_for(receipt, "MODEL_TIMEOUT and retained applied steer")
                assert calls() == 2
                assert queued in json.dumps(json.loads((root / "steer-provider-observations.json").read_text())["users"]), \
                    "Committed steer was absent from the timed-out provider request"
                (root / "ui-crash-ready").write_text("ready")
            else:
                wait_for(receipt, "timeout receipt and applied steer after restart")
                assert "Start foreground process before provider timeout" in frame.locator("#messages").inner_text()
                page.wait_for_timeout(3000)
                assert calls() == 2, "Restart dispatched a provider request"
                assert (root / "process-count").read_text() == "1", "Restart repeated a process effect"
                (root / "recovery-ui-complete").write_text(json.dumps({
                    "providerCalls": 2, "timeout": "MODEL_TIMEOUT", "steer": queued,
                    "steerStatus": "applied", "processStarts": 1,
                }))
        except Exception:
            detail = traceback.format_exc()
            if frame:
                try:
                    detail += "\nWebview text:\n" + frame.locator("body").inner_text(timeout=5000)
                except Exception:
                    pass
            (root / ("timeout-restart-ui-error.txt" if restart else "timeout-ui-error.txt")).write_text(detail)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL selected Chat timeout UI: {error}", file=sys.stderr)
        sys.exit(1)
