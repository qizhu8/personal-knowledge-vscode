import argparse
import json
import signal
import urllib.request

from playwright.sync_api import sync_playwright


def open_environment_card(surface, environment_id):
    card = surface.locator(f'.env-card[data-env-id="{environment_id}"]')
    surface.locator('#env-tree .tree-cat-hdr').first.wait_for()
    for _ in range(8):
        if card.is_visible():
            return card
        collapsed = surface.locator('#env-tree .tree-cat-hdr[aria-expanded="false"]:visible')
        if collapsed.count() == 0:
            break
        collapsed.first.click()
    raise AssertionError("Retained environment card is not reachable through the real category tree")


def packages(surface, environment_id):
    card = open_environment_card(surface, environment_id)
    button = card.get_by_role("button", name="Packages", exact=True)
    assert button.is_enabled(), "Ordinary Packages is disabled for the retained registration"
    button.click()
    surface.locator("#pkg-body").wait_for()
    assert "retained_fixture" in surface.locator("#pkg-body").inner_text().replace("-", "_")


def run(base, environment_id, venv_id, chromium):
    def state(action=None):
        request = urllib.request.Request(
            base + "/fixture", data=json.dumps(action).encode() if action else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def terminate(_signal, _frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, terminate)
    report = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=chromium)
        try:
            for stage in ("old", "current"):
                context = browser.new_context()
                page = context.new_page()
                page.set_default_timeout(7000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                try:
                    page.goto(base + "/" + stage)
                    page.wait_for_load_state("networkidle")
                    before = state()
                    packages(page, environment_id)
                    assert "cached" in page.locator("#env-out").inner_text()
                    assert state()["calls"] == before["calls"]
                    if stage == "old":
                        page.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                        page.get_by_text("ENOENT", exact=False).wait_for()
                        assert state()["calls"] == before["calls"]
                        assert state()["cacheSha256"] == before["cacheSha256"]
                        packages(page, environment_id)
                    if stage == "current":
                        refresh = page.locator('#env-out button[onclick*="viewEnvPackages"]')
                        refresh.click()
                        page.wait_for_function("window.__messages.some(m=>m.command==='envPackages' && m.cached===false && !m.error)")
                        assert "captured" in page.locator("#env-out").inner_text()
                        assert state()["calls"] == before["calls"] + 1
                        state({"permission": "deny"})
                        refresh.click()
                        page.get_by_text("EACCES", exact=False).wait_for()
                        denied = state()
                        assert denied["calls"] == before["calls"] + 1
                        state({"permission": "restore"})
                        packages(page, environment_id)
                        assert "cached" in page.locator("#env-out").inner_text()
                        assert state()["cacheSha256"] == denied["cacheSha256"]
                        page.locator("#env-refresh-btn").click()
                        page.wait_for_function("window.__messages.some(m=>m.command==='envList' && 'refreshErrors' in m)")
                        open_environment_card(page, environment_id)
                    packages(page, venv_id)
                    assert "pip" in page.locator("#pkg-body").inner_text()
                    assert "cached" in page.locator("#env-out").inner_text()
                    if stage == "current":
                        page.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                        page.wait_for_function(
                            "id=>window.__messages.some(m=>m.command==='envPackages' && m.id===id && m.cached===false && !m.error)",
                            arg=venv_id,
                        )
                        assert "pip" in page.locator("#pkg-body").inner_text()
                    assert not errors, errors
                    report.append({"stage": stage, "state": state(), "browserErrors": errors})
                except Exception as error:
                    raise RuntimeError(json.dumps({
                        "stage": stage, "browserErrors": errors,
                        "body": page.locator("body").inner_text()[:3000],
                    })) from error
                finally:
                    context.close()
        finally:
            browser.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--venv-id", required=True)
    parser.add_argument("--chromium", required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.base, args.id, args.venv_id, args.chromium)))
