"""Use the installed Settings webview and real host modal, never invoke the controller directly."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import Error, expect, sync_playwright


fixture = json.loads(Path(sys.argv[1]).read_text())
base = Path(fixture["base"])
with sync_playwright() as playwright:
    deadline = time.monotonic() + 65
    page = None
    while time.monotonic() < deadline:
        try:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{fixture['port']}", timeout=500)
            page = browser.contexts[0].pages[0]
            break
        except Exception:
            time.sleep(0.1)
    assert page is not None, "Installed switch candidate did not expose CDP."

    def wait_for(filename, initial=False):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if (base / filename).exists():
                return
            failure = base / "upgrade-failure.json"
            if failure.exists():
                raise AssertionError(failure.read_text())
            if initial:
                dialog = page.locator(".monaco-dialog-box").first
                if dialog.count() and dialog.is_visible():
                    for label in ("Trust", "Allow", "Trust and Start", "Allow and Trust"):
                        action = dialog.get_by_role("button", name=label, exact=True)
                        if action.count() and action.first.is_visible():
                            action.first.click()
                            break
            time.sleep(0.1)
        raise AssertionError(f"Missing observation: {filename}")

    def settings_frame():
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            for frame in page.frames:
                if frame.is_detached():
                    continue
                tab = frame.locator('[data-settings-owner="mcp"] [data-settings-tab="mcp"]')
                try:
                    if tab.count() and tab.first.is_visible():
                        return frame, tab.first
                except Error:
                    if frame.is_detached():
                        continue
                    raise
            time.sleep(0.1)
        raise AssertionError("Actual PKM Settings webview not found")

    try:
        wait_for("settings-awaiting-status.json", initial=True)
        native_start = json.loads((base / "settings-native-started.json").read_text())
        assert native_start["source"] == "activation"
        assert native_start["beforeSetupAndToolInvocation"] is True
        assert native_start["explicitStartExecuted"] is False
        assert any("PKM MCP automatic startup: ready" in line for line in native_start["startupTrace"])
        frame, tab = settings_frame()
        tab.click()
        active = frame.locator(".mcp-backend-observed")
        restored = json.loads((base / "settings-restored-startup.json").read_text())
        assert restored["source"] == "restored-chat-ready"
        assert restored["observed"]["originalConnection"]["attribution"]["source"] == "pkm-chat"
        assert any("PKM Chat first state:" in line for line in restored["startupTrace"])
        assert any("PKM MCP discovery: elapsedMs=" in line for line in restored["startupTrace"])
        expect(active).to_contain_text("Original MCP · Accepting calls", timeout=15000)
        expect(active).to_contain_text("MCP version v2.19.0")
        expect(active).to_contain_text("MCP version v2.19.0", timeout=30000)
        expect(frame.locator("#mcp-backend-target")).to_be_enabled(timeout=15000)
        expect(frame.locator(".mcp-backend-feedback")).not_to_contain_text(
            "Both Workbench pkm and PKM Chat", timeout=40000)
        expect(frame.locator('[data-settings-panel="mcp"] #mcp-lifecycle')).to_have_count(0)
        expect(frame.locator('[data-settings-panel="debug"] #mcp-lifecycle')).to_have_count(1)
        active.evaluate("""el => {
            const slot = el.closest('#mcp-backend-slot');
            slot.quietRefreshMutations = 0;
            slot.quietRefreshSnapshots = [slot.innerHTML];
            slot.quietRefreshObserver = new MutationObserver(records => {
                slot.quietRefreshMutations += records.length;
                slot.quietRefreshSnapshots.push(slot.innerHTML);
            });
            slot.quietRefreshObserver.observe(slot, {childList: true, subtree: true, attributes: true});
        }""")
        page.wait_for_timeout(31000)
        expect(frame.locator(".mcp-backend-feedback")).not_to_contain_text("Reading manager status")
        mutations = active.evaluate("""el => {
            const slot = el.closest('#mcp-backend-slot');
            slot.quietRefreshObserver.disconnect();
            return slot.quietRefreshMutations;
        }""")
        if mutations:
            (base / "settings-quiet-refresh-failure.json").write_text(json.dumps({
                "mutations": mutations,
                "snapshots": active.evaluate("el => el.closest('#mcp-backend-slot').quietRefreshSnapshots"),
            }))
        assert mutations == 0, f"Unchanged backend status redrew the installed UI {mutations} times"
        (base / "settings-ui-auto-status.json").write_text(json.dumps({
            "startupWithoutManualRefresh": True, "restoredWebview": True, "originalVersion": "2.19.0",
            "activationNativeAutostart": True, "explicitNativeStartExecuted": False,
            "lifecycleOnlyInDebug": True, "quietRefreshMutations": mutations,
        }))
        wait_for("settings-observed-original.json", initial=True)
        web = playwright.chromium.launch(headless=True)

        def enroll_browser(label):
            page.get_by_text("Copy sign-in token and open", exact=True).click(timeout=15000)
            wait_for("browser-enrollment.json")
            enrollment = base / "browser-enrollment.json"
            grant = json.loads(enrollment.read_text())
            enrollment.unlink()
            assert grant["label"] == label
            url = grant["url"]
            tab = web.new_page()
            tab.goto(url, wait_until="networkidle")
            expect(tab.get_by_label("Server token")).to_be_visible()
            tab.locator("input[type=password]").evaluate("(el, token) => { el.value = token; }", grant.pop("token"))
            tab.get_by_role("button", name="Sign in").click()
            expect(tab.get_by_role("searchbox", name="Search Notes")).to_be_visible()
            tab.get_by_role("button", name="(uncategorized) Folder", exact=False).click()
            tab.get_by_role("button", name="InstalledGatewayNote File").click()
            expect(tab.locator("#detail")).to_contain_text("Created by genuine installed 4.0.27 PKM Chat")
            (base / f"settings-browser-read-{label}").touch()
            return tab, url

        def assert_revoked(tab, url):
            try:
                status = tab.evaluate("""async () => (await fetch("/webview/message", {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({command: "detail", path: "InstalledGatewayNote.md"}),
                    signal: AbortSignal.timeout(3000)
                })).status""")
            except Error as error:
                assert "Failed to fetch" in str(error)
            else:
                assert status in (401, 403, 409, 503), f"Old browser grant returned HTTP {status} after handoff"
            finally:
                tab.close()

        original_browser = enroll_browser("original")
        frame, tab = settings_frame()
        tab.click()
        active = frame.locator(".mcp-backend-observed")
        target = frame.locator("#mcp-backend-target")
        apply = frame.locator("#mcp-backend-apply")
        expect(active).to_contain_text("Original MCP", timeout=15000)

        def action(target_label, active_label, accept, milestone):
            option = target.locator("option").filter(has_text=target_label)
            expect(option).to_have_count(1)
            target.select_option(value=option.get_attribute("value"))
            active.evaluate("""el => {
                const slot = el.closest('#mcp-backend-slot');
                slot.dataset.sawDrain = '';
                const observer = new MutationObserver(records => {
                    for (const record of records) {
                        for (const node of record.addedNodes) {
                            const text = node.querySelector?.('.mcp-backend-observed strong')?.textContent;
                            if (text?.includes('Draining calls')) slot.dataset.sawDrain = text;
                        }
                    }
                });
                observer.observe(slot, { childList: true });
                slot.stopDrainObservation = () => observer.disconnect();
            }""")
            apply.click()
            dialog = page.locator(".monaco-dialog-box").first
            expect(dialog).to_contain_text(f"Switch pkm from {active_label} to {target_label}?", timeout=10000)
            dialog.get_by_role("button", name="Switch backend" if accept else "Cancel", exact=True).click()
            expect(frame.locator(".mcp-backend-feedback")).to_contain_text(
                "confirmed completion" if accept else "cancelled", timeout=20000)
            expect(active).to_contain_text(target_label if accept else active_label)
            expect(active).to_contain_text(
                "MCP version v0.1.0" if accept and target_label == "Bundled v5 MCP" else "MCP version v2.19.0")
            drain = active.evaluate("""el => {
                const slot = el.closest('#mcp-backend-slot');
                slot.stopDrainObservation();
                return slot.dataset.sawDrain;
            }""")
            assert drain == (f"{active_label} · Draining calls" if accept else ""), drain
            (base / f"settings-switch-{milestone}.json").write_text(json.dumps({"approved": accept}))
            wait_for(f"settings-observed-{milestone}.json")

        action("Bundled v5 MCP", "Original MCP", False, "cancelled")
        action("Bundled v5 MCP", "Original MCP", True, "v5")
        assert_revoked(*original_browser)
        v5_browser = enroll_browser("v5")
        action("Original MCP", "Bundled v5 MCP", True, "returned")
        assert_revoked(*v5_browser)
        (base / "settings-browser-coexistence.json").write_text(json.dumps({
            "bothBackendsRead": True, "grantsRevokedOnSwitch": True,
        }))
    except Exception:
        page.screenshot(path=str(base / "installed-settings-switch-failure.png"))
        raise
    finally:
        if "web" in locals():
            web.close()
