#!/usr/bin/env python3
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:4178/projects"


def red_pixels_near_arrow(page, selector):
        endpoint = page.locator(selector).first.evaluate("arrow => { const rect = arrow.getBoundingClientRect(); return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2}; }")
        screenshot = base64.b64encode(page.screenshot()).decode("ascii")
        return page.evaluate("""async ({screenshot, endpoint}) => {
            const image = new Image(); image.src = 'data:image/png;base64,' + screenshot; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
            const x = Math.max(0, Math.round(endpoint.x) - 9), y = Math.max(0, Math.round(endpoint.y) - 9);
            const pixels = context.getImageData(x, y, 19, 19).data; let count = 0;
            for (let index = 0; index < pixels.length; index += 4)
                if (pixels[index] > 170 && pixels[index + 1] < 130 && pixels[index + 2] < 130 && pixels[index + 3] > 180) count++;
            return count;
        }""", {"screenshot": screenshot, "endpoint": endpoint})


def open_recipe(page):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-workspace="automation"]').click()
    page.locator('.tab[data-tab="recipes"]').click()
    page.get_by_role("searchbox", name="Search Recipes").fill("PKM Tutorial")
    page.locator('.tree-cat-hdr[title="Examples"]').click()
    page.locator('.tree-cat-hdr[title="PKM"]').click()
    page.locator('.project-recipe-row', has_text="PKM Tutorial").click()
    page.locator('.recipe-graph-toolbar').wait_for()


def assert_single_toolbar_row(page):
    toolbar = page.locator('.recipe-graph-tools')
    styles = toolbar.evaluate("element => { const style = getComputedStyle(element); return {display:style.display, direction:style.flexDirection, wrap:style.flexWrap, width:style.width}; }")
    centers = toolbar.locator(':scope > *').evaluate_all(
        "elements => elements.map(element => { const rect = element.getBoundingClientRect(); return Math.round(rect.top + rect.height / 2); })"
    )
    assert max(centers) - min(centers) <= 1, f"Definition Graph controls wrapped onto multiple rows: {centers}; styles={styles}"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    open_recipe(page)

    assert page.locator('.workspace-separator').count() == 4
    assert_single_toolbar_row(page)
    assert page.locator('.recipe-graph-boundary.source').inner_text().strip().endswith("Input")
    assert page.locator('.recipe-graph-boundary.sink').inner_text().strip().endswith("Output")
    assert page.locator('.recipe-graph-links > path.boundary-edge').count() >= 2
    arrow_style = page.locator('.recipe-graph-arrow').first.evaluate(
        "element => ({background: getComputedStyle(element).backgroundColor})"
    )
    assert arrow_style["background"] == "rgb(226, 85, 85)", arrow_style
    assert red_pixels_near_arrow(page, '.recipe-graph-arrow') >= 3

    zoom = page.locator('#recipe-graph-zoom-label')
    assert zoom.inner_text() == "100%"
    page.get_by_role("button", name="Zoom in").click()
    assert zoom.inner_text() == "110%"
    page.get_by_role("button", name="Reset zoom").click()
    assert zoom.inner_text() == "100%"

    page.get_by_role("button", name="Add Step").click()
    page.locator('#pk-modal-input').fill("browser-step")
    page.locator('#pk-modal-ok').click()
    page.locator('.recipe-graph-node[data-node-id="browser-step"]').wait_for()
    page.get_by_role("button", name="Re-organize").click()

    page.get_by_role("button", name="Zoom in").click()
    assert zoom.inner_text() == "110%"
    graph_position = page.locator('.recipe-graph-viewport').evaluate("""element => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
      element.scrollTop = element.scrollHeight - element.clientHeight;
      return { left: element.scrollLeft, top: element.scrollTop };
    }""")

    page.locator('.recipe-graph-node[data-node-id="find-relevant-guidance"] header').dblclick()
    overlay = page.locator('#recipe-design-overlay')
    overlay.wait_for()
    overlay.locator('[data-recipe-design-tab="references"]').click()
    references = overlay.locator('[data-recipe-design-panel="references"]')
    references.wait_for()
    references.locator('.recipe-reference-actions button').first.click()
    assert references.locator('.sub-picker').count() == 2
    skill = references.locator('.sub-picker').first.locator('.sub-tree-leaf input').first
    skill.check()
    references.locator('[title="How this reference is used"]').select_option("required")
    overlay.get_by_role("button", name="Done", exact=True).click()
    page.wait_for_timeout(50)
    assert zoom.inner_text() == "110%", "Opening a component reset the graph zoom"
    restored_position = page.locator('.recipe-graph-viewport').evaluate("element => ({ left: element.scrollLeft, top: element.scrollTop })")
    assert restored_position == graph_position, f"Opening a component moved the graph viewport: {graph_position} -> {restored_position}"

    page.evaluate("""
      window.__recipeOpen = null;
      window.__recipeSave = null;
      window.addEventListener('releaseRecipeOpenBrowser', event => window.__recipeOpen = event.detail);
      window.addEventListener('releaseRecipeUpdate', event => window.__recipeSave = event.detail);
    """)
    browser_button = page.locator('.recipe-editor-header button[title*="browser"]')
    assert browser_button.count() == 1, "Browser control disappeared after editing Recipe references"
    browser_button.click()
    assert "action-pending" in (browser_button.get_attribute("class") or "")
    assert browser_button.get_attribute("aria-busy") == "true"
    assert "Opening" in browser_button.inner_text()
    page.wait_for_function("window.__recipeOpen !== null")
    assert page.evaluate("window.__recipeOpen.recipeId") == "recipe_builtin_pkm_tutorial"

    page.locator('.recipe-graph-tools button[onclick="recipeSave(this)"]').click()
    page.wait_for_function("window.__recipeSave !== null")
    bindings = page.evaluate("window.__recipeSave.nodeBindings")
    assert bindings == [{
        "nodeId": "find-relevant-guidance",
        "bindings": [{
            "kind": "skill",
            "knowledgeId": "System/PKM/PKM Skills",
            "usage": "required",
        }],
    }]
    page.screenshot(path="/tmp/pkm-recipe-desktop.png", full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile_errors = []
    mobile.on("pageerror", lambda error: mobile_errors.append(str(error)))
    open_recipe(mobile)
    assert mobile.locator('.workspace-separator').count() == 4
    assert_single_toolbar_row(mobile)
    mobile.screenshot(path="/tmp/pkm-recipe-mobile.png", full_page=True)

    assert not errors, f"Desktop page errors: {errors}"
    assert not mobile_errors, f"Mobile page errors: {mobile_errors}"
    browser.close()

print("Recipe browser UI tests passed")
