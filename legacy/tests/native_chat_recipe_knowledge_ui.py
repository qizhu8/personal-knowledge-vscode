import json
import time
from pathlib import Path
from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose):
    fixture = Path(descriptor["root"]).parent
    original = json.loads((fixture / "original-recipe-evidence.json").read_text())
    state_file = fixture / "native-knowledge-ui-state.json"
    choose(frame, descriptor["workerManager"])
    panel = frame.locator("details[data-native-recipes]")
    expect(panel).to_be_visible(timeout=20000)
    if panel.get_attribute("open") is None:
        panel.locator("summary").click()
    if stage == "native-knowledge-start":
        panel.locator(f'[data-native-recipe-id="{original["recipeId"]}"]').click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill(json.dumps({"mode": "complete"}))
        field.press("Enter")
        expect(page.get_by_text("Run this exact Recipe with the installed trusted adapter?", exact=True)).to_be_visible(timeout=15000)
        detail = page.locator(".dialog-message-detail")
        expect(detail).to_contain_text("SATURN installed bound Note.")
        expect(detail).to_contain_text("SATURN installed bound Skill.")
        expect(detail).to_contain_text('"executionAuthority": false')
        approval = json.loads(detail.inner_text().split("\nFresh authority", 1)[0])
        run_id = approval["runId"]
        page.get_by_role("button", name="Run exact native Recipe", exact=True).click()
        expect(panel.locator(f'[data-native-recipe-run-id="{run_id}"]')).to_contain_text("succeeded", timeout=20000)
        state = {"runId": run_id, "knowledgeShownInExactModal": True}
        original_run = original["completedRunId"]
    else:
        state = json.loads(state_file.read_text())
        expect(panel.locator(f'[data-native-recipe-run-id="{state["runId"]}"]')).to_contain_text("succeeded", timeout=20000)
        original_run = original["unknownRunId"]
    panel.locator(f'[data-native-recipe-history="{original_run}"]').click()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and "pkm.recipe.historical-run/v1" not in page.locator("body").inner_text():
        page.wait_for_timeout(100)
    expect(page.locator("body")).to_contain_text("pkm.recipe.historical-run/v1")
    state[stage] = {"inspectedOriginalRun": original_run, "ephemeralDocumentOpened": True}
    state_file.write_text(json.dumps(state))
    print(f"PASS real installed Knowledge modal/run and original-history inspect: {stage}", flush=True)
