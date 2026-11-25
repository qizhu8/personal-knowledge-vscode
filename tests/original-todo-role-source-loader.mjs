import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";
import ts from "typescript";

// Leaf-only source evaluation. Modules are transformed in memory; no emitted files or pins are changed.
const source = resolve("src") + sep;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL || pathToFileURL(resolve("index.mjs")));
      const path = url.protocol === "file:" ? fileURLToPath(url) : "";
      if (path.startsWith(source) && path.endsWith(".js") && existsSync(path.slice(0, -3) + ".ts"))
        return { url: pathToFileURL(path.slice(0, -3) + ".ts").href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const path = url.startsWith("file:") ? fileURLToPath(url) : "";
    if (path.startsWith(source) && path.endsWith(".ts"))
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: path,
      }).outputText };
    return next(url, context);
  },
});
