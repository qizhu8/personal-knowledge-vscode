import importlib.util
import os
import pathlib
import unittest
from unittest.mock import MagicMock


actor_path = pathlib.Path(os.environ.get(
    "PKM_ROOM_UI_ACTOR",
    pathlib.Path(__file__).parent / "next-trial-electron/collaboration-room-user-ui.py",
))
spec = importlib.util.spec_from_file_location("room_ui", actor_path)
actor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(actor)


class WorkbenchFocusTests(unittest.TestCase):
    def page(self, count=1):
        page = MagicMock()
        editor = page.locator.return_value
        editor.count.return_value = count
        editor.bounding_box.return_value = {"x": 100, "y": 100, "width": 600, "height": 400}
        return page, editor

    def test_real_editor_group_shortcut_does_not_click_blank_virtualized_lines(self):
        page, editor = self.page()
        actor.focus_workbench_editor(page)
        page.keyboard.press.assert_called_once_with("Control+1")
        page.mouse.click.assert_called_once_with(180, 112)
        editor.locator.assert_not_called()
        page.wait_for_function.assert_called_once_with(
            "(editor) => editor.contains(document.activeElement)",
            arg=editor.element_handle.return_value,
        )

    def test_ambiguous_editor_is_not_clicked(self):
        page, editor = self.page(2)
        with self.assertRaisesRegex(ValueError, "Exactly one"):
            actor.focus_workbench_editor(page)
        editor.locator.assert_not_called()
        page.keyboard.press.assert_not_called()
        page.mouse.click.assert_not_called()
        page.wait_for_function.assert_not_called()

    def test_focus_must_be_observed_inside_editor(self):
        page, editor = self.page()
        page.wait_for_function.side_effect = TimeoutError("focus remained elsewhere")
        with self.assertRaisesRegex(TimeoutError, "focus remained elsewhere"):
            actor.focus_workbench_editor(page)
        page.keyboard.press.assert_called_once_with("Control+1")
        page.keyboard.insert_text.assert_not_called()

    def test_unrendered_viewport_is_not_clicked_or_typed(self):
        page, editor = self.page()
        editor.bounding_box.return_value = None
        with self.assertRaisesRegex(ValueError, "rendered editor viewport"):
            actor.focus_workbench_editor(page)
        page.mouse.click.assert_not_called()
        page.keyboard.press.assert_not_called()

    def test_notes_panel_is_revealed_after_the_content_editor_takes_focus(self):
        page = MagicMock()
        panel = page.locator.return_value.filter.return_value
        page.locator.return_value.filter.side_effect = lambda **kwargs: panel if kwargs["has_text"].fullmatch("Notes") else MagicMock(count=lambda: 0)
        panel.count.return_value = 1
        panel.is_visible.return_value = True
        self.assertTrue(actor.reveal_product_panel(page))
        panel.click.assert_called_once_with()

    def test_ambiguous_product_tabs_are_not_selected(self):
        page = MagicMock()
        panel = page.locator.return_value.filter.return_value
        panel.count.return_value = 2
        self.assertFalse(actor.reveal_product_panel(page))
        panel.click.assert_not_called()


class ProductWorkspaceNavigationTests(unittest.TestCase):
    def frame(self, visible=False, buttons=1):
        frame, navigation, button = MagicMock(), MagicMock(), MagicMock()
        frame.locator.side_effect = [navigation, button]
        navigation.count.return_value = 1
        navigation.is_visible.return_value = visible
        navigation.get_attribute.return_value = "tab"
        navigation.locator.return_value.get_attribute.return_value = "projects"
        button.count.return_value = buttons
        button.is_visible.return_value = True
        return frame, navigation, button

    def test_hidden_threads_tab_reveals_its_projects_workspace_before_clicking(self):
        frame, navigation, button = self.frame()
        events = []
        button.click.side_effect = lambda: events.append("workspace")
        navigation.click.side_effect = lambda: events.append("tab")
        actor.navigate_product_tab(frame, "chatroom", events.append)
        self.assertEqual(events, ["panel-workspace-reveal-chatroom", "workspace",
                                  "panel-navigation-chatroom", "tab"])
        frame.locator.assert_any_call('#workspace-rail .workspace-button[data-workspace="projects"]')
        navigation.wait_for.assert_called_once_with(state="visible")

    def test_visible_active_tab_does_not_change_workspace(self):
        frame, navigation, button = self.frame(visible=True)
        navigation.get_attribute.return_value = "tab active"
        actor.navigate_product_tab(frame, "chatroom", MagicMock())
        self.assertEqual(frame.locator.call_count, 1)
        button.click.assert_not_called()
        navigation.click.assert_not_called()

    def test_ambiguous_workspace_is_not_clicked(self):
        frame, navigation, button = self.frame(buttons=2)
        with self.assertRaisesRegex(ValueError, "Exactly one visible"):
            actor.navigate_product_tab(frame, "chatroom", MagicMock())
        button.click.assert_not_called()
        navigation.click.assert_not_called()

    def test_missing_workspace_does_not_force_click_the_hidden_tab(self):
        frame, navigation, button = self.frame()
        navigation.locator.return_value.get_attribute.return_value = None
        with self.assertRaisesRegex(ValueError, "actual product workspace"):
            actor.navigate_product_tab(frame, "chatroom", MagicMock())
        button.click.assert_not_called()
        navigation.click.assert_not_called()


class WorkbenchFileDialogTests(unittest.TestCase):
    def test_actual_custom_open_label_is_used_not_a_generic_open_title(self):
        page = MagicMock()
        quick = page.locator.return_value
        quick.count.return_value = 1
        quick.get_by_role.return_value.count.return_value = 1
        fixture = pathlib.Path(__file__).resolve().parents[1] / ".migration-test-work"
        value = str(fixture / "owned-fixture" / "share.bin")
        actor.operate_workbench_file_dialog(page, fixture, "Share to room", value)
        quick.get_by_role.assert_called_once_with("button", name="Share to room", exact=True)
        quick.locator.return_value.first.fill.assert_called_once_with(value)
        quick.locator.return_value.first.press.assert_called_once_with("Enter")

    def test_unrelated_dialog_does_not_receive_the_private_path(self):
        page = MagicMock()
        quick = page.locator.return_value
        quick.count.return_value = 1
        quick.get_by_role.return_value.count.return_value = 1
        quick.get_by_role.return_value.wait_for.side_effect = TimeoutError("wrong dialog")
        fixture = pathlib.Path(__file__).resolve().parents[1] / ".migration-test-work"
        with self.assertRaisesRegex(TimeoutError, "wrong dialog"):
            actor.operate_workbench_file_dialog(page, fixture, "Save shared file", str(fixture / "save.bin"))
        quick.locator.assert_not_called()

    def test_file_dialog_cannot_select_a_path_outside_its_fixture(self):
        page = MagicMock()
        fixture = pathlib.Path(__file__).resolve().parents[1] / ".migration-test-work"
        with self.assertRaisesRegex(ValueError, "only this private fixture"):
            actor.operate_workbench_file_dialog(page, fixture, "Share to room", str(fixture.parent / "outside.bin"))
        page.locator.assert_not_called()

    def test_observed_generic_save_confirmation_is_allowed_only_for_save(self):
        page = MagicMock()
        quick = page.locator.return_value
        quick.count.return_value = 1
        requested, actual = MagicMock(), MagicMock()
        requested.count.return_value = 0
        actual.count.return_value = 1
        quick.get_by_role.side_effect = [requested, actual]
        fixture = pathlib.Path(__file__).resolve().parents[1] / ".migration-test-work"
        actor.operate_workbench_file_dialog(page, fixture, "Save shared file", str(fixture / "save.bin"))
        actual.wait_for.assert_called_once_with(state="visible")
        self.assertEqual(quick.get_by_role.call_args_list[-1].kwargs, {"name": "OK", "exact": True})

    def test_generic_ok_is_not_accepted_for_a_share_dialog(self):
        page = MagicMock()
        quick = page.locator.return_value
        quick.count.return_value = 1
        quick.get_by_role.return_value.count.return_value = 0
        fixture = pathlib.Path(__file__).resolve().parents[1] / ".migration-test-work"
        with self.assertRaisesRegex(ValueError, "observed Workbench file confirmation"):
            actor.operate_workbench_file_dialog(page, fixture, "Share to room", str(fixture / "share.bin"))
        self.assertEqual(quick.get_by_role.call_count, 1)
        quick.locator.assert_not_called()


if __name__ == "__main__":
    unittest.main()
