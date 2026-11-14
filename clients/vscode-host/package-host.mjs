import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));

export async function packageHost(output, { env = process.env } = {}) {
  const command = env.PKM_VSCE_EXECUTABLE || "vsce";
  const version = spawnSync(command, ["--version"], { env, encoding: "utf8" });
  if (version.error || version.status !== 0) throw new Error("Existing vsce CLI unavailable. Set PKM_VSCE_EXECUTABLE; no tooling will be installed.");
  const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
  if (`${manifest.publisher}.${manifest.name}` !== "pkm-nonproduction.pkm-next-nonproduction-host")
    throw new Error("Refusing to package a non-host extension.");
  const stage = resolve(here, `.host-package-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const name of ["package.json", "README.md", "dist"])
      await cp(resolve(here, name), resolve(stage, name), { recursive: true });
    await cp(new URL("../../legacy/LICENSE", import.meta.url), resolve(stage, "LICENSE"));
    const result = spawnSync(command, [
      "package", "--no-dependencies", "--allow-missing-repository", "--out", resolve(output),
    ], { cwd: stage, env, stdio: "inherit", timeout: 120000 });
    if (result.error || result.status !== 0) throw result.error || new Error(`Host-only VSIX packaging failed: ${result.status}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(here, process.argv[2] || "pkm-next-nonproduction-host-0.1.0.vsix");
  await packageHost(output);
}
