const assert = require("node:assert/strict");
const { LF_TEXT_EXTENSIONS, textNewlinePolicy, normalizeTextNewlines, convertTextNewlines } = require("../dist/knowledge/text-format");

for (const extension of LF_TEXT_EXTENSIONS) {
  for (const filename of [`scripts/sample${extension}`, `C:\\notes\\SAMPLE${extension.toUpperCase()}`]) {
    assert.equal(textNewlinePolicy(filename), "lf");
    assert(normalizeTextNewlines(filename, Buffer.from("\uFEFFfirst\r\nsecond\nlast\r"))
      .equals(Buffer.from("\uFEFFfirst\nsecond\nlast\r")));
  }
}
for (const filename of ["file", "file.unknown", "image.png", "binary.dll", "archive.zip", "paper.pdf"]) {
  assert.equal(textNewlinePolicy(filename), "preserve");
  const original = Buffer.from("looks like text\r\n");
  assert.strictEqual(normalizeTextNewlines(filename, original), original);
}
for (const original of [Buffer.from([0xff, 13, 10]), Buffer.from("UTF-16\0\r\n")]) {
  assert.strictEqual(normalizeTextNewlines("file.md", original), original);
  assert.throws(() => convertTextNewlines(original, "lf"), /valid UTF-8/);
  assert.throws(() => convertTextNewlines(original, "crlf"), /valid UTF-8/);
}
for (const prefix of ["", "\uFEFF"]) {
  const mixed = Buffer.from(prefix + "one\r\ntwo\nthree\r\nlast");
  const lf = Buffer.from(prefix + "one\ntwo\nthree\nlast");
  const crlf = Buffer.from(prefix + "one\r\ntwo\r\nthree\r\nlast");
  assert(convertTextNewlines(mixed, "lf").equals(lf));
  assert(convertTextNewlines(mixed, "crlf").equals(crlf));
  assert.strictEqual(convertTextNewlines(lf, "lf"), lf);
  assert.strictEqual(convertTextNewlines(crlf, "crlf"), crlf);
  assert(convertTextNewlines(convertTextNewlines(crlf, "lf"), "crlf").equals(crlf));
  assert(convertTextNewlines(Buffer.from(prefix + "no final newline"), "lf")
    .equals(Buffer.from(prefix + "no final newline")));
}
assert.throws(() => convertTextNewlines(Buffer.from("text"), "invalid"), /Unsupported/);
console.log("Extension LF rules, BOM preservation, mixed-line conversion, round trips, idempotency and byte-sensitive exclusions passed.");
