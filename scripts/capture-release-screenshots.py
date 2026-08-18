#!/usr/bin/env python3
"""Capture privacy-safe release screenshots from the real built PKM webview."""
import argparse
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCREENSHOTS = ROOT / "resources" / "screenshots"


def wait_for_server(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"Preview server did not become ready: {url}")


def assert_private_demo(page, route: str, require_markers: bool = True) -> None:
    body = page.locator("body").inner_text()
    required = {
        "config": ["/home/demo/", "PKM Integration Status"],
        "chat": ["Release Planning", "Docs Reviewer"],
        "papers": [],
    }[route]
    if require_markers:
        for value in required:
            if value not in body:
                raise RuntimeError(f"Synthetic fixture missing required marker: {value}")
        if route == "papers":
            keys = page.evaluate("() => (typeof currentGraphData !== 'undefined' ? currentGraphData?.nodes || [] : []).map(node => node.key)")
            if not keys or any(not str(key).startswith("demo/") for key in keys):
                raise RuntimeError("Privacy guard rejected non-demo Papers graph data")
    if route == "chat":
        names = page.evaluate("() => (chat.active?.members || []).map(member => member.user)")
        allowed = {"Release Host", "Docs Reviewer", "QA Agent", "Build Monitor"}
        if set(names) - allowed:
            raise RuntimeError(f"Privacy guard rejected non-demo Chatroom identities: {set(names) - allowed}")


def capture_page(page, route: str, output: str) -> None:
    page.goto(f"http://127.0.0.1:4178/{route}", wait_until="networkidle")
    wait_until_ready(page)
    assert_private_demo(page, route)
    target = SCREENSHOTS / output
    page.screenshot(path=str(target), full_page=False)
    validate_image_metadata(target)


def install_cursor(page) -> None:
    page.evaluate("""() => {
      let cursor = document.getElementById('release-cursor');
      if (!cursor) {
        cursor = document.createElement('div'); cursor.id = 'release-cursor';
        cursor.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;border:2px solid #fff;border-radius:50%;background:#0078d4cc;box-shadow:0 2px 8px #000;z-index:10000;pointer-events:none;transform:translate(-50%,-50%);transition:left .22s ease,top .22s ease';
        document.body.appendChild(cursor);
      }
    }""")


def wait_until_ready(page) -> None:
    page.wait_for_function("!document.getElementById('loading-banner') || document.getElementById('loading-banner').classList.contains('hidden')")


def move_cursor(page, locator) -> None:
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    if not box:
        raise RuntimeError("Could not locate animation target")
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.evaluate("([x,y]) => { const cursor=document.getElementById('release-cursor'); cursor.style.left=x+'px'; cursor.style.top=y+'px'; }", [x, y])
    page.mouse.move(x, y)
    page.wait_for_timeout(260)


def install_lesson_rail(page, title: str, steps) -> None:
    page.evaluate("([title,steps]) => { document.body.style.paddingRight='370px'; let rail=document.getElementById('release-lessons'); if(rail)rail.remove(); rail=document.createElement('aside');rail.id='release-lessons';rail.style.cssText='position:fixed;right:0;top:0;bottom:0;width:370px;padding:24px 20px;background:#151515;border-left:1px solid #343434;color:#ddd;z-index:9998;overflow:auto;font:13px Segoe UI,sans-serif'; const items=steps.map((step,index)=>'<li data-step=\"'+index+'\" style=\"display:grid;grid-template-columns:26px 1fr;gap:9px;padding:11px 10px;margin:7px 0;border:1px solid #343434;border-radius:5px;background:#1f1f1f\"><span class=\"lesson-number\" style=\"display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid #777;border-radius:50%;font-size:11px\">'+(index+1)+'</span><span><strong style=\"display:block;color:#ddd\">'+step[0]+'</strong><small style=\"display:block;margin-top:4px;color:#999;line-height:1.45\">'+step[1]+'</small></span></li>').join(''); rail.innerHTML='<div style=\"font-size:10px;color:#66b7f1;text-transform:uppercase;letter-spacing:.08em\">Interactive guide</div><h2 style=\"font-size:18px;margin:6px 0 14px;color:#fff\">'+title+'</h2><ol style=\"list-style:none;padding:0;margin:0\">'+items+'</ol><div style=\"margin-top:14px;font-size:10px;color:#777\">Synthetic demo data · privacy-safe release capture</div>';document.body.appendChild(rail); }", [title, steps])


def set_lesson_step(page, index: int) -> None:
    page.evaluate("index => document.querySelectorAll('#release-lessons li').forEach((item,i)=>{const done=i<index,active=i===index;item.style.borderColor=active?'#0078d4':done?'#2e8b57':'#343434';item.style.background=active?'#082f49':done?'#173524':'#1f1f1f';const marker=item.querySelector('.lesson-number');marker.textContent=done?'✓':String(i+1);marker.style.color=active?'#66b7f1':done?'#4ade80':'#aaa';})", index)


def remove_lesson_rail(page) -> None:
    page.evaluate("() => { document.getElementById('release-lessons')?.remove(); document.body.style.paddingRight=''; window.dispatchEvent(new Event('resize')); if(typeof cy !== 'undefined' && cy){cy.resize();cy.fit(undefined,36);} }")


def frame(page, directory: Path, index: int) -> int:
    page.screenshot(path=str(directory / f"frame-{index:03d}.png"), full_page=False)
    return index + 1


def write_gif(directory: Path, output: str, duration: int = 420) -> None:
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is unavailable; skipping GIF. Install Pillow to enable --gif.", file=sys.stderr)
        return
    images = [Image.open(item).convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for item in sorted(directory.glob("*.png"))]
    images[0].save(SCREENSHOTS / output, save_all=True, append_images=images[1:], duration=duration, loop=0, optimize=True)
    validate_image_metadata(SCREENSHOTS / output)
    for item in directory.glob("*.png"):
        item.unlink()
    directory.rmdir()


def validate_image_metadata(file_path: Path) -> None:
    from PIL import Image
    with Image.open(file_path) as image:
        metadata = {key: str(value) for key, value in image.info.items() if key not in {"duration", "loop", "background", "version", "extension"}}
    if metadata:
        raise RuntimeError(f"Unexpected release media metadata in {file_path.name}: {metadata}")


def capture_chat_gif(page) -> None:
    frames_dir = SCREENSHOTS / ".chatroom-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    page.goto("http://127.0.0.1:4178/chat", wait_until="networkidle")
    wait_until_ready(page)
    assert_private_demo(page, "chat")
    install_cursor(page)
    steps = [
        ["Copy the Magic Link", "Click Invite beside the hosted Room."],
        ["Give it to an Agent", "Paste the complete invite and assign an exact Agent name."],
        ["Select Docs Reviewer", "Use To autocomplete instead of hand-typing a spaced alias."],
        ["Send the first task", "The Agent changes from standby to working, responds, then returns."],
        ["Select QA Agent", "Start a second directed round with another Agent."],
        ["Send the second task", "Observe working, response, and standby again."],
    ]
    install_lesson_rail(page, "Chatroom: Invite and Direct Agents", steps)
    static_guide = SCREENSHOTS / "chatroom-guide.png"
    page.screenshot(path=str(static_guide), full_page=False)
    validate_image_metadata(static_guide)
    remove_lesson_rail(page)
    index = 0
    invite = page.locator("#chat-hub-info a", has_text="Invite")
    move_cursor(page, invite); index = frame(page, frames_dir, index); invite.click()
    page.wait_for_timeout(250)
    details = page.evaluate("() => new Promise(resolve => { const handler=e=>{window.removeEventListener('releaseInviteCopied',handler);resolve(e.detail)}; window.addEventListener('releaseInviteCopied',handler); document.querySelector('#chat-hub-info a')?.click(); })")
    index = frame(page, frames_dir, index)
    for round_index, (agent, prompt) in enumerate([
        ("Docs Reviewer", "Review the installation guide and version table."),
        ("QA Agent", "Run the release regression checklist."),
    ], start=1):
        all_chip = page.locator("#chat-recipient-chips .chat-recipient-chip", has_text="@all")
        if all_chip.count():
            remove = all_chip.locator("button")
            move_cursor(page, remove); remove.click(); page.wait_for_timeout(150)
        recipient = page.locator("#chat-recipient-input")
        move_cursor(page, recipient); recipient.fill("@" + agent[:4]); page.wait_for_timeout(200)
        option = page.locator("#chat-mention-pop .chat-mrow", has_text=agent).first
        move_cursor(page, option); index = frame(page, frames_dir, index); option.click()
        composer = page.locator("#chat-input")
        move_cursor(page, composer); composer.fill(prompt); index = frame(page, frames_dir, index)
        send = page.locator("#chat-send-btn")
        move_cursor(page, send); send.click(); page.wait_for_timeout(250); index = frame(page, frames_dir, index)
        page.wait_for_timeout(450); index = frame(page, frames_dir, index)
        page.wait_for_timeout(900); index = frame(page, frames_dir, index)
    frame(page, frames_dir, index)
    write_gif(frames_dir, "chatroom.gif", 1000)


def capture_papers_gif(page) -> None:
    frames_dir = SCREENSHOTS / ".papers-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    page.goto("http://127.0.0.1:4178/papers", wait_until="networkidle")
    wait_until_ready(page)
    assert_private_demo(page, "papers", require_markers=False)
    install_cursor(page)
    steps = [
        ["Open Graph", "Render the selected synthetic Paper collection."],
        ["Drag a 2D node", "Reposition a Paper with direct manipulation."],
        ["Zoom the 2D graph", "Use the mouse wheel to inspect dense areas."],
        ["Click a 2D Paper", "Open a Paper directly from its graph node."],
        ["Switch to 3D", "Use the same citation data in the WebGL renderer."],
        ["Rotate and zoom 3D", "Drag the scene, zoom, then click a node."],
    ]
    install_lesson_rail(page, "Papers: Explore 2D and 3D Graphs", steps)
    set_lesson_step(page, 0)
    graph_button = page.locator("#btn-paper-graph")
    move_cursor(page, graph_button)
    index = frame(page, frames_dir, 0)
    graph_button.click()
    page.wait_for_selector("#paper-graph-view:not(.hidden)")
    page.wait_for_timeout(1000)
    assert_private_demo(page, "papers")
    static_guide = SCREENSHOTS / "papers-graph-guide.png"
    page.screenshot(path=str(static_guide), full_page=False)
    validate_image_metadata(static_guide)
    remove_lesson_rail(page)
    page.wait_for_timeout(350)
    index = frame(page, frames_dir, index)
    canvas = page.locator("#pg-canvas")
    canvas_box = canvas.bounding_box()
    node = page.evaluate("() => { const n=cy.nodes()[0]; const p=n.renderedPosition(); return {x:p.x,y:p.y}; }")
    start_x, start_y = canvas_box["x"] + node["x"], canvas_box["y"] + node["y"]
    page.mouse.move(start_x, start_y); page.mouse.down(); page.mouse.move(start_x + 150, start_y + 75, steps=12); page.mouse.up(); page.wait_for_timeout(300)
    index = frame(page, frames_dir, index)
    page.mouse.move(canvas_box["x"] + canvas_box["width"] / 2, canvas_box["y"] + canvas_box["height"] / 2)
    page.mouse.wheel(0, -520); page.wait_for_timeout(350); index = frame(page, frames_dir, index)
    page.mouse.wheel(0, 320); page.wait_for_timeout(300); index = frame(page, frames_dir, index)
    node = page.evaluate("() => { const n=cy.nodes()[1]; const p=n.renderedPosition(); return {x:p.x,y:p.y}; }")
    page.mouse.click(canvas_box["x"] + node["x"], canvas_box["y"] + node["y"]); page.wait_for_timeout(250); index = frame(page, frames_dir, index)
    toggle = page.locator("#pg-3d")
    move_cursor(page, toggle)
    index = frame(page, frames_dir, index)
    toggle.check()
    page.wait_for_timeout(1600)
    index = frame(page, frames_dir, index)
    canvas3d = page.locator("#pg-canvas canvas").first
    box3d = canvas3d.bounding_box()
    center_x, center_y = box3d["x"] + box3d["width"] / 2, box3d["y"] + box3d["height"] / 2
    page.mouse.move(center_x, center_y); page.mouse.down(); page.mouse.move(center_x + 180, center_y + 80, steps=14); page.mouse.up(); page.wait_for_timeout(400); index = frame(page, frames_dir, index)
    page.mouse.wheel(0, -650); page.wait_for_timeout(450); index = frame(page, frames_dir, index)
    page.mouse.wheel(0, 380); page.wait_for_timeout(350); index = frame(page, frames_dir, index)
    page.mouse.click(center_x, center_y); page.wait_for_timeout(350); index = frame(page, frames_dir, index)
    frame(page, frames_dir, index)
    write_gif(frames_dir, "papers-graph.gif", 520)


def capture_installation_gif(page) -> None:
    frames_dir = SCREENSHOTS / ".installation-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    page.goto("http://127.0.0.1:4178/config", wait_until="networkidle")
    wait_until_ready(page)
    assert_private_demo(page, "config")
    install_cursor(page)
    index = 0
    steps = [
        ("1 — Check component versions", "Server, Knowledge, Chat, and Skill Router versions are independent. Orange means action is required.", ".mcp-version-table"),
        ("2 — Verify resolved paths", "Confirm the Knowledge Root, environment root, runtime, Python, and generated server directory.", ".mcp-paths"),
        ("3 — Follow Setup guideline", "Complete each row from top to bottom. Green checks are already done.", ".mcp-setup-guide"),
        ("4 — Select Python 3.10+", "Validate a machine-local Python, then create or repair the isolated pkm-mcp runtime.", "#mcp-python-path"),
        ("5 — Generate server code", "Generate server.py, chat_server.py, and requirements.txt. Current code needs no highlighted action.", "#mcp-regenerate-server-code"),
        ("6 — Register external Agency", "VS Code registers pkm automatically when supported. External Agencies use the copyable instructions.", "#mcp-agency-registration"),
        ("7 — Verify Running", "Start pkm from MCP: List Servers. The dashboard process light turns green when server.py is detected.", ".mcp-running"),
    ]
    rail_steps = [[title.split('—',1)[-1].strip(), description] for title, description, _ in steps]
    install_lesson_rail(page, "Install and Verify PKM MCP", rail_steps)
    static_guide = SCREENSHOTS / "installation-guide.png"
    page.screenshot(path=str(static_guide), full_page=False)
    validate_image_metadata(static_guide)
    remove_lesson_rail(page)
    for step_index, (_title, _description, selector) in enumerate(steps):
        target = page.locator(selector)
        move_cursor(page, target)
        index = frame(page, frames_dir, index)
    frame(page, frames_dir, index)
    write_gif(frames_dir, "installation-guide.gif", 900)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gif", action="store_true", help="Also capture Chatroom, Papers graph, and installation GIFs")
    parser.add_argument("--no-build", action="store_true", help="Reuse the existing dist/ bundle")
    args = parser.parse_args()
    if not args.no_build:
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(["node", "scripts/release-preview-server.js"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        wait_for_server("http://127.0.0.1:4178/config")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
            capture_page(page, "config", "config-dashboard.png")
            capture_page(page, "chat", "chatroom.png")
            if args.gif:
                capture_chat_gif(page)
                capture_papers_gif(page)
                capture_installation_gif(page)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    print("Captured privacy-safe release screenshots in resources/screenshots/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
