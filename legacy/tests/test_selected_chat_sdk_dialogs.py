#!/usr/bin/env python3
"""Offline DOM checks for the private Code SDK journey driver, not an installed test."""
import os
import shutil
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

from selected_chat_sdk_dialogs import STARTED, handle_dialogs


class DialogActions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1] / ".migration-test-work" / f"sdk-dialog-dom-{uuid.uuid4()}"
        cls.root.mkdir(parents=True, mode=0o700)
        cls.old_tmp = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(cls.root)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        if cls.old_tmp is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = cls.old_tmp
        shutil.rmtree(cls.root)

    def setUp(self):
        (self.root / "sdk-trial-information-shown").unlink(missing_ok=True)
        (self.root / "sdk-trial-information-cleared").unlink(missing_ok=True)
        self.page = self.browser.new_page()
        self.events = []

    def tearDown(self):
        self.page.close()

    def act(self):
        return handle_dialogs(self.page, self.root, self.events.append)

    def test_unrelated_notification_does_not_open_center(self):
        self.page.set_content("""
          <div id="status.notifications"><a role="button" aria-label="Notifications"
           onclick="window.opened=true"><span class="codicon-bell-dot">bell</span></a></div>
          <div class="notifications-center" style="display:none"></div>
        """)
        self.assertFalse(self.act())
        self.assertIsNone(self.page.evaluate("window.opened"))

    def test_real_notification_markup_closes_without_escape_race(self):
        self.page.set_content(f"""
          <div class="notifications-center">
            <div class="notification-list-item">
              <span>{STARTED}</span>
              <a role="button" aria-label="Clear Notification (Del)" href="#"
                 onclick="this.closest('.notification-list-item').remove();window.cleared=true">clear</a>
            </div>
            <a role="button" aria-label="Hide Notifications (Escape)"
               onclick="this.parentNode.style.display='none'">hide</a>
          </div>
          <script>window.escapes=0; document.addEventListener('keydown', e => {{
            if(e.key==='Escape') window.escapes++;
          }});</script>
        """)
        self.assertTrue(self.act())
        self.assertTrue(self.page.evaluate("window.cleared"))
        self.assertEqual(self.page.evaluate("window.escapes"), 0)
        self.page.evaluate("""() => {
          let widget=document.createElement('div'); widget.className='quick-input-widget';
          widget.innerHTML='<input><span>Choose an original Chat for the independent Next workspace</span><button>New chat</button>';
          document.body.appendChild(widget);
        }""")
        self.assertTrue(self.act())
        self.assertFalse(self.page.locator(".notifications-center").is_visible())
        self.assertTrue(self.act())
        self.assertEqual(self.events[-1], "selected New chat")

    def test_information_marker_allows_opening_notification_center(self):
        self.page.set_content("""
          <div id="status.notifications"><a role="button" aria-label="Notifications"
           onclick="window.opened=true"><span class="codicon-bell-dot">bell</span></a></div>
          <div class="notifications-center" style="display:none"></div>
        """)
        (self.root / "sdk-trial-information-shown").write_text("shown")
        self.assertTrue(self.act())
        self.assertTrue(self.page.evaluate("window.opened"))

    def test_old_information_marker_does_not_open_center_after_restart(self):
        self.page.set_content("""
          <div id="status.notifications"><a role="button" aria-label="Notifications"
           onclick="window.opened=true"><span class="codicon-bell-dot">bell</span></a></div>
          <div class="notifications-center" style="display:none"></div>
        """)
        (self.root / "sdk-trial-information-shown").write_text("shown")
        self.assertFalse(handle_dialogs(self.page, self.root, self.events.append, phase=2))
        self.assertIsNone(self.page.evaluate("window.opened"))

    def test_optional_menu_escape_targets_its_input_only(self):
        self.page.set_content("""
          <div class="quick-input-widget"><input>
            <div>Create document</div><div>List and edit documents</div>
          </div>
          <script>window.source=''; document.addEventListener('keydown', e => {
            if(e.key==='Escape') window.source=e.target.tagName;
          });</script>
        """)
        self.assertTrue(self.act())
        self.assertEqual(self.page.evaluate("window.source"), "INPUT")

    def test_exact_arguments_and_sdk_model_selection(self):
        self.page.set_content("""
          <div class="quick-input-widget"><span>Exact program arguments as a JSON string array</span>
            <input onkeydown="if(event.key==='Enter')window.argumentsSubmitted=this.value">
          </div>
        """)
        self.assertTrue(self.act())
        self.assertIn(str(self.root / "background.cjs"), self.page.evaluate("window.argumentsSubmitted"))
        self.page.set_content("""
          <div class="quick-input-widget"><input>
            <span>Choose a Copilot SDK model for the independent Chat</span>
            <button onclick="window.chosen=this.textContent">Local SDK fixture · Copilot SDK</button>
          </div>
        """)
        self.assertTrue(self.act())
        self.assertEqual(self.page.evaluate("window.chosen"), "Local SDK fixture · Copilot SDK")

    def test_cleared_information_does_not_reopen_unrelated_notifications(self):
        self.page.set_content("""
          <div id="status.notifications"><a role="button" aria-label="Notifications"
           onclick="window.opened=true"><span class="codicon-bell-dot">bell</span></a></div>
          <div class="notifications-center" style="display:none"></div>
        """)
        (self.root / "sdk-trial-information-shown").write_text("shown")
        (self.root / "sdk-trial-information-cleared").write_text("cleared")
        self.assertFalse(self.act())
        self.assertIsNone(self.page.evaluate("window.opened"))


if __name__ == "__main__":
    unittest.main()
