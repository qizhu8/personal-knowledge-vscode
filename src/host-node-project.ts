import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, lstatSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const locks = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const localNodeProjectSchema = z.strictObject({
  schema: z.literal("pkm.local-node-project/v1"), root: z.string().min(1), rootIdentity: z.string().regex(/^\d+:\d+$/),
  entry: z.string().min(1).max(4096), source: z.string().refine(value => Buffer.byteLength(value) <= 16_384 && !value.includes("\0")),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.enum(["commonjs", "module"]).optional(), typescript: z.boolean().optional(),
  files: z.array(z.strictObject({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(128),
});
type Project = z.infer<typeof localNodeProjectSchema>;
export function verifyNodeProject(project: Project): void {
  const { root } = project, stat = lstatSync(root);
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !stat.isDirectory()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o002) !== 0 || `${stat.dev}:${stat.ino}` !== project.rootIdentity)
    throw new Error("Approved Node project directory changed.");
  const read = (name: string, limit: number) => {
    const file = resolve(root, name), inside = relative(root, file);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || realpathSync(file) !== file)
      throw new Error("Node project input escaped or changed.");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size > limit)
        throw new Error("Node project input must be bounded and owned.");
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0, count: number;
      while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      if (length !== info.size) throw new Error("Node project input changed.");
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  };
  if (!/\.(cjs|js|mjs|ts|mts|cts)$/.test(project.entry) || isAbsolute(project.entry) || relative(root, resolve(root, project.entry)) !== project.entry)
    throw new Error("Only a canonical JavaScript/TypeScript project entry is qualified.");
  const source = read(project.entry, 16_384);
  if (hash(source) !== project.sourceSha256 || !Buffer.from(project.source).equals(source))
    throw new Error("Approved Node project entry changed.");
  const names = ["package.json", ...locks.filter(name => existsSync(join(root, name)))];
  let scoped: Record<string, unknown> | undefined;
  const pkg = (name: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(read(name, 65_536).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Node package.json.");
    return value as Record<string, unknown>;
  };
  for (let folder = dirname(join(root, project.entry)); folder !== root; folder = dirname(folder)) {
    const name = relative(root, join(folder, "package.json"));
    if (existsSync(join(root, name))) { scoped ??= pkg(name); names.push(name); }
  }
  scoped ??= pkg("package.json");
  const typescript = /\.(ts|mts|cts)$/.test(project.entry);
  const format = /\.(mjs|mts)$/.test(project.entry) || !/\.(cjs|cts)$/.test(project.entry) && scoped.type === "module" ? "module" : "commonjs";
  if ((project.format ?? "commonjs") !== format || (project.typescript ?? false) !== typescript)
    throw new Error("Approved project module/TypeScript format changed.");
  const files = names.map(name => ({ path: name, sha256: hash(read(name, locks.includes(name) ? 8_388_608 : 65_536)) }));
  if (JSON.stringify(files) !== JSON.stringify(project.files)) throw new Error("Node package/lock inputs changed; approve again.");
}
export function nodeProjectStdin(project: Project): Buffer {
  const prefix = `const Module=require("node:module"),path=require("node:path");
const project=${JSON.stringify({ entry: join(project.root, project.entry), source: project.source, typescript: project.typescript ?? false })};
const args=process.argv.slice(2);process.argv=[process.execPath,project.entry,...args];
if(project.typescript){
if(typeof Module.stripTypeScriptTypes!=="function")throw new Error("Selected installed Node has no TypeScript stripping support; no executor was installed.");
project.source=Module.stripTypeScriptTypes(project.source,{mode:"strip",sourceUrl:project.entry});
}
`;
  if (project.format === "module") return Buffer.from(`${prefix}
const entryURL=require("node:url").pathToFileURL(project.entry).href;
if(typeof Module.registerHooks!=="function")throw new Error("Selected installed Node has no snapshot ESM hooks; no runtime was installed.");
const source="import.meta.main=true;\\n"+project.source.replace(/^\\uFEFF/,"").replace(/^#![^\\r\\n]*/,"");
Module.registerHooks({load(url,context,nextLoad){return url===entryURL?{format:"module",source,shortCircuit:true}:nextLoad(url,context);}});
import(entryURL).catch(error=>{console.error(error);process.exitCode=1;});`);
  return Buffer.from(`${prefix}
const main=new Module(project.entry,null);main.id=".";main.filename=project.entry;
main.paths=Module._nodeModulePaths(path.dirname(project.entry));process.mainModule=main;
Module._cache[project.entry]=main;
main._compile(project.source.replace(/^\\uFEFF/,"").replace(/^#![^\\r\\n]*/,""),project.entry);main.loaded=true;`);
}
