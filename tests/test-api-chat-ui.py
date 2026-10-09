import json
import tempfile
import time
import unittest
from urllib.parse import urlparse
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent


class ChatUiTests(unittest.TestCase):
    def test_panel_host_connection_warning(self):
        assets = ROOT / 'dist' / 'webview'
        html = (assets / 'panel.html').read_text(encoding='utf-8')
        for token, asset in {'PANEL_JS': 'panel.js', 'PANEL_CSS': 'panel.css', 'CODICON_CSS': 'codicon.css',
                             'HOST_HEALTH_JS': 'host-health.js', 'HOST_HEALTH_CSS': 'host-health.css',
                             'MARKED_SRC': 'marked.umd.js', 'HLJS_SRC': 'hljs.js', 'HLJS_CSS': 'hljs.css',
                             'KATEX_SRC': 'katex.js', 'KATEX_CSS': 'katex.css'}.items():
            html = html.replace('%%' + token + '%%', asset)
        html = html.replace('%%CSP_SOURCE%%', "'self'")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in (1280, 390, 320):
                    page = browser.new_page(viewport={'width': width, 'height': 844})
                    page.clock.install()
                    page.add_init_script("window.__posts=[];window.acquireVsCodeApi=()=>({getState:()=>({tab:'notes'}),setState:()=>{},postMessage:value=>window.__posts.push(value)});")
                    def route(request):
                        name = Path(urlparse(request.request.url).path).name
                        if name == 'index.html':
                            request.fulfill(body=html, content_type='text/html')
                        elif (assets / name).is_file():
                            request.fulfill(path=str(assets / name))
                        else:
                            request.fulfill(status=404, body='Not found')
                    page.route('http://panel.test/**', route)
                    page.goto('http://panel.test/index.html')
                    page.clock.fast_forward(15_000)
                    warning = page.locator('#pkm-host-warning')
                    expect(warning).to_contain_text('PKM failed to load')
                    geometry = warning.bounding_box()
                    self.assertAlmostEqual(geometry['x'] + geometry['width'], width - 8, delta=1)
                    self.assertAlmostEqual(geometry['y'], 8, delta=1)
                    self.assertGreaterEqual(geometry['x'], 0)
                    self.assertTrue(warning.locator('span:not(.codicon)').evaluate('node=>node.scrollWidth<=node.clientWidth'))
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{command:'loadingProgress',data:{stage:'ready'}}}))")
                    expect(warning).to_be_hidden()
                    page.clock.fast_forward(20_000)
                    expect(warning).to_contain_text('Extension Host is not responding')
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:window.__posts.filter(message=>message.command==='hostHealth').at(-1)}))")
                    expect(warning).to_be_hidden()
                    page.close()
            finally:
                browser.close()

    def test_popovers_model_acknowledgement_and_single_activity(self):
        assets = ROOT / "dist" / "webview"
        page_html = (assets / "api-chat.html").read_text()
        replacements = {
            "nonce": "isolated-chat-ui", "cspSource": "https://chat.test",
            "styles": "api-chat.css", "script": "api-chat.js", "icons": "codicon.css",
            "marked": "marked.umd.js", "purify": "purify.min.js",
            "libraryScript": "api-chat-library.js", "retrievalScript": "chat-retrieval-flow.js",
            "hostHealthScript": "host-health.js", "hostHealthStyles": "host-health.css",
        }
        for key, value in replacements.items():
            page_html = page_html.replace("{{" + key + "}}", value)
        started = int(time.time() * 1000) - 5000
        chat_url = "pkm://chats/0123456789abcdef/816fcfcc-05f3-4506-9b10-eeb09efbafd2"
        progress = {"attemptId": "fixture", "startedAt": started, "status": "running", "model": "fixture", "steps": [
            {"label": "Preparing context", "at": started, "status": "complete"},
            {"label": "Completed tool: read_file", "at": started + 100, "status": "complete"},
            {"label": "Waiting for tool-loop decision", "at": started + 200, "status": "waiting"},
        ]}
        fixture = {"type": "state", "busy": True, "approvals": [], "chats": [], "tools": [], "toolGroups": [],
            "library": {"groups": [], "chats": [{"id": "chat_fixture", "title": "Chat UI", "status": "running", "groupId": "ungroup"}]},
            "chat": {"id": "chat_fixture", "title": "Chat UI", "context": [], "permissionMode": "allow-all", "permissionGrants": [],
                "messages": [{"id": "reply", "role": "assistant", "content": f"Partial result\n\n[Chat link]({chat_url}) [Unsafe link](javascript:alert(1)) [File link](file:///tmp/private) [External link](https://example.com)", "status": "streaming", "progress": progress,
                    "toolCalls": [{"id": "read", "name": "read_file", "arguments": "{}", "result": "retained result", "status": "complete"}]}],
                "progress": progress, "includeHistory": True},
            "settings": {"provider": "vscode", "maxToolRounds": 30, "contextWindow": 8192, "maxOutputTokens": 1024,
                "selectedProfile": {"id": "fixture", "model": "fixture", "label": "Fixture", "status": "active", "contextWindow": 8192, "maxOutputTokens": 1024}}}

        def serve(route):
            name = Path(urlsplit(route.request.url).path).name
            if not name:
                route.fulfill(content_type="text/html", body=page_html)
            elif (assets / name).is_file():
                suffix = Path(name).suffix
                content_type = {".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf"}.get(suffix, "application/octet-stream")
                route.fulfill(content_type=content_type, body=(assets / name).read_bytes())
            else:
                route.fulfill(status=404, body="missing fixture asset")

        with tempfile.TemporaryDirectory(prefix="pkm-chat-ui-") as screenshots, sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in [1280, 390]:
                    with self.subTest(width=width):
                        page = browser.new_page(viewport={"width": width, "height": 800})
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.clock.install()
                        page.route("https://chat.test/**", serve)
                        page.add_init_script("window.__posts=[];window.acquireVsCodeApi=()=>({getState:()=>({screen:'chat'}),setState:()=>{},postMessage:value=>window.__posts.push(value)});")
                        page.goto("https://chat.test/")
                        page.wait_for_function("window.__posts.some(message=>message.type==='ready')")
                        expect(page.get_by_role('progressbar', name='Loading PKM Chat')).to_be_visible()
                        self.assertTrue(page.evaluate('window.PkmHostHealth.unavailable'))
                        page.locator('#composer').evaluate("node=>node.requestSubmit()")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), 0)
                        page.clock.fast_forward(15_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('PKM failed to load')
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        expect(page.locator('#copy-chat-id')).to_have_attribute('aria-label', 'Copy PKM URL')
                        banner = page.locator('#pkm-host-warning').bounding_box()
                        self.assertAlmostEqual(banner['x'] + banner['width'], width - 8, delta=1)
                        self.assertGreaterEqual(banner['x'], 0)
                        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                        page.get_by_role('button', name='Reconnect to Extension Host').click()
                        expect(page.locator('#pkm-chat-loading')).to_be_visible()
                        page.clock.fast_forward(10_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('Reconnecting to Extension Host')
                        expect(page.locator('#pkm-chat-loading')).to_be_visible()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        expect(page.locator('#library-view')).to_be_visible()
                        expect(page.locator('#messages .message')).to_have_count(0)
                        expect(page.locator('#chat-list .chat-status-indicator')).to_have_attribute('aria-label', 'Running')
                        page.get_by_role('button', name='Chat actions', exact=True).click()
                        page.get_by_role('menuitem', name='Rename chat', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='rename'&&message.id==='chat_fixture')"))
                        expect(page.locator('#library-view')).to_be_visible()
                        waiting = {**fixture, 'library': {'groups': [], 'chats': [{**fixture['library']['chats'][0], 'status': 'awaiting-input'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", waiting)
                        expect(page.locator('#chat-list .chat-status-indicator')).to_have_attribute('aria-label', 'Waiting for Input')
                        expect(page.locator('#messages .message')).to_have_count(0)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'showChat'}}))")
                        expect(page.locator('#messages .message')).to_have_count(1)
                        expect(page.locator('#pkm-host-warning')).to_be_hidden()
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        expect(page.locator('#send')).to_be_visible()
                        expect(page.locator('#stop')).to_be_visible()
                        for mode, text in [('steer', 'Revised boundary'), ('task', 'Independent next task')]:
                            page.locator(f'#{mode}-mode').click()
                            page.locator('#prompt').fill(text)
                            page.locator('#send').click()
                            sent = page.evaluate("window.__posts.filter(message=>message.type==='send').at(-1)")
                            self.assertIsNotNone(sent, {'errors': errors, 'form': page.locator('#composer').evaluate("node=>({valid:node.checkValidity(),invalid:Array.from(node.querySelectorAll(':invalid')).map(item=>({id:item.id,message:item.validationMessage}))})"), 'hostUnavailable': page.evaluate('window.PkmHostHealth.unavailable')})
                            self.assertEqual(sent['text'], text)
                            self.assertEqual(sent['mode'], mode)
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", {'type': 'sendAccepted', 'chatId': sent['chatId'], 'submissionId': sent['submissionId']})
                            expect(page.locator('#prompt')).to_have_value('')
                        queued_fixture = {**fixture, 'chat': {**fixture['chat'], 'queuedInputs': [{'id': 'queued_fixture', 'mode': 'task', 'text': 'Queued evidence check'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", queued_fixture)
                        expect(page.locator('#queued-inputs')).to_contain_text('Queued evidence check')
                        page.get_by_role('button', name='Remove queued input', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='removeQueuedInput'&&message.id==='queued_fixture')"))
                        idle_queue = {**queued_fixture, 'busy': False}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", idle_queue)
                        page.get_by_role('button', name='Run queued inputs', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='runQueued')"))
                        delegated = {**fixture, 'chat': {**fixture['chat'], 'messages': [{**fixture['chat']['messages'][0], 'delegations': [{'id': 'receipt_fixture', 'chatUrl': chat_url, 'status': 'complete', 'answer': '<img src=x onerror=alert(1)> safely stored result'}]}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", delegated)
                        expect(page.locator('.delegation-answer')).to_contain_text('<img src=x onerror=alert(1)>')
                        expect(page.locator('.delegation-result img')).to_have_count(0)
                        expect(page.locator('.delegation-result .chat-status-indicator')).to_have_attribute('data-state', 'completed')
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                        expect(page.get_by_role('link', name='Chat link', exact=True)).to_have_attribute('href', chat_url)
                        page.get_by_role('link', name='Chat link', exact=True).click()
                        self.assertTrue(page.evaluate("url=>window.__posts.some(message=>message.type==='openLink'&&message.value===url)", chat_url))
                        self.assertIsNone(page.locator('.content a').filter(has_text='Unsafe link').get_attribute('href'))
                        self.assertIsNone(page.locator('.content a').filter(has_text='File link').get_attribute('href'))
                        page.get_by_role('link', name='External link', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='openLink'&&message.value==='https://example.com')"))
                        expect(page.locator(".workflow > summary")).to_contain_text("Activity [2 / 3]")
                        expect(page.locator(".workflow-summary .elapsed")).to_have_attribute("data-started", str(started + 200))
                        expect(page.locator(".workflow-summary .elapsed")).to_have_attribute("title", "Elapsed current step time")
                        expect(page.locator(".workflow-rail")).to_have_count(0)
                        expect(page.locator(".workflow-summary .working-cauldron")).to_have_count(1)
                        cauldron = page.locator(".workflow-summary .working-cauldron")
                        expect(cauldron).to_be_visible()
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationName"), "working-cauldron-rock")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).width"), "16px")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).height"), "16px")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).position"), "static")
                        self.assertTrue(cauldron.evaluate("node=>node.parentElement.matches('.workflow-summary')"))
                        page.emulate_media(reduced_motion="reduce")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationName"), "none")
                        page.emulate_media(reduced_motion="no-preference")
                        page.evaluate("document.body.classList.add('chat-backgrounded')")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationPlayState"), "paused")
                        page.evaluate("document.body.classList.remove('chat-backgrounded')")
                        expect(page.locator(".debug-information")).to_have_count(1)
                        expect(page.locator("#allow-all")).to_have_count(0)
                        expect(page.locator(".model-controls > #model + #options")).to_have_count(1)
                        expect(page.locator(".model-controls + #send")).to_have_count(1)
                        expect(page.locator("#options .codicon")).to_have_class("codicon codicon-settings")
                        expect(page.locator("#options")).to_have_attribute("aria-label", "Model settings")
                        model_label = page.locator("#model-label").bounding_box()
                        arrow = page.locator("#model .codicon-chevron-down").bounding_box()
                        self.assertAlmostEqual(arrow["x"] - model_label["x"] - model_label["width"], 4, delta=1)
                        options = page.locator("#options").bounding_box()
                        self.assertAlmostEqual(options["x"] - arrow["x"] - arrow["width"], 8, delta=1)
                        self.assertAlmostEqual(options["y"], page.locator("#model").bounding_box()["y"], delta=1)
                        original_label = page.locator("#model-label").inner_text()
                        for full_name in ["Long provider / very long model name for layout verification",
                                          "provider/very-long-model-name-with-complete-version-and-deployment-identifier-2026-10-08"]:
                            page.locator("#model-label").evaluate("(node,label)=>node.textContent=label", full_name)
                            expect(page.locator("#model-label")).to_have_text(full_name)
                            self.assertTrue(page.locator("#model-label").evaluate(
                                "node=>node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+1&&getComputedStyle(node).overflow==='visible'"))
                            long_model = page.locator("#model").bounding_box()
                            long_options = page.locator("#options").bounding_box()
                            self.assertAlmostEqual(long_options["x"] - long_model["x"] - long_model["width"], 4, delta=1)
                            self.assertAlmostEqual(long_options["y"] + long_options["height"] / 2,
                                                   long_model["y"] + long_model["height"] / 2, delta=1)
                            self.assertLessEqual(long_options["x"] + long_options["width"], width)
                            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        page.locator("#model-label").evaluate("(node,label)=>node.textContent=label", original_label)
                        before = page.locator("#composer").bounding_box()
                        for mode, label in [("protective", "Protective"), ("ask", "Ask before changes"), ("read-only", "Read only"), ("allow-all", "Allow All")]:
                            page.locator("#permissions").click()
                            page.locator("#permission-mode").select_option(mode)
                            self.assertTrue(page.evaluate("mode=>window.__posts.some(message=>message.type==='permissionMode'&&message.value===mode)", mode))
                            fixture["chat"]["permissionMode"] = mode
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                            expect(page.locator("#permissions")).to_have_attribute("data-permission-mode", mode)
                            expect(page.locator("#permissions .codicon")).to_have_class("codicon codicon-shield")
                            expect(page.locator("#permission-label")).to_have_count(0)
                            expect(page.locator("#permissions")).to_have_attribute("title", "Permissions: " + label + " \u00b7 next request")
                            expect(page.locator("#permission-mode")).to_have_value(mode)
                            self.assertEqual(page.locator("#composer").bounding_box(), before)
                            page.keyboard.press("Escape")
                            page.locator("#permissions").hover()
                            self.assertLessEqual(page.locator("#permissions").bounding_box()["width"], 32)
                        for button, panel in [("permissions", "permissions-panel"), ("tools", "tools-panel"), ("options", "advanced-budget"), ("agent-config", "agent-config-panel"), ("memory", "memory-panel")]:
                            page.locator("#" + button).click()
                            expect(page.locator("#" + panel)).to_be_visible()
                            self.assertEqual(page.locator(".chat-settings:visible").count(), 1)
                            self.assertEqual(page.locator("#composer").bounding_box(), before)
                            rectangle = page.locator("#" + panel).bounding_box()
                            self.assertGreaterEqual(rectangle["x"], 0)
                            self.assertLessEqual(rectangle["x"] + rectangle["width"], width)
                            self.assertGreaterEqual(rectangle["y"], 0)
                            page.keyboard.press("Escape")
                            expect(page.locator("#" + panel)).to_be_hidden()
                        page.locator("#model").click()
                        expect(page.locator("#model")).to_have_attribute("aria-busy", "true")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='chooseModel').length"), 1)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'modelPickerClosed'}}))")
                        self.assertIsNone(page.locator("#model").get_attribute("aria-busy"))
                        page.locator(".workflow > summary").click()
                        expect(page.locator(".workflow-events")).to_be_visible()
                        expect(page.locator(".tool-call")).to_be_visible()
                        page.screenshot(path=str(Path(screenshots) / f"chat-{width}.png"), full_page=True)
                        idle = {**fixture, "busy": False, "chat": {**fixture["chat"], "progress": {**progress, "status": "complete"}}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", idle)
                        expect(page.locator(".workflow-summary .working-cauldron")).to_have_count(0)
                        statuses = page.evaluate("""() => ['running','completed','new-result','failed','awaiting-input','idle','awaiting-result','paused'].map(value => {
                            const node=PkmChatStatusIndicator(value);document.body.append(node);
                            const result={state:node.dataset.state,cauldron:node.classList.contains('working-cauldron'),color:getComputedStyle(node,'::before').backgroundColor,width:getComputedStyle(node).width};
                            node.remove();return result;
                        })""")
                        self.assertTrue(statuses[0]['cauldron'])
                        self.assertEqual(statuses[1]['state'], 'completed')
                        self.assertEqual(statuses[2]['state'], 'completed')
                        self.assertEqual(statuses[1]['color'], 'rgb(82, 187, 128)')
                        self.assertEqual(statuses[3]['color'], 'rgb(239, 108, 108)')
                        self.assertEqual(statuses[4]['state'], 'waiting-input')
                        self.assertEqual(statuses[6]['state'], 'waiting-result')
                        self.assertEqual(statuses[6]['color'], 'rgb(227, 179, 65)')
                        self.assertEqual(statuses[7]['state'], 'stopped')
                        self.assertTrue(all(status['width'] == '16px' for status in statuses))
                        long_text = '\n\n'.join(f'History paragraph {index}: retained Chat result.' for index in range(150))
                        long_chat = {**idle, 'chat': {**idle['chat'], 'messages': [{'id': 'long_reply', 'role': 'assistant', 'status': 'complete', 'content': long_text}]}}
                        page.locator('#back').click()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", long_chat)
                        page.locator('.chat-list-open').click()
                        expect(page.locator('#library-view')).to_be_hidden()
                        self.assertTrue(page.locator('#messages').evaluate('node=>node.scrollHeight-node.scrollTop-node.clientHeight<2'))
                        page.locator('#messages').evaluate('node=>node.scrollTop=80')
                        refreshed = {**long_chat, 'chat': {**long_chat['chat'], 'messages': [{**long_chat['chat']['messages'][0], 'content': long_text + '\n\nNew result.'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", refreshed)
                        self.assertEqual(page.locator('#messages').evaluate('node=>node.scrollTop'), 80)
                        page.locator('#back').click()
                        page.locator('.chat-list-open').click()
                        self.assertTrue(page.locator('#messages').evaluate('node=>node.scrollHeight-node.scrollTop-node.clientHeight<2'))
                        page.evaluate("""() => {
                            window.__previousMessage=document.querySelector('#messages .message');
                            Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
                            document.dispatchEvent(new Event('visibilitychange'));
                        }""")
                        buffered = {**refreshed, 'chat': {**refreshed['chat'], 'messages': [{**refreshed['chat']['messages'][0], 'content': long_text + '\n\nBuffered while hidden.'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", buffered)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'delta',chatId:'chat_fixture',id:'long_reply',text:' Streamed while hidden.'}}))")
                        page.clock.run_for(32)
                        self.assertTrue(page.evaluate("window.__previousMessage===document.querySelector('#messages .message')"))
                        expect(page.locator('#messages')).not_to_contain_text('Buffered while hidden.')
                        page.evaluate("() => {delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));}")
                        expect(page.locator('#messages')).to_contain_text('Buffered while hidden. Streamed while hidden.')
                        page.locator('#back').click()
                        previous_message = page.locator('#messages .message').element_handle()
                        for _ in range(5):
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", buffered)
                        self.assertTrue(previous_message.evaluate("node=>node===document.querySelector('#messages .message')"))
                        page.locator('.chat-list-open').click()
                        expect(page.locator('#messages')).to_contain_text('Buffered while hidden.')
                        page.locator('#prompt').fill('Draft must survive host disconnection')
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('Extension Host is not responding')
                        page.screenshot(path=str(Path(screenshots) / f'host-disconnected-{width}.png'), full_page=True)
                        sends = page.evaluate("window.__posts.filter(message=>message.type==='send').length")
                        page.locator('#composer').evaluate("node=>node.requestSubmit()")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), sends)
                        expect(page.locator('#prompt')).to_have_value('Draft must survive host disconnection')
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'hostHealth',id:'stale'}}))")
                        expect(page.locator('#pkm-host-warning')).to_be_visible()
                        page.get_by_role('button', name='Reconnect to Extension Host').click()
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='ready').length"), 3)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:window.__posts.filter(message=>message.type==='hostHealth').at(-1)}))")
                        expect(page.locator('#pkm-host-warning')).to_be_hidden()
                        expect(page.locator('#prompt')).to_have_value('Draft must survive host disconnection')
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), sends)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'initializationError',message:'fixture backend startup failure'}}))")
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture backend startup failure')
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture backend startup failure')
                        page.evaluate("window.dispatchEvent(new ErrorEvent('error',{message:'fixture script failure'}))")
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture script failure')
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture script failure')
                        self.assertEqual(errors, [])
                        page.close()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()