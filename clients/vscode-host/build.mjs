import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", here], { stdio: "inherit" });
const { build } = require("esbuild");
await build({
  entryPoints: [fileURLToPath(new URL("extension.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("dist/extension.cjs", import.meta.url)),
  bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"],
  logLevel: "warning",
});
// Keep import.meta-relative worker/compat assets inside the installable host.
const migration = new URL("dist/migration/", import.meta.url);
await rm(migration, { recursive: true, force: true });
await mkdir(new URL("src/", migration), { recursive: true });
await writeFile(new URL("package.json", migration), '{"type":"module"}\n');
await build({
  entryPoints: {
    "import-helper": fileURLToPath(new URL("import-helper.ts", import.meta.url)),
    "storage-worker": fileURLToPath(new URL("../../src/storage-worker.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("src/", migration)),
  bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "warning",
});
await cp(new URL("../../compat/", import.meta.url), new URL("compat/", migration), {
  recursive: true, filter: source => basename(source) !== "__pycache__",
});
await mkdir(new URL("legacy/resources/", migration), { recursive: true });
await writeFile(new URL("legacy/package.json", migration), '{"type":"commonjs"}\n');
await cp(new URL("../../legacy/resources/action_components.js", import.meta.url), new URL("legacy/resources/action_components.js", migration), { recursive: true });
