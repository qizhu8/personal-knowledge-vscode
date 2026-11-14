import time
import os
from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9335", timeout=30000)
    try:
        page = browser.contexts[0].pages[0]
        try:
            page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        panel = page.get_by_role("tab", name="Personal Knowledge Manager", exact=False)
        panel.first.wait_for(state="visible", timeout=30000)
        frame = None
        for attempt in range(300):
            if attempt % 60 == 0:
                panel.first.click(timeout=10000)
            for context in browser.contexts:
                for current in context.pages:
                    for candidate in current.frames:
                        if candidate.locator(".sub-dashboard").count():
                            frame = candidate
                            break
                    if frame:
                        break
                if frame:
                    break
            if frame:
                break
            time.sleep(0.1)
        if not frame:
            raise AssertionError("Installed Subscription panel unavailable")
        frame.get_by_role("tab", name="Subscribing", exact=True).click()
        item = frame.locator(".sub-subscriber-card").filter(has_text=os.environ["PKM_TEST_GITHUB_ALIAS"])
        expect(item).to_have_count(1, timeout=30000)
        item.locator(".sub-row").click()
        item.get_by_role("button", name="Refresh branch", exact=True).click()
        try:
            expect(item).to_contain_text(os.environ["PKM_TEST_GITHUB_EXPECTED_COMMIT"][:10], timeout=30000)
        except AssertionError as error:
            raise AssertionError(f"{error}\nPanel: {frame.locator('body').inner_text()[:6000]}") from error
    finally:
        browser.close()
