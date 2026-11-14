import sys
import time
import os
import base64
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


def frame_for_chat(page):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        for frame in page.frames:
            try:
                if frame.locator("#composer").count() and frame.locator("#native-chat-experiment").is_visible():
                    return frame
            except PlaywrightError:
                if not frame.is_detached():
                    raise
        page.wait_for_timeout(150)
    details = [(frame.name, frame.url) for frame in page.frames]
    raise AssertionError(f"Selected Chat renderer did not appear: {details}; workbench={page.locator('body').inner_text()[:2500]}")


def send(frame, text):
    frame.locator("#prompt").fill(text)
    expect(frame.locator("#send")).to_be_enabled(timeout=15000)
    frame.locator("#send").click()
    frame.evaluate("() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))")


def main():
    endpoint, root = sys.argv[1], Path(sys.argv[2])
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint)
        try:
            page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
            page.wait_for_load_state("networkidle", timeout=45000)
            page.bring_to_front()
            (root / "renderer-connected").write_text("ready", encoding="utf-8")
            header = page.get_by_role("button", name="PKM Selected Independent Chat Section", exact=True)
            page.wait_for_timeout(1500)
            if header.count() and header.get_attribute("aria-expanded") != "true":
                header.click()
            try:
                frame = frame_for_chat(page)
            except Exception:
                page.screenshot(path=str(root / "selected-failure.png"))
                print("IFRAMES", page.locator("iframe").evaluate_all(
                    "(items) => items.map(item => ({src:item.src, title:item.title, html:item.outerHTML.slice(0,500)}))"), flush=True)
                raise
            expect(frame.locator("#chats option")).not_to_have_count(0, timeout=30000)
            if not frame.locator("#chats").is_visible():
                frame.locator(".chat-list-open").first.click(timeout=15000)
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)
            if os.environ.get("PKM_SELECTED_IMAGE_ONLY") == "1":
                frame.get_by_role("button", name="Save image: original.png", exact=True).click(timeout=15000)
                if os.environ.get("PKM_SELECTED_REAL_SAVE") == "1":
                    from selected_chat_native_save_dialog import complete_native_save
                    complete_native_save(root, page)
                expected = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=")
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    saved = root / ("workspace/export.png" if os.environ.get("PKM_SELECTED_REAL_SAVE") == "1" else "export.png")
                    if saved.exists() and saved.read_bytes() == expected:
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError("Original image was not saved to the chosen fixture file")
                (root / "ui-complete").write_text("done", encoding="utf-8")
                print("PASS actual selected renderer: historical image save", flush=True)
                return
            frame.locator("#chat-actions-toggle").click()
            frame.locator("#task").click()
            expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
            send(frame, "Start the allowed private process.")
            approval = frame.get_by_role("button", name="Approve", exact=True)
            expect(approval).to_be_visible(timeout=30000)
            assert not (root / "ticks").exists(), "Process ran before user approval"
            approval.click()
            expect(frame.locator("#messages")).to_contain_text("FIXTURE_SUCCESS", timeout=45000)
            deadline = time.monotonic() + 15
            while not (root / "ticks").exists() and time.monotonic() < deadline:
                page.wait_for_timeout(100)
            assert (root / "ticks").exists(), "Approved process did not start"
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)
            send(frame, "Request isolated authentication failure.")
            expect(frame.locator("#messages")).to_contain_text("MODEL_AUTHENTICATION", timeout=45000)
            assert "selected-fixture-secret" not in frame.locator("body").inner_text()
            (root / "ui-complete").write_text("done", encoding="utf-8")
            print("PASS actual selected renderer: approval, model response and safe authentication error", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
