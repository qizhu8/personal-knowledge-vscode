"""Actual installed Chat persistence and error recovery after the baseline tool journey."""
import importlib.util
import json
import re
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, expect


def run_core(page):
    base = Path(json.loads(Path(sys.argv[1]).read_text())["base"])

    def chat_frame():
        until = time.monotonic() + 30
        while time.monotonic() < until:
            for frame in page.frames:
                try:
                    if not frame.is_detached() and frame.locator("#chats").count():
                        if frame.locator("#chats").is_visible() or frame.locator("#library-view").is_visible():
                            return frame
                except PlaywrightError as error:
                    if "Frame was detached" not in str(error) or not frame.is_detached():
                        raise
                    print("Chat frame detached during Reload discovery; waiting for its replacement", file=sys.stderr)
            page.wait_for_timeout(100)
        raise AssertionError("Installed Chat interface was not restored")

    def send(frame, marker, failed=False):
        frame.locator("#prompt").fill(marker)
        frame.locator("#send").focus()
        frame.locator("#send").press("Enter")
        until = time.monotonic() + 30
        while time.monotonic() < until:
            failure = frame.locator("#messages .message-error").filter(has_text="HTTP 401")
            if failed and failure.count() and failure.first.is_visible():
                expect(failure.first).to_contain_text("Check the endpoint, model and credentials")
                break
            if not failed and frame.locator("#messages").get_by_text(marker + "_REPLY", exact=True).count():
                break
            cards = frame.locator(".approval").filter(
                has=frame.get_by_role("button", name=re.compile(r"Allow once|^Approve$")))
            if cards.count() and cards.first.is_visible():
                cards.first.get_by_role("button", name=re.compile(r"Allow once|^Approve$")).first.click()
            page.wait_for_timeout(100)
        else:
            raise AssertionError(f"Installed Chat turn did not reach its expected outcome: {marker}")
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)

    try:
        frame = chat_frame()
        previous_id = frame.locator("#chats").input_value()
        frame.locator("#back").click()
        frame.locator("#list-new").click()
        expect(frame.locator("#prompt")).to_be_visible()
        expect(frame.locator("#chats")).not_to_have_value(previous_id)
        chat_id = frame.locator("#chats").input_value()
        frame.locator("#options").click()
        frame.locator("#history").check()
        frame.locator("#options").click()
        send(frame, "CORE_FIRST")
        send(frame, "CORE_SECOND")
        draft = "CORE_UNSENT_DRAFT"
        frame.locator("#prompt").fill(draft)
        frame.locator("#back").click()
        frame.locator("#list-new").click()
        expect(frame.locator("#chats")).not_to_have_value(chat_id)
        other_id = frame.locator("#chats").input_value()
        assert other_id != chat_id
        frame.locator("#prompt").fill("CORE_OTHER_DRAFT")
        frame.locator("#chats").select_option(chat_id)
        expect(frame.locator("#prompt")).to_have_value(draft)
        expect(frame.locator("#messages")).to_contain_text("CORE_FIRST_REPLY")
        expect(frame.locator("#messages")).to_contain_text("CORE_SECOND_REPLY")
        frame.locator("#chats").select_option(other_id)
        expect(frame.locator("#prompt")).to_have_value("CORE_OTHER_DRAFT")
        frame.locator("#chats").select_option(chat_id)
        until = time.monotonic() + 20
        while not (base / "chat-core-initial-host.json").exists() and time.monotonic() < until:
            page.wait_for_timeout(100)
        assert (base / "chat-core-initial-host.json").exists(), "Initial production-host evidence must precede Reload"
        page.keyboard.press("Control+Shift+P")
        quick = page.locator(".quick-input-widget input").first
        expect(quick).to_be_visible()
        quick.fill(">Developer: Reload Window")
        page.keyboard.press("Enter")
        until = time.monotonic() + 30
        while not frame.is_detached() and time.monotonic() < until:
            page.wait_for_timeout(100)
        assert frame.is_detached(), "Reload must detach the previous Chat interface"
        frame = chat_frame()
        if frame.locator("#library-view").is_visible():
            frame.locator(f'.chat-list-open[data-chat-id="{chat_id}"]').click()
        else:
            frame.locator("#chats").select_option(chat_id)
        expect(frame.locator("#messages")).to_contain_text("CORE_FIRST_REPLY", timeout=30000)
        expect(frame.locator("#messages")).to_contain_text("CORE_SECOND_REPLY")
        expect(frame.locator("#prompt")).to_have_value(draft)
        send(frame, "CORE_FAIL", failed=True)
        send(frame, "CORE_RECOVER")
        evidence = {"chatId": chat_id, "otherChatId": other_id, "multiRoundHistory": True,
                    "perChatDrafts": True, "actualWindowReload": True, "historyRestored": True,
                    "explicitAuthFailure": True, "nextTurnRecovered": True}
        staging = base / "chat-core-done.json.next"
        staging.write_text(json.dumps(evidence), encoding="utf-8")
        staging.replace(base / "chat-core-done.json")
        print("INSTALLED_CHAT_CORE_ACCEPTED: history, drafts, real Reload, failed turn and recovery", flush=True)
    except Exception:
        traceback.print_exc()
        try:
            page.screenshot(path=str(base / "chat-core-blocked.png"), full_page=True, timeout=2000)
        except Exception as diagnostic_error:
            print(f"Chat failure screenshot unavailable: {diagnostic_error}", file=sys.stderr)
        raise


spec = importlib.util.spec_from_file_location("baseline", Path(__file__).with_name("installed-compatibility-chat.py"))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
baseline.main(after=run_core)
