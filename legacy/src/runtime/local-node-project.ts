import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const locks = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export type LocalNodeProject = Readonly<{
  schema: "pkm.local-node-project/v1"; root: string; rootIdentity: string;
  entry: string; source: string; sourceSha256: string;
  format?: "commonjs" | "module"; typescript?: boolean;
  files: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
}>;
function directory(root: string) {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root
    || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o002) !== 0)
    throw new Error("Select a canonical owned Node project directory, not a symlink or world-writable folder.");
  return `${stat.dev}:${stat.ino}`;
}
function read(root: string, relative: string, limit: number): Buffer {
  const file = path.resolve(root, relative), inside = path.relative(root, file);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)
    || fs.realpathSync(file) !== file) throw new Error("Project files must remain canonical and inside the selected project.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > limit)
      throw new Error("Project input must be an owned bounded regular file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== stat.size) throw new Error("Project input changed; review it again.");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function manifest(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Node package.json object.");
  return value as Record<string, unknown>;
}
export function inspectNodeProject(root: string) {
  directory(root);
  const bytes = read(root, "package.json", 65_536), pkg = manifest(bytes);
  const candidates = [pkg.main, "index.cjs", "index.js", "index.mjs", "index.ts", "index.mts", "index.cts",
    "src/index.cjs", "src/index.js", "src/index.mjs", "src/index.ts"];
  const entries = [...new Set(candidates.filter((value): value is string => typeof value === "string"))]
    .filter(value => {
      try { captureNodeProject(root, path.resolve(root, value)); return true; } catch { return false; }
    });
  return { root, name: typeof pkg.name === "string" ? pkg.name.slice(0, 256) : path.basename(root),
    packageSha256: digest(bytes), entries,
    engines: pkg.engines, packageManager: pkg.packageManager,
    scripts: pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : [],
    qualification: "CommonJS/ESM; TypeScript requires the selected installed Node's stripping support. Scripts/engines are metadata, never installed." };
}
export function captureNodeProject(root: string, entrypoint: string): LocalNodeProject {
  const rootIdentity = directory(root), entry = path.relative(root, entrypoint);
  if (!path.isAbsolute(entrypoint) || path.resolve(entrypoint) !== entrypoint || !/\.(cjs|js|mjs|ts|mts|cts)$/.test(entry))
    throw new Error("Select an existing JavaScript/TypeScript entry. TypeScript only reuses the selected Node's existing stripping support; no compiler or build is installed.");
  const bytes = read(root, entry, 16_384), source = bytes.toString("utf8");
  if (source.includes("\0") || !Buffer.from(source).equals(bytes)) throw new Error("Project entry must be bounded UTF-8 source.");
  const names = ["package.json", ...locks.filter(name => fs.existsSync(path.join(root, name)))];
  let scoped: Record<string, unknown> | undefined;
  for (let folder = path.dirname(entrypoint); folder !== root; folder = path.dirname(folder)) {
    const name = path.relative(root, path.join(folder, "package.json"));
    if (fs.existsSync(path.join(root, name))) {
      const pkg = manifest(read(root, name, 65_536));
      scoped ??= pkg; names.push(name);
    }
  }
  scoped ??= manifest(read(root, "package.json", 65_536));
  const typescript = /\.(ts|mts|cts)$/.test(entry);
  const format = /\.(mjs|mts)$/.test(entry) || !/\.(cjs|cts)$/.test(entry) && scoped.type === "module" ? "module" : "commonjs";
  const files = names.map(name => Object.freeze({ path: name,
    sha256: digest(read(root, name, locks.includes(name) ? 8_388_608 : 65_536)) }));
  return Object.freeze({ schema: "pkm.local-node-project/v1", root, rootIdentity, entry, source,
    sourceSha256: digest(bytes), files: Object.freeze(files),
    ...(format === "module" || typescript ? { format, typescript } : {}) });
}
export function validateNodeProject(project: LocalNodeProject): void {
  if (JSON.stringify(captureNodeProject(project.root, path.join(project.root, project.entry))) !== JSON.stringify(project))
    throw new Error("Node project source/package/lock mapping changed; reselect and approve again.");
}
export function discoverLocalExecutors(folder: string, language: "javascript" | "csharp") {
  const root = fs.realpathSync(folder);
  if (!fs.statSync(root).isDirectory()) throw new Error("Select a local executable directory.");
  return (language === "javascript" ? ["node", "nodejs"] : ["dotnet", "csc", "csi", "mcs"]).flatMap(id => {
    const executable = path.join(root, id);
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      if (!fs.statSync(executable).isFile()) return [];
      return [{ id: language === "javascript" ? "node" : id, executable, target: fs.realpathSync(executable) }];
    } catch { return []; }
  });
}
