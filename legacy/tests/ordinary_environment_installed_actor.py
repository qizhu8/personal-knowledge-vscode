import argparse
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import time

from playwright.sync_api import sync_playwright


def run(cdp, helper, environment_id, venv_id, phase, fixture_root):
    version = tuple(int(part) for part in importlib.metadata.version("playwright").split("."))
    if version < (1, 64, 1):
        raise RuntimeError("Code 1.143/Electron 43 requires an existing Playwright >=1.64.1 CDP client; do not download one automatically.")
    root = Path(fixture_root).resolve(strict=True)
    assert root.parent == Path(__file__).resolve().parents[1] / ".migration-test-work"
    receipt = json.loads((root / "fixture-receipt.json").read_text())
    tool, cache, calls = (Path(receipt[key]) for key in ("tool", "cache", "calls"))
    for owned in (tool, cache, calls):
        assert root in owned.resolve(strict=True).parents
    spec = importlib.util.spec_from_file_location("ordinary_env_helper", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(cdp)
        try:
            deadline = time.monotonic() + 60
            surface = None
            while time.monotonic() < deadline and surface is None:
                for context in browser.contexts:
                    for page in context.pages:
                        for frame in page.frames:
                            tab = frame.locator('[data-tab="environments"]')
                            if tab.count():
                                surface = frame
                                frame.wait_for_load_state("networkidle")
                                if not tab.first.is_visible():
                                    frame.locator('.workspace-button[data-workspace="tools"]').click(timeout=7000)
                                tab.first.click(timeout=7000)
                                break
                        if surface:
                            break
                    if surface:
                        break
                if surface is None:
                    time.sleep(0.2)
            if surface is None:
                raise AssertionError("No real ordinary Environments tab in the installed Root UI")
            module.packages(surface, environment_id)
            assert "cached" in surface.locator("#env-out").inner_text()
            if phase != "original":
                surface.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                surface.get_by_text("captured", exact=False).wait_for(timeout=10000)
                assert "retained_fixture" in surface.locator("#pkg-body").inner_text()
                before_cache, before_calls = cache.read_bytes(), calls.read_bytes()
                mode = tool.stat().st_mode
                try:
                    os.chmod(tool, 0o600)
                    surface.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                    surface.get_by_text("EACCES", exact=False).wait_for(timeout=10000)
                    assert str(tool) in surface.locator("#env-out").inner_text()
                    assert cache.read_bytes() == before_cache
                    assert calls.read_bytes() == before_calls
                finally:
                    os.chmod(tool, mode)
                module.packages(surface, environment_id)
                assert "cached" in surface.locator("#env-out").inner_text()
                assert calls.read_bytes() == before_calls
                surface.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                surface.get_by_text("captured", exact=False).wait_for(timeout=10000)
                assert len(calls.read_bytes().splitlines()) == len(before_calls.splitlines()) + 1
            module.packages(surface, venv_id)
            assert "pip" in surface.locator("#pkg-body").inner_text()
            if phase != "original":
                surface.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                surface.get_by_text("captured", exact=False).wait_for(timeout=10000)
                assert "pip" in surface.locator("#pkg-body").inner_text()
                surface.locator("#env-refresh-btn").click()
                module.open_environment_card(surface, environment_id)
            return {"phase": phase, "ordinaryUi": True, "conda": True, "realPip": True,
                    "permissionErrorCacheRecovery": phase != "original"}
        except Exception as error:
            snapshots = []
            try:
                session = browser.new_browser_cdp_session()
                snapshots.append({"targets": session.send("Target.getTargets")})
                session.detach()
            except Exception:
                pass
            for context in browser.contexts:
                for page in context.pages:
                    for frame in page.frames:
                        try:
                            snapshots.append({"url": frame.url, "body": frame.locator("body").inner_text(timeout=1000)[:5000]})
                        except Exception:
                            pass
            raise RuntimeError(json.dumps(snapshots)) from error
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for argument in ("cdp", "helper", "id", "venv-id", "phase", "fixture-root"):
        parser.add_argument("--" + argument, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.cdp, args.helper, args.id, args.venv_id, args.phase, args.fixture_root)))
