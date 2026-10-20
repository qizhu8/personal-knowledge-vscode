import json
import subprocess
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class ChatVisualizationTests(unittest.TestCase):
    def test_inline_graph_drilldown_steering_errors_and_chat_isolation(self):
        assets = ROOT / "dist" / "webview"
        values = {
            "nonce": "fixture", "cspSource": "'self'", "styles": "api-chat.css",
            "script": "api-chat.js", "icons": "codicon.css", "marked": "marked.umd.js",
            "purify": "purify.min.js", "libraryScript": "api-chat-library.js",
            "retrievalScript": "chat-retrieval-flow.js", "hostHealthScript": "host-health.js",
            "hostHealthStyles": "host-health.css", "harnessScript": "agent-harness.js",
            "harnessStyles": "agent-harness.css", "visualizationScript": "chat-visualization.js",
            "katex": "katex.js", "katexStyles": "katex.css", "mermaid": "mermaid.js",
        }
        html = (assets / "api-chat.html").read_text()
        for key, value in values.items():
            html = html.replace("{{" + key + "}}", value)
        self.assertNotIn("{{", html)
        snapshot = json.loads(subprocess.check_output(
            ["node", "-e", "console.log(JSON.stringify(require('./tests/native-harness-fixture').fixture()))"],
            cwd=ROOT, text=True))
        state = {
            "type": "state", "busy": True, "approvals": [], "chats": [], "tools": [], "toolGroups": [],
            "library": {"groups": [], "chats": [{"id": "chat-a", "title": "Fixture", "status": "running"}]},
            "chat": {"id": "chat-a", "title": "Fixture", "context": [], "permissionMode": "ask",
                     "messages": [{"id": "reply", "role": "assistant", "content": "Public progress explanation.", "status": "streaming"}],
                     "includeHistory": True},
            "settings": {"provider": "vscode", "maxToolRounds": 30, "contextWindow": 8192, "maxOutputTokens": 1024,
                         "selectedProfile": {"id": "fixture", "label": "Fixture", "model": "fixture",
                                             "status": "active", "contextWindow": 8192, "maxOutputTokens": 1024}},
        }
        def serve(route):
            name = urlsplit(route.request.url).path.lstrip("/")
            if not name:
                route.fulfill(body=html, content_type="text/html")
            elif (assets / name).is_file():
                route.fulfill(path=str(assets / name), content_type={
                    ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf",
                }.get(Path(name).suffix, "application/octet-stream"))
            else:
                route.fulfill(status=404)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in (1280, 390):
                    with self.subTest(width=width):
                        page = browser.new_page(viewport={"width": width, "height": 900})
                        failures = []
                        page.on("pageerror", lambda error: failures.append(str(error)))
                        page.add_init_script("""
                            window.__posts=[];window.__reply=true;
                            window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:message=>{
                                window.__posts.push(message);
                                if(message.type==='hostHealth')window.dispatchEvent(new MessageEvent('message',{data:message}));
                                if(message.type==='visualizationRequest' && window.__reply)queueMicrotask(()=>window.dispatchEvent(
                                    new MessageEvent('message',{data:{type:'visualizationResult',requestId:message.requestId,
                                        chatId:message.chatId,data:window.__snapshot,error:window.__error}})));
                            }});
                        """)
                        page.route("http://chat.test/**", serve)
                        page.goto("http://chat.test/")
                        page.evaluate("data=>{window.__snapshot=data.snapshot;window.__state=data.state;window.dispatchEvent(new MessageEvent('message',{data:data.state}));window.dispatchEvent(new MessageEvent('message',{data:{type:'showChat'}}));}",
                                      {"snapshot": snapshot, "state": state})
                        button = page.get_by_role("button", name="Visualization", exact=True)
                        self.assertEqual(button.evaluate("node=>node.previousElementSibling.id"), "memory")
                        page.locator("#prompt").fill("Keep my intervention draft")
                        button.click()
                        panel = page.locator("#visualization-panel")
                        expect(panel).to_be_visible()
                        expect(page.locator("#messages")).to_be_visible()
                        expect(panel.get_by_role("group", name="Harness lifecycle").locator('[aria-current="step"]')).to_have_attribute("data-stage", "run")
                        panel.get_by_role("button", name="Current execution", exact=True).click()
                        expect(panel.locator(".pkm-harness-inspector")).to_contain_text("Inspect evidence")
                        expect(button).to_have_attribute("aria-expanded", "true")
                        panel.get_by_role("button", name="Open in Visualization window", exact=True).click()
                        self.assertEqual(page.evaluate("window.__posts.filter(p=>p.type==='openVisualizationWindow').map(p=>p.chatId)"), [state["chat"]["id"]])
                        expect(panel).to_be_visible()
                        panel.get_by_role("navigation", name="Graph ancestors").get_by_role("button", name=snapshot["task"], exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: Implement and validate", exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: Development", exact=True).click()
                        panel.get_by_role("button", name="Recipe: Nested debug", exact=True).click()
                        expect(panel.locator("dialog")).to_contain_text("Pinned nested debug v2")
                        panel.get_by_role("button", name="Close preview", exact=True).click()
                        panel.get_by_role("button", name="Back to parent", exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: Fix the failing test", exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: Attempt 2", exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: 1 recorded calls", exact=True).click()
                        panel.get_by_role("button", name="mcp_action_call", exact=True).click()
                        expect(panel.locator(".pkm-harness-inspector")).to_contain_text('{"dryRun":true}')
                        panel.get_by_role("button", name="Open subgraph: mcp_action_call", exact=True).click()
                        panel.get_by_role("button", name="Open subgraph: fixture.script", exact=True).click()
                        expect(panel.locator(".pkm-harness-viewport")).to_contain_text("Durable Action receipts")
                        page.get_by_role("button", name="Steer current task", exact=True).click()
                        expect(page.locator("#prompt")).to_be_focused()
                        expect(page.locator("#prompt")).to_have_value("Keep my intervention draft")
                        expect(page.locator("#steer-mode")).to_have_attribute("aria-checked", "true")
                        self.assertFalse(page.evaluate("window.__posts.some(p=>p.type==='send'||p.type==='startTask')"))
                        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        page.get_by_role("button", name="Close visualization", exact=True).click()
                        expect(button).to_be_focused()
                        page.evaluate("window.__error='Fixture access denied'")
                        button.click()
                        expect(panel.get_by_role("alert")).to_have_text("Fixture access denied")
                        button.click()
                        page.evaluate("window.__reply=false;window.__error=undefined")
                        button.click()
                        request = page.evaluate("window.__posts.filter(p=>p.type==='visualizationRequest').at(-1)")
                        page.evaluate("""() => {
                            const state=structuredClone(window.__state);state.chat.id='chat-b';
                            window.dispatchEvent(new MessageEvent('message',{data:state}));
                        }""")
                        expect(panel).to_be_hidden()
                        page.evaluate("request=>window.dispatchEvent(new MessageEvent('message',{data:{type:'visualizationResult',requestId:request.requestId,chatId:request.chatId,data:window.__snapshot}}))", request)
                        expect(panel.locator(".pkm-harness")).to_have_count(0)
                        self.assertEqual(failures, [])
                        page.close()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
