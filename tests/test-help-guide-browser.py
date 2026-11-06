"""Production panel with a mock Host; no installed extension or inference is used.

Serve dist/webview on loopback and pass its URL as the first argument.
Requires the existing Python Playwright environment and headless Chromium.
"""
import base64
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:48731"
GUIDES = {locale: (ROOT / "resources/help" / f"{locale}.md").read_text() for locale in ("en", "zh-hans")}
CATALOGS = {locale: json.loads((ROOT / "resources/locales" / f"{locale}.json").read_text()) for locale in ("en", "zh-hans")}
PAGE_ERRORS = []
MOCK = r"""
const params = new URLSearchParams(location.search);
const restored = JSON.parse(localStorage.getItem('pkm-help-test-state') || 'null');
let saved = restored || {tab:params.get('initial') || 'help',workspace:params.get('initial') === 'notes' ? 'knowledge' : 'help'};
window.helpTest = {messages:[],fail:false,delay:false,pending:[],copied:null};
window.acquireVsCodeApi = () => ({
 getState:() => saved,
 setState:value => {saved=value;localStorage.setItem('pkm-help-test-state',JSON.stringify(value));},
 postMessage:message => {
   helpTest.messages.push(message);
   const emit = response => setTimeout(() => window.postMessage(response,'*'),0);
   if(message.command === 'helpGuide') {
     const response = {command:'helpGuide',data:{language:message.language,requestId:message.requestId,
       ...(helpTest.fail ? {error:'Mock guide read failed'} : {content:HELP_GUIDES[message.language]})}};
     if(helpTest.delay) helpTest.pending.push(response); else emit(response);
   }
   if(message.command === 'list') emit({command:'list',tab:message.tab,data:[],folders:[]});
   if(message.command === 'mcpStatus') emit({command:'mcpStatus',data:helpTest.mcp || {
     installed:true,current:true,store:{valid:false},mcpPython:{valid:false},
     automaticSetup:{state:'action-required',error:'Python 3.10+ was not found'}
   }});
 }
});
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
 writeText:async text => {if(helpTest.copyDenied) throw Error('Clipboard denied');helpTest.copied=text;}
}});
"""


def panel_route(route):
    locale = parse_qs(urlparse(route.request.url).query).get("lang", ["en"])[0]
    payload = {"setting": locale, "resolved": locale, "catalogs": CATALOGS,
               "locales": [{"id": "en", "label": "English", "direction": "ltr"},
                           {"id": "zh-hans", "label": "简体中文", "direction": "ltr"},
                           {"id": "ar", "label": "Arabic", "direction": "rtl"}]}
    html = (ROOT / "dist/webview/panel.html").read_text()
    assets = {"PANEL_CSS": "panel.css", "PANEL_JS": "panel.js", "CODICON_CSS": "codicon.css",
              "MARKED_SRC": "marked.umd.js", "HLJS_SRC": "hljs.js", "HLJS_CSS": "hljs.css",
              "KATEX_SRC": "katex.js", "KATEX_CSS": "katex.css", "HOST_HEALTH_JS": "host-health.js",
              "HOST_HEALTH_CSS": "host-health.css", "AGENT_HARNESS_CSS": "agent-harness.css",
              "MERMAID_SRC": "mermaid.js", "CYTOSCAPE_SRC": "cytoscape.js", "FORCEGRAPH3D_SRC": "forcegraph3d.js"}
    values = {key: f"{BASE}/{value}" for key, value in assets.items()}
    values.update({"CSP_SOURCE": "'self'", "PKM_VERSION": "source-test",
                   "I18N_PAYLOAD_B64": base64.b64encode(json.dumps(payload).encode()).decode()})
    html = re.sub(r"%%([A-Z0-9_]+)%%", lambda match: values.get(match[1], ""), html)
    route.fulfill(status=200, content_type="text/html", body=html)


def fresh(browser, query=""):
    context = browser.new_context(viewport={"width": 1360, "height": 900})
    context.add_init_script("const HELP_GUIDES = " + json.dumps(GUIDES) + ";\n" + MOCK)
    context.route("**/panel.html*", panel_route)
    page = context.new_page()
    page.on("pageerror", lambda error: PAGE_ERRORS.append(str(error)))
    page.on("console", lambda message: print("Browser error:", message.text) if message.type == "error" else None)
    page.on("requestfailed", lambda request: print("Failed request:", request.url, request.failure))
    page.on("response", lambda response: print("HTTP error:", response.status, response.url) if response.status >= 400 else None)
    page.goto(BASE + "/panel.html" + query)
    page.wait_for_load_state("networkidle")
    assert not PAGE_ERRORS, PAGE_ERRORS
    return context, page


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context, page = fresh(browser)
        expect(page.locator('.workspace-button[data-workspace="help"]')).to_have_class(re.compile("active"))
        expect(page.locator('.tab[data-tab="help"]')).to_have_attribute("aria-selected", "true")
        expect(page.locator(".pkm-help-content h1")).to_contain_text("practical guide")
        expect(page.locator(".pkm-help-toc a")).to_have_count(14)
        expect(page.locator(".pkm-help-copy")).to_have_count(13)
        sections = {"start": 0, "tools": 1, "retrieval": 2, "agents": 3, "tasks": 4,
                    "workers": 5, "memory": 6, "recipes": 7, "projects": 8,
                    "sharing": 9, "snapshots": 10, "setup": 11, "troubleshooting": 12}
        for section, index in sections.items():
            page.evaluate("section => openHelpSection(section)", section)
            expect(page.locator(f"#pkm-help-section-{index}")).to_be_focused()
            expect(page.locator(f"#pkm-help-section-{index}")).to_have_text(
                re.findall(r"^## (.+)$", GUIDES["en"], re.MULTILINE)[index])
        expect(page.locator("#sidebar")).to_be_hidden()
        expect(page.locator("#content-toolbar")).to_be_hidden()
        assert page.evaluate("helpTest.messages.filter(m=>['generateMcp','mcpSetPython','checkMcp','openApiChat'].includes(m.command)).length") == 0
        page.locator(".pkm-help-toc a").nth(4).click()
        expect(page.locator("#pkm-help-section-4")).to_be_focused()
        expected = page.locator("code.language-agent").first.text_content()
        page.locator(".pkm-help-copy").first.click()
        expect(page.locator(".pkm-help-status")).to_contain_text("nothing has been executed")
        assert page.evaluate("helpTest.copied") == expected
        page.evaluate("helpTest.copyDenied=true")
        page.locator(".pkm-help-copy").first.click()
        expect(page.locator(".pkm-help-status")).to_contain_text("copy it manually")
        page.evaluate("helpTest.copyDenied=false")
        page.locator('a[href="pkm-help:notes"]').first.click()
        expect(page.locator('.tab[data-tab="notes"]')).to_have_attribute("aria-selected", "true")
        page.locator('.workspace-button[data-workspace="help"]').click()
        expect(page.locator(".pkm-help-content h1")).to_contain_text("practical guide")
        page.reload()
        page.wait_for_load_state("networkidle")
        expect(page.locator(".pkm-help-content h1")).to_contain_text("practical guide")
        page.evaluate("applyUiLanguage({resolved:'zh-hans',setting:'zh-hans'})")
        expect(page.locator(".pkm-help-content h1")).to_contain_text("第一条笔记")
        expect(page.locator(".pkm-help-copy").first).to_have_text("复制给 Agent 的指令")
        page.evaluate("applyUiLanguage({resolved:'ar',setting:'ar'})")
        expect(page.locator(".pkm-help-language")).to_contain_text("English is shown")
        expect(page.locator(".pkm-help-content")).to_have_attribute("dir", "ltr")
        expect(page.locator("html")).to_have_attribute("dir", "rtl")
        page.set_viewport_size({"width": 620, "height": 780})
        assert page.locator(".pkm-help-content").bounding_box()["width"] > 300
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        context.close()

        context, page = fresh(browser, "?initial=notes")
        page.evaluate("helpTest.fail=true")
        page.locator('.workspace-button[data-workspace="help"]').click()
        expect(page.locator('.pkm-help [role="alert"]')).to_contain_text("Mock guide read failed")
        page.evaluate("helpTest.fail=false")
        page.get_by_role("button", name="Retry loading guide").click()
        expect(page.locator(".pkm-help-content h1")).to_contain_text("practical guide")
        page.locator('a[href="pkm-help:setup"]').click()
        expect(page.locator("#mcp-python-path")).to_be_visible()
        expect(page.locator("#mcp-python-path")).to_be_focused()
        context.close()

        context, page = fresh(browser, "?initial=notes")
        page.evaluate("helpTest.delay=true")
        page.locator('.workspace-button[data-workspace="help"]').click()
        page.locator('.workspace-button[data-workspace="knowledge"]').click()
        page.evaluate("helpTest.delay=false;helpTest.pending.forEach(response=>window.postMessage(response,'*'))")
        page.wait_for_timeout(100)
        expect(page.locator(".pkm-help")).to_have_count(0)
        page.locator('.workspace-button[data-workspace="help"]').click()
        expect(page.locator(".pkm-help-content h1")).to_contain_text("practical guide")
        context.close()

        context, page = fresh(browser, "?initial=notes")
        page.evaluate("showViewActionError('Saved result is uncertain')")
        expect(page.locator('#detail > .pk-action-error')).to_be_visible()
        page.locator('#detail > .pk-action-error').get_by_role("button", name="View troubleshooting steps").click()
        expect(page.locator("#pkm-help-section-4")).to_be_focused()
        page.evaluate("""mcpOnStatus({installed:true,current:true,store:{valid:false},
          mcpPython:{valid:false},automaticSetup:{state:'action-required',error:'Python missing'}})""")
        expect(page.locator("#mcp-global-warning .mcp-setup-action")).to_have_text("Choose Knowledge Root")
        page.locator("#mcp-global-warning .mcp-help-action").click()
        expect(page.locator("#pkm-help-section-11")).to_be_focused()
        page.evaluate("""helpTest.mcp = {installed:true,current:true,store:{valid:true,path:'/knowledge'},
          mcpPython:{valid:true,path:'/python',version:'3.11'},mcpRuntime:{healthy:false,exists:true,error:'Import failed'},
          automaticSetup:{state:'error',error:'pip failed'}};
          mcpOnStatus(helpTest.mcp); mcpStatusUpdatedAt=0""")
        page.locator("#mcp-global-warning .mcp-setup-action").click()
        expect(page.locator("#mcp-runtime-status")).to_be_visible()
        expect(page.locator("#mcp-runtime-status")).to_be_focused()
        expect(page.locator("#mcp-runtime-status .pkm-problem-guidance")).to_contain_text("pip failed")
        page.locator("#mcp-runtime-status .pkm-problem-guidance").get_by_role("button", name="View step-by-step guide").click()
        expect(page.locator("#pkm-help-section-11")).to_be_focused()
        page.locator('.workspace-button[data-workspace="tools"]').click()
        page.locator('.tab[data-tab="environments"]').click()
        page.evaluate("""renderEnvDashboard([
          {id:'ordinary',name:'Ordinary',path:'/missing',manager:'venv',missing:true},
          {id:'mcp-runtime',name:'MCP runtime',path:'/pkm',manager:'venv',missing:true,isMcpRuntime:true}
        ])""")
        expect(page.locator('#detail > .dash > .pkm-problem-guidance')).to_contain_text("2 registered environment(s) need attention")
        page.get_by_role("button", name="Review Ordinary", exact=True).click()
        ordinary = page.locator('.env-card[data-env-id="ordinary"]')
        managed = page.locator('.env-card[data-env-id="mcp-runtime"]')
        expect(ordinary.get_by_role("button", name="Select environment folder")).to_be_visible()
        expect(ordinary.get_by_role("button", name="Review MCP runtime repair")).to_have_count(0)
        expect(managed.get_by_role("button", name="Review MCP runtime repair")).to_be_visible()
        managed.get_by_role("button", name="Review MCP runtime repair").click()
        expect(page.locator("#mcp-runtime-status")).to_be_visible()
        page.evaluate("showViewActionError('Operation result uncertain')")
        expect(page.locator('#detail > .pk-action-error')).to_be_visible()
        page.locator('#detail > .pk-action-error').get_by_role("button", name="View troubleshooting steps").click()
        expect(page.locator("#pkm-help-section-11")).to_be_focused()
        page.locator('.workspace-button[data-workspace="settings"]').click()
        page.locator('.tab[data-tab="skillRouter"]').click()
        page.evaluate("""skillRouterSolutionCache = {enabled:true,models:[{id:'model',name:'Model',error:'model import failed'}],
          setup:{phase:'failed',failedPhase:'runtime',error:'model Python lacks torch'}};
          renderSkillRouterPane({runtime:{semanticStatus:'unavailable',solution:{requested_package_id:'model'},skillServing:{}}});
          selectSettingsSubtab('router','performance')""")
        page.locator('.pkm-problem-guidance').get_by_role("button", name="Review model setup and budget").first.click()
        expect(page.locator("#sr-inspector")).to_have_attribute("data-stage", "encoder")
        expect(page.locator("#sr-inspector-tab-controls")).to_have_attribute("aria-selected", "true")
        expect(page.locator("#sr-text-solutions")).to_be_visible()
        expect(page.locator("#sr-text-solutions")).to_be_focused()
        expect(page.locator(".sr-model-advanced")).to_have_attribute("open", "")
        page.locator("#sr-text-solutions .pkm-problem-guidance").get_by_role("button", name="View step-by-step guide").first.click()
        expect(page.locator("#pkm-help-section-2")).to_be_focused()
        assert not page.evaluate("helpTest.messages.some(m => ['checkMcp','mcpRepairRuntime','generateMcp','envDelete','envCreate'].includes(m.command))")
        context.close()

        context, page = fresh(browser, "?lang=zh-hans")
        expect(page.locator(".pkm-help-content h1")).to_contain_text("第一条笔记")
        page.evaluate("translateUi()")
        assert page.locator(".pkm-help-content").get_attribute("lang") == "zh-hans"
        context.close()
        browser.close()
        assert not PAGE_ERRORS, PAGE_ERRORS
        print("PASS: production Help DOM, cold/restored routes, 14 headings, 13 exact-copy examples, "
              "feature/setup links, clipboard failure, locale/RTL, narrow layout, retry, "
              "late-response isolation, all 13 problem-guide section routes, missing-root/setup/env actions, "
              "visible generic recovery errors and no implicit mutation; 0 page errors. Mock Host, no installed-extension claim.")


if __name__ == "__main__":
    main()
