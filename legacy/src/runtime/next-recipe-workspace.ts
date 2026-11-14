import * as fs from "fs";
import * as path from "path";

export interface NextRecipeWorkspacePin {
  schema: "pkm.next-recipe-workspace/v1";
  parent: string; workspaceId: string; parentIdentity: string; workspaceIdentity: string;
  databaseIdentity: string; markerIdentity: string;
}
export function captureRecipeWorkspace(parent: string, workspaceId: string): NextRecipeWorkspacePin {
  const identity = (file: string, directory: boolean) => {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file)
      throw new Error("Recipe workspace paths must be canonical and cannot contain symlinks.");
    const stat = fs.lstatSync(file, { bigint: true });
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || directory && (stat.mode & 0o077n) !== 0n)
      throw new Error("Recipe workspace identity or ownership is unsafe.");
    return `${stat.dev}:${stat.ino}`;
  };
  const root = path.join(parent, "workspace"), marker = path.join(root, ".pkm-next-workspace");
  if (!/^[a-f0-9-]{36}$/.test(workspaceId) || JSON.parse(fs.readFileSync(marker, "utf8")).id !== workspaceId)
    throw new Error("Recipe workspace marker changed.");
  return { schema: "pkm.next-recipe-workspace/v1", parent, workspaceId,
    parentIdentity: identity(parent, true), workspaceIdentity: identity(root, true),
    databaseIdentity: identity(path.join(root, "core.sqlite"), false), markerIdentity: identity(marker, false) };
}
export function assertRecipeWorkspace(pin: NextRecipeWorkspacePin): void {
  if (!pin || pin.schema !== "pkm.next-recipe-workspace/v1"
    || JSON.stringify(captureRecipeWorkspace(pin.parent, pin.workspaceId)) !== JSON.stringify(pin))
    throw new Error("Independent Recipe workspace pin is missing or changed; no adoption or repair is performed.");
}
