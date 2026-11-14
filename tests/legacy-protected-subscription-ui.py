import os
import json
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

step = "startup"

def main():
    global step
    stage = sys.argv[1]
    with sync_playwright() as playwright:
        step = "connect"
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9334", timeout=30000)
        try:
            step = "pages"
            page = browser.contexts[0].pages[0]
            step = "load"
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except PlaywrightTimeoutError:
                pass
            page.bring_to_front()
            with open(os.path.join(os.environ["PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT"], "ui-driver-open"), "x"):
                pass
            welcome = page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True)
            if welcome.is_visible():
                page.keyboard.press("Escape")
            tab = page.get_by_role("tab", name="Private Subscription Fixture", exact=False)
            tab.first.wait_for(state="visible", timeout=30000)
            step = "frame"
            frame = None
            diagnostic = "no-fixture"
            found_title = False
            found_iframe = False
            found_webview_error = False
            found_chrome_error = False
            for attempt in range(300):
                if attempt % 60 == 0:
                    count = tab.count()
                    if count:
                        tab.nth((attempt // 60) % count).click(timeout=10000)
                for context in browser.contexts:
                    for current in context.pages:
                        if current.get_by_text("Private Subscription Fixture", exact=False).count():
                            found_title = True
                        if current.locator("iframe").count():
                            found_iframe = True
                        if current.get_by_text("Error loading webview", exact=False).count():
                            found_webview_error = True
                        for candidate in current.frames:
                            if candidate.url.startswith("chrome-error:"):
                                found_chrome_error = True
                            if candidate.locator("#fixture-quit").count():
                                diagnostic = candidate.evaluate("""() => {
                                    if (typeof subscriptionOnState !== "function") return "renderer-script";
                                    if (typeof ask !== "function") return "bridge-script";
                                    if (document.querySelector("#fixture-error")?.textContent) return "host-error";
                                    return "no-state";
                                }""")
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
            if frame is None:
                pages = [current for context in browser.contexts for current in context.pages]
                frames = [candidate for current in pages for candidate in current.frames]
                allowed_schemes = {"http", "https", "file", "about", "data", "vscode-file",
                                   "vscode-webview", "vscode-webview-resource", "chrome-error"}
                schemes = sorted({scheme if scheme in allowed_schemes else "other"
                                  for scheme in (urlsplit(candidate.url).scheme for candidate in frames)})
                inner_iframes = 0
                complete = 0
                for candidate in frames:
                    try:
                        inner_iframes += candidate.locator("iframe").count()
                        complete += int(candidate.evaluate("document.readyState === 'complete'"))
                    except Exception:
                        pass
                print(f"UI_DETAIL tabs={tab.count()} pages={len(pages)} frames={len(frames)} "
                      f"iframes={inner_iframes} complete={complete} schemes={','.join(schemes)}",
                      file=sys.stderr)
                step = diagnostic if diagnostic != "no-fixture" else (
                    "webview-error" if found_webview_error else "chrome-error" if found_chrome_error else
                    "title-with-iframe" if found_title and found_iframe else
                    "title-no-iframe" if found_title else "no-title-with-iframe" if found_iframe else "no-title")
                raise AssertionError("Original Subscription renderer did not appear.")
            step = "initial-row"
            row = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic old subscription")
            expect(row).to_have_count(1, timeout=30000)
            step = "initial-cache"
            expect(frame.locator("#fixture-cache")).to_contain_text(
                "Synthetic original note" if stage in ("refresh", "crash") else "Synthetic refreshed note revision 2")
            step = "initial-error"
            expect(frame.locator("#fixture-error")).to_be_empty()
            if stage in ("refresh", "crash"):
                step = "initial-revision"
                expect(row).to_contain_text("revision 1")
                step = "expand"
                row.locator(".sub-row").click()
                expect(row).to_contain_text("1 cached items")
                step = "priority"
                row.locator("select[aria-label^='Retrieval priority']").select_option("highest")
                expect(row.locator("select[aria-label^='Retrieval priority']")).to_have_value("highest")
                step = "refresh"
                row.get_by_role("button", name="Refresh", exact=True).click()
                if stage == "crash":
                    expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                    expect(frame.locator("#fixture-ack")).to_contain_text("Transaction interrupted at injected boundary.")
                else:
                    expect(row).to_contain_text("revision 2", timeout=60000)
                    step = "refreshed-cache"
                    expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic refreshed note revision 2")
                    expect(frame.locator("#fixture-error")).to_be_empty()
            elif stage == "resume":
                step = "resume"
                expect(row).to_contain_text("revision 2")
                row.locator(".sub-row").click()
                row.get_by_role("button", name="Refresh", exact=True).click()
                expect(frame.locator("#fixture-error")).to_be_empty()
                expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic refreshed note revision 2", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Refresh published.", timeout=60000)
                frame.evaluate("ask('fixtureReplay')")
                expect(frame.locator("#fixture-ack")).to_contain_text("Replay matched.", timeout=60000)
            elif stage == "restart":
                step = "restart"
                expect(row).to_contain_text("revision 2")
                row.locator(".sub-row").click()
                expect(row.locator("select[aria-label^='Retrieval priority']")).to_have_value("highest")
                frame.evaluate("ask('fixtureReplay')")
                expect(frame.locator("#fixture-ack")).to_contain_text("Replay matched.", timeout=60000)
            elif stage in ("multi", "remote-resume", "remote-crash"):
                step = "multi-refresh"
                restricted = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")
                expect(restricted).to_have_count(1)
                if stage == "remote-resume":
                    expect(restricted).to_contain_text("revision 3")
                else:
                    expect(restricted).to_contain_text("revision 1")
                    expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic restricted original")
                restricted.locator(".sub-row").click()
                restricted.get_by_role("button", name="Refresh", exact=True).click()
                if stage == "remote-crash":
                    expect(frame.locator("#fixture-ack")).to_contain_text("Transaction interrupted at injected boundary.", timeout=60000)
                    expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.")
                else:
                    expect(restricted).to_contain_text("revision 3", timeout=60000)
                    expect(row).to_contain_text("revision 2")
                    expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic restricted revision 3")
                    expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic refreshed note revision 2")
                    expect(frame.locator("#fixture-error")).to_be_empty()
            elif stage == "remote-post-commit":
                step = stage
                restricted = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")
                restricted.locator(".sub-row").click()
                restricted.locator("select[aria-label^='Retrieval priority']").select_option("high")
                restricted.get_by_role("button", name="Refresh", exact=True).click()
                expect(frame.locator("#fixture-ack")).to_contain_text("Committed transaction interrupted before reply.", timeout=60000)
            elif stage == "remote-post-restart":
                step = stage
                restricted = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")
                expect(restricted).to_contain_text("revision 3")
                restricted.locator(".sub-row").click()
                expect(restricted.locator("select[aria-label^='Retrieval priority']")).to_have_value("high")
                frame.evaluate("ask('fixtureReplay')")
                expect(frame.locator("#fixture-ack")).to_contain_text("Replay matched.", timeout=60000)
            elif stage in ("member-remove", "member-remove-crash", "member-remove-post-commit"):
                step = stage
                restricted = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")
                expect(restricted).to_have_count(1)
                restricted.locator(".sub-row").click()
                restricted.get_by_role("button", name="Remove", exact=True).click()
                dialog = frame.get_by_role("dialog")
                expect(dialog).to_be_visible()
                dialog.get_by_role("button", name="Remove", exact=True).click()
                if stage == "member-remove-crash":
                    expect(frame.locator("#fixture-ack")).to_contain_text("Transaction interrupted at injected boundary.", timeout=60000)
                elif stage == "member-remove-post-commit":
                    expect(frame.locator("#fixture-ack")).to_contain_text("Committed transaction interrupted before reply.", timeout=60000)
                else:
                    expect(frame.locator("#fixture-ack")).to_contain_text("Subscription removed.", timeout=60000)
                    expect(restricted).to_have_count(0)
            elif stage == "member-recover-remove":
                step = stage
                expect(frame.locator("#membership-status")).to_contain_text("requires explicit recovery")
                frame.locator("#membership-recover").click()
                expect(frame.locator("#fixture-ack")).to_contain_text("Removal recovered.", timeout=60000)
                expect(frame.locator("#fixture-error")).to_be_empty()
                expect(frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")).to_have_count(0)
            elif stage in ("member-add", "member-add-crash", "member-add-recover", "member-add-denied"):
                step = stage
                invite = json.loads(sys.stdin.readline())
                frame.locator("#sub-alias").fill("Synthetic restricted subscription")
                frame.locator("#sub-magic-link").fill(invite["magicLink"])
                frame.locator("#sub-broker-secret").fill(invite["secret"])
                frame.get_by_role("button", name="Subscribe", exact=True).click()
                if stage == "member-add-crash":
                    expect(frame.locator("#fixture-ack")).to_contain_text("Transaction interrupted at injected boundary.", timeout=60000)
                elif stage == "member-add-denied":
                    expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                else:
                    expect(frame.locator("#fixture-ack")).to_contain_text("Subscription added.", timeout=60000)
                    expect(frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")).to_have_count(1)
                    expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic restricted revision 3")
                    expect(frame.locator("#fixture-error")).to_be_empty()
            elif stage == "member-restart-removed":
                step = stage
                expect(frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")).to_have_count(0)
            elif stage == "member-open-only":
                step = stage
                expect(frame.locator("#fixture-error")).to_be_empty()
            elif stage in ("multi-offline", "multi-recover"):
                step = stage
                restricted = frame.locator(".sub-subscriber-card").filter(has_text="Synthetic restricted subscription")
                expect(restricted).to_have_count(1)
                expect(restricted).to_contain_text("revision 3")
                restricted.locator(".sub-row").click()
                restricted.get_by_role("button", name="Refresh", exact=True).click()
                if stage == "multi-offline":
                    expect(frame.locator("#fixture-ack")).to_contain_text("Failed refresh published.", timeout=60000)
                    expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.")
                    expect(restricted).to_contain_text("offline · revision 3")
                else:
                    expect(frame.locator("#fixture-ack")).to_contain_text("Refresh published.", timeout=60000)
                    expect(frame.locator("#fixture-error")).to_be_empty()
                    expect(restricted).to_contain_text("current · revision 3")
                expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic restricted revision 3")
                expect(frame.locator("#fixture-cache")).to_contain_text("Synthetic refreshed note revision 2")
            elif stage == "post-commit":
                step = "post-commit"
                row.locator(".sub-row").click()
                row.locator("select[aria-label^='Retrieval priority']").select_option("normal")
                row.get_by_role("button", name="Refresh", exact=True).click()
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Committed transaction interrupted before reply.")
            elif stage == "after-commit":
                step = "after-commit"
                row.locator(".sub-row").click()
                expect(row.locator("select[aria-label^='Retrieval priority']")).to_have_value("normal")
                frame.evaluate("ask('fixtureReplay')")
                expect(frame.locator("#fixture-ack")).to_contain_text("Replay matched.", timeout=60000)
                row.locator("select[aria-label^='Retrieval priority']").select_option("highest")
                row.get_by_role("button", name="Refresh", exact=True).click()
                expect(frame.locator("#fixture-ack")).to_contain_text("Refresh published.", timeout=60000)
            elif stage == "conflict":
                step = "conflict"
                row.locator(".sub-row").click()
                frame.evaluate("ask('fixtureConflict')")
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Publication conflict.")
                frame.locator("#fixture-error").evaluate("(element) => { element.textContent = ''; }")
                frame.locator("#fixture-ack").evaluate("(element) => { element.textContent = ''; }")
                frame.evaluate("ask('fixtureStale')")
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Publication conflict.")
                frame.locator("#fixture-ack").evaluate("(element) => { element.textContent = ''; }")
                frame.evaluate("ask('fixtureRestore')")
                expect(frame.locator("#fixture-ack")).to_contain_text("Fixture restored.", timeout=60000)
            elif stage == "foreign-conflict":
                step = "foreign-conflict"
                frame.evaluate("ask('fixtureForeignConflict')")
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Publication conflict.")
            elif stage == "invalid-secret":
                step = "invalid-secret"
                row.locator(".sub-row").click()
                row.get_by_role("button", name="Refresh", exact=True).click()
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.")
                expect(row).to_contain_text("revision 2")
            elif stage == "same-revision":
                step = "same-revision"
                frame.evaluate("ask('fixtureSameRevision')")
                expect(frame.locator("#fixture-error")).to_contain_text("Private Subscription action denied.", timeout=60000)
                expect(frame.locator("#fixture-ack")).to_contain_text("Publication conflict.")
            else:
                raise AssertionError("Invalid fixture phase.")
            step = "close"
            frame.locator("#fixture-quit").click()
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"UI_STEP_FAILED {step}", file=sys.stderr)
        print(f"UI_ERROR_CLASS {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
