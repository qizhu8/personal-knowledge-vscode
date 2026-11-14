"""Exercise the actual VS Code quick pick and modal for a private Chat intent."""
import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def wait_receipt(path):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        time.sleep(0.1)
    raise AssertionError(f"No driver receipt: {path.name}")


def command(page, label):
    page.get_by_role("button", name="Open Quick Access", exact=True).click()
    field = page.locator(".quick-input-widget input")
    expect(field).to_be_visible(timeout=15000)
    field.fill(">" + label)
    page.wait_for_timeout(500)
    field.press("Enter")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cdp", required=True)
    parser.add_argument("--fixture", required=True)
    args = parser.parse_args()
    fixture = Path(args.fixture)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.cdp)
        page = None
        try:
            page = next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
            page.wait_for_load_state("networkidle", timeout=45000)
            page.bring_to_front()
            welcome = page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True)
            if welcome.is_visible():
                page.keyboard.press("Escape")
            ready = wait_receipt(fixture / "driver-ready.json")
            if not ready["trusted"]:
                page.get_by_role("banner").get_by_role("button", name="Manage", exact=True).click()
                trust = page.get_by_role("button", name="Trust", exact=True)
                expect(trust).to_be_visible(timeout=15000)
                trust.click()
                page.get_by_role("button", name="Close Modal Editor (Escape)", exact=True).click()
            command(page, "PKM Intent Fixture: Ask")
            picker = page.locator(".quick-input-widget")
            expect(picker.get_by_text("Private original Chat", exact=True)).to_be_visible(timeout=15000)
            page.keyboard.press("Escape")
            assert wait_receipt(fixture / "attempt-1.json")["status"] == "cancelled"
            command(page, "PKM Intent Fixture: Ask")
            expect(picker.get_by_text("Private original Chat", exact=True)).to_be_visible(timeout=15000)
            picker.get_by_text("Private original Chat", exact=True).click()
            confirm = page.get_by_role("button", name="Allow Selected Chat", exact=True)
            expect(confirm).to_be_visible(timeout=15000)
            confirm.click()
            result = wait_receipt(fixture / "attempt-2.json")
            assert result["status"] == "approved", result
            assert result["trusted"] and result["deniedOtherChat"]
            command(page, "PKM Intent Fixture: Revoke")
            assert wait_receipt(fixture / "revoke-check.json") == {"denied": True, "aborted": True}
            assert wait_receipt(fixture / "revoked.json") == {"aborted": True}
            print("PASS real Code QuickPick, cancellation, modal confirmation and disconnect revocation", flush=True)
        except Exception:
            if page is not None:
                page.screenshot(path=str(fixture / "actor-failure.png"))
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
