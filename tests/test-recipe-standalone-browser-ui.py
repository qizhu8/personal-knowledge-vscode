#!/usr/bin/env python3
import base64
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright


recipe = {
    "recipeId": "recipe_browser_e2e", "scope": "global", "category": "Examples",
    "name": "Browser E2E", "description": "Editable Recipe", "revision": 1,
    "executableDigest": "digest-1", "nodeBindings": [],
    "metadata": {"applicableFunctions": [], "solution": "", "requiredInputs": [], "expectedOutputs": []},
    "methodology": {
        "schema": "pkm.recipe.methodology/v1", "family": "validation-and-testing", "phase": "validate",
        "abstract": False, "mixins": [], "capabilities": ["adaptive-test-selection"],
        "artifacts": {"inputs": ["task-contract"], "outputs": ["evidence-bundle"]},
        "gates": ["independent-acceptance-gate"], "invariants": ["coverage-is-not-acceptance"],
        "expansion": {"mode": "adaptive", "signals": ["risk"]},
        "communication": {"minimumAssurance": "structured-acknowledgement", "escalateOn": ["risk"]},
        "retrieval": {
            "intents": ["validate a feature end to end"], "terminology": ["test matrix"],
            "operationalPoints": ["ui", "security", "simulation"],
        },
    },
    "methodologyDigest": "methodology-digest",
    "editorLayout": {"nodePositions": {}},
    "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
        "inputs": {}, "outputs": {}, "completion": {"requiredNodes": ["finish"]},
        "nodes": [
            {"nodeId": "prepare", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [], "ports": {"inputs": [], "outputs": ["completion"]}, "control": {"mode": "single"}, "generalInstruction": "Prepare"},
            {"nodeId": "finish", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [{"from": "prepare", "accept": ["succeeded"], "required": True}], "ports": {"inputs": ["dependency"], "outputs": ["completion"]}, "control": {"mode": "single"}, "generalInstruction": "Finish"},
        ],
    }},
}

generator = "const fs=require('fs');const {recipeBrowserEditorDocument}=require('./dist/recipe-browser.js');process.stdout.write(recipeBrowserEditorDocument(JSON.parse(fs.readFileSync(0,'utf8'))));"


def red_pixels_near_arrow(page, selector):
    endpoint = page.locator(selector).first.evaluate("""path => {
        const rect = path.getBoundingClientRect(), svgRect = (path.ownerSVGElement || path.parentElement).getBoundingClientRect(), style = getComputedStyle(path);
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
            pathRect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height},
            svgRect: {left: svgRect.left, top: svgRect.top, width: svgRect.width, height: svgRect.height},
            style: {background: style.backgroundColor, fill: style.fill, stroke: style.stroke, opacity: style.opacity, visibility: style.visibility, display: style.display}};
    }""")
    screenshot = base64.b64encode(page.screenshot()).decode("ascii")
    return page.evaluate("""async ({screenshot, endpoint}) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + screenshot; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const x = Math.max(0, Math.round(endpoint.x) - 9), y = Math.max(0, Math.round(endpoint.y) - 9);
        const pixels = context.getImageData(x, y, 19, 19).data, colors = new Map(); let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] > 170 && pixels[index + 1] < 130 && pixels[index + 2] < 130 && pixels[index + 3] > 180) count++;
            const color = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]].join(',');
            colors.set(color, (colors.get(color) || 0) + 1);
        }
        return {count, endpoint, image:{width:image.width,height:image.height}, colors:[...colors].sort((a,b)=>b[1]-a[1]).slice(0,8)};
    }""", {"screenshot": screenshot, "endpoint": endpoint})
html = subprocess.run(["node", "-e", generator], input=json.dumps(recipe), text=True, capture_output=True, check=True).stdout.encode()
saved = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write(html)

    def do_POST(self):
        payload = self.read_json(); definition = payload["definition"]
        self.send_json({"definition": definition, "nodeCount": len(definition["spec"]["nodes"]), "executableDigest": "validated"})

    def do_PUT(self):
        payload = self.read_json(); saved.append(payload); payload["revision"] += 1; payload["executableDigest"] = "saved"
        self.send_json({"recipe": payload})

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

    def send_json(self, value):
        body = json.dumps(value).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1360, "height": 900})
        errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"http://127.0.0.1:{server.server_port}", wait_until="networkidle")
        workbench_geometry = page.locator("main.workbench").evaluate("""element => {
            const rect = element.getBoundingClientRect(), graph = document.querySelector('.graph-viewport').getBoundingClientRect();
            return {left:rect.left, width:rect.width, bottom:rect.bottom, graphHeight:graph.height};
        }""")
        assert workbench_geometry["left"] == 0, workbench_geometry
        assert workbench_geometry["width"] == 1360, workbench_geometry
        assert workbench_geometry["bottom"] == 900, workbench_geometry
        assert workbench_geometry["graphHeight"] > 700, workbench_geometry
        assert page.locator('[data-methodology-view="pyramid"]').is_visible()
        assert page.locator('[data-methodology-view="composition"]').is_visible()
        assert page.locator('[data-methodology-view="evidence"]').is_visible()
        assert page.locator('[data-methodology-view="retrieval"]').is_visible()
        assert page.locator("#methodology").get_by_text("coverage-is-not-acceptance").is_visible()
        assert page.locator("#methodology").get_by_text("security").is_visible()
        save_button = page.locator("#save")
        assert save_button.is_disabled(), "Save must start disabled for an unchanged Recipe"
        page.locator("#name").fill("Browser E2E changed")
        assert save_button.is_enabled(), "Editing Recipe metadata must enable Save"
        page.locator("#name").fill("Browser E2E")
        assert save_button.is_disabled(), "Reverting the only draft change must disable Save"
        assert page.locator(".graph-node").count() == 2
        assert page.locator(".boundary.source").inner_text() == "Input"
        assert page.locator(".boundary.sink").inner_text() == "Output"
        assert page.locator(".graph-links > path").count() == 4
        assert page.locator(".graph-arrow-head").count() == 3
        assert page.locator(".graph-links > .input-edge").count() == 1
        assert page.locator(".graph-links > .edge-visible").count() == 1
        assert page.locator(".graph-links > .edge-hit").count() == 1
        assert page.locator(".graph-links > .output-edge").count() == 1
        first_two = page.locator(".graph-node").evaluate_all("""nodes => nodes.slice(0, 2).map(node => {
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
        assert page.locator(".selection-marquee").count() == 0, "Plain drag must not start marquee selection"
        page.mouse.up()
        page.keyboard.down("Shift")
        page.mouse.move(selection_box["left"], selection_box["top"])
        page.mouse.down()
        page.mouse.move(selection_box["right"], selection_box["bottom"], steps=4)
        assert page.locator(".selection-marquee").count() == 1
        page.mouse.up()
        page.keyboard.up("Shift")
        assert page.locator(".graph-node.selected").count() == 2
        assert page.locator(".edge-visible.selected").count() == 1
        page.locator(".graph-node").first.locator("header").click(position={"x": 50, "y": 20})
        assert page.locator(".graph-node.selected").count() == 1
        selected_style = page.locator(".graph-node.selected").evaluate(
            "node => ({outline:getComputedStyle(node).outlineWidth, border:getComputedStyle(node).borderColor})"
        )
        assert selected_style["outline"] == "3px", selected_style
        canvas = page.locator(".graph-canvas")
        blank_point = canvas.evaluate("""canvas => {
            const rect = canvas.getBoundingClientRect();
            for (let y=Math.max(1,rect.top+8); y<Math.min(innerHeight-1,rect.bottom-8); y+=12)
                for (let x=Math.max(1,rect.left+8); x<Math.min(innerWidth-1,rect.right-8); x+=12) {
                    const target=document.elementFromPoint(x,y);
                    if (target===canvas || target?.matches?.('.graph-links')) return {x,y};
                }
            throw new Error('No visible blank graph point');
        }""")
        page.mouse.click(blank_point["x"], blank_point["y"])
        assert page.locator(".graph-node.selected").count() == 0
        assert page.locator(".edge-visible.selected").count() == 0
        assert page.locator(".edge-actions").count() == 0
        positions = page.locator(".graph-node").evaluate_all(
            "nodes => Object.fromEntries(nodes.map(node => [node.dataset.nodeId, {left: node.offsetLeft, top: node.offsetTop}]))"
        )
        assert positions["finish"]["top"] - positions["prepare"]["top"] == 114, positions
        connection_direction = page.locator(".edge-visible").first.evaluate("""path => {
            const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
            return {startY:start.y, endY:end.y};
        }""")
        assert connection_direction["startY"] < connection_direction["endY"], connection_direction
        arrow_style = page.locator(".graph-arrow-head").first.evaluate(
            "element => ({background: getComputedStyle(element).backgroundColor})"
        )
        assert arrow_style["background"] == "rgb(226, 85, 85)", arrow_style
        arrow_pixels = red_pixels_near_arrow(page, ".graph-arrow-head")
        assert arrow_pixels["count"] >= 3, arrow_pixels
        source = page.locator(".boundary.source")
        source_box = source.bounding_box()
        page.mouse.move(source_box["x"] + 20, source_box["y"] + 15)
        page.mouse.down()
        page.mouse.move(source_box["x"] + 100, source_box["y"] + 500, steps=8)
        page.mouse.up()
        source_constraint = page.locator(".graph-canvas").evaluate("""canvas => {
            const source = canvas.querySelector('.boundary.source'), modules = [...canvas.querySelectorAll('.graph-node')];
            return {sourceRight:source.offsetLeft + source.offsetWidth, sourceBottom:source.offsetTop + source.offsetHeight,
                minimumModuleTop:Math.min(...modules.map(node => node.offsetTop))};
        }""")
        assert source_constraint["sourceBottom"] < source_constraint["minimumModuleTop"], source_constraint
        assert source_constraint["sourceRight"] > 100, source_constraint

        sink = page.locator(".boundary.sink")
        sink_box = sink.bounding_box()
        page.mouse.move(sink_box["x"] + 20, sink_box["y"] + 15)
        page.mouse.down()
        page.mouse.move(sink_box["x"] + 100, sink_box["y"] - 500, steps=8)
        page.mouse.up()
        sink_constraint = page.locator(".graph-canvas").evaluate("""canvas => {
            const sink = canvas.querySelector('.boundary.sink'), modules = [...canvas.querySelectorAll('.graph-node')];
            return {sinkTop:sink.offsetTop, maximumModuleBottom:Math.max(...modules.map(node => node.offsetTop + node.offsetHeight))};
        }""")
        assert sink_constraint["sinkTop"] > sink_constraint["maximumModuleBottom"], sink_constraint
        constrained_sink_top = sink_constraint["sinkTop"]
        sink_box = sink.bounding_box()
        page.mouse.move(sink_box["x"] + 20, sink_box["y"] + 15)
        page.mouse.down()
        page.mouse.move(sink_box["x"] + 20, sink_box["y"] + 120, steps=8)
        page.mouse.up()
        assert sink.evaluate("node => node.offsetTop") > constrained_sink_top
        assert page.evaluate("recipe.editorLayout.boundaryPositions.input.x > 20 && recipe.editorLayout.boundaryPositions.output.y > 0")

        edge_point = page.locator(".edge-hit").first.evaluate("""path => {
            const point = path.getPointAtLength(path.getTotalLength() / 2);
            const matrix = path.getScreenCTM();
            return {x:matrix.a * point.x + matrix.c * point.y + matrix.e,
                    y:matrix.b * point.x + matrix.d * point.y + matrix.f};
        }""")
        page.mouse.click(edge_point["x"], edge_point["y"])
        hit_target = page.evaluate("""({x,y}) => {
            const target = document.elementFromPoint(x,y);
            const path = document.querySelector('.edge-hit');
            return {tag:target?.tagName, classes:target?.getAttribute?.('class'), source:target?.dataset?.source, target:target?.dataset?.target,
                path:path?.getAttribute('d'), pathRect:path?.getBoundingClientRect().toJSON(),
                svgRect:path?.ownerSVGElement?.getBoundingClientRect().toJSON(),
                cards:[...document.querySelectorAll('.graph-node')].map(node => ({id:node.dataset.nodeId,rect:node.getBoundingClientRect().toJSON()}))};
        }""", edge_point)
        assert page.locator(".edge-visible.selected").count() == 1, {"point": edge_point, "target": hit_target}
        page.locator("#delete-edge").click()
        assert page.locator(".edge-visible").count() == 0
        page.locator("#cancel").click()
        assert page.locator(".edge-visible").count() == 1

        prepare_header = page.locator('.graph-node[data-node-id="prepare"] header')
        box = prepare_header.bounding_box()
        page.mouse.move(box["x"] + 30, box["y"] + 20)
        page.mouse.down()
        page.mouse.move(box["x"] + 30, box["y"] + 360, steps=8)
        page.mouse.up()
        output_reflow = page.locator(".graph-canvas").evaluate("""canvas => {
            const moved = canvas.querySelector('[data-node-id="prepare"]'), output = canvas.querySelector('.boundary.sink');
            return {movedBottom:moved.offsetTop + moved.offsetHeight, outputTop:output.offsetTop};
        }""")
        assert output_reflow["outputTop"] > output_reflow["movedBottom"], output_reflow

        page.locator("#reorganize").click()
        reorganized = page.locator(".graph-node").evaluate_all(
            "nodes => Object.fromEntries(nodes.map(node => [node.dataset.nodeId, node.offsetTop]))"
        )
        assert reorganized["prepare"] < reorganized["finish"], reorganized

        boundary_edges_before_create = page.locator(".graph-links > .boundary-edge").count()
        page.locator("#add-node").click()
        assert page.locator("#create-module-title").inner_text() == "Add Module"
        page.locator("#create-module-type").select_option("single")
        page.locator("#create-module-confirm").click()
        assert page.locator("#create-module-error").inner_text() == "Use a stable ID beginning with a letter."
        assert page.locator("#create-module-title").count() == 1, "Invalid Module ID must keep the dialog open"
        page.locator("#create-module-id").fill("browser-module")
        page.locator("#create-module-confirm").click()
        page.locator("#node-instruction").fill("New browser-created module")
        page.locator("#editor-done").click()
        created_id = page.locator(".graph-node").last.get_attribute("data-node-id")
        created = page.locator(f'.graph-node[data-node-id="{created_id}"]')
        assert "selected" in created.get_attribute("class")
        assert save_button.is_enabled(), "Adding a Module must enable Save"
        assert "invalid" in created.get_attribute("class")
        assert created.get_attribute("aria-invalid") == "true"
        assert page.locator(".graph-links > .boundary-edge").count() == boundary_edges_before_create
        page.locator('.graph-node[data-node-id="prepare"] .port-handle.output').click()
        page.locator(f'.graph-node[data-node-id="{created_id}"] .port-handle.input').click()
        assert "invalid" not in created.get_attribute("class")
        assert page.locator(".graph-links > .edge-visible").count() == 2

        page.locator('[data-edit="finish"]').click()
        page.locator('[data-editor-tab="parameters"]').click()
        page.locator("#node-mode").select_option("branch")
        page.locator("#editor-done").click()
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator('.graph-node[data-node-id="finish"] .port-handle.output').click()
        page.locator('.graph-node[data-node-id="prepare"] .port-handle.input').click()
        loop_hit = page.locator(".edge-hit.loop-edge")
        assert loop_hit.count() == 1
        assert "while-if / if-while" in loop_hit.get_attribute("aria-label")
        widths = page.locator(".graph-canvas").evaluate("""canvas => ({
            normal:getComputedStyle(canvas.querySelector('.edge-visible:not(.loop-edge)')).strokeWidth,
            loop:getComputedStyle(canvas.querySelector('.edge-visible.loop-edge')).strokeWidth
        })""")
        assert float(widths["loop"].replace("px", "")) > float(widths["normal"].replace("px", "")), widths
        loop_hit.focus()
        page.keyboard.press("Enter")
        assert page.locator("#delete-edge").count() == 1
        page.locator("#delete-edge").click()
        deletion_state = page.evaluate("() => ({selectedEdge, dependencies:nodes().map(node => [node.nodeId,node.dependsOn])})")
        assert page.locator(".edge-hit.loop-edge").count() == 0, deletion_state

        page.locator('[data-edit="finish"]').click()
        page.locator('[data-editor-tab="parameters"]').click()
        page.locator("#node-mode").select_option("repeat")
        page.locator("#editor-done").click()
        repeat = page.locator('.graph-node[data-node-id="finish"]')
        assert "mode-repeat" in repeat.get_attribute("class")
        assert repeat.locator(".repeat-badge").inner_text() == "x2"
        assert repeat.evaluate("node => getComputedStyle(node).backgroundColor") == "rgba(0, 0, 0, 0)"

        page.locator("#name").fill("Discard me")
        page.locator("#cancel").click()
        assert page.locator("#name").input_value() == "Browser E2E"
        assert page.locator(".graph-node").count() == 2
        assert page.locator(".repeat-badge").count() == 0

        base_module_count = page.locator(".graph-node").count()
        page.locator(".graph-node").first.locator("header").click(position={"x": 50, "y": 20})
        page.keyboard.press("Delete")
        assert page.locator(".graph-node").count() == base_module_count - 1
        page.keyboard.press("Control+Z")
        assert page.locator(".graph-node").count() == base_module_count
        page.keyboard.press("Control+Y")
        assert page.locator(".graph-node").count() == base_module_count - 1
        page.keyboard.press("Control+Z")
        page.locator(".graph-node").first.locator("header").click(position={"x": 50, "y": 20})
        page.keyboard.press("Control+C")
        page.keyboard.press("Control+V")
        assert page.locator(".graph-node").count() == base_module_count + 1
        assert page.locator('.graph-node[data-node-id$="-copy"]').count() == 1
        page.keyboard.press("Control+X")
        assert page.locator(".graph-node").count() == base_module_count
        page.keyboard.press("Control+Z")
        assert page.locator(".graph-node").count() == base_module_count + 1
        page.keyboard.press("Control+Shift+Z")
        assert page.locator(".graph-node").count() == base_module_count
        page.locator("#cancel").click()
        assert page.locator(".graph-node").count() == base_module_count

        page.locator('[data-edit="finish"]').click()
        page.locator("#node-instruction").fill("Finish with verified evidence")
        page.locator('[data-editor-tab="parameters"]').click()
        page.locator("#node-mode").select_option("branch")
        page.locator('[data-editor-tab="references"]').click()
        page.locator("#ref-add").click()
        page.locator('[data-ref-id="0"]').fill("Coding/Testing")
        page.locator('[data-ref-usage="0"]').select_option("required")
        page.locator("#editor-done").click()

        page.locator("#add-node").click()
        page.locator("#create-module-type").select_option("single")
        page.locator("#create-module-id").fill("browser-module")
        page.locator("#create-module-confirm").click()
        page.locator("#node-instruction").fill("New browser-created module")
        page.locator("#editor-done").click()
        assert page.locator(".graph-node").count() == 3
        assert page.locator('.graph-node[data-node-id="browser-module"].invalid').count() == 1
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#save").click()
        assert not saved
        assert "Connect highlighted Modules before saving" in page.locator("#status").inner_text()
        page.locator('.graph-node[data-node-id="finish"] .port-handle.output').click()
        page.locator('.graph-node[data-node-id="browser-module"] .port-handle.input').click()
        assert page.locator('.graph-node[data-node-id="browser-module"].invalid').count() == 0
        page.locator("#save").click()
        page.get_by_text("Saved", exact=True).wait_for()
        assert not errors, errors
        browser.close()
finally:
    server.shutdown(); server.server_close()

assert len(saved) == 1
finish = next(node for node in saved[0]["definition"]["spec"]["nodes"] if node["nodeId"] == "finish")
assert finish["generalInstruction"] == "Finish with verified evidence"
assert finish["control"]["mode"] == "branch"
assert saved[0]["nodeBindings"] == [{"nodeId": "finish", "bindings": [{"kind": "skill", "knowledgeId": "Coding/Testing", "usage": "required"}]}]
assert any(node["generalInstruction"] == "New browser-created module" for node in saved[0]["definition"]["spec"]["nodes"])
print("Standalone Recipe browser UI tests passed")