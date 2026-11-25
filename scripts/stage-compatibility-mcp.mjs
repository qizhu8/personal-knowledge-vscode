import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function write(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  return hash(bytes);
}
async function pin(path) {
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isFile()) throw new Error("Runtime must be a regular file.");
  return { path: canonical, sha256: hash(await readFile(canonical)) };
}
/** Stages code/config only, never creates a v5 database or edits the business library. */
export async function stageCompatibilityMcp(input) {
  const { extension, knowledgeRoot, managedRoot, python, destination } = input;
  for (const path of [extension, knowledgeRoot, managedRoot, dirname(destination)]) {
    if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("Use canonical absolute paths.");
  }
  const rel = relative(knowledgeRoot, destination);
  if (!isAbsolute(destination) || destination !== resolve(destination)
    || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    throw new Error("The runtime stage must be outside the business library.");
  const parent = await lstat(dirname(destination));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw new Error("Choose an existing private stage parent.");
  const require = createRequire(join(extension, "package.json"));
  const lifecycle = require(join(extension, "dist/mcp/mcp-lifecycle.js"));
  const legacy = lifecycle.readManagedMcpManifest(managedRoot);
  if (!legacy || legacy.managedRoot !== managedRoot) throw new Error("The original managed runtime is not provisioned.");
  await mkdir(destination, { mode: 0o700 });
  try {
    const entry = join(destination, "gateway.mjs");
    await build({
      entryPoints: [join(root, "src/compatibility-mcp-cli.ts")], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
      banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' },
    });
    await chmod(entry, 0o600);
    const supervisor = join(destination, "supervisor.py");
    await copyFile(join(extension, "resources/next_mcp_subreaper.py"), supervisor, constants.COPYFILE_EXCL);
    await chmod(supervisor, 0o600);
    const node = await pin(process.execPath), entryPin = await pin(entry), supervisorPin = await pin(supervisor);
    const generation = randomUUID();
    const runtimeBuild = hash(JSON.stringify({ entry: entryPin.sha256, supervisor: supervisorPin.sha256,
      node: node.sha256, upstream: legacy.runtimeBuild, architecture: "v5-mcp-with-original-business-adapter" }));
    const configuration = {
      schema: "pkm.compatibility-mcp/v1", knowledgeRoot, managedRoot: destination,
      node, supervisor: supervisorPin, python,
      legacy: { launcher: await pin(join(managedRoot, "server.py")), generation: legacy.generation,
        runtimeBuild: legacy.runtimeBuild, version: legacy.version, components: legacy.components, compatibleUpdates: true },
      gateway: { generation, runtimeBuild }, writable: true,
    };
    const configPath = join(destination, "adapter.json"), configSha256 = await write(configPath, configuration);
    await write(join(destination, "active-generation.json"), { schema: "pkm.mcp.lifecycle/v1", generation });
    const targetPath = join(destination, "target.json");
    const target = { schema: "pkm.mcp-runtime-target/v1", knowledgeRoot, command: node, entry: entryPin,
      args: [configPath, configSha256], cwd: destination, expectedVersion: "0.1.0", runtimeBuild };
    const targetSha256 = await write(targetPath, target);
    const directory = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return { targetPath, targetSha256, runtimeBuild, generation, canonicalBusinessOperations: "captured-and-verified-on-connection",
      storageMigrated: false, legacyBusinessVersion: legacy.version, legacyBusinessBuild: legacy.runtimeBuild,
      originalRootChanged: false };
  } catch (error) {
    try { await rm(destination, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Compatibility staging failed and the new partial stage could not be removed."); }
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [extension, knowledgeRoot, managedRoot, python, destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw new Error("Usage: EXTENSION KNOWLEDGE_ROOT MANAGED_ROOT PYTHON NEW_PRIVATE_STAGE");
  console.log(JSON.stringify(await stageCompatibilityMcp({ extension, knowledgeRoot, managedRoot, python, destination })));
}
