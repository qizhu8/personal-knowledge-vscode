"""Drive the isolated SDK journey using VS Code's actual workbench controls."""
import json


STARTED = "Isolated PKM Next trial started. External writers remain unknown; no cutover was performed."


def handle_dialogs(page, root, trace, phase=1):
    for button in ["Create Trial", "Reopen Chat", "Open Independent Chat", "Discover SDK Models"]:
        item = page.get_by_role("button", name=button, exact=True)
        if item.count() and item.first.is_visible():
            item.first.click(timeout=2000)
            trace("clicked " + button)
            return True

    for container in [".notifications-toasts", ".notifications-center"]:
        notices = page.locator(container + " .notification-list-item").filter(has_text=STARTED)
        for index in range(notices.count()):
            notice = notices.nth(index)
            if not notice.is_visible():
                continue
            notice.hover(timeout=2000)
            clear = notice.get_by_role("button", name="Clear Notification (Del)", exact=True)
            if clear.count():
                clear.first.click(timeout=2000)
                (root / "sdk-trial-information-cleared").write_text("cleared")
                trace("cleared isolated trial information")
                return True

    center = page.locator(".notifications-center")
    widget = page.locator(".quick-input-widget")
    if center.is_visible() and widget.is_visible():
        center.get_by_role("button", name="Hide Notifications (Escape)", exact=True).click(timeout=2000)
        trace("hid notifications")
        return True
    # Do not open the center for unrelated startup notifications. This marker
    # records an actual call to the original information API, not a response.
    if (phase == 1 and (root / "sdk-trial-information-shown").exists()
            and not (root / "sdk-trial-information-cleared").exists() and not center.is_visible()):
        if page.locator('#status\\.notifications .codicon-bell-dot').is_visible():
            page.get_by_role("button", name="Notifications", exact=True).click(timeout=2000)
            trace("opened notifications")
            return True

    if not widget.count() or not widget.first.is_visible():
        return False
    text = widget.first.inner_text()
    if "Exact program arguments as a JSON string array" in text:
        entry = widget.first.locator("input").first
        entry.fill(json.dumps([str(root / "background.cjs")]))
        entry.press("Enter")
        trace("entered exact arguments")
        return True
    for title, choice in [
        ("Choose an original Chat for the independent Next workspace", "New chat"),
        ("Choose the independent Chat process scope", "Allow one exact program and argument list"),
        ("Choose the independent Chat model source", "Choose a VS Code or Copilot SDK model for this session"),
        ("Choose a VS Code model for the independent Chat", "Discover Copilot SDK models"),
        ("Choose a Copilot SDK model for the independent Chat", "Local SDK fixture"),
    ]:
        if title in text:
            choices = widget.first.get_by_text(choice, exact=(choice != "Local SDK fixture"))
            for index in range(choices.count()):
                item = choices.nth(index)
                if item.is_visible():
                    item.click(timeout=2000)
                    trace("selected " + choice)
                    return True
    if "Create document" in text and "List and edit documents" in text:
        widget.first.locator("input").first.press("Escape")
        trace("dismissed optional trial menu")
        return True
    return False
