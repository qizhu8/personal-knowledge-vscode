import assert from "node:assert/strict";
import { test } from "node:test";
import { chatToolRoundLimit, chatToolRoundBudgetNotice } from "../dist/domain/chat-turn-original.js";
import { originalAssertions } from "./chat-turn-original-capture.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

test("exact original pure round-limit assertion and budget reducers", () => {
  for (const body of originalAssertions) Function("assert", "chatToolRoundLimit", body)(assert, chatToolRoundLimit);
  for (const value of [0, -1, 1001, 1.5, NaN, "2", null]) assert.throws(() => chatToolRoundLimit(value));
  assert.equal(chatToolRoundBudgetNotice(0), undefined);
  assert.match(chatToolRoundBudgetNotice(0, 2), /remaining=2/);
  assert.match(chatToolRoundBudgetNotice(2, 2), /only summary allowed/);
  assert.throws(() => chatToolRoundBudgetNotice(3, 2));
});

test("capture provenance resolves original and captured files under their proper roots", async () => {
  const manifest = JSON.parse(await readFile(new URL("../migration/chat-turn-provenance.json", import.meta.url), "utf8"));
  assert.equal(manifest.sourceRoot, "..");
  assert.equal(manifest.capturedRoot, ".");
  const digest = value => createHash("sha256").update(value).digest("hex");
  for (const entry of manifest.files) {
    assert.equal(digest(await readFile(new URL(`../../${entry.source}`, import.meta.url))), entry.sourceSha256);
    assert.equal(digest(await readFile(new URL(`../${entry.captured}`, import.meta.url))), entry.capturedSha256);
  }
});
