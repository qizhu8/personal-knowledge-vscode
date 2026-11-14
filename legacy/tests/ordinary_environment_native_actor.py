import argparse
import importlib.util
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def run(args):
    fixture = Path(args.fixture)
    contract = json.loads((fixture / "contract.json").read_text())
    spec = importlib.util.spec_from_file_location(
        "environment_helper", str(Path(contract["project"]) / "tests/ordinary_environment_profile_ui.py")
    )
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    with sync_playwright() as playwright:
        deadline = time.monotonic() + 60
        while True:
            try:
                browser = playwright.chromium.connect_over_cdp(args.cdp)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)
        try:
            page = browser.contexts[0].pages[0]
            page.get_by_role("button", name="Allow Environment Reads", exact=True).click(timeout=60000)
            deadline = time.monotonic() + 60
            frame = None
            while time.monotonic() < deadline:
                error = fixture / f"native-error-{args.phase}.txt"
                if error.exists():
                    raise AssertionError(error.read_text())
                for candidate in page.frames:
                    if candidate.locator("#env-tree").count():
                        frame = candidate
                        break
                if frame:
                    break
                time.sleep(0.2)
            assert frame, "Actual ordinary Environments webview was not rendered"
            # Native custom modal is clicked in the Workbench, not via a product function or fake reply.
            for environment_id in (contract["id"], contract["venvId"]):
                helper.packages(frame, environment_id)
                assert "cached" in frame.locator("#env-out").inner_text()
                frame.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                dialog = page.get_by_role("button", name="Refresh Selected Environments", exact=True)
                dialog.wait_for(timeout=30000)
                page.screenshot(path=str(fixture / f"native-confirm-{args.phase}-{environment_id}.png"))
                dialog.click()
                frame.get_by_text("captured", exact=False).wait_for(timeout=30000)
                assert "retained_fixture" in frame.locator("#pkg-body").inner_text()
                helper.packages(frame, environment_id)
                assert "cached" in frame.locator("#env-out").inner_text()
            frame.locator("#env-refresh-btn").click()
            page.get_by_role("button", name="Refresh Selected Environments", exact=True).click(timeout=30000)
            frame.wait_for_function(
                "envCache.length===2 && envCache.every(e=>e.pyVersion && e.pyVersion!=='0.0' && e.sizeBytes>0)",
                timeout=30000,
            )
            page.screenshot(path=str(fixture / f"native-success-{args.phase}.png"))
            return {"phase": args.phase, "realNativeReadAndRefreshConsent": True,
                    "ordinaryComponents": True, "prestartedOwner": True,
                    "qualification": "controlled fixture channel; not exclusive cross-process authority or production"}
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("fixture", "phase", "cdp"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args())))
