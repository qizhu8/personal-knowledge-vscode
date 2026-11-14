import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { capture, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const source = process.env.PKM_TEST_LEGACY_RECIPE_METADATA_PROFILE;
const incomplete = process.env.PKM_TEST_LEGACY_RECIPE_INCOMPLETE_METADATA_PROFILE;
const skip = !source && "Requires an actually closed original installed MCP metadata profile.";
function copy(t, profile) {
  assert(fs.realpathSync(profile).startsWith(path.resolve(".migration-test-work") + path.sep));
  const base = path.resolve(`.migration-test-work/recipe-metadata-${randomUUID()}`);
  fs.mkdirSync(base, { mode: 0o700 });
  const root = path.join(base, "knowledge");
  const mask = process.umask(0o077);
  try { fs.cpSync(path.join(profile, "knowledge"), root, { recursive: true }); }
  finally { process.umask(mask); }
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return root;
}
test("actual original compact Recipe metadata is archived byte-for-byte, never execution authority", { skip }, async t => {
  const root = copy(t, source), before = capture(root);
  const { inspectLegacyUiRetiredState } = await load("legacy-ui-retired-state");
  const proof = inspectLegacyUiRetiredState(root);
  assert.equal(proof.metadataAuthority, "archive_only");
  assert.equal(proof.components.telemetry, "completed-lifecycle-and-recipe-metadata-only");
  assert(proof.files.some(item => item.path.includes("mcp-usage/events/")));
  assert.deepEqual(capture(root), before);
});
test("actual metadata usage rejects failures, version/token changes, executable leaves and facade/leaf identity mixing", { skip }, async t => {
  const root = copy(t, source), state = path.join(root, ".pkm/state");
  const { inspectLegacyUiRetiredState } = await load("legacy-ui-retired-state");
  const usage = fs.readdirSync(path.join(state, "mcp-usage/events")).map(name => {
    const file = path.join(state, "mcp-usage/events", name);
    return { file, raw: fs.readFileSync(file), value: JSON.parse(fs.readFileSync(file)) };
  });
  const leaf = usage.find(item => item.value.toolName === "recipe_search");
  const wrapper = usage.find(item => item.value.toolName === "capability_read");
  assert(leaf && wrapper);
  for (const [item, modify] of [
    [leaf, value => { value.success = false; }],
    [leaf, value => { value.toolName = "recipe_run_get"; value.domain = "knowledge"; }],
    [leaf, value => { value.reportedTokens.output = 1; }],
    [leaf, value => { value.executionAuthority = true; }],
    [wrapper, value => { value.capabilityVersion = 2; }],
    [wrapper, value => { value.toolName = "capability_call"; }],
  ]) {
    const changed = structuredClone(item.value); modify(changed);
    fs.writeFileSync(item.file, JSON.stringify(changed));
    assert.throws(() => inspectLegacyUiRetiredState(root));
    fs.writeFileSync(item.file, item.raw);
  }
  const streams = fs.readdirSync(path.join(state, "diagnostics/mcp")).map(name => path.join(state, "diagnostics/mcp", name));
  const stream = streams.find(file => fs.readFileSync(file, "utf8").includes('"tool":"recipe_search"'));
  const raw = fs.readFileSync(stream, "utf8");
  for (const modify of [
    rows => rows.forEach(row => { if (row.tool === "recipe_search") row.requestId = "f".repeat(24); }),
    rows => rows.forEach(row => { if (row.tool === "recipe_search") row.tool = "recipe_run_get"; }),
    rows => rows.filter(row => row.tool !== "mcp_lifecycle_quiesce"),
    rows => rows.forEach(row => { if (row.tool === "recipe_search") row.dropped = 1; }),
  ]) {
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    const changed = modify(rows) || rows;
    fs.writeFileSync(stream, changed.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.throws(() => inspectLegacyUiRetiredState(root));
    fs.writeFileSync(stream, raw);
  }
  assert(inspectLegacyUiRetiredState(root));
});
test("actual original metadata client without a complete owned quiesce remains blocked", {
  skip: !incomplete && "Requires an actual incomplete original MCP metadata attempt.",
}, async t => {
  const root = copy(t, incomplete);
  const { inspectLegacyUiRetiredState } = await load("legacy-ui-retired-state");
  assert.throws(() => inspectLegacyUiRetiredState(root), /handoff are incomplete/);
});
