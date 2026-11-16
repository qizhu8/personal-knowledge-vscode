import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

export async function validateHostBuild(directory = resolve(here, "dist")) {
  const manifest = JSON.parse(await readFile(join(directory, "host-build.json"), "utf8"));
  if (manifest.schema !== "pkm.host-build/v1" || !manifest.files || Array.isArray(manifest.files))
    throw new Error("Invalid host build inventory; rebuild before packaging.");
  const actual = {};
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const filename = join(parent, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const name = relative(directory, filename).replaceAll("\\", "/");
        if (name !== "host-build.json") actual[name] = createHash("sha256").update(await readFile(filename)).digest("hex");
      } else throw new Error(`Refusing linked or unsupported host asset: ${filename}`);
    }
  }
  await visit(directory);
  if (Object.keys(actual).length !== Object.keys(manifest.files).length
    || Object.entries(manifest.files).some(([name, digest]) => actual[name] !== digest))
    throw new Error("Host build assets changed or are incomplete; rebuild before packaging.");
  for (const name of ["extension.cjs", "extension-modules.json", "migration/src/import-helper.js", "migration/package.json"])
    if (!actual[name]) throw new Error(`Host runtime asset missing: ${name}`);
  return manifest;
}

export async function validateHostPayload(extensionPath = here) {
  const build = await validateHostBuild(resolve(extensionPath, "dist"));
  const verifier = resolve(extensionPath, "next-runtime/server/legacy/dist/runtime/next-payload-verifier.js");
  const payload = require(verifier).verifyNextPayload(extensionPath);
  if (payload.buildId !== build.payloadBuildId || !Array.isArray(build.retainedRuntime))
    throw new Error("The host build and verified payload do not match; rebuild before packaging.");
  for (const name of build.retainedRuntime) {
    const duplicate = resolve(extensionPath, "dist", name);
    try { await readFile(duplicate); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`Duplicate retained host module: ${name}`);
  }
  return payload;
}

export async function packageHost(output, { env = process.env } = {}) {
  await validateHostPayload();
  await mkdir(dirname(resolve(output)), { recursive: true });
  const command = env.PKM_VSCE_EXECUTABLE || "vsce";
  const version = spawnSync(command, ["--version"], { env, encoding: "utf8" });
  if (version.error || version.status !== 0) throw new Error("Existing vsce CLI unavailable. Set PKM_VSCE_EXECUTABLE; no tooling will be installed.");
  const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
  if (`${manifest.publisher}.${manifest.name}` !== "pkm-nonproduction.pkm-v5")
    throw new Error("Refusing to package a non-host extension.");
  const stage = resolve(here, `.host-package-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const name of ["package.json", "README.md", "dist", "next-runtime"])
      await cp(resolve(here, name), resolve(stage, name), { recursive: true });
    await validateHostPayload(stage);
    await cp(new URL("../../LICENSE", import.meta.url), resolve(stage, "LICENSE"));
    const result = spawnSync(command, [
      "package", "--no-dependencies", "--allow-missing-repository", "--out", resolve(output),
    ], { cwd: stage, env, stdio: "inherit", timeout: 120000 });
    if (result.error || result.status !== 0) throw result.error || new Error(`Host-only VSIX packaging failed: ${result.status}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(here, process.argv[2] || "pkm-v5-0.1.0.vsix");
  await packageHost(output);
}
