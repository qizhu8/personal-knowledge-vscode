import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

/** Keep lazy imports and implementation fingerprints alive after VS Code removes an old extension. */
export function stageRetrievalRuntime(state: string, workerScript: string): { script: string; build: string; version: string } {
  const resources = path.dirname(workerScript);
  const packagePath = path.join(resources, "..", "package.json");
  const version: string = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, "utf8")).version : "0.0.0";
  const files = fs.readdirSync(resources).filter(name => /^retrieval[^/]*\.py$/.test(name)
    || name === "retrieval-default-model.json" || name === "retrieval-model-requirements.txt").sort();
  const vendor = path.join(resources, "vendor");
  if (fs.existsSync(vendor)) files.push(...fs.readdirSync(vendor)
    .filter(name => /^adaptive_skill_retrieval-.*\.whl$/.test(name)).sort().map(name => `vendor/${name}`));
  const hash = createHash("sha256");
  hash.update(version);
  for (const name of files) {
    if (!fs.lstatSync(path.join(resources, name)).isFile()) throw new Error("Retrieval runtime contains a non-regular helper.");
    hash.update(name).update("\0").update(fs.readFileSync(path.join(resources, name)));
  }
  const build = hash.digest("hex");
  const directory = path.join(state, "runtimes", build);
  if (!fs.existsSync(directory)) {
    const temporary = `${directory}.${randomUUID()}.pending`;
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const name of files) {
        fs.mkdirSync(path.dirname(path.join(temporary, name)), { recursive: true });
        fs.copyFileSync(path.join(resources, name), path.join(temporary, name));
      }
      fs.writeFileSync(path.join(temporary, "runtime-build"), build, { mode: 0o600 });
      fs.writeFileSync(path.join(temporary, "runtime-version"), version, { mode: 0o600 });
      try { fs.renameSync(temporary, directory); }
      catch (error) {
        if (!fs.existsSync(directory) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        for (const name of files) if (!fs.readFileSync(path.join(directory, name)).equals(fs.readFileSync(path.join(temporary, name)))) {
          throw new Error("Concurrent retrieval runtime publication failed verification.");
        }
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return { script: path.join(directory, path.basename(workerScript)), build, version };
}
