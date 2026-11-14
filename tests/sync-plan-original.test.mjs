import assert from "node:assert/strict";
import { test } from "node:test";
import { githubSyncIgnoredPath, githubSyncUnrecordedAbsenceNeedsReview, planGitHubSyncPublication } from "../dist/domain/sync-plan-original.js";

for (const ignored of ["__pycache__/module.cpython-311.pyc", "nested/module.pyc", "nested/module.pyo", ".venv/bin/python", "node_modules/package/index.js", ".git/config", ".pytest_cache/data", ".DS_Store", "Thumbs.db"]) assert(githubSyncIgnoredPath(ignored), ignored);
for (const retained of ["module.py", "native.pyd", "target/tool", "bin/tool", "objects/data.json", "cache-notes.md"]) assert(!githubSyncIgnoredPath(retained), retained);
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, true, false, false), true, "A previously synchronized file missing locally must not be silently resurrected from Remote");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, false, false, false), true, "A missing remote baseline entity must not be silently republished either");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, true, true, false), false, "Explicit local deletion proceeds through three-way deletion reconciliation");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, false, false, true), false, "Explicit remote deletion proceeds through three-way deletion reconciliation");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(false, false, true, false, false), false, "A genuine new remote entity may still be pulled on initial sync");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, true, false, false), false);
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, false, false, false), false);

test("pure planner isolates required groups and portable destination collisions without mutating inputs", () => {
  const remote = new Map([["a", [{ path: "notes/old.md" }]], ["b", [{ path: "notes/other.md" }]]]);
  const candidates = new Map([["a", [{ path: "notes/new.md" }]], ["b", [{ path: "NOTES/NEW.md" }]],
    ["recipe", [{ path: "recipes/recipe.json" }]], ["safe", [{ path: "notes/safe.md" }]]]);
  const before = JSON.stringify([...candidates]);
  const result = planGitHubSyncPublication(candidates, remote, new Set(), new Map([["recipe", new Set(["a"])]]));
  assert.deepEqual([...result.blocked].sort(), ["a", "b", "recipe"]);
  assert.deepEqual(result.files.map(file => file.path).sort(), ["notes/old.md", "notes/other.md", "notes/safe.md"]);
  assert.equal(JSON.stringify([...candidates]), before);
});
