import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type PayloadManifest = {
  schema: string; extensionVersion: string; serverVersion: string; node: string;
  entry: string; buildId: string; files: Record<string, string>;
};

export function verifyNextPayload(extensionPath: string): {
  root: string; entry: string; version: string; buildId: string; nodeRequirement: string;
} {
  const root = join(extensionPath, "next-runtime");
  const fail = (message: string): never => { throw new Error(`Next-server payload invalid: ${message}`); };
  const readJson = (file: string): any => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fail(`cannot read ${file}`); }
  };
  const manifest = readJson(join(root, "manifest.json")) as PayloadManifest;
  if (!manifest || manifest.schema !== "pkm.next-payload/v1" || manifest.node !== ">=22.18.0"
    || manifest.entry !== "server/dist/managed-client-child.js" || !manifest.files
    || typeof manifest.files !== "object" || Array.isArray(manifest.files)) fail("unrecognized manifest");
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (hash(JSON.stringify(manifest.files)) !== manifest.buildId) fail("inventory digest mismatch");
  const required = ["server/package.json", "server/package-lock.json", manifest.entry,
    "server/dist/cli.js", "server/dist/legacy-import-cli.js", "server/dist/legacy-import.js",
    "server/dist/migration-preflight.js", "server/dist/rename-no-replace.js",
    "server/dist/file-mtime.js", "server/dist/storage-worker.js", "server/compat/legacy-compact-mcp.py",
    "server/node_modules/zod/package.json", "resources/note_inventory.py", "check.cjs"];
  if (required.some(name => !manifest.files[name])) fail("required file missing from inventory");
  if (manifest.extensionVersion !== readJson(join(extensionPath, "package.json")).version
    || manifest.serverVersion !== readJson(join(root, "server", "package.json")).version
    || manifest.serverVersion !== readJson(join(root, "server", "package-lock.json")).packages?.[""]?.version)
    fail("version mismatch");
  const discovered = new Set<string>();
  const scan = (directory: string, prefix = ""): void => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return fail(`cannot list ${prefix || "payload"}`); }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name);
      let stat;
      try { stat = lstatSync(full); } catch { return fail(`cannot inspect ${rel}`); }
      if (stat.isSymbolicLink()) fail(`link forbidden: ${rel}`);
      if (stat.isDirectory()) scan(full, rel);
      else if (stat.isFile()) discovered.add(rel);
      else fail(`non-regular file: ${rel}`);
    }
  };
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("payload root must be a real directory");
  } catch { return fail("payload root missing or inaccessible"); }
  scan(root);
  discovered.delete("manifest.json");
  const names = Object.keys(manifest.files);
  if (names.length !== discovered.size) fail("file inventory differs");
  for (const name of names) {
    if (!name || name.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))
      || !/^[a-f0-9]{64}$/.test(manifest.files[name]) || !discovered.has(name)) fail(`unsafe or missing file: ${name}`);
    if (hash(readFileSync(join(root, ...name.split("/")))) !== manifest.files[name]) fail(`digest mismatch: ${name}`);
  }
  return { root, entry: join(root, ...manifest.entry.split("/")), version: manifest.serverVersion,
    buildId: manifest.buildId, nodeRequirement: manifest.node };
}
