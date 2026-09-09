#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const storage = require("../dist/storage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-prompt-note-"));
try {
  storage.setStorePath(root);
  const versionDir = path.join(root, "prompts", "Ads", "Accuracy", "v9");
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, "base.jinja2"), "BASE {{ Language }}", "utf8");
  fs.writeFileSync(path.join(versionDir, "prompt.jinja2"), "{# PROMPT_METADATA\ntitle: Accuracy\nnote:\nOld note\n#}\n{% extends 'base.jinja2' %}", "utf8");

  const overwrite = storage.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "Reviewed in place");
  assert.strictEqual(overwrite.version, "v9");
  assert.strictEqual(storage.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2").meta.note, "Reviewed in place");

  const created = storage.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "New version note", "v9.1");
  assert.strictEqual(created.version, "v9.1");
  assert.strictEqual(fs.readFileSync(path.join(root, "prompts", "Ads", "Accuracy", "v9.1", "base.jinja2"), "utf8"), "BASE {{ Language }}");
  assert.strictEqual(storage.promptGetFile("Ads", "Accuracy", "v9.1", "prompt.jinja2").meta.note, "New version note");
  assert.strictEqual(storage.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2").meta.note, "Reviewed in place");
  assert.throws(() => storage.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "x", "v9.1"), /already exists/);
  assert.throws(() => storage.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "x", "latest"), /Version must look/);
  assert.throws(() => storage.promptFilePath("..", "..", "..", "etc/passwd"), /escapes/);
  console.log("Prompt version note test: overwrite, full-directory clone, metadata preservation, and path/version validation OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}