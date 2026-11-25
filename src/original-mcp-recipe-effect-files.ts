import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { recipeEffectFileSchema } from "./original-mcp-recipe-effect-contracts.js";

const identity = (stat: Stats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
export function pinRecipeEffectFile(path: string, maximum = 134217728, executable = false) {
  const before = lstatSync(path);
  const ownedExecutableGroup = executable && process.platform !== "win32"
    && before.uid === process.getuid!() && before.gid === process.getgid!();
  if (!isAbsolute(path) || realpathSync(path) !== path || !before.isFile() || !executable && before.nlink !== 1 || before.size > maximum
    || executable && !(before.mode & 0o111)
    || process.platform !== "win32" && (before.mode & 0o7002 || before.mode & 0o020 && !ownedExecutableGroup
      || before.uid !== 0 && before.uid !== process.getuid!()))
    throw new Error("NATIVE_RECIPE_EFFECT_FILE_CHANGED");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd);
    if (identity(before) !== identity(fstatSync(fd)) || identity(before) !== identity(lstatSync(path)) || bytes.length !== before.size)
      throw new Error("NATIVE_RECIPE_EFFECT_FILE_CHANGED");
    return recipeEffectFileSchema.parse({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, identity: identity(before) });
  } finally { closeSync(fd); }
}
export function pinRecipeEffectCwd(root: string, path: string) {
  const stat = lstatSync(path), child = relative(root, path);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !stat.isDirectory()
    || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)
    || process.platform !== "win32" && (stat.uid !== process.getuid!() || stat.mode & 0o022))
    throw new Error("NATIVE_RECIPE_EFFECT_CWD_CHANGED");
  return { path, identity: [stat.dev, stat.ino, stat.uid, stat.mode].join(":") };
}
export function assertRecipeEffectExecutable(path: string) {
  if (/^(?:sh|bash|dash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(basename(path)))
    throw new Error("Shell command execution is not admitted by this Recipe effect producer.");
}
