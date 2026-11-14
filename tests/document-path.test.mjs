import { test } from "node:test";
import assert from "node:assert/strict";
import { documentPath, resourcePath } from "../dist/document-path.js";

test("portable paths accept well-formed Unicode and reject lone surrogates before filesystem/URI encoding", () => {
  for (const path of ["Folder/\u8bbe\u8ba1.md", "Folder/\uD83D\uDCCE.md"]) assert(documentPath.safeParse(path).success);
  for (const path of ["Folder/\uD800.md", "Folder/\uDC00.md", "Folder/\uD800x.md"]) assert(!documentPath.safeParse(path).success);
  assert(resourcePath.safeParse("Doc.assets/\uD83D\uDE00.png").success);
  assert(!resourcePath.safeParse("Doc.assets/\uD800.png").success);
});

test("portable paths measure component and total limits in UTF-8 bytes, not character-count proxies", () => {
  const component = `${"\u6c49".repeat(84)}.md`;
  assert.equal(Buffer.byteLength(component, "utf8"), 255);
  assert(documentPath.safeParse(component).success);
  assert(!documentPath.safeParse(`x${component}`).success);
  const exact = [...Array(8).fill("\u6c49".repeat(84)), `${"b".repeat(21)}.md`].join("/");
  assert.equal(Buffer.byteLength(exact, "utf8"), 2048);
  assert(exact.length < 2048);
  assert(documentPath.safeParse(exact).success);
  assert(!documentPath.safeParse(`x${exact}`).success);
});
