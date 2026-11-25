import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveActionExecutable } from "./action-program-build.js";
import { pinRecipeEffectFile } from "./original-mcp-recipe-effect-files.js";

export function pinRegisteredActionExecutable(path: string) {
  const files: ReturnType<typeof pinRecipeEffectFile>[] = [];
  const visit = (value: string) => {
    if (files.length >= 4 || files.some(file => file.path === value))
      throw new Error("REGISTERED_ACTION_INTERPRETER_CLOSURE_REQUIRED");
    let file: ReturnType<typeof pinRecipeEffectFile>;
    try { file = pinRecipeEffectFile(value); }
    catch (cause) { throw new Error(`REGISTERED_ACTION_EXECUTABLE_CUSTODY_REQUIRED: ${value}`, { cause }); }
    files.push(file);
    const bytes = readFileSync(value);
    if (bytes[0] !== 35 || bytes[1] !== 33) return;
    const line = bytes.subarray(2, Math.min(bytes.length, 1024)).toString("utf8").split("\n")[0]!.trim();
    const words = line.split(/\s+/);
    const interpreter = resolveActionExecutable(words[0]!);
    if (!interpreter) throw new Error("REGISTERED_ACTION_INTERPRETER_REQUIRED");
    visit(interpreter);
    if (basename(interpreter) === "env") {
      const command = words[1] === "-S" ? words[2] : words[1];
      if (!command || command.startsWith("-") || command.includes("="))
        throw new Error("REGISTERED_ACTION_CLOSED_INTERPRETER_REQUIRED");
      const resolved = resolveActionExecutable(command);
      if (!resolved) throw new Error("REGISTERED_ACTION_INTERPRETER_REQUIRED");
      visit(resolved);
    }
  };
  visit(path);
  return files;
}
