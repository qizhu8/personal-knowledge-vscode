import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { compareVersionOrder } from "../runtime/version-order";

export function ensureRecipeCompiler(extensionPath: string, mcpDirectory: string, executable: string): void {
  const configPath = path.join(mcpDirectory, "recipe_compiler_config.json");
  const version: string = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8")).version;
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if ((compareVersionOrder(existing.extensionVersion, version) || 0) > 0) {
      throw new Error(`Refusing to replace Recipe compiler from newer extension ${existing.extensionVersion} with ${version}. Reload this window.`);
    }
  }
  const names = ["workflow-contracts.js", "value-contracts.js"];
  const files = names.map(name => fs.readFileSync(path.join(extensionPath, "dist", "workflows", name)));
  const digest = createHash("sha256");
  files.forEach((bytes, index) => digest.update(names[index]).update(bytes));
  const directory = path.join(mcpDirectory, "recipe-compiler", digest.digest("hex"));
  fs.mkdirSync(directory, { recursive: true });
  names.forEach((name, index) => {
    const target = path.join(directory, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, files[index], { flag: "wx", mode: 0o600 });
    else if (!fs.readFileSync(target).equals(files[index])) throw new Error(`Recipe compiler artifact mismatch: ${target}`);
  });
  const config = JSON.stringify({ executable, contracts: path.join(directory, names[0]), extensionVersion: version });
  if (fs.existsSync(configPath) && fs.readFileSync(configPath, "utf8") === config) return;
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, config, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
