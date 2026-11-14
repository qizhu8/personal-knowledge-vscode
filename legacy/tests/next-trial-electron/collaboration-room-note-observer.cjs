"use strict";
const assert = require("node:assert/strict"), path = require("node:path");

module.exports = (filestore, original) => {
  const canonical = original.markdownPath.replace(/\\/g, "/");
  const alias = "note:" + canonical.replace(/\.md$/i, "").normalize("NFC");
  const matches = filestore.noteList("all", 10000, true).filter(note => note.aliases?.includes(alias));
  assert.equal(matches.length, 1, "Exactly one original Note must preserve the canonical legacy alias.");
  const note = matches[0], relative = note.slug + ".md";
  assert.equal(path.posix.normalize(relative), relative, "Saved original Note path must remain portable.");
  assert.equal(path.posix.dirname(relative), path.posix.dirname(canonical), "Saved original Note must remain in its Meeting collection.");
  assert.equal(typeof note.content, "string");
  return { content: note.content, path: relative, knowledgeId: note.knowledgeId };
};
