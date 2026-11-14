import json
import re
import sys

from playwright.sync_api import expect, sync_playwright


settings = json.loads(sys.stdin.readline())
calls = []


def record_request(request):
    if "/v1/capability_read" not in request.url and "/v1/capability_call" not in request.url:
        return
    try:
        body = request.post_data_json
        calls.append({"method": request.url.rsplit("/", 1)[-1],
                      "operation": body.get("operation"), "arguments": body.get("arguments", {})})
    except Exception:
        calls.append({"method": request.url.rsplit("/", 1)[-1], "operation": None, "arguments": {}})


def checkpoint(name):
    print(json.dumps({"checkpoint": name}), flush=True)
    assert json.loads(sys.stdin.readline())["ready"]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_default_timeout(8_000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", record_request)
        response = page.goto(settings["url"], wait_until="networkidle")
        assert response and response.status == 200
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        lifecycle = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
        page.get_by_role("link", name="Lifecycle", exact=True).click()
        search_kind = lifecycle.get_by_label("Search Knowledge kind", exact=True)
        search_kind.select_option("note")
        search_form = lifecycle.locator("form").filter(
            has=page.get_by_role("heading", name="Literal search", exact=True))
        query = search_form.get_by_label("Search terms", exact=True)
        query.fill("Pinned Browser Fixture")
        search_form.get_by_role("button", name="Search", exact=True).click()
        results = lifecycle.get_by_role("region", name="Literal search results", exact=True)
        source_button = results.get_by_role(
            "button", name=re.compile(re.escape(settings["title"])))
        source_button.wait_for()
        checkpoint("search-ready")

        source_button.click()
        alert = lifecycle.get_by_role("alert")
        expect(alert).to_contain_text(re.compile("changed|snapshot|conflict", re.I))
        assert "OLD pinned source" not in lifecycle.inner_text()

        search_form.get_by_role("button", name="Search", exact=True).click()
        refreshed_button = results.get_by_role(
            "button", name=re.compile(re.escape(settings["title"])))
        refreshed_button.wait_for()
        refreshed_button.click()
        expect(lifecycle.locator("pre").last).to_contain_text("CURRENT pinned source")
        rendered = lifecycle.locator("pre").last.inner_text()
        assert "<script>window.pkmInjected = true</script>" in rendered
        assert "OLD pinned source" not in rendered
        assert lifecycle.locator("script, img").count() == 0
        assert page.evaluate("window.pkmInjected === true") is False
        expect(lifecycle.get_by_text(
            "Opened the exact source selected from this pinned search snapshot; no write was attempted.",
            exact=True)).to_be_visible()
        assert lifecycle.get_by_role("button", name="Save specialized fields", exact=True).count() == 0
        print(json.dumps({"errors": errors, "calls": calls, "injected": page.evaluate("!!window.pkmInjected"),
                          "readOnly": lifecycle.get_by_role("button", name="Save specialized fields", exact=True).count() == 0}),
              flush=True)
    finally:
        browser.close()
