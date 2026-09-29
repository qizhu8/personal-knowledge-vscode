#!/usr/bin/env python3
import base64
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("PKM_PREVIEW_URL", "http://127.0.0.1:4178") + "/projects"
SCREENSHOT_PATH = os.environ.get("PKM_AGENT_SESSION_GRAPH_SCREENSHOT", "")


def red_pixels_near_arrow(page, selector):
        arrow = page.locator(selector).first
        arrow.scroll_into_view_if_needed()
        endpoint = arrow.evaluate("arrow => { const rect = arrow.getBoundingClientRect(); return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2}; }")
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
    page.wait_for_function("recipeDraftBaselinePending === false")


def open_configurable_testing_recipe(page):
    page.get_by_role("searchbox", name="Search Recipes").fill("Configurable Validation and Testing")
    for category in ["System", "PKM", "Fundamental"]:
        header = page.locator(f'.tree-cat-hdr[title="{category}"]')
        if header.count() and "expanded" not in (header.get_attribute("class") or ""):
            header.click()
    page.locator('.project-recipe-row', has_text="Configurable Validation and Testing").click()
    page.locator('.recipe-methodology-projections').wait_for()
    page.wait_for_function("recipeDraftBaselinePending === false")


def assert_single_toolbar_row(page):
    toolbar = page.locator('.recipe-graph-tools')
    styles = toolbar.evaluate("element => { const style = getComputedStyle(element); return {display:style.display, direction:style.flexDirection, wrap:style.flexWrap, width:style.width}; }")
    centers = toolbar.locator(':scope > *').evaluate_all(
        "elements => elements.map(element => { const rect = element.getBoundingClientRect(); return Math.round(rect.top + rect.height / 2); })"
    )
    assert max(centers) - min(centers) <= 1, f"Definition Graph controls wrapped onto multiple rows: {centers}; styles={styles}"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    isolated_startup = browser.new_page(viewport={"width": 1440, "height": 1000})
    isolated_startup.route("**/panel.css", lambda route: route.abort())
    isolated_startup.goto(BASE_URL, wait_until="domcontentloaded")
    isolated_startup.wait_for_timeout(100)
    assert isolated_startup.locator("#loading-banner").is_visible()
    assert isolated_startup.locator("button:visible").count() == 0, "stylesheet failure exposed raw startup buttons"
    assert isolated_startup.locator("progress:visible").count() == 0, "stylesheet failure exposed an unstyled progress bar"
    isolated_text = isolated_startup.locator("body").inner_text()
    assert "The interface styles did not load." in isolated_text
    assert "Regenerate Server Code" not in isolated_text
    assert "Knowledge Sync" not in isolated_text
    isolated_startup.close()

    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    open_recipe(page)

    page.locator("#start-tour-button").click()
    assert page.locator("#experience-layer").is_visible()
    assert page.locator("#coachmark-title").inner_text() == "Welcome to Personal Knowledge Manager"
    assert page.locator("#coachmark-progress").inner_text() == "Step 1 of 9"
    assert page.locator("#topbar strong").evaluate("element => element.classList.contains('coachmark-target')")
    page.locator("#coachmark-close").click()
    assert page.locator("#experience-layer").is_hidden()
    assert not any(
        message.get("command") == "completeTourModules"
        for message in page.evaluate("window.__previewMessages")
    ), "manual replay must not change durable completion state"

    page.evaluate("""startOnboardingTour({
      moduleIds: ['core-navigation', 'agent-workflows', 'runtime-and-sharing'],
      audience: 'update',
      automatic: true
    })""")
    page.locator("#coachmark-close").click()
    page.wait_for_function(
        "window.__previewMessages.some(message => message.command === 'completeTourModules')"
    )
    completion_messages = [
        message for message in page.evaluate("window.__previewMessages")
        if message.get("command") == "completeTourModules"
    ]
    assert completion_messages[-1]["moduleIds"] == [
        "core-navigation",
        "agent-workflows",
        "runtime-and-sharing",
    ], "explicit skip must persist every presented module"
    assert completion_messages[-1]["audience"] == "update"

    page.set_viewport_size({"width": 520, "height": 900})
    page.locator("#start-tour-button").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-title").filter(has_text="Create your first reusable item").wait_for()
    assert page.locator("#more-btn").evaluate("element => element.classList.contains('coachmark-target')")
    page.locator("#coachmark-close").click()
    page.set_viewport_size({"width": 1440, "height": 1000})
    open_recipe(page)

    assert page.locator('.workspace-separator').count() == 4
    assert_single_toolbar_row(page)
    save_button = page.locator('[data-recipe-save]')
    assert save_button.is_disabled(), "Save must start disabled for an unchanged Recipe"
    initial_name = page.locator("#recipe-name").input_value()
    page.locator("#recipe-name").fill(initial_name + " changed")
    assert save_button.is_enabled(), "Editing Recipe metadata must enable Save"
    page.locator("#recipe-name").fill(initial_name)
    assert save_button.is_disabled(), "Reverting the only draft change must disable Save"
    assert page.locator('.recipe-graph-boundary.source').inner_text().strip().endswith("Input")
    assert page.locator('.recipe-graph-boundary.sink').inner_text().strip().endswith("Output")
    assert page.locator('.recipe-graph-links > path.boundary-edge').count() >= 2
    arrow_style = page.locator('.recipe-graph-arrow').first.evaluate(
        "element => ({background: getComputedStyle(element).backgroundColor})"
    )
    assert arrow_style["background"] == "rgb(226, 85, 85)", arrow_style
    assert red_pixels_near_arrow(page, '.recipe-graph-arrow') >= 3
    assert page.locator(".recipe-graph-node.kind-step").count() >= 1
    canvas = page.locator(".recipe-graph-canvas")
    first_two = page.locator(".recipe-graph-node").evaluate_all("""nodes => nodes.slice(0, 2).map(node => {
      const rect = node.getBoundingClientRect();
      return {left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom};
    })""")
    selection_box = {
        "left": min(rect["left"] for rect in first_two) - 6,
        "top": min(rect["top"] for rect in first_two) - 6,
        "right": max(rect["right"] for rect in first_two) + 6,
        "bottom": max(rect["bottom"] for rect in first_two) + 6,
    }
    page.mouse.move(selection_box["left"], selection_box["top"])
    page.mouse.down()
    page.mouse.move(selection_box["right"], selection_box["bottom"], steps=4)
    assert page.locator(".recipe-selection-marquee").count() == 0, "Plain drag must not start marquee selection"
    page.mouse.up()
    page.keyboard.down("Shift")
    page.mouse.move(selection_box["left"], selection_box["top"])
    page.mouse.down()
    page.mouse.move(selection_box["right"], selection_box["bottom"], steps=4)
    assert page.locator(".recipe-selection-marquee").count() == 1
    page.mouse.up()
    page.keyboard.up("Shift")
    assert page.locator(".recipe-graph-node.selected").count() >= 2
    assert page.locator(".recipe-graph-links .edge-visible.selected").count() >= 1
    first_header = page.locator(".recipe-graph-node").first.locator("header")
    first_header.click(position={"x": 50, "y": 20})
    assert page.locator(".recipe-graph-node.selected").count() == 1
    selected_style = page.locator(".recipe-graph-node.selected").evaluate(
        "node => ({outline:getComputedStyle(node).outlineWidth, border:getComputedStyle(node).borderColor})"
    )
    assert selected_style["outline"] == "3px", selected_style
    blank_point = canvas.evaluate("""canvas => {
      const rect = canvas.getBoundingClientRect();
      for (let y=Math.max(1,rect.top+8); y<Math.min(innerHeight-1,rect.bottom-8); y+=12)
        for (let x=Math.max(1,rect.left+8); x<Math.min(innerWidth-1,rect.right-8); x+=12) {
          const target=document.elementFromPoint(x,y);
          if (target===canvas || target?.matches?.('.recipe-graph-links')) return {x,y};
        }
      throw new Error('No visible blank graph point');
    }""")
    page.mouse.click(blank_point["x"], blank_point["y"])
    assert page.locator(".recipe-graph-node.selected").count() == 0
    assert page.locator(".recipe-graph-links .edge-visible.selected").count() == 0
    assert page.locator(".recipe-edge-inspector").count() == 0
    source = page.locator(".recipe-graph-boundary.source")
    source.scroll_into_view_if_needed()
    source_box = source.bounding_box()
    page.mouse.move(source_box["x"] + 20, source_box["y"] + 15)
    page.mouse.down()
    page.mouse.move(source_box["x"] + 100, source_box["y"] + 500, steps=8)
    page.mouse.up()
    source_constraint = page.locator(".recipe-graph-canvas").evaluate("""canvas => {
      const source = canvas.querySelector('.recipe-graph-boundary.source'), modules = [...canvas.querySelectorAll('.recipe-graph-node')];
      return {sourceBottom:source.offsetTop + source.offsetHeight, minimumModuleTop:Math.min(...modules.map(node => node.offsetTop))};
    }""")
    assert source_constraint["sourceBottom"] < source_constraint["minimumModuleTop"], source_constraint

    sink = page.locator(".recipe-graph-boundary.sink")
    sink.scroll_into_view_if_needed()
    sink_box = sink.bounding_box()
    page.mouse.move(sink_box["x"] + 20, sink_box["y"] + 15)
    page.mouse.down()
    page.mouse.move(sink_box["x"] + 100, sink_box["y"] - 500, steps=8)
    page.mouse.up()
    sink_constraint = page.locator(".recipe-graph-canvas").evaluate("""canvas => {
      const sink = canvas.querySelector('.recipe-graph-boundary.sink'), modules = [...canvas.querySelectorAll('.recipe-graph-node')];
      return {sinkTop:sink.offsetTop, maximumModuleBottom:Math.max(...modules.map(node => node.offsetTop + node.offsetHeight))};
    }""")
    assert sink_constraint["sinkTop"] > sink_constraint["maximumModuleBottom"], sink_constraint
    assert page.evaluate("recipeDraft.editorLayout.boundaryPositions.input.x > 12 && recipeDraft.editorLayout.boundaryPositions.output.y > 0")

    normal_edge_count = page.locator(".recipe-graph-links .edge-visible:not(.loop-edge)").count()
    edge_hit = page.locator(".recipe-graph-links .edge-hit:not(.loop-edge)").first
    edge_hit.evaluate("path => path.scrollIntoView({block:'center',inline:'center'})")
    edge_point = edge_hit.evaluate("""path => {
      const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM();
      return { x:matrix.a * point.x + matrix.c * point.y + matrix.e,
               y:matrix.b * point.x + matrix.d * point.y + matrix.f };
    }""")
    page.mouse.click(edge_point["x"], edge_point["y"])
    hit_target = page.evaluate("""({x,y}) => {
      const target = document.elementFromPoint(x,y), path = document.querySelector('.recipe-graph-links .edge-hit:not(.loop-edge)');
      return { tag:target?.tagName, classes:target?.getAttribute?.('class'), path:path?.getAttribute('d'),
        pathRect:path?.getBoundingClientRect().toJSON(),
        cards:[...document.querySelectorAll('.recipe-graph-node')].map(node => ({id:node.dataset.nodeId,rect:node.getBoundingClientRect().toJSON()})) };
    }""", edge_point)
    assert page.locator(".recipe-graph-links .edge-visible.selected").count() == 1, {"point": edge_point, "target": hit_target}
    page.locator('.recipe-edge-inspector button[title="Delete selected connection"]').click()
    assert page.locator(".recipe-graph-links .edge-visible:not(.loop-edge)").count() == normal_edge_count - 1
    page.get_by_role("button", name="Cancel", exact=True).click()
    assert page.locator(".recipe-graph-links .edge-visible:not(.loop-edge)").count() == normal_edge_count

    movable = page.locator(".recipe-graph-node").first
    movable_header = movable.locator("header")
    box = movable_header.bounding_box()
    page.mouse.move(box["x"] + 40, box["y"] + 20)
    page.mouse.down()
    page.mouse.move(box["x"] + 40, box["y"] + 380, steps=8)
    page.mouse.up()
    output_reflow = page.locator(".recipe-graph-canvas").evaluate("""canvas => {
      const moved = canvas.querySelector('.recipe-graph-node'), output = canvas.querySelector('.recipe-graph-boundary.sink');
      return { movedBottom:moved.offsetTop + moved.offsetHeight, outputTop:output.offsetTop };
    }""")
    assert output_reflow["outputTop"] > output_reflow["movedBottom"], output_reflow

    original_name = page.locator("#recipe-name").input_value()
    page.locator("#recipe-name").fill("Discard this draft")
    page.get_by_role("button", name="Cancel", exact=True).click()
    assert page.locator("#recipe-name").input_value() == original_name

    base_module_count = page.locator(".recipe-graph-node").count()
    page.locator(".recipe-graph-node").first.locator("header").click(position={"x": 50, "y": 20})
    page.keyboard.press("Delete")
    assert page.locator(".recipe-graph-node").count() == base_module_count - 1
    page.keyboard.press("Control+Z")
    assert page.locator(".recipe-graph-node").count() == base_module_count
    page.keyboard.press("Control+Y")
    assert page.locator(".recipe-graph-node").count() == base_module_count - 1
    page.keyboard.press("Control+Z")
    page.locator(".recipe-graph-node").first.locator("header").click(position={"x": 50, "y": 20})
    page.keyboard.press("Control+C")
    page.keyboard.press("Control+V")
    assert page.locator(".recipe-graph-node").count() == base_module_count + 1
    assert page.locator('.recipe-graph-node[data-node-id$="-copy"]').count() == 1
    page.keyboard.press("Control+X")
    assert page.locator(".recipe-graph-node").count() == base_module_count
    page.keyboard.press("Control+Z")
    assert page.locator(".recipe-graph-node").count() == base_module_count + 1
    page.keyboard.press("Control+Shift+Z")
    assert page.locator(".recipe-graph-node").count() == base_module_count
    page.get_by_role("button", name="Cancel", exact=True).click()
    assert page.locator(".recipe-graph-node").count() == base_module_count

    page.evaluate("recipeGraphControlMode(recipeDraft.definition.spec.nodes[0].nodeId,'repeat')")
    repeat = page.locator(".recipe-graph-node.mode-repeat").first
    assert repeat.locator(".recipe-repeat-badge").inner_text() == "x2"
    assert repeat.evaluate("node => getComputedStyle(node).backgroundColor") == "rgba(0, 0, 0, 0)"
    page.get_by_role("button", name="Cancel", exact=True).click()

    pair = page.evaluate("""() => {
      const downstream = recipeDraft.definition.spec.nodes.find(node => (node.dependsOn || []).length);
      return {upstream:downstream.dependsOn[0].from, downstream:downstream.nodeId};
    }""")
    page.evaluate("(id) => recipeGraphControlMode(id,'branch')", pair["downstream"])
    page.locator(f'.recipe-graph-node[data-node-id="{pair["downstream"]}"] .recipe-drag-handle').drag_to(
        page.locator(f'.recipe-graph-node[data-node-id="{pair["upstream"]}"]')
    )
    page.get_by_role("button", name="Create Loop").click()
    loop_hit = page.locator(".recipe-graph-links .edge-hit.loop-edge")
    assert loop_hit.count() == 1
    assert "while-if / if-while" in loop_hit.get_attribute("aria-label")
    widths = page.locator(".recipe-graph-canvas").evaluate("""canvas => ({
      normal:getComputedStyle(canvas.querySelector('.edge-visible:not(.loop-edge)')).strokeWidth,
      loop:getComputedStyle(canvas.querySelector('.edge-visible.loop-edge')).strokeWidth
    })""")
    assert float(widths["loop"].replace("px", "")) > float(widths["normal"].replace("px", "")), widths
    loop_hit.focus()
    page.keyboard.press("Enter")
    page.locator('.recipe-edge-inspector button[title="Delete selected connection"]').click()
    assert page.locator(".recipe-graph-links .edge-hit.loop-edge").count() == 0
    page.get_by_role("button", name="Cancel", exact=True).click()

    zoom = page.locator('#recipe-graph-zoom-label')
    assert zoom.inner_text() == "100%"
    page.get_by_role("button", name="Zoom in").click()
    assert zoom.inner_text() == "110%"
    page.get_by_role("button", name="Reset zoom").click()
    assert zoom.inner_text() == "100%"

    boundary_edges_before_create = page.locator('.recipe-graph-links > path.boundary-edge').count()
    page.get_by_role("button", name="Add Module").click()
    page.locator('#pk-modal-ok').click()
    assert page.locator('#pk-modal-error').inner_text() == "Use a stable ID beginning with a letter."
    assert page.locator('#pk-modal-bg').count() == 1, "Invalid Module ID must keep the dialog open"
    page.locator('#pk-modal-input').fill("browser-step")
    page.locator('#pk-modal-ok').click()
    created = page.locator('.recipe-graph-node[data-node-id="browser-step"]')
    created.wait_for()
    assert "selected" in created.get_attribute("class")
    assert save_button.is_enabled(), "Adding a Module must enable Save"
    assert "invalid" in created.get_attribute("class")
    assert created.get_attribute("aria-invalid") == "true"
    assert page.locator('.recipe-graph-links > path.boundary-edge').count() == boundary_edges_before_create
    visibility = created.evaluate("""node => {
      const nodeRect = node.getBoundingClientRect(), viewportRect = node.closest('.recipe-graph-viewport').getBoundingClientRect();
      return nodeRect.right > viewportRect.left && nodeRect.left < viewportRect.right
        && nodeRect.bottom > viewportRect.top && nodeRect.top < viewportRect.bottom;
    }""")
    assert visibility, "New Module was created outside the visible Graph viewport"
    page.locator('.recipe-graph-actions button[onclick="recipeSave(this)"]').click()
    assert page.locator('#pk-modal .pk-modal-title').inner_text() == "Incomplete Recipe Graph"
    assert "browser-step" in page.locator('#pk-modal .pk-modal-msg').inner_text()
    assert page.evaluate("window.__recipeSave") is None
    page.locator('#pk-modal-ok').click()
    terminal_id = page.evaluate("""() => RecipeGraph.topology(
      recipeDraft.definition.spec.nodes, recipeGraphPendingNodeIds
    ).terminals[0].nodeId""")
    page.evaluate("([sourceId,targetId]) => recipeGraphCommitDependency(sourceId,targetId,false)", [terminal_id, "browser-step"])
    assert "invalid" not in created.get_attribute("class")
    page.evaluate("""() => {
      const output = document.querySelector('[data-graph-boundary="sink"]');
      output.style.left = '12px';
      output.style.top = '12px';
      recipeDraft.editorLayout.boundaryPositions = { output:{x:12,y:12} };
    }""")
    page.get_by_role("button", name="Re-organize").click()
    organized_geometry = page.evaluate("""() => {
      const modules = [...document.querySelectorAll('.recipe-graph-node')];
      const terminals = RecipeGraph.topology(recipeDraft.definition.spec.nodes, recipeGraphPendingNodeIds).terminals;
      const terminalCards = terminals.map(node => modules.find(card => card.dataset.nodeId === node.nodeId));
      const output = document.querySelector('[data-graph-boundary="sink"]');
      const outputCenter = parseFloat(output.style.left) + output.offsetWidth / 2;
      const terminalCenter = terminalCards.reduce(
        (sum, card) => sum + parseFloat(card.style.left) + card.offsetWidth / 2, 0
      ) / terminalCards.length;
      return {
        outputCenter,
        terminalCenter,
        outputTop:parseFloat(output.style.top),
        moduleBottom:Math.max(...modules.map(card => parseFloat(card.style.top) + card.offsetHeight))
      };
    }""")
    assert abs(organized_geometry["outputCenter"] - organized_geometry["terminalCenter"]) <= 2, organized_geometry
    assert organized_geometry["outputTop"] > organized_geometry["moduleBottom"], organized_geometry
    action_geometry = page.evaluate("""() => {
      const viewport = document.querySelector('.recipe-graph-viewport').getBoundingClientRect();
      const actions = document.querySelector('.recipe-graph-actions').getBoundingClientRect();
      return { viewportRight:viewport.right, viewportBottom:viewport.bottom, actionsRight:actions.right, actionsTop:actions.top };
    }""")
    assert abs(action_geometry["actionsRight"] - action_geometry["viewportRight"]) <= 2, action_geometry
    assert action_geometry["actionsTop"] >= action_geometry["viewportBottom"], action_geometry

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

    page.locator('.recipe-graph-actions button[onclick="recipeSave(this)"]').click()
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
    open_configurable_testing_recipe(page)
    methodology = page.locator('.recipe-methodology-projections')
    for heading in ["Pyramid", "Composition", "Evidence Contract", "Retrieval"]:
        assert methodology.get_by_text(heading, exact=True).is_visible()
    assert methodology.get_by_text("coverage-is-not-acceptance", exact=True).is_visible()
    assert methodology.get_by_text("security", exact=True).is_visible()
    assert page.locator('.recipe-graph-node[data-node-id="select-security"]').count() == 1
    assert page.locator('.recipe-graph-node[data-node-id="test-ui"]').count() == 1
    assert page.locator('.recipe-graph-node[data-node-id="test-simulation"]').count() == 1
    assert page.locator('.recipe-graph-node[data-node-id="test-full-e2e"]').count() == 1
    assert page.locator('.recipe-graph-node[data-node-id="independent-acceptance"]').count() == 1

    page.locator('.tab[data-tab="agentSessions"]').click()
    session_run = page.locator('.agent-session-task', has_text="Validate recovery").locator('.agent-runtime-run')
    session_run.locator('summary').click()
    running_module = session_run.locator('.agent-runtime-node[data-node-id="browser-validation"]')
    assert running_module.locator('.agent-runtime-todo-owner').inner_text().startswith("Validate recovery")
    assert running_module.locator('.agent-module-health').inner_text().lower().startswith("healthy running")
    assert "Do not skip active work" in running_module.inner_text()
    running_module.focus()
    page.evaluate("renderAgentSessions()")
    page.wait_for_function("document.activeElement?.dataset?.nodeId === 'browser-validation'")
    assert page.evaluate("document.activeElement?.dataset?.nodeId") == "browser-validation"
    assert page.locator('.agent-runtime-run[data-run-id="recipe_run_demo_observable"]').get_attribute("open") is not None
    page.evaluate("selectedAgentSessionTodoId = ''")
    page.locator('.agent-session-task[data-todo-id="todo_validate"] > header').click()
    assert "selected" in (page.locator('.agent-session-task[data-todo-id="todo_validate"]').get_attribute("class") or "")
    assert "todo-selected" in (running_module.get_attribute("class") or "")
    page.locator('.agent-runtime-run[data-run-id="recipe_run_demo_observable"] button[title="Open full-screen Session graph"]').click()
    fullscreen = page.locator('.agent-session-fullscreen')
    fullscreen.wait_for()
    assert fullscreen.locator('.agent-session-unified-graph').count() == 1
    assert fullscreen.locator('.agent-session-unified-links').count() == 1
    assert fullscreen.locator('.agent-session-unified-session').count() == 1
    assert fullscreen.locator('.agent-session-unified-todo').count() == 2
    assert fullscreen.locator('.agent-session-unified-todo[data-todo-id="todo_design"]').count() == 1
    assert fullscreen.locator('.agent-session-unified-todo[data-todo-id="todo_validate"]').count() == 1
    assert fullscreen.locator('.agent-session-recipe-tree').count() == 1
    assert fullscreen.locator('.agent-session-recipe-subtree').count() == 2
    assert fullscreen.locator('.agent-session-recipe-subtree[data-recipe-group="todo_design"]').count() == 1
    assert fullscreen.locator('.agent-session-recipe-subtree[data-recipe-group="todo_validate"]').count() == 1
    assert fullscreen.locator('.agent-session-unified-node').count() == 6
    assert fullscreen.locator('.agent-session-unified-node[data-run-id="recipe_run_demo_design"]').count() == 2
    assert fullscreen.locator('.agent-session-unified-node[data-run-id="recipe_run_demo_observable"]').count() == 4
    tree_levels = fullscreen.locator('.agent-session-recipe-tree-canvas').evaluate("""tree => {
      const box = id => tree.querySelector(`[data-node-id="${id}"]`).getBoundingClientRect();
      const browser = box('browser-validation'), security = box('security-validation'), acceptance = box('acceptance');
      return {siblingTopDelta:Math.abs(browser.top - security.top), childGap:acceptance.top - Math.max(browser.bottom, security.bottom)};
    }""")
    assert tree_levels["siblingTopDelta"] <= 2, tree_levels
    assert tree_levels["childGap"] > 20, tree_levels
    if SCREENSHOT_PATH:
        screenshot_path = Path(SCREENSHOT_PATH)
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        fullscreen.screenshot(path=str(screenshot_path))
    assert fullscreen.locator('.agent-session-unified-todo[data-todo-id="todo_design"]').get_attribute("data-todo-status") == "succeeded"
    assert "running" in fullscreen.locator('.agent-session-recipe-subtree[data-recipe-group="todo_design"]').get_attribute("data-recipe-statuses").split()
    lane_geometry = fullscreen.locator('.agent-session-unified-graph').evaluate("""graph => {
      const todos = [...graph.querySelectorAll('.agent-session-unified-todo')];
      const treeRect = graph.querySelector('.agent-session-recipe-tree').getBoundingClientRect();
      return todos.map(todo => {
        const todoRect = todo.getBoundingClientRect();
        return {todoRight:todoRect.right, treeLeft:treeRect.left};
      });
    }""")
    assert all(item["todoRight"] < item["treeLeft"] for item in lane_geometry), lane_geometry
    fullscreen.locator('button[title="Zoom in"]').click()
    assert fullscreen.locator('[data-agent-session-zoom]').inner_text() == "110%"
    edge_geometry = fullscreen.locator('.agent-session-unified-graph').evaluate("""graph => {
      const cards = new Map([...graph.querySelectorAll('.agent-session-unified-node')]
        .map(card => [card.dataset.nodeKey, card]));
      const structural = [...graph.querySelectorAll('.agent-session-structure-edge')];
      const ownership = [...graph.querySelectorAll('.agent-session-ownership-edge')];
      const dependencies = [...graph.querySelectorAll('.agent-session-unified-edge')];
      const arrows = [...graph.querySelectorAll(':scope > .agent-graph-arrow')];
      return {structural:structural.length, ownership:ownership.length, dependencies:dependencies.length,
        arrows:arrows.map(arrow => {
        const source = cards.get(arrow.dataset.edgeSource), target = cards.get(arrow.dataset.edgeTarget);
        const arrowRect = arrow.getBoundingClientRect(), targetRect = target?.getBoundingClientRect();
        return {
          sourceExists:!!source, targetExists:!!target,
          centerDelta:targetRect ? Math.abs(arrowRect.left + arrowRect.width / 2 - (targetRect.left + targetRect.width / 2)) : 999,
          targetGap:targetRect ? targetRect.top - arrowRect.bottom : 999
        };
      })};
    }""")
    assert edge_geometry["structural"] == 2, edge_geometry
    assert edge_geometry["ownership"] == 2, edge_geometry
    assert edge_geometry["dependencies"] == len(edge_geometry["arrows"]) > 0, edge_geometry
    assert all(edge["sourceExists"] and edge["targetExists"] for edge in edge_geometry["arrows"]), edge_geometry
    assert all(edge["centerDelta"] <= 2 and 5 <= edge["targetGap"] <= 14 for edge in edge_geometry["arrows"]), edge_geometry
    fullscreen_module = fullscreen.locator('.agent-runtime-node[data-node-id="browser-validation"]')
    module_box = fullscreen_module.bounding_box()
    page.mouse.move(module_box["x"] + 40, module_box["y"] + 20)
    page.mouse.down()
    page.mouse.move(module_box["x"] + 100, module_box["y"] + 80, steps=6)
    page.mouse.up()
    assert "translate(60px,60px)" in fullscreen_module.get_attribute("style").replace(" ", "")
    page.evaluate("renderAgentSessions()")
    fullscreen = page.locator('.agent-session-fullscreen')
    assert "translate(60px,60px)" in fullscreen.locator('.agent-runtime-node[data-node-id="browser-validation"]').get_attribute("style").replace(" ", "")
    fullscreen.locator('button[title="Re-organize graph"]').click()
    assert "translate(0px,0px)" in page.locator('.agent-session-fullscreen .agent-runtime-node[data-node-id="browser-validation"]').get_attribute("style").replace(" ", "")
    fullscreen.locator('button[title="Close full-screen graph"]').click()
    assert page.locator('.agent-session-fullscreen').count() == 0

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile_errors = []
    mobile.on("pageerror", lambda error: mobile_errors.append(str(error)))
    open_recipe(mobile)
    assert mobile.locator('.workspace-separator').count() == 4
    assert_single_toolbar_row(mobile)
    assert not errors, f"Desktop page errors: {errors}"
    assert not mobile_errors, f"Mobile page errors: {mobile_errors}"
    browser.close()

print("Recipe browser UI tests passed")
