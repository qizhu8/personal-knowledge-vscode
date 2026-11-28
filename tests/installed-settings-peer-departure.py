"""Verify the surviving installed window through its real Settings and native modal."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


fixture = json.loads(Path(sys.argv[1]).read_text())
base = Path(fixture["base"])
with sync_playwright() as playwright:
    deadline = time.monotonic() + 65
    while True:
        try:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{fixture['port']}", timeout=500)
            page = browser.contexts[0].pages[0]
            break
        except Exception:
            assert time.monotonic() < deadline, "Surviving installed window did not expose CDP"
            time.sleep(0.1)

    def wait_for(filename):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if (base / filename).exists():
                return
            failure = base / "settings-peer-failure.json"
            assert not failure.exists(), failure.read_text() if failure.exists() else ""
            dialog = page.locator(".monaco-dialog-box").first
            if dialog.count() and dialog.is_visible():
                for label in ("Trust", "Allow", "Trust and Start", "Allow and Trust"):
                    action = dialog.get_by_role("button", name=label, exact=True)
                    if action.count() and action.first.is_visible():
                        action.first.click()
                        break
            time.sleep(0.1)
        raise AssertionError(f"Missing surviving-window observation: {filename}")

    try:
        wait_for("settings-peer-admitted.json")
        wait_for("settings-peer-owner-departure-ready.json")
        deadline = time.monotonic() + 25
        frame = None
        while time.monotonic() < deadline:
            for candidate in page.frames:
                tab = candidate.locator('[data-settings-owner="mcp"] [data-settings-tab="mcp"]')
                if not candidate.is_detached() and tab.count() and tab.first.is_visible():
                    frame = candidate
                    tab.first.click()
                    break
            if frame:
                break
            time.sleep(0.1)
        assert frame is not None, "Surviving installed Settings webview not found"
        active = frame.locator(".mcp-backend-observed")
        expect(active).to_contain_text("Original MCP · Accepting calls", timeout=15000)

        def switch(target_label, active_label, milestone):
            target = frame.locator("#mcp-backend-target")
            expect(target).to_be_enabled()
            option = target.locator("option").filter(has_text=target_label)
            expect(option).to_have_count(1)
            target.select_option(value=option.get_attribute("value"))
            frame.locator("#mcp-backend-apply").click()
            dialog = page.locator(".monaco-dialog-box").first
            expect(dialog).to_contain_text(
                f"Switch pkm from {active_label} to {target_label}?", timeout=15000)
            dialog.get_by_role("button", name="Switch backend", exact=True).click()
            expect(frame.locator(".mcp-backend-feedback")).to_contain_text(
                "confirmed completion", timeout=30000)
            expect(active).to_contain_text(f"{target_label} · Accepting calls")
            expect(active).to_contain_text(
                "MCP version v0.1.0" if milestone == "v5" else "MCP version v2.19.0")
            (base / f"settings-peer-switch-{milestone}.json").write_text(
                json.dumps({"actualSettingsAndNativeModal": True}))
            wait_for(f"settings-peer-observed-{milestone}.json")

        switch("Bundled v5 MCP", "Original MCP", "v5")
        switch("Original MCP", "Bundled v5 MCP", "returned")
        wait_for("settings-peer-owner-departure.json")
    except Exception:
        page.screenshot(path=str(base / "installed-peer-departure-failure.png"))
        raise
