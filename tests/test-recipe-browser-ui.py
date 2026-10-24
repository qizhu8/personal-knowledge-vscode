#!/usr/bin/env python3
import base64
import json
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
    page.keyboard.press("Control+f")
    page.get_by_role("searchbox", name="Search Recipes").fill("PKM Tutorial (Editable Demo)")
    page.locator('.tree-cat-hdr[title="Examples"]').click()
    page.locator('.tree-cat-hdr[title="PKM"]').click()
    page.locator('.project-recipe-row', has_text="PKM Tutorial (Editable Demo)").click()
    page.locator('.recipe-graph-toolbar').wait_for()
    page.wait_for_function("recipeDraftBaselinePending === false")


def assert_project_errors_in_viewport(browser):
    root = Path(__file__).resolve().parents[1]
    source = (root / "src/webview/panel/15-projects.js").read_text(encoding="utf-8")
    handler = source[source.index("function projectOnError(data) {"):]
    styles = (root / "src/webview/panel.css").read_text(encoding="utf-8")
    message = "Move this Group's Tasks to Trash before deleting the Group.\nBlocking Task: Chat E2E acceptance, status: paused. Running or paused Tasks must be explicitly stopped or completed first. " + "long-task-identity-" * 30
    for width, height in [(1280, 900), (390, 844), (320, 568)]:
      page = browser.new_page(viewport={"width": width, "height": height})
      try:
        page.route("**/codicon.ttf?*", lambda route: route.fulfill(path=str(root / "dist/webview/codicon.ttf"), content_type="font/ttf"))
        page.set_content('<html style="--panel:#252526;--border:#454545;--text:#e0e0e0;--muted:#ababab;--input:#313131"><head><base href="http://pkm-fixture.invalid/"></head><body style="background:#181818;color:var(--text);font-family:sans-serif"><div id="detail" style="height:100vh;overflow:hidden"><div style="height:100vh">Agent Sessions</div></div><div class="agent-session-fullscreen">Full-screen graph</div><div id="pk-modal-bg"><div id="pk-modal">Overlapping modal</div></div></body></html>')
        page.add_style_tag(content=styles)
        page.add_style_tag(content=(root / "dist/webview/codicon.css").read_text(encoding="utf-8"))
        page.add_script_tag(content="const state={tab:'agentSessions'}; function finishAction() {} function failAction() {}\n" + handler)
        page.evaluate("message => projectOnError({action:'agentSessionGroupDelete',error:message})", message)
        error = page.locator("#project-action-error")
        assert error.get_attribute("role") == "alert"
        assert error.locator(".project-action-error-message").inner_text() == message
        geometry = error.evaluate("element => { const r=element.getBoundingClientRect(); const text=element.querySelector('.project-action-error-message'); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,textWidth:text.clientWidth,textScrollWidth:text.scrollWidth,front:!!document.elementFromPoint(r.x+4,r.y+4)?.closest('#project-action-error')}; }")
        assert geometry["x"] >= 0 and geometry["y"] >= 0, geometry
        assert geometry["right"] <= geometry["width"] and geometry["bottom"] <= geometry["height"], geometry
        assert geometry["textScrollWidth"] <= geometry["textWidth"], geometry
        assert geometry["front"], "Modal or graph obscures the error: " + str(geometry)
        assert error.evaluate("element => getComputedStyle(element).backgroundColor") == "rgb(37, 37, 38)"
        page.evaluate("document.fonts.ready")
        screenshot_directory = os.environ.get("PKM_PROJECT_ERROR_SCREENSHOTS")
        if screenshot_directory:
          Path(screenshot_directory).mkdir(parents=True, exist_ok=True)
          page.screenshot(path=str(Path(screenshot_directory) / f"project-error-{width}.png"))
        page.locator(".project-action-error-message").evaluate("element => element.scrollTop=element.scrollHeight")
        page.evaluate("projectOnError({action:'agentSessionGroupDelete',error:'<img src=x onerror=alert(1)> Replacement error'})")
        assert error.count() == 1 and error.locator("img").count() == 0
        assert "Replacement error" in error.inner_text()
        page.get_by_role("button", name="Dismiss error").click()
        assert error.count() == 0
      finally:
        page.close()


def open_configurable_testing_recipe(page):
    page.keyboard.press("Control+f")
    page.get_by_role("searchbox", name="Search Recipes").fill("Configurable Validation and Testing (Editable Demo)")
    for category in ["System", "PKM", "Fundamental"]:
        header = page.locator(f'.tree-cat-hdr[title="{category}"]')
        if header.count() and "expanded" not in (header.get_attribute("class") or ""):
            header.click()
    page.locator('.project-recipe-row', has_text="Configurable Validation and Testing (Editable Demo)").click()
    page.locator('.recipe-methodology-projections').wait_for()
    page.wait_for_function("recipeDraftBaselinePending === false")


def assert_single_toolbar_row(page):
    toolbar = page.locator('.recipe-graph-tools')
    styles = toolbar.evaluate("element => { const style = getComputedStyle(element); return {display:style.display, direction:style.flexDirection, wrap:style.flexWrap, width:style.width}; }")
    centers = toolbar.locator(':scope > *').evaluate_all(
        "elements => elements.map(element => { const rect = element.getBoundingClientRect(); return Math.round(rect.top + rect.height / 2); })"
    )
    assert max(centers) - min(centers) <= 1, f"Definition Graph controls wrapped onto multiple rows: {centers}; styles={styles}"


def assert_single_module_and_trash(browser):
    usage = {"protocol":{"observed":True,"calls":3,"estimatedTokens":120},
             "model":{"quality":"measured","measuredTokens":{"totalTokens":55}}}
    for width, height in [(1280,900),(390,844)]:
        page = browser.new_page(viewport={"width":width,"height":height})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-workspace="automation"]').click()
        page.locator('.tab[data-tab="agentSessions"]').click()
        page.wait_for_function("projectSnapshot !== null")
        page.evaluate("""usage => {
          projectSnapshot.agentSessionTrash = [{sessionId:'agent_session_historical', task:'Historical full content',
            status:'completed', agent:{name:'Copilot'}, trashedAt:'2026-10-04T00:00:00Z',
            checkpoint:{sequence:3,summary:'Historical checkpoint content'},
            todos:[{todoId:'historical',title:'Historical Todo',status:'succeeded',summary:'Historical Todo summary',recipeRunIds:['historical_run'],usage}],
            runs:[{runId:'historical_run',recipeName:'Historical Recipe',status:'completed',nodes:[
              {nodeId:'archived-module',state:'succeeded',instruction:'Historical node content',dependsOn:[],usage}]}]}];
          renderAgentSessions();
        }""", usage)
        dock = page.locator('.cattree-trash-dock')
        dock.locator('.knowledge-trash-dock-row').press("Space")
        dock.locator('.agent-session-trash-row').press("Enter")
        assert page.locator('.agent-session-content h3').inner_text() == "Historical full content"
        assert "Historical checkpoint content" in page.locator('.agent-session-content').inner_text()
        assert "Historical Todo summary" in page.locator('.agent-session-content').inner_text()
        page.locator('.agent-runtime-run summary').click()
        historical_module = page.locator('.agent-runtime-run .agent-runtime-node[data-node-id="archived-module"]')
        assert historical_module.locator('p').inner_text() == "Historical node content"
        assert "55 measured" in historical_module.inner_text()
        for kind in ["recipe","ad-hoc"]:
            if kind == "ad-hoc":
                page.evaluate("""usage => {
                  projectSnapshot.agentSessions = [{sessionId:'agent_session_single',task:'Single ad hoc task',status:'completed',runs:[],
                    todos:[{todoId:'single',title:'Single ad hoc module',status:'succeeded',usage}]}];
                  agentSessionSelect('agent_session_single');
                }""", usage)
            page.locator('.agent-session-flow > header button[title="Open full-screen Session graph"]').click()
            graph = page.locator('.agent-session-fullscreen')
            assert graph.locator('.agent-session-unified-node').count() == 1
            module = graph.locator('.agent-session-unified-node')
            assert "3 calls" in module.inner_text() and "55 measured" in module.inner_text()
            geometry = graph.evaluate("""graph => {
              const card = graph.querySelector('.agent-session-unified-node');
              const center = element => {const rect=element.getBoundingClientRect();return rect.left+rect.width/2;};
              const middle = center(graph.querySelector('.agent-session-recipe-tree-canvas'));
              return {deltas:[card,graph.querySelector('[data-module-boundary="start"]'),graph.querySelector('[data-module-boundary="stop"]')]
                .map(element=>Math.abs(center(element)-middle)), overflow:card.scrollWidth>card.clientWidth,
                overlapping:[...card.querySelectorAll('.agent-session-todo-usage>span')].some(element=>element.scrollWidth>element.clientWidth)};
            }""")
            assert max(geometry["deltas"]) <= 2, geometry
            assert not geometry["overflow"] and not geometry["overlapping"], geometry
            if SCREENSHOT_PATH:
                graph.screenshot(path=str(Path(SCREENSHOT_PATH).with_name(f"agent-session-single-{kind}-{width}.png")))
            graph.locator('button[title="Close full-screen graph"]').click()
        assert not errors, errors
        page.close()


def assert_shared_trash_docks(browser):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(BASE_URL, wait_until="networkidle")
    page.wait_for_function("projectSnapshot !== null")
    page.evaluate("""() => {
      projectSnapshot.agentSessionTrash = [{sessionId:'agent_session_trash_ui', task:'Trashed Session',
        status:'completed', agent:{name:'Copilot'}, trashedAt:'2026-10-04T00:00:00Z'}];
      projectSnapshot.recipeTrash = [{...projectSnapshot.recipes[0], scope:'global',
        recipeId:'recipe_trash_ui', name:'Trashed Recipe'}];
    }""")
    for width, height in [(1280, 900), (390, 844)]:
      page.set_viewport_size({"width": width, "height": height})
      reference = None
      for workspace, area, command in [
        ("knowledge", "skills", "skillTrashEmpty"),
        ("automation", "recipes", "recipeTrash"),
        ("automation", "agentSessions", "agentSessionTrash"),
      ]:
        list_requests = page.evaluate("window.__previewMessages.filter(message => message.command === 'list' && message.tab === 'skills').length")
        page.locator(f'[data-workspace="{workspace}"]').click()
        tab = page.locator(f'.tab[data-tab="{area}"]')
        if tab.get_attribute("aria-selected") != "true":
          tab.click()
        if area == "skills":
          page.wait_for_function("count => !skillsListLoading && window.__previewMessages.filter(message => message.command === 'list' && message.tab === 'skills').length > count", arg=list_requests)
          page.evaluate("""() => {
            state.knowledgeTrash = [{id:'trash_ui', name:'Trashed Skill', kind:'file', originalPath:'Testing/Skill'}];
            renderKnowledgeTrashDock('skills');
          }""")
        else:
          page.evaluate("""() => {
            projectSnapshot.agentSessionTrash = [{sessionId:'agent_session_trash_ui', task:'Trashed Session',
              status:'completed', agent:{name:'Copilot'}, trashedAt:'2026-10-04T00:00:00Z'}];
            projectSnapshot.recipeTrash = [{...projectSnapshot.recipes[0], scope:'global',
              recipeId:'recipe_trash_ui', name:'Trashed Recipe'}];
          }""")
          page.evaluate("renderGlobalRecipes()" if area == "recipes" else "renderAgentSessions()")
        dock = page.locator('.cattree-trash-dock:visible')
        row = dock.locator('.knowledge-trash-dock-row')
        button = row.get_by_role("button", name="Delete All", exact=True)
        assert button.is_visible() and button.is_enabled(), f"{area} Trash Delete All unavailable at {width}px"
        assert row.get_attribute("aria-expanded") == "false"
        assert page.locator('.agent-session-archive').count() == 0
        styles = row.evaluate("""element => {
          const style = getComputedStyle(element);
          const button = element.querySelector('.knowledge-trash-empty');
          const action = getComputedStyle(button);
          return [style.fontSize, style.color, style.padding, element.getBoundingClientRect().height,
            action.fontSize, action.color, action.padding, action.borderWidth, action.minHeight,
            action.display, action.flexDirection, button.getBoundingClientRect().height];
        }""")
        if reference is None:
          reference = styles
        assert styles == reference, f"{area} Trash differs from Skills: {styles}"
        bounds = button.bounding_box()
        assert bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= width
        assert bounds["y"] >= 0 and bounds["y"] + bounds["height"] <= height
        row.focus()
        row.press("Space")
        assert row.get_attribute("aria-expanded") == "true"
        row.press("Space")
        assert row.get_attribute("aria-expanded") == "false"
        button.focus()
        button.press("Enter")
        assert page.locator('#pk-modal-ok').is_visible()
        assert row.get_attribute("aria-expanded") == "false", "Delete All must not toggle the popover"
        page.locator('#pk-modal-ok').click()
        page.wait_for_function("command => window.__previewMessages.some(message => message.command === command)", arg=command)
        request = page.evaluate("command => window.__previewMessages.filter(message => message.command === command).at(-1)", command)
        if area != "skills":
          assert request["action"] == "empty"
        screenshots_dir = os.environ.get("PKM_TRASH_SCREENSHOT_DIR")
        if screenshots_dir:
          Path(screenshots_dir).mkdir(parents=True, exist_ok=True)
          page.screenshot(path=str(Path(screenshots_dir) / f"{area}-trash-{width}.png"))
        if area == "skills":
          page.evaluate("state.knowledgeTrash = []; renderKnowledgeTrashDock('skills')")
        else:
          page.evaluate("""area => {
            const key = area === 'recipes' ? 'recipeTrash' : 'agentSessionTrash';
            const entries = projectSnapshot[key]; projectSnapshot[key] = [];
            area === 'recipes' ? renderGlobalRecipes() : renderAgentSessions();
            projectSnapshot[key] = entries;
          }""", area)
        assert dock.get_by_role("button", name="Delete All", exact=True).is_disabled()
    page.close()


def assert_automatic_refresh_preserves_interaction(browser):
    for width, height in [(1280, 900), (390, 844)]:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        open_recipe(page)
        page.evaluate(r"""async () => {
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          window.__refreshMessages = [];
          vscode.postMessage = message => window.__refreshMessages.push(message);
          const send = (command, data, extra = {}) => window.dispatchEvent(new MessageEvent('message', {data:{command,data,...extra}}));
          const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
          const edit = (id, value, caret = 3) => {
            const input = document.getElementById(id);
            check(!!input, 'Missing fixture input: ' + id);
            input.value = value; input.focus();
            if (input.type !== 'number') input.setSelectionRange(caret, caret);
            return input;
          };
          const position = element => [element.scrollLeft, element.scrollTop];
          const samePosition = (element, before, label) => check(JSON.stringify(position(element)) === JSON.stringify(before), label);

          recipeGraphZoomSet(3);
          await frames();
          const graph = document.querySelector('.recipe-graph-viewport');
          graph.scrollLeft = 150; graph.scrollTop = 100;
          const recipePosition = position(graph), recipeZoom = recipeGraphZoom;
          check(recipePosition[0] > 0, 'Recipe fixture must have real horizontal overflow');
          send('recipeSubscriptionGroups', {groups:[]});
          await frames();
          samePosition(document.querySelector('.recipe-graph-viewport'), recipePosition, 'Recipe subscription result resets graph');
          check(recipeGraphZoom === recipeZoom, 'Recipe refresh resets zoom');
          invalidateRecipeSubscriptionGroups();
          await frames();
          samePosition(document.querySelector('.recipe-graph-viewport'), recipePosition, 'Recipe invalidation resets graph');

          state.tab = 'scripts';
          const script = {type:'script',path:'fixture/script.py',name:'Refresh Script',content:'print("disk")'};
          currentDetailRequest = {type:'script',key:script.path};
          renderDetail(script); startEditScript();
          const scriptInput = edit('se-script', 'print("unsaved draft")', 8);
          send('reloaded', {changedPath:'/fixture/notes/unrelated.md'});
          const detailRequest = window.__refreshMessages.filter(message => message.command === 'detail').at(-1);
          check(!!detailRequest, 'Filesystem reload must request current Script');
          send('detail', {...script,content:'print("new disk")'}, {detailRequestId:detailRequest.detailRequestId,detailTab:detailRequest.detailTab});
          check(document.getElementById('se-script') === scriptInput && scriptInput.value.includes('unsaved draft'), 'Script refresh replaces draft DOM');
          check(document.activeElement === scriptInput && scriptInput.selectionStart === 8, 'Script refresh loses focus or caret');
          send('scriptSaved', {cancelled:true,path:script.path});
          check(document.getElementById('se-script') === scriptInput, 'Cancelled Save discards Script draft');
          cancelScriptEdit();
          check(!document.getElementById('se-script'), 'Explicit Cancel must exit Script editor');
          const cancelRequest = window.__refreshMessages.filter(message => message.command === 'detail').at(-1);
          send('detail', script, {detailRequestId:cancelRequest.detailRequestId,detailTab:cancelRequest.detailTab});
          startEditScript();
          send('scriptSaved', {ok:true,path:script.path});
          check(!document.getElementById('se-script'), 'Successful Save must exit Script editor');
          const savedRequest = window.__refreshMessages.filter(message => message.command === 'detail').at(-1);
          send('detail', script, {detailRequestId:savedRequest.detailRequestId,detailTab:savedRequest.detailTab});
          ask('detail', {type:'script',key:'fixture/other.py'});
          const latestRequest = window.__refreshMessages.filter(message => message.command === 'detail').at(-1);
          send('detail', {...script,path:'fixture/other.py'}, {detailRequestId:latestRequest.detailRequestId,detailTab:latestRequest.detailTab});
          send('detail', script, {detailRequestId:savedRequest.detailRequestId,detailTab:savedRequest.detailTab});
          check(currentDetail.path === 'fixture/other.py', 'Late detail response replaces current entity');

          state.tab = 'githubSync'; githubSyncNew();
          edit('github-sync-name', 'Unsaved Target');
          edit('github-sync-repository', 'https://github.com/fixture/only.git');
          edit('github-sync-branch', 'draft-branch', 5);
          const targetDetail = document.getElementById('detail'); targetDetail.scrollTop = 130;
          const targetPosition = position(targetDetail);
          send('githubSyncRuntimeState', {targetId:'unrelated-target',status:'idle'});
          check(document.getElementById('github-sync-name').value === 'Unsaved Target', 'Runtime state discards new Target name');
          check(document.getElementById('github-sync-repository').value.includes('/fixture/only.git'), 'Runtime state discards repository');
          check(document.activeElement.id === 'github-sync-branch' && document.activeElement.selectionStart === 5, 'Target runtime refresh loses focus or caret');
          samePosition(targetDetail, targetPosition, 'Target runtime refresh resets scroll');
          send('githubSyncRunQueued', {targetId:'unrelated-target'});
          check(document.getElementById('github-sync-branch').value === 'draft-branch', 'Queued run discards Target branch');

          state.tab = 'subscriptions'; subscriptionEditingShare = 'broker-a'; subscriptionEditorTab = 'general';
          const subscription = {displayName:'Saved Node',port:19877,host:'127.0.0.1',shares:[
            {shareId:'broker-a',name:'Broker A',dataPort:0,subscribers:[{nodeId:'fixture-account',name:'Fixture Account'}]}, {shareId:'broker-b',name:'Broker B',dataPort:0}
          ],subscriptions:[],catalog:{}};
          subscriptionOnState(subscription);
          edit('sub-display-name', 'Unsaved Node'); edit('sub-alias', 'Unsaved Alias');
          edit('sub-magic-link', 'fixture-link-not-valid'); edit('sub-share-name', 'Unsaved Broker', 6);
          const subscriptionDetail = document.getElementById('detail'); subscriptionDetail.scrollTop = 140;
          const subscriptionPosition = position(subscriptionDetail);
          send('subscriptionState', {...subscription,port:19888,shares:[{...subscription.shares[0],name:'Updated A',dataPort:42},subscription.shares[1]]});
          check(document.getElementById('sub-display-name').value === 'Unsaved Node', 'Subscription refresh discards Node draft');
          check(document.getElementById('sub-alias').value === 'Unsaved Alias' && document.getElementById('sub-magic-link').value === 'fixture-link-not-valid', 'Subscription refresh discards mount fields');
          check(document.getElementById('sub-port').value === '19888' && document.getElementById('sub-share-data-port').value === '42', 'Untouched Subscription fields freeze old backend state');
          check(document.getElementById('sub-share-name').value === 'Unsaved Broker', 'Subscription refresh discards Broker draft');
          check(document.activeElement.id === 'sub-share-name' && document.activeElement.selectionStart === 6, 'Subscription refresh loses caret');
          samePosition(subscriptionDetail, subscriptionPosition, 'Subscription refresh resets scroll');
          subscriptionSetEditorTab('acl'); subscriptionSetEditorTab('general');
          check(document.getElementById('sub-share-name').value === 'Unsaved Broker', 'Broker tab switch discards draft');
          subscriptionSetEditorTab('subscribers');
          const account = document.getElementById('sub-account-fixture-account'); account.checked = true; account.focus();
          send('subscriptionState', {...subscriptionData,gatewayStatus:'running'});
          check(document.getElementById(account.id).checked && document.activeElement.id === account.id, 'Subscriber refresh discards account selection or focus');
          subscriptionEditingShare = 'broker-b'; renderSubscriptionPane();
          check(document.getElementById('sub-share-name').value === 'Broker B', 'Broker A draft leaks into Broker B');

          state.tab = 'servers';
          const server = {slug:'refresh-server',name:'Refresh Server',command:'python server.py',port:8999,status:'starting',tags:[]};
          renderServerDashboard([server]); editServer(server.slug);
          const serverInput = edit('se-cmd-' + server.slug, 'python unsaved.py', 7);
          send('serverList', [{...server,status:'running'}]);
          check(document.getElementById('se-cmd-' + server.slug) === serverInput && serverInput.value === 'python unsaved.py', 'Server polling replaces settings DOM');
          check(document.activeElement === serverInput && serverInput.selectionStart === 7, 'Server polling loses focus or caret');
          onServerLog(server.slug, Array.from({length:150}, (_,index) => 'log ' + index).join('\n'));
          const log = document.querySelector('.srv-log'); log.scrollTop = 70;
          const logPosition = position(log);
          send('serverList', [{...server,status:'stopped'}]);
          check(document.querySelector('.srv-log') === log, 'Server refresh removes log DOM');
          samePosition(log, logPosition, 'Server refresh resets log scroll');
          send('serverList', []);
          check(!document.getElementById('se-cmd-' + server.slug) && !document.querySelector('.srv-log'), 'Deleted Server output is resurrected');

          state.tab = 'agentSessions';
          const session = {...projectSnapshot.agentSessions[0],sessionId:'refresh-session-a',task:'Refresh Session A',runs:[],
            todos:Array.from({length:12}, (_,index) => ({todoId:'refresh-todo-' + index,title:'Refresh module ' + index,status:'pending',recipeRunIds:[]}))};
          projectSnapshot.agentSessions = [session,{...session,sessionId:'refresh-session-b',task:'Refresh Session B',todos:[session.todos[0]]}];
          selectedAgentSessionId = session.sessionId; agentSessionGraphZoom = 1; renderAgentSessions();
          const sessionGraph = document.querySelector('.agent-session-overview-graph');
          sessionGraph.scrollLeft = 350;
          const sessionPosition = position(sessionGraph);
          check(sessionPosition[0] > 0, 'Session fixture must have real graph overflow');
          const changed = structuredClone(projectSnapshot); changed.agentSessions[0].updatedAt = '2026-10-05T12:00:00Z';
          send('projectState', changed); await frames();
          samePosition(document.querySelector('.agent-session-overview-graph'), sessionPosition, 'Session automatic refresh resets inline graph');
          selectedAgentSessionId = 'refresh-session-b'; renderAgentSessions();
          check(document.querySelector('.agent-session-overview-graph').scrollLeft === 0, 'Session A viewport leaks into B');
          state.tab = 'agentSnapshots'; selectedAgentSnapshotId = ''; renderAgentSnapshots();
          document.getElementById('agent-snapshot-source').value = 'refresh-session-b';
          const snapshotRefresh = structuredClone(projectSnapshot); snapshotRefresh.agentSessions[0].updatedAt = '2026-10-05T12:00:01Z';
          send('projectState', snapshotRefresh);
          check(document.getElementById('agent-snapshot-source').value === 'refresh-session-b', 'Snapshot source changes on refresh');
          snapshotRefresh.agentSessions = [snapshotRefresh.agentSessions[0]];
          send('projectState', snapshotRefresh);
          check(document.getElementById('agent-snapshot-source').value === 'refresh-session-a', 'Removed Snapshot source does not fall back to valid Session');
        }""")
        assert not errors, f"Automatic refresh console errors at {width}px: {errors}"
        page.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("PKM_CHROMIUM_EXECUTABLE") or None)
    if os.environ.get("PKM_PROJECT_ERROR_UI_ONLY") == "1":
        assert_project_errors_in_viewport(browser)
        browser.close()
        print("Project error browser checks passed: unclipped full text, narrow-screen wrapping, overlay hit testing, safe replacement and physical dismissal.")
        raise SystemExit(0)
    assert_project_errors_in_viewport(browser)
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
    assert page.locator("#coachmark-progress").inner_text() == "Step 1 of 7"
    assert page.locator("#topbar strong").evaluate("element => element.classList.contains('coachmark-target')")
    page.locator("#coachmark-close").click()
    assert page.locator("#experience-layer").is_hidden()
    assert not any(
        message.get("command") == "completeTourModules"
        for message in page.evaluate("window.__previewMessages")
    ), "manual replay must not change durable completion state"

    page.evaluate("""startOnboardingTour({
      moduleIds: ['pkm-chat', 'retrieval-system', 'router', 'github-sync', 'portal'],
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
        "pkm-chat", "retrieval-system", "router", "github-sync", "portal",
    ], "explicit skip must persist every presented module"
    assert completion_messages[-1]["audience"] == "update"

    page.set_viewport_size({"width": 520, "height": 900})
    page.locator("#start-tour-button").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-next").click()
    page.locator("#coachmark-title").filter(has_text="Router").wait_for()
    target = page.locator(".coachmark-target")
    assert target.count() == 1 and target.is_visible()
    assert target.evaluate("element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth; }")
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
    assert page.evaluate("window.__recipeOpen.recipeId") == "recipe_demo_pkm_tutorial"

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

    page.evaluate("""() => {
        const node = projectSnapshot.agentSessions.flatMap(session => session.runs || [])
            .find(run => run.runId === 'recipe_run_demo_observable').nodes
            .find(node => node.nodeId === 'browser-validation');
        node.lastHeartbeatAt = node.lastProgressAt = new Date().toISOString();
    }""")
    page.locator('.tab[data-tab="agentSessions"]').click()
    session_run = page.locator('.agent-session-task', has_text="Validate recovery").locator('.agent-runtime-run')
    session_run.locator('summary').click()
    page.wait_for_function("agentSessionOpenRunIds.has('recipe_run_demo_observable')")
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
    queue_geometry = """graph => {
      const origin = graph.querySelector('.agent-session-unified-graph').getBoundingClientRect();
      return [...graph.querySelectorAll('[data-todo-node]')].map(node => {
        const rect = node.getBoundingClientRect(); return {id:node.dataset.todoNode,x:rect.left-origin.left,y:rect.top-origin.top};
      });
    }"""
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
      const dependencies = [...graph.querySelectorAll('.agent-session-unified-edge[data-edge-relation="prerequisite"]')];
      const arrows = [...graph.querySelectorAll(':scope > .agent-graph-arrow[data-edge-source]')];
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
    assert edge_geometry["structural"] == 3, edge_geometry
    assert edge_geometry["ownership"] == 2, edge_geometry
    assert edge_geometry["dependencies"] == len(edge_geometry["arrows"]) > 0, edge_geometry
    assert all(edge["sourceExists"] and edge["targetExists"] for edge in edge_geometry["arrows"]), edge_geometry
    assert all(edge["centerDelta"] <= 2 and 5 <= edge["targetGap"] <= 14 for edge in edge_geometry["arrows"]), edge_geometry
    fullscreen_module = fullscreen.locator('.agent-runtime-node[data-node-id="browser-validation"]')
    queue_before_drag = fullscreen.evaluate(queue_geometry)
    module_box = fullscreen_module.bounding_box()
    page.mouse.move(module_box["x"] + 40, module_box["y"] + 20)
    page.mouse.down()
    page.mouse.move(module_box["x"] + 100, module_box["y"] + 80, steps=6)
    page.mouse.up()
    moved_box = fullscreen_module.bounding_box()
    assert abs(moved_box["x"] - module_box["x"] - 60) <= 2, moved_box
    assert abs(moved_box["y"] - module_box["y"] - 60) <= 2, moved_box
    moved_transform = fullscreen_module.evaluate("node => node.style.transform")
    page.evaluate("renderAgentSessions()")
    fullscreen = page.locator('.agent-session-fullscreen')
    assert fullscreen.locator('.agent-runtime-node[data-node-id="browser-validation"]').evaluate("node => node.style.transform") == moved_transform
    assert fullscreen.evaluate(queue_geometry) == queue_before_drag
    fullscreen.locator('.agent-session-recipe-tree button[title="Reorganize Recipes"]').click()
    assert "translate(0px,0px)" in page.locator('.agent-session-fullscreen .agent-runtime-node[data-node-id="browser-validation"]').get_attribute("style").replace(" ", "")
    assert fullscreen.evaluate(queue_geometry) == queue_before_drag
    fullscreen.locator('button[title="Close full-screen graph"]').click()
    assert page.locator('.agent-session-fullscreen').count() == 0

    session_path = os.environ.get("PKM_AGENT_SESSION_GRAPH_DATA", "")
    graph_session = json.loads(Path(session_path).read_text()) if session_path else {
      "sessionId": "session_no_recipe", "task": "Sync recovery and graph parity", "status": "running",
      "todos": [{"todoId": name, "title": name, "status": status} for name, status in
            [("Sync recovery", "succeeded"), ("Graph parity", "running"), ("Watcher deferred", "pending")]],
    }
    assert graph_session["todos"], "The parity test must use actual durable Todos"
    assert not graph_session.get("recipeRunIds"), "This regression expects a Session without Recipe Runs"
    graph_session["runs"] = []
    install_graph = """session => {
      projectSnapshot.agentSessions = [session]; selectedAgentSessionId = session.sessionId;
      selectedAgentSessionTodoId = ''; agentSessionFullscreenRunId = ''; state.tab = 'agentSessions';
      renderAgentSessions();
    }"""
    page.evaluate(install_graph, graph_session)
    overview = page.locator('.agent-session-overview-graph')
    assert overview.locator('[data-module-kind="todo"]').count() == len(graph_session["todos"])
    parallel_geometry = """graph => {
      const origin = graph.querySelector('.agent-session-unified-graph').getBoundingClientRect();
      return [...graph.querySelectorAll('[data-module-kind="todo"]')].map(node => {
        const rect = node.getBoundingClientRect(); return {top:rect.top-origin.top,left:rect.left-origin.left,right:rect.right-origin.left};
      }).sort((left,right) => left.left - right.left);
    }"""
    parallel_before_drag = overview.evaluate(parallel_geometry)
    assert max(node['top'] for node in parallel_before_drag) - min(node['top'] for node in parallel_before_drag) <= 2, parallel_before_drag
    assert all(left['right'] < right['left'] for left,right in zip(parallel_before_drag,parallel_before_drag[1:])), parallel_before_drag
    queue_before_drag = overview.evaluate(queue_geometry)
    inline_module = overview.locator('[data-module-kind="todo"]').first
    module_box = inline_module.bounding_box()
    page.mouse.move(module_box["x"] + 30, module_box["y"] + 20)
    page.mouse.down()
    page.mouse.move(module_box["x"] + 75, module_box["y"] + 55, steps=6)
    page.mouse.up()
    moved_box = inline_module.bounding_box()
    assert abs(moved_box["x"] - module_box["x"] - 45) <= 2, moved_box
    assert abs(moved_box["y"] - module_box["y"] - 35) <= 2, moved_box
    assert overview.evaluate(queue_geometry) == queue_before_drag
    moved_transform = inline_module.evaluate("node => node.style.transform")
    page.evaluate("renderAgentSessions()")
    assert inline_module.evaluate("node => node.style.transform") == moved_transform
    page.evaluate("agentSessionNodePositions['unrelated-run:node'] = {x:17,y:23}")
    overview.locator('button[title="Reorganize Recipes"]').click()
    assert inline_module.evaluate("node => node.style.transform") == 'translate(0px, 0px)'
    assert overview.evaluate(queue_geometry) == queue_before_drag, {"before":queue_before_drag,"after":overview.evaluate(queue_geometry)}
    assert page.evaluate("agentSessionNodePositions['unrelated-run:node']") == {"x":17,"y":23}
    assert overview.evaluate(parallel_geometry) == parallel_before_drag
    page.locator('.agent-session-flow > header button[title="Open full-screen Session graph"]').click()
    fullscreen = page.locator('.agent-session-fullscreen')
    assert fullscreen.locator('[data-module-kind="todo"]').count() == len(graph_session["todos"])
    parallel_fullscreen = fullscreen.evaluate(parallel_geometry)
    assert max(node['top'] for node in parallel_fullscreen) - min(node['top'] for node in parallel_fullscreen) <= 2, parallel_fullscreen
    assert fullscreen.locator('[data-session-node]').count() == 1
    page.wait_for_function("document.querySelector('.agent-session-fullscreen .agent-session-structure-edge') !== null")
    branches = fullscreen.locator('.agent-session-structure-edge').evaluate_all(
      "elements => elements.map(element => ({source:element.dataset.structureSource, target:element.dataset.structureTarget, relation:element.dataset.edgeRelation}))")
    queue = [graph_session["sessionId"], *[todo["todoId"] for todo in graph_session["todos"]], graph_session["sessionId"] + ':stop']
    assert len(branches) == len(queue) - 1
    assert [(edge["source"], edge["target"]) for edge in branches] == list(zip(queue, queue[1:])), branches
    assert all(edge["relation"] == 'queue-order' for edge in branches), branches
    assert fullscreen.locator('[data-module-boundary]').count() == 2
    assert fullscreen.locator('[data-queue-boundary]').count() == 2
    boundary_geometry = fullscreen.locator('.agent-session-unified-graph').evaluate("""graph => {
      const rect = graph.getBoundingClientRect(), scale = rect.width / graph.offsetWidth;
      const cards = [...graph.querySelectorAll('.agent-session-unified-node')].map(card => card.getBoundingClientRect());
      let intersections = 0;
      for (const edge of graph.querySelectorAll('.agent-session-module-boundary-edge')) {
        const length = edge.getTotalLength();
        for (let distance = 4; distance < length - 4; distance += 4) {
          const point = edge.getPointAtLength(distance), x = rect.left + point.x * scale, y = rect.top + point.y * scale;
          if (cards.some(card => x > card.left + 1 && x < card.right - 1 && y > card.top + 1 && y < card.bottom - 1)) intersections++;
        }
      }
      const tree = graph.querySelector('.agent-session-recipe-tree-canvas').getBoundingClientRect();
      const start = graph.querySelector('[data-module-boundary="start"]').getBoundingClientRect();
      const complete = graph.querySelector('[data-module-boundary="stop"]').getBoundingClientRect();
      const center = rect => rect.left + rect.width / 2;
      return {intersections, startDelta:Math.abs(center(start)-center(tree)), completeDelta:Math.abs(center(complete)-center(tree)),
        completeGap:complete.top-Math.max(...cards.map(card=>card.bottom)),
        entryPaths:[...graph.querySelectorAll('[data-edge-relation="module-entry"]')].map(edge=>edge.getAttribute('d')),
        exitPaths:[...graph.querySelectorAll('[data-edge-relation="module-exit"]')].map(edge=>edge.getAttribute('d'))};
    }""")
    assert boundary_geometry["intersections"] == 0, boundary_geometry
    assert boundary_geometry["startDelta"] <= 2 and boundary_geometry["completeDelta"] <= 2, boundary_geometry
    assert 20 < boundary_geometry["completeGap"] < 100, boundary_geometry
    assert len(boundary_geometry['entryPaths']) == len(graph_session['todos']), boundary_geometry
    assert len(boundary_geometry['exitPaths']) == len(graph_session['todos']), boundary_geometry
    assert all(path.split()[3::2] == ['V','H','V'] for path in boundary_geometry['entryPaths'] + boundary_geometry['exitPaths']), boundary_geometry
    assert fullscreen.locator('[data-module-boundary="stop"] strong').inner_text() == 'Complete'
    for todo in graph_session["todos"]:
      assert fullscreen.locator(f'[data-todo-node="{todo["todoId"]}"]').get_attribute("data-todo-status") == todo["status"]
    if SCREENSHOT_PATH:
      fullscreen.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("agent-session-no-recipe.png")))

    sketch_session = {
      "sessionId":"session_sketch", "task":"Sketch: two branches, Check join, final Todo", "status":"running",
      "todos":[{"todoId":name,"title":name,"status":"pending","recipeRunIds":["run_" + name]} for name in ["Todo1","Todo2","Check","Todo3"]],
      "runs":[{"runId":"run_" + name,"recipeName":name,"status":"pending","nodes":[
        {"nodeId":"step" + str(index),"state":"pending","dependsOn":[] if index == 1 else [{"from":"step" + str(index - 1)}]}
        for index in range(1,count + 1)]} for name,count in [("Todo1",2),("Todo2",3),("Check",1),("Todo3",1)]],
      "recipeTreeEdges":[
        {"fromRunId":"run_Todo1","fromNodeId":"step2","toRunId":"run_Check","toNodeId":"step1"},
        {"fromRunId":"run_Todo2","fromNodeId":"step3","toRunId":"run_Check","toNodeId":"step1"},
        {"fromRunId":"run_Check","fromNodeId":"step1","toRunId":"run_Todo3","toNodeId":"step1"}],
    }
    page.evaluate(install_graph, sketch_session)
    page.locator('.agent-session-flow > header button[title="Open full-screen Session graph"]').click()
    sketch = page.locator('.agent-session-fullscreen')
    page.wait_for_function("document.querySelectorAll('.agent-session-fullscreen [data-edge-relation=prerequisite]').length === 6")
    sketch_geometry = sketch.evaluate("""graph => {
      const box = todo => graph.querySelector(`[data-recipe-group="${todo}"]`).getBoundingClientRect();
      const first = box('Todo1'), second = box('Todo2'), check = box('Check'), last = box('Todo3');
      const start = graph.querySelector('[data-module-boundary="start"]').getBoundingClientRect();
      const stop = graph.querySelector('[data-module-boundary="stop"]').getBoundingClientRect();
      const columns = todo => [...graph.querySelectorAll(`[data-run-id="run_${todo}"]`)].map(node => node.getBoundingClientRect().left);
      const rect = graph.querySelector('.agent-session-unified-graph').getBoundingClientRect();
      const scale = rect.width / graph.querySelector('.agent-session-unified-graph').offsetWidth;
      const cards = [...graph.querySelectorAll('.agent-session-unified-node')].map(node => node.getBoundingClientRect());
      let ownershipIntersections = 0;
      for (const edge of graph.querySelectorAll('.agent-session-ownership-edge')) {
        for (let distance = 4; distance < edge.getTotalLength() - 4; distance += 4) {
          const point = edge.getPointAtLength(distance), x = rect.left + point.x * scale, y = rect.top + point.y * scale;
          if (cards.some(card => x > card.left + 1 && x < card.right - 1 && y > card.top + 1 && y < card.bottom - 1)) ownershipIntersections++;
        }
      }
      return {firstRight:first.right, secondLeft:second.left, firstTop:first.top, secondTop:second.top,
        branchesBottom:Math.max(first.bottom,second.bottom), checkTop:check.top, checkBottom:check.bottom, lastTop:last.top,
        firstColumns:columns('Todo1'),secondColumns:columns('Todo2'),ownershipIntersections,
        alignedColumns:[...columns('Todo1'),...columns('Check'),...columns('Todo3')],
        boundaryCenterDelta:Math.abs(start.left+start.width/2-stop.left-stop.width/2)};
    }""")
    assert abs(sketch_geometry['firstTop'] - sketch_geometry['secondTop']) <= 2, sketch_geometry
    assert sketch_geometry['firstRight'] < sketch_geometry['secondLeft'], sketch_geometry
    assert sketch_geometry['checkTop'] > sketch_geometry['branchesBottom'], sketch_geometry
    assert sketch_geometry['lastTop'] > sketch_geometry['checkBottom'], sketch_geometry
    assert max(sketch_geometry['firstColumns']) - min(sketch_geometry['firstColumns']) <= 2, sketch_geometry
    assert max(sketch_geometry['secondColumns']) - min(sketch_geometry['secondColumns']) <= 2, sketch_geometry
    assert sketch_geometry['ownershipIntersections'] == 0, sketch_geometry
    assert max(sketch_geometry['alignedColumns']) - min(sketch_geometry['alignedColumns']) <= 2, sketch_geometry
    assert sketch_geometry['boundaryCenterDelta'] <= 2, sketch_geometry
    if SCREENSHOT_PATH:
      sketch.locator('button[title="Zoom out"]').click()
      sketch.locator('button[title="Zoom out"]').click()
      sketch.screenshot(path=str(Path(SCREENSHOT_PATH).with_name('agent-session-sketch.png')))
    sketch.locator('button[title="Close full-screen graph"]').click()

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile_errors = []
    mobile.on("pageerror", lambda error: mobile_errors.append(str(error)))
    open_recipe(mobile)
    assert mobile.locator('.workspace-separator').count() == 4
    assert_single_toolbar_row(mobile)
    mobile.evaluate(install_graph, graph_session)
    assert mobile.locator('.agent-session-overview-graph [data-module-kind="todo"]').count() == len(graph_session["todos"])
    assert mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), "The graph must scroll within its viewport, not widen the phone page"
    mobile.locator('.agent-session-flow > header button[title="Open full-screen Session graph"]').click()
    assert mobile.locator('.agent-session-fullscreen [data-module-kind="todo"]').count() == len(graph_session["todos"])
    close_box = mobile.locator('.agent-session-fullscreen button[title="Close full-screen graph"]').bounding_box()
    assert close_box["x"] >= 0 and close_box["x"] + close_box["width"] <= 390, "The close control must remain inside the phone viewport"
    if SCREENSHOT_PATH:
      mobile.screenshot(path=str(Path(SCREENSHOT_PATH).with_name("agent-session-mobile.png")))
    assert not errors, f"Desktop page errors: {errors}"
    assert not mobile_errors, f"Mobile page errors: {mobile_errors}"
    assert_single_module_and_trash(browser)
    assert_shared_trash_docks(browser)
    assert_automatic_refresh_preserves_interaction(browser)
    browser.close()

print("Recipe browser UI tests passed")
