import os
import sys
import time
from playwright.sync_api import expect, sync_playwright

stage = sys.argv[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9337", timeout=30000)
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
                        if candidate.locator(".github-sync-dashboard").count():
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
            raise AssertionError("Installed Sync panel unavailable")
        body = frame.locator(".github-sync-dashboard")
        expect(body).to_contain_text("Synthetic installed Sync", timeout=30000)
        repository = "git@github.com:fixture/fixture.git" if os.environ.get("PKM_TEST_SYNC_NATIVE_GIT") == "ssh" else "https://github.com/fixture/fixture.git"
        expect(body).to_contain_text(repository)
        if stage == "initial":
            expect(body).to_contain_text("State: initial")
            body.get_by_role("button", name="Compare Skills", exact=True).click()
            expect(body).to_contain_text("State: comparison", timeout=30000)
            expect(body).to_contain_text("Local only/change")
            expect(body).to_contain_text("Remote only/change")
            expect(body).to_contain_text("local conflict")
            expect(body).to_contain_text("remote conflict")
            body.get_by_role("button", name="Use Local for One", exact=True).click()
            expect(body).to_contain_text("Choice: local", timeout=30000)
            body.get_by_role("button", name="Apply reviewed comparison & Sync", exact=True).click()
            expect(body).to_contain_text("State: idle", timeout=30000)
        elif stage in ("push", "pull", "unknown", "blocked"):
            body.get_by_role("button", name="Sync Skills", exact=True).click()
            expect(body).to_contain_text("working", timeout=10000)
            if stage in ("unknown", "blocked"):
                expect(body.get_by_role("alert")).to_be_visible(timeout=30000)
                if stage == "unknown":
                    expect(body).to_contain_text("State: publishing")
            else:
                expect(body).not_to_contain_text("working", timeout=30000)
                expect(body).to_contain_text("State: idle", timeout=30000)
        elif stage == "conflict":
            body.get_by_role("button", name="Sync Skills", exact=True).click()
            expect(body).to_contain_text("State: conflict", timeout=30000)
            expect(body).to_contain_text("later local conflict")
            expect(body).to_contain_text("later remote conflict")
            body.get_by_role("button", name="Use Remote for One", exact=True).click()
            expect(body).to_contain_text("Choice: remote", timeout=30000)
            body.get_by_role("button", name="Apply reviewed comparison & Sync", exact=True).click()
            expect(body).to_contain_text("State: idle", timeout=30000)
        elif stage == "recover":
            expect(body).to_contain_text("State: publishing", timeout=30000)
            body.get_by_role("button", name="Review pending Sync", exact=True).click()
            expect(body).to_contain_text("State: idle", timeout=30000)
        elif stage == "review":
            expect(body).to_contain_text("State: publishing", timeout=30000)
            body.get_by_role("button", name="Review pending Sync", exact=True).click()
            expect(body).to_contain_text("State: review", timeout=30000)
        else:
            raise AssertionError("Unknown stage")
    finally:
        browser.close()
