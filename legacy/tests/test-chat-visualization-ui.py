import json
import subprocess
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class ChatVisualizationTests(unittest.TestCase):
    def test_visualization_opens_window_directly_without_inline_panel_or_draft_changes(self):
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
                        expect(page.locator("#visualization-panel")).to_have_count(0)
                        expect(page.locator("#messages")).to_be_visible()
                        self.assertEqual(page.evaluate("window.__posts.filter(p=>p.type==='openVisualizationWindow').map(p=>p.chatId)"), [state["chat"]["id"]])
                        expect(page.locator("#prompt")).to_have_value("Keep my intervention draft")
                        self.assertFalse(page.evaluate("window.__posts.some(p=>p.type==='visualizationRequest')"))
                        self.assertFalse(page.evaluate("window.__posts.some(p=>p.type==='send'||p.type==='startTask')"))
                        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        page.evaluate("""() => {
                            const state=structuredClone(window.__state);state.chat.id='chat-b';
                            window.dispatchEvent(new MessageEvent('message',{data:state}));
                        }""")
                        button.click()
                        self.assertEqual(page.evaluate("window.__posts.filter(p=>p.type==='openVisualizationWindow').at(-1).chatId"), "chat-b")
                        expect(page.locator(".pkm-harness")).to_have_count(0)
                        page.evaluate("""() => {
                            const state=structuredClone(window.__state);state.chat=undefined;
                            window.dispatchEvent(new MessageEvent('message',{data:state}));
                        }""")
                        expect(page.locator("#visualization")).to_be_disabled()
                        self.assertEqual(failures, [])
                        page.close()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
