import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
const legacySource = fileURLToPath(new URL("../../legacy/src/", import.meta.url));
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p",
  fileURLToPath(new URL("../../legacy/tsconfig.json", import.meta.url))], { stdio: "inherit" });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", here], { stdio: "inherit" });
const { stage, retainedRuntimeFiles } = require("../../scripts/stage-runtime.cjs");
const retained = new Set(retainedRuntimeFiles());
const output = fileURLToPath(new URL("dist/", import.meta.url));
await rm(output, { recursive: true, force: true });
const { build } = require("esbuild");
const extensionBuild = await build({
  entryPoints: [fileURLToPath(new URL("extension.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("dist/extension.cjs", import.meta.url)),
  bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"],
  plugins: [{
    name: "shared-retained-runtime",
    setup(plugin) {
      plugin.onResolve({ filter: /^\./ }, args => {
        const source = resolve(dirname(args.importer), args.path);
        const local = relative(legacySource, source);
        if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return;
        const compiled = local.replace(/\.ts$/, "").replace(/\.js$/, "") + ".js";
        const name = compiled.split(sep).join("/");
        if (retained.has(name)) return { path: `../next-runtime/server/legacy/dist/${name}`, external: true };
      });
    },
  }],
  metafile: true,
  logLevel: "warning",
});
const retainedSource = filename => {
  const local = relative(legacySource, resolve(filename)).split(sep).join("/");
  return retained.has(local.replace(/\.ts$/, ".js"));
};
if (Object.keys(extensionBuild.metafile.inputs).some(filename => retainedSource(filename)
  || filename.endsWith("/active-vscode-migration-host.ts")))
  throw new Error("Shared retained modules and active host brands must not be bundled into the extension.");
await writeFile(join(output, "extension-modules.json"), JSON.stringify({
  retainedExternals: Object.values(extensionBuild.metafile.outputs).flatMap(result =>
    result.imports.filter(item => item.external && item.path.includes("/legacy/dist/")).map(item => item.path)),
}, null, 2) + "\n");
const migration = new URL("dist/migration/", import.meta.url);
await rm(migration, { recursive: true, force: true });
await mkdir(new URL("src/", migration), { recursive: true });
await writeFile(new URL("package.json", migration), '{"type":"module"}\n');
const helperBuild = await build({
  entryPoints: {
    "import-helper": fileURLToPath(new URL("import-helper.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("src/", migration)),
  bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  plugins: [{
    name: "shared-core-importer",
    setup(plugin) {
      plugin.onResolve({ filter: /legacy-import(?:\.js|\.ts)?$/ }, args => {
        const source = resolve(dirname(args.importer), args.path).replace(/\.js$/, ".ts");
        if (source === fileURLToPath(new URL("../../src/legacy-import.ts", import.meta.url)))
          return { path: "../../../next-runtime/server/dist/legacy-import.js", external: true };
      });
    },
  }],
  metafile: true,
  logLevel: "warning",
});
if (Object.keys(helperBuild.metafile.inputs).some(filename => retainedSource(filename)
  || filename.endsWith("/active-vscode-migration-host.ts")))
  throw new Error("The separate first-run helper must not embed active-host authority modules.");
await copyFile(join(here, "original-mcp-native-sdk-supervisor.py"),
  join(output, "original-mcp-native-sdk-supervisor.py"));
const files = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(filename);
    else if (entry.isFile()) files[relative(output, filename).replaceAll("\\", "/")] =
      createHash("sha256").update(await readFile(filename)).digest("hex");
    else throw new Error(`Unsupported built host asset: ${filename}`);
  }
}
await inventory(output);
const payload = fileURLToPath(new URL("next-runtime/", import.meta.url));
await rm(payload, { recursive: true, force: true });
const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
stage(payload, { production: true, extensionVersion: manifest.version });
const payloadManifest = JSON.parse(await readFile(join(payload, "manifest.json"), "utf8"));
if (!payloadManifest.files["server/dist/active-vscode-migration-host.js"])
  throw new Error("Build the current Core before the host: the active migration leaf is missing.");
await writeFile(join(output, "host-build.json"), JSON.stringify({
  schema: "pkm.host-build/v1", files, payloadBuildId: payloadManifest.buildId, retainedRuntime: [...retained],
}, null, 2) + "\n");
