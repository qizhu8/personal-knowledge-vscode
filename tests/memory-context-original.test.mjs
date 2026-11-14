import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as original from "../dist/domain/memory-context-selection.js";

const require = createRequire(import.meta.url);
const fixture = await readFile(new URL("../legacy/tests/test-chat-memory-recall.js", import.meta.url), "utf8");
vm.compileFunction(fixture, ["require"], { filename: "original/tests/test-chat-memory-recall.js" })(name => {
  if (name === "../dist/chat/chat-memory") return original;
  if (name === "node:test" || name === "node:assert/strict") return require(name);
  throw new Error(`Unexpected dependency in original memory fixture: ${name}`);
});
