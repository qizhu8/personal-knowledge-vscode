"""Exercise the actual private VS Code Chat renderer, not injected approvals."""
import sys
import time
import subprocess
import re
import struct
import ctypes
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def frame_for(page):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        for frame in page.frames:
            if not frame.is_detached() and frame.locator("#composer").count():
                return frame
        page.wait_for_timeout(150)
    raise AssertionError("Chat webview did not appear")


def send(frame, text):
    frame.locator("#prompt").fill(text)
    expect(frame.locator("#send")).to_be_enabled(timeout=15000)
    frame.locator("#send").click()


def confirm_native_stop():
    # Default Linux VS Code uses an X11-native modal; its recorded dialog has
    # Cancel on the left and Stop process on the right, outside CDP's DOM.
    deadline = time.monotonic() + 15
    pattern = r'^\s*(0x[0-9a-f]+) "Visual Studio Code": .*?\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)'
    while time.monotonic() < deadline:
        windows = subprocess.run(
            ["xwininfo", "-root", "-tree"], text=True, capture_output=True, check=True).stdout
        candidates = re.findall(pattern, windows, re.MULTILINE)
        if candidates:
            assert len(candidates) == 1, f"Ambiguous native confirmation: {candidates}"
            window, width, height, x, y = candidates[0]
            width, height, x, y = map(int, (width, height, x, y))
            assert width >= 400 and height >= 150
            x11 = ctypes.CDLL("libX11.so.6")
            xtest = ctypes.CDLL("libXtst.so.6")
            x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
            x11.XOpenDisplay.restype = ctypes.c_void_p
            x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x11.XFlush.argtypes = [ctypes.c_void_p]
            x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
            xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            display = x11.XOpenDisplay(None)
            assert display, "Private X display unavailable"
            try:
                x11.XRaiseWindow(display, int(window, 16))
                assert xtest.XTestFakeMotionEvent(display, -1, x + width * 3 // 4, y + height - 16, 0)
                assert xtest.XTestFakeButtonEvent(display, 1, 1, 0)
                assert xtest.XTestFakeButtonEvent(display, 1, 0, 0)
                x11.XFlush(display)
            finally:
                x11.XCloseDisplay(display)
            print("Confirmed native VS Code Stop dialog", window, flush=True)
            return
        time.sleep(0.1)
    raise AssertionError("Native VS Code Stop confirmation did not appear")


def main(endpoint, chat_id, fixture):
    fixture = Path(fixture)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint)
        print("CDP pages", [(item.url, item.title()) for context in browser.contexts for item in context.pages], flush=True)
        pages = [page for context in browser.contexts for page in context.pages if "workbench" in page.url]
        assert pages, "No private VS Code workbench"
        page = pages[0]
        page.add_locator_handler(page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True),
                                 lambda: page.keyboard.press("Escape"))
        page.wait_for_load_state("networkidle", timeout=45000)
        try:
            page.get_by_role("button", name="Open Quick Access", exact=True).click(timeout=10000)
        except Exception as error:
            raise AssertionError(f"Workbench controls unavailable: url={page.url} title={page.title()}") from error
        command = page.locator(".quick-input-widget input")
        expect(command).to_be_visible(timeout=15000)
        command.fill(">Personal Knowledge Manager: Open API Chat")
        page.wait_for_timeout(2000)
        print("Quick access", page.locator(".quick-input-widget").inner_text()[:1000], flush=True)
        command.press("Enter")
        frame = frame_for(page)
        expect(frame.locator("#chats option")).not_to_have_count(0, timeout=30000)
        if not frame.locator("#chats").is_visible():
            try:
                frame.locator(f'.chat-list-open[data-chat-id="{chat_id}"]').click(timeout=10000)
            except Exception as error:
                raise AssertionError(f"Chat not listed: {frame.locator('body').inner_text()[:2500]}") from error
        frame.locator("#chats").select_option(chat_id)
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)
        send(frame, "Start the program.")
        approval = frame.locator(".approval").filter(has_text="Run program")
        expect(approval).to_be_visible(timeout=30000)
        assert not (fixture / "started").exists()
        approval.get_by_role("button", name="Approve", exact=True).click()
        try:
            controls = frame.locator(".process-controls").first
            expect(controls).to_have_count(1, timeout=20000)
            workflow = controls.locator("xpath=ancestor::details[contains(@class,'workflow')]")
            if workflow.get_attribute("open") is None:
                workflow.locator(":scope > summary").click()
            event = controls.locator("xpath=ancestor::details[contains(@class,'activity-event')]")
            if event.get_attribute("open") is None:
                event.locator(":scope > summary").click()
            expect(frame.locator(".process-controls").get_by_role("button", name="Pause process")).to_be_visible(timeout=20000)
        except Exception as error:
            raise AssertionError(f"Process controls missing: {frame.locator('#messages').inner_text()[:4000]}") from error
        frame.locator(".process-controls").get_by_role("button", name="Pause process").click()
        expect(frame.locator(".process-controls").get_by_role("button", name="Resume process")).to_be_visible(timeout=15000)
        page.wait_for_timeout(100)
        before = (fixture / "ticks").stat().st_size
        page.wait_for_timeout(200)
        assert (fixture / "ticks").stat().st_size == before
        frame.locator(".process-controls").get_by_role("button", name="Resume process").click()
        expect(frame.locator(".process-controls").get_by_role("button", name="Pause process")).to_be_visible(timeout=15000)
        deadline = time.monotonic() + 5
        while (fixture / "ticks").stat().st_size == before and time.monotonic() < deadline:
            page.wait_for_timeout(30)
        assert (fixture / "ticks").stat().st_size > before
        frame.locator(".process-controls").get_by_role("button", name="Stop process").click()
        try:
            confirm_native_stop()
        except Exception:
            print("STOP_DIAGNOSTIC dialogs:", page.get_by_role("dialog").all_inner_texts(), flush=True)
            print("STOP_DIAGNOSTIC notifications:", page.locator(".notifications-center, .notifications-toasts").all_inner_texts(), flush=True)
            print("STOP_DIAGNOSTIC chat:", frame.locator("body").inner_text()[:6000], flush=True)
            windows = subprocess.run(
                ["xwininfo", "-root", "-tree"], text=True, capture_output=True, check=False).stdout
            print("STOP_DIAGNOSTIC xwindows:", windows, flush=True)
            native = re.search(r'^\s*(0x[0-9a-f]+) "Visual Studio Code":', windows, re.MULTILINE)
            if native:
                from PIL import Image
                raw = subprocess.run(["xwd", "-silent", "-id", native.group(1)],
                                     capture_output=True, check=True).stdout
                header = struct.unpack(">25I", raw[:100])
                size, _, _, _, width, height, _, order, _, _, _, depth, stride, _, _, _, _, _, _, colors = header[:20]
                if order == 0 and depth == 32:
                    image = Image.frombytes("RGB", (width, height), raw[size + colors * 12:], "raw", "BGRX", stride)
                    image.save(Path(__file__).resolve().parent.parent / ".migration-test-work/chat-stop-native-modal.png")
            raise
        controls = frame.locator(".process-controls").first
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and "cancelled" not in controls.inner_text().lower():
            refresh = controls.get_by_role("button", name="Refresh status")
            if refresh.is_visible() and refresh.is_enabled():
                refresh.click()
            page.wait_for_timeout(200)
        expect(controls).to_contain_text("cancelled", timeout=1000)
        send(frame, "Read output.")
        expect(frame.locator("#messages")).to_contain_text("owned-log", timeout=30000)
        send(frame, "Start crash program.")
        approval = frame.locator(".approval").filter(has_text="Run program")
        expect(approval).to_be_visible(timeout=30000)
        approval.get_by_role("button", name="Approve", exact=True).click()
        expect(frame.locator(".process-controls")).to_have_count(2, timeout=20000)
        print("PASS real VS Code Chat approval, pause/resume, confirmed Stop, log and second approved launch")
        browser.close()


if __name__ == "__main__":
    main(*sys.argv[1:])
