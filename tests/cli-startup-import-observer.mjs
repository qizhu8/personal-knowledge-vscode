import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";

const root = new URL("../dist/", import.meta.url);
const seen = new Set();
if (process.env.PKM_TEST_CLI_NATIVE_NOTES_ONLY === "1") {
  const spawn = childProcess.spawn;
  childProcess.spawn = function(command, args, ...rest) {
    if (Array.isArray(args) && args.some(value =>
      /(?:^|[/\\])(?:legacy-note-inventory|legacy-knowledge-mcp|legacy-compact-mcp)\.py$/.test(String(value))))
      throw new Error(`Qualified native Note operation attempted a compatibility Python executor: ${args.join(" ")}\n${new Error().stack}`);
    return spawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
}
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(root.href)) {
      const module = relative(fileURLToPath(root), fileURLToPath(url)).replaceAll("\\", "/");
      if (!seen.has(module)) {
        seen.add(module);
        process.stderr.write(`PKM_CLI_IMPORT ${JSON.stringify({
          module, threadId, ownerNoncePresent: Object.hasOwn(process.env, "PKM_NEXT_OWNER_READY_NONCE"),
        })}\n`);
      }
      if (module === process.env.PKM_TEST_CLI_BLOCK_MODULE)
        throw new Error(`Selected CLI module blocked before evaluation: ${module}`);
    }
    return nextLoad(url, context);
  },
});
