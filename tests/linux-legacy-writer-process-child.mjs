import { writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [mode, readyPath, root] = process.argv.slice(2);
const ready = resolve(readyPath);
const rootPath = resolve(root);
let descriptor;
if (mode === "inspect-as-parent") {
  const moduleUrl = new URL("../dist/linux-legacy-writer-quiescence.js", import.meta.url).href;
  const source = `const m=await import(${JSON.stringify(moduleUrl)});
    const r=await m.inspectLinuxLegacyWriterQuiescence(process.argv[1]);
    console.log(JSON.stringify({parent:process.ppid,report:r}));`;
  process.stdout.write(execFileSync(process.execPath, ["--input-type=module", "-e", source, rootPath]));
  process.exit(0);
}
if (mode === "writable") {
  descriptor = openSync(join(rootPath, "notes", "Existing.md"), "r+");
} else if (mode === "working-directory") {
  process.chdir(rootPath);
}
writeFileSync(ready, "ready");
process.stdin.on("end", () => {
  if (descriptor !== undefined) closeSync(descriptor);
  process.exit(0);
});
process.stdin.resume();
