import { promises as fs } from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { GitSource, importGitSource, assertGitSourceAncestor, parseGitSource } from "./git-source";

const metadata = ".pkm-git-source.json";

function packagePath(root: string, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(name)) throw new Error("Choose a package name using letters, digits, dots, underscores or hyphens.");
  return path.join(root, name);
}

async function inventory(directory: string, checkout = false): Promise<Record<string, string>> {
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Package roots cannot be symlinks.");
  const files:Record<string, string> = Object.create(null);
  let bytes = 0, count = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes:true })) {
      if (!relative && (checkout && entry.name === ".git" || !checkout && entry.name === metadata)) continue;
      const member = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error(`Package contains a symlink or special file: ${member}`);
      if (entry.isDirectory()) await walk(member);
      else {
        if (checkout && entry.name === metadata) throw new Error(`Repository contains reserved PKM metadata: ${member}`);
        const file = path.join(directory, member);
        bytes += (await fs.stat(file)).size;
        if (bytes > 64 * 1024 * 1024 || ++count > 10_000) throw new Error("Package exceeds the 64 MiB / 10,000 file import limit.");
        const content = await fs.readFile(file);
        files[member] = createHash("sha256").update(content).digest("hex");
      }
    }
  }
  await walk("");
  return files;
}

async function packageLock(checkouts:string, target:string):Promise<() => Promise<void>> {
  await fs.mkdir(checkouts, { recursive:true });
  const lock = path.join(checkouts, `.pkm-package-lock-${createHash("sha256").update(path.resolve(target)).digest("hex")}`);
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("This package is already being imported or updated. If a Host crashed, inspect its retained lock before removing it.");
    throw error;
  }
  return () => fs.rmdir(lock);
}

function same(left:Record<string, string>, right:Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, hash]) => right[name] === hash);
}

async function stage(directory: string, checkout: string, source:GitSource): Promise<void> {
  const files = await inventory(checkout, true);
  for (const [name, hash] of Object.entries(files)) {
    const content = await fs.readFile(path.join(checkout, name));
    if (createHash("sha256").update(content).digest("hex") !== hash) throw new Error("Checkout changed while staging the package.");
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive:true });
    await fs.writeFile(target, content);
  }
  await fs.writeFile(path.join(directory, metadata), JSON.stringify({ schema:1, ...source, files }, null, 2) + "\n", { flag:"wx" });
}

export async function importGitPackage(root:string, checkouts:string, name:string, url:string, branch:string):Promise<void> {
  const target = packagePath(root, name);
  const release = await packageLock(checkouts, target);
  const checkout = path.join(checkouts, `${name}-${randomUUID()}`);
  const temporary = path.join(root, `.pkm-git-stage-${randomUUID()}`);
  try {
    await fs.mkdir(root, { recursive:true });
    try { await fs.lstat(target); throw new Error("The package destination already exists."); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    const source = await importGitSource(checkout, url, branch);
    await fs.mkdir(temporary);
    await stage(temporary, checkout, source);
    await fs.rename(temporary, target);
  } finally {
    try {
      await fs.rm(temporary, { recursive:true, force:true });
      await fs.rm(checkout, { recursive:true, force:true });
    } finally { await release(); }
  }
}

export async function updateGitPackage(root:string, checkouts:string, name:string):Promise<void> {
  const target = packagePath(root, name);
  const release = await packageLock(checkouts, target);
  const checkout = path.join(checkouts, `${name}-${randomUUID()}`);
  const temporary = path.join(root, `.pkm-git-stage-${randomUUID()}`);
  const backup = path.join(root, `.pkm-git-backup-${randomUUID()}`);
  let backedUp = false;
  let installed = false;
  try {
    const recorded = JSON.parse(await fs.readFile(path.join(target, metadata), "utf8"));
    const source = parseGitSource(recorded);
    if (recorded.schema !== 1 || !recorded.files || typeof recorded.files !== "object" || Array.isArray(recorded.files)
      || Object.values(recorded.files).some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Package Git metadata is invalid.");
    const files:Record<string, string> = recorded.files;
    if (!same(files, await inventory(target))) throw new Error("Package has local changes or extra files. Preserve them before updating; nothing was overwritten.");
    const current = await importGitSource(checkout, source.url, source.branch);
    await assertGitSourceAncestor(checkout, source.revision);
    await fs.mkdir(temporary);
    await stage(temporary, checkout, current);
    if (!same(files, await inventory(target))) throw new Error("Package changed during fetch. Update refused.");
    await fs.rename(target, backup); backedUp = true;
    await fs.rename(temporary, target); installed = true;
  } finally {
    try {
      if (backedUp && !installed) await fs.rename(backup, target);
      if (installed) await fs.rm(backup, { recursive:true });
      await fs.rm(temporary, { recursive:true, force:true });
      await fs.rm(checkout, { recursive:true, force:true });
    } finally { await release(); }
  }
}
