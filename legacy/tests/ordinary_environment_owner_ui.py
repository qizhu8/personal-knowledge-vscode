import argparse
import importlib.util
import json
from playwright.sync_api import sync_playwright


def run(args):
    spec = importlib.util.spec_from_file_location("ordinary_env_helper", args.helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chromium)
        try:
            page = browser.new_page()
            page.goto(args.base)
            page.wait_for_load_state("networkidle")
            for environment_id in (args.id, args.venv_id):
                module.packages(page, environment_id)
                assert "cached" in page.locator("#env-out").inner_text()
                expected = "pip" if environment_id == args.venv_id else "retained_fixture"
                assert expected in page.locator("#pkg-body").inner_text()
                page.locator('#env-out button[onclick*="viewEnvPackages"]').click()
                if args.refresh_owner:
                    page.get_by_text("captured", exact=False).wait_for(timeout=10000)
                    assert expected in page.locator("#pkg-body").inner_text()
                else:
                    page.get_by_text("separate authorization", exact=False).wait_for(timeout=10000)
                module.packages(page, environment_id)
                assert "cached" in page.locator("#env-out").inner_text()
            if args.refresh_owner:
                page.locator("#env-refresh-btn").click()
                page.wait_for_function("envCache.length===2 && envCache.every(e=>e.pyVersion && e.pyVersion!=='0.0' && e.sizeBytes>0)")
            return {"ordinaryOwnerUi": True, "readCacheOnly": True}
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("base", "helper", "chromium", "id", "venv-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--refresh-owner", action="store_true")
    print(json.dumps(run(parser.parse_args())))
