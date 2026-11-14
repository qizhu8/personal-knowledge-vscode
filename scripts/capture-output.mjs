import { readFile, writeFile } from "node:fs/promises";

export async function publishCapture(outputs, check) {
  if (check) {
    const stale = [];
    for (const [path, content] of outputs) {
      let existing;
      try { existing = await readFile(path, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing !== content) stale.push(path);
    }
    if (stale.length) throw new Error(`Action compiler capture differs: ${stale.join(", ")}. Re-capture and requalify.`);
    return;
  }
  for (const [path, content] of outputs) await writeFile(path, content);
}
