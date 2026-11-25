import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceRoot = pathToFileURL(`${resolve(import.meta.dirname, "../src")}/`).href;
registerHooks({
  resolve(specifier, context, next) {
    const candidate = specifier.startsWith("file:") ? specifier
      : specifier.startsWith(".") && context.parentURL?.startsWith(sourceRoot) ? new URL(specifier, context.parentURL).href : undefined;
    if (candidate?.startsWith(sourceRoot) && candidate.endsWith(".js")) {
      const source = candidate.slice(0, -3) + ".ts";
      if (existsSync(fileURLToPath(source))) return { url: source, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts"))
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
    return next(url, context);
  },
});
