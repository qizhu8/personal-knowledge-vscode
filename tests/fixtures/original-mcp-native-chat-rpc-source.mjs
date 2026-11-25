import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const target = new URL("../../dist/original-mcp-native-chat-rpc.js", import.meta.url).href;
const source = new URL("../../src/original-mcp-native-chat-rpc.ts", import.meta.url);
// Opt-in noEmit Source check; normal runs use Parent's coherent emitted runtime.
if (process.env.PKM_TEST_NATIVE_CHAT_RPC_SOURCE === "1") registerHooks({
  load(url, context, next) {
    if (url !== target) return next(url, context);
    return { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
  },
});
