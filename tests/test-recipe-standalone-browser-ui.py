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
        assert page.locator(".graph-node").count() == 2
        assert page.locator(".boundary.source").inner_text() == "Input"
        assert page.locator(".boundary.sink").inner_text() == "Output"
        assert page.locator(".graph-links > path").count() == 3
        assert page.locator(".graph-arrow-head").count() == 3
        assert page.locator(".graph-links > .input-edge").count() == 1
        assert page.locator(".graph-links > .module-edge").count() == 1
        assert page.locator(".graph-links > .output-edge").count() == 1
        positions = page.locator(".graph-node").evaluate_all(
            "nodes => Object.fromEntries(nodes.map(node => [node.dataset.nodeId, {left: node.offsetLeft, top: node.offsetTop}]))"
        )
        assert positions["finish"]["top"] - positions["prepare"]["top"] == 118, positions
        arrow_style = page.locator(".graph-arrow-head").first.evaluate(
            "element => ({background: getComputedStyle(element).backgroundColor})"
        )
        assert arrow_style["background"] == "rgb(226, 85, 85)", arrow_style
        arrow_pixels = red_pixels_near_arrow(page, ".graph-arrow-head")
        assert arrow_pixels["count"] >= 3, arrow_pixels

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
        page.locator("#node-instruction").fill("New browser-created module")
        page.locator("#editor-done").click()
        assert page.locator(".graph-node").count() == 3
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