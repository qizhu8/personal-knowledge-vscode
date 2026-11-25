"""Real Chromium, actual Chat controller/HTTP provider/MCP; isolated VS Code host facade."""
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main():
    url, output = sys.argv[1:]
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1100})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.goto(url)
            page.wait_for_load_state("networkidle")
            assert not errors, errors
            expect(page.locator("#pkm-chat-warning")).not_to_be_visible()
            print("Rendered controls:", page.get_by_role("button").all_text_contents(), flush=True)
            page.locator("#list-new").click()
            expect(page.locator("#prompt")).to_be_visible(timeout=30000)
            page.locator("#options").click()
            page.locator("#history").uncheck()
            page.locator("#options").click()
            page.locator("#permissions").click()
            page.locator("#permission-mode").select_option("ask")
            page.locator("#permissions").click()
            page.locator("#chat-actions-toggle").click()
            page.locator("#task").click()
            expect(page.locator("#harness-summary")).to_be_visible(timeout=15000)
            page.locator("#prompt").fill("Create, update and read the isolated Gateway Browser Note. Validate its terminal gateway read receipt.")
            page.locator("#send").click()
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if page.locator("#messages").get_by_text(re.compile("^GATEWAY_BROWSER_ACCEPTED:")).count():
                    break
                approval = page.locator(".approval")
                if approval.count() and approval.first.is_visible():
                    print("Actual approval:", approval.first.inner_text()[:250], flush=True)
                    approve = approval.first.get_by_role("button", name=re.compile(r"Allow once|^Approve$"))
                    if approve.count() == 0:
                        raise AssertionError("The actual Chat approval has no approve control: " + approval.first.inner_text())
                    approve.first.click()
                error = page.locator("#error")
                if error.is_visible():
                    raise AssertionError(error.inner_text())
                page.wait_for_timeout(150)
            page.wait_for_function("() => document.getElementById('messages').textContent.includes('GATEWAY_BROWSER_ACCEPTED:')", timeout=1000)
            expect(page.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)
            page.locator("#visualization").click()
            with page.expect_popup() as popup:
                page.locator("#gateway-harness").click()
            harness = popup.value
            harness.on("pageerror", lambda error: errors.append(str(error)))
            harness.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            expect(harness.locator(".pkm-harness")).to_be_visible(timeout=30000)
            expect(harness.locator('.pkm-harness-stage[data-stage="end"]')).to_have_attribute("data-status", "complete")
            harness.locator('.pkm-harness-stage[data-stage="check"]').click()
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("yes (recorded)")
            harness.locator('.pkm-harness-stage[data-stage="evaluate"]').click()
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("Original Note readback")
            expect(harness.locator(".pkm-harness-inspector")).to_contain_text("Evidence calls")
            harness.screenshot(path=str(Path(output) / "harness-accepted.png"), full_page=True)
            page.screenshot(path=str(Path(output) / "accepted.png"), full_page=True)
            page.bring_to_front()
            page.locator("#prompt").fill("CANCEL_GATEWAY: Wait for Stop; do not invoke any tools or replay the earlier write.")
            page.locator("#send").click()
            expect(page.locator("#messages")).to_have_attribute("aria-busy", "true", timeout=15000)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and page.locator("body").get_attribute("data-gateway-provider-waiting") != "true":
                approval = page.locator(".approval")
                if approval.count() and approval.first.is_visible():
                    approval.first.get_by_role("button", name="Allow once", exact=True).click()
                page.wait_for_timeout(100)
            expect(page.locator("body")).to_have_attribute("data-gateway-provider-waiting", "true", timeout=15000)
            page.locator("#stop").click()
            expect(page.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)
            expect(page.locator("#messages")).to_contain_text("Cancelled", timeout=15000)
            assert not errors, errors
            print("REAL_BROWSER_GATEWAY_ACCEPTED: real Chat UI approvals, original create/update/read effects, evidence-bound Harness Check/End, Stop cancellation; no model credentials.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
