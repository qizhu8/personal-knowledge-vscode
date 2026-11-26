"""Drive the CLI-installed extension's actual Electron webviews over private CDP."""
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main(after=None):
    fixture = json.loads(Path(sys.argv[1]).read_text())
    base = Path(fixture["base"])
    with sync_playwright() as playwright:
        browser = None
        page = None
        try:
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                try:
                    browser = playwright.chromium.connect_over_cdp(
                        f"http://127.0.0.1:{fixture['port']}", timeout=500)
                    if browser.contexts and browser.contexts[0].pages:
                        page = browser.contexts[0].pages[0]
                        break
                except Exception:
                    time.sleep(0.1)
            assert page is not None, "Private installed workbench did not expose CDP"

            def dialogs():
                dialog = page.locator(".monaco-dialog-box")
                if dialog.count() and dialog.first.is_visible():
                    for button in dialog.first.get_by_role("button").all():
                        label = button.inner_text().strip().replace("&", "")
                        if label in ("Drain and switch", "Trust", "Allow", "Trust and Start",
                                     "Allow and Trust"):
                            print("Real native dialog:", dialog.first.inner_text()[:400], flush=True)
                            button.click()
                            return

            def frame_with(selector, timeout=30):
                until = time.monotonic() + timeout
                while time.monotonic() < until:
                    if (base / "host-failure.json").exists():
                        raise AssertionError((base / "host-failure.json").read_text())
                    dialogs()
                    for frame in page.frames:
                        try:
                            if frame.locator(selector).count() and frame.locator(selector).first.is_visible():
                                return frame
                        except Exception:
                            pass
                    time.sleep(0.1)
                raise AssertionError(f"No actual installed webview containing {selector}")

            if "--transcript-consent" in sys.argv:
                approval = page.get_by_role("button", name="Share transcript", exact=True)
                expect(approval).to_be_visible(timeout=60000)
                expect(page.locator(".monaco-dialog-box")).to_contain_text("Read-only")
                approval.click()
                expect(approval).not_to_be_visible(timeout=10000)
                return

            chat = frame_with("#list-new", 80)
            chat.locator("#list-new").click()
            expect(chat.locator("#prompt")).to_be_visible(timeout=30000)
            chat.locator("#options").click()
            chat.locator("#history").uncheck()
            chat.locator("#options").click()
            chat.locator("#permissions").click()
            chat.locator("#permission-mode").select_option("ask")
            chat.locator("#permissions").click()
            if "--populate" not in sys.argv:
                chat.locator("#chat-actions-toggle").click()
                chat.locator("#task").click()
                quick_input = page.locator(".quick-input-widget input").first
                expect(quick_input).to_be_visible(timeout=15000)
                quick_input.fill("Installed gateway acceptance Task")
                quick_input.press("Enter")
                expect(chat.locator("#harness-summary")).to_be_visible(timeout=15000)
            chat.locator("#prompt").fill(
                "Create the isolated InstalledGatewayNote, then read it and validate the terminal read receipt.")
            chat.locator("#send").click()
            approvals = []
            until = time.monotonic() + 80
            while time.monotonic() < until:
                if chat.locator("#messages").get_by_text(re.compile("^INSTALLED_GATEWAY_ACCEPTED:")).count():
                    break
                approval = chat.locator(".approval").filter(
                    has=chat.get_by_role("button", name=re.compile(r"Allow once|^Approve$"))).first
                button = approval.get_by_role("button", name=re.compile(r"Allow once|^Approve$")).first
                if button.is_visible() and button.is_enabled():
                    text = approval.inner_text()
                    if text[:2000] not in approvals:
                        approvals.append(text[:2000])
                        print("Actual installed Chat approval:", text[:250], flush=True)
                    button.click()
                if chat.locator("#error").is_visible():
                    raise AssertionError(chat.locator("#error").inner_text())
                dialogs()
                page.wait_for_timeout(100)
            chat.wait_for_function(
                "() => document.getElementById('messages').textContent.includes('INSTALLED_GATEWAY_ACCEPTED:')",
                timeout=1000)
            expect(chat.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
            assert any("Run PKM add_note?" in approval for approval in approvals), approvals
            if "--populate" in sys.argv:
                (base / "browser-done.json").write_text(json.dumps({
                    "namedWriteApproval": True, "approvals": approvals, "realInstalledWebview": True,
                }))
                return
            page.screenshot(path=str(base / "installed-chat-accepted.png"), full_page=True)
            chat.locator("#visualization").click()
            harness = frame_with(".pkm-harness")
            expect(harness.locator('.pkm-harness-stage[data-stage="end"]')).to_have_attribute(
                "data-status", "complete", timeout=15000)
            harness.locator('.pkm-harness-stage[data-stage="check"]').click()
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("yes (recorded)")
            harness.locator('.pkm-harness-stage[data-stage="evaluate"]').click()
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("Installed Note readback")
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("Evidence calls")
            page.screenshot(path=str(base / "installed-harness-accepted.png"), full_page=True)
            # The real Visualization window hides the Chat tab; select its existing editor.
            page.get_by_role("tab", name=re.compile("PKM Chat|API Chat")).first.click()
            chat = frame_with("#prompt")
            chat.locator("#prompt").fill("CANCEL_INSTALLED: wait for Stop; do not replay any tools.")
            chat.locator("#send").click()
            expect(chat.locator("#messages")).to_have_attribute("aria-busy", "true", timeout=15000)
            until = time.monotonic() + 20
            while not (base / "provider-waiting.json").exists() and time.monotonic() < until:
                approval = chat.locator(".approval").get_by_role("button", name="Allow once", exact=True).first
                if approval.is_visible() and approval.is_enabled():
                    approval.click()
                page.wait_for_timeout(100)
            assert (base / "provider-waiting.json").exists(), "Cancel never reached the local provider"
            chat.locator("#stop").click()
            expect(chat.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
            expect(chat.locator("#messages")).to_contain_text("Cancelled", timeout=15000)
            (base / "browser-done.json").write_text(json.dumps({
                "namedWriteApproval": True, "approvals": approvals, "realInstalledWebview": True,
                "harnessCheck": True, "harnessEnd": True, "harnessEvidence": "installed-call-4",
                "cancelled": True,
            }, indent=2))
            print("REAL_INSTALLED_BROWSER_ACCEPTED: named Note approval, readback, Harness evidence/Check/End and Stop", flush=True)
            if after is not None:
                after(page)
        except Exception:
            if page and not page.is_closed():
                page.screenshot(path=str(base / "installed-blocker.png"), full_page=True)
                (base / "installed-blocker-dom.txt").write_text(page.locator("body").inner_text())
                (base / "installed-blocker-frames.json").write_text(json.dumps([
                    {"url": frame.url, "text": frame.locator("body").inner_text()[:16000]}
                    for frame in page.frames if frame.locator("body").count()
                ], indent=2))
            raise
        finally:
            if browser:
                browser.close()


if __name__ == "__main__":
    main()
