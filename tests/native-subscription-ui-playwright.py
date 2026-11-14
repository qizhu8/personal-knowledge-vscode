import json
import sys
import time

from playwright.sync_api import expect, sync_playwright


def main():
    stage = sys.argv[1]
    invitation = json.loads(sys.stdin.readline()) if stage in ("offline", "retry") else None
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9334", timeout=30000)
        try:
            page = browser.contexts[0].pages[0]
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            page.bring_to_front()
            welcome = page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True)
            if welcome.is_visible():
                page.keyboard.press("Escape")
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
                details = []
                for context in browser.contexts:
                    for current in context.pages:
                        for candidate in current.frames:
                            try:
                                details.append(f"{candidate.url}: {candidate.locator('body').inner_text(timeout=1000)[:1200]}; iframes: " +
                                               repr(candidate.locator('iframe').evaluate_all("(els) => els.map(e => ({src: e.src, title: e.title}))")))
                            except Exception:
                                details.append(candidate.url)
                raise AssertionError("Original installed Subscription panel did not appear: " + repr(details))
            frame.get_by_role("tab", name="Subscribing", exact=True).click()
            old = frame.locator(".sub-subscriber-card").filter(has_text="Original old membership")
            expect(old).to_have_count(1, timeout=30000)
            if stage in ("offline", "retry"):
                frame.locator("#sub-alias").fill("New membership")
                frame.locator("#sub-magic-link").fill(invitation["magicLink"])
                frame.locator("#sub-broker-secret").fill(invitation["secret"])
                frame.get_by_role("button", name="Subscribe", exact=True).click()
                new = frame.locator(".sub-subscriber-card").filter(has_text="New membership")
                if stage == "offline":
                    expect(new).to_have_count(0, timeout=30000)
                else:
                    expect(new).to_have_count(1, timeout=60000)
            elif stage == "priority":
                old.locator(".sub-row").click()
                selector = old.get_by_role("combobox", name="Retrieval priority for Original old membership")
                selector.select_option("highest")
                expect(selector).to_have_value("highest")
            elif stage == "rename":
                item = frame.locator(".sub-subscriber-card").filter(has_text="New membership")
                item.locator(".sub-row").click()
                item.get_by_role("button", name="Rename", exact=True).click()
                frame.locator("#pk-modal-input").fill("Renamed membership")
                frame.locator("#pk-modal-ok").click()
                expect(frame.locator(".sub-subscriber-card").filter(has_text="Renamed membership")).to_have_count(1, timeout=30000)
            elif stage in ("refresh-offline", "refresh-denied", "refresh-retry", "recovery-blocked", "recovery-recheck"):
                if stage in ("recovery-blocked", "recovery-recheck"):
                    recovery = frame.locator("[data-sub-recovery]")
                    expect(recovery).to_be_visible(timeout=30000)
                    recovery.get_by_role("button", name="Inspect pending refresh").click()
                    expect(recovery.get_by_text("Retained entries:", exact=False)).to_be_visible(timeout=30000)
                    if stage == "recovery-blocked":
                        expect(recovery).to_contain_text(".staging")
                        expect(recovery).to_contain_text("needs review")
                    else:
                        recovery.get_by_role("button", name="Recheck after preservation").click()
                        expect(recovery).to_contain_text("Cache matched the admitted baseline", timeout=30000)
                        return
                item = frame.locator(".sub-subscriber-card").filter(has_text="Renamed membership")
                expect(item).to_have_count(1, timeout=30000)
                item.locator(".sub-row").click()
                item.get_by_role("button", name="Refresh", exact=True).click()
                if stage == "refresh-retry":
                    expect(item).to_contain_text("revision 3", timeout=60000)
                else:
                    message = ("Broker is unreachable" if stage == "refresh-offline"
                               else "Broker denied this subscriber (403)" if stage == "refresh-denied"
                               else "Subscription action failed or requires explicit recovery")
                    expect(frame.get_by_role("alert").filter(has_text=message)).to_be_visible(timeout=30000)
            elif stage == "remove":
                old.locator(".sub-row").click()
                old.get_by_role("button", name="Remove", exact=True).click()
                dialog = frame.locator("#pk-modal")
                expect(dialog).to_be_visible()
                dialog.get_by_role("button", name="Remove", exact=True).click()
                expect(old).to_have_count(0, timeout=60000)
            else:
                raise AssertionError("Unknown synthetic UI stage.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
